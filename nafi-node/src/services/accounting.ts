import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as J from '../core/jalali.js';
import { money, digits } from '../core/validator.js';
import { env } from '../core/env.js';
import * as ch from '../core/changes.js';
import { sha256 } from '../core/crypto.js';

export interface Line { account_id: number; debit?: number | null; credit?: number | null; description?: string | null }

/** Starter chart only: the company's accountant must review/replace it before real use. [code, name, nature, parent code|null, postable] */
export const STARTER: [string, string, string, string | null, number][] = [
  ['1', 'دارایی‌ها', 'debit', null, 0], ['11', 'دارایی‌های جاری', 'debit', '1', 0], ['1101', 'صندوق', 'debit', '11', 1], ['1102', 'بانک', 'debit', '11', 1], ['1103', 'حساب‌های دریافتنی', 'debit', '11', 1],
  ['2', 'بدهی‌ها', 'credit', null, 0], ['21', 'بدهی‌های جاری', 'credit', '2', 0], ['2101', 'حساب‌های پرداختنی', 'credit', '21', 1], ['2102', 'مالیات بر ارزش افزوده پرداختنی', 'credit', '21', 1],
  ['3', 'حقوق صاحبان سهام', 'credit', null, 0], ['3101', 'سرمایه', 'credit', '3', 1], ['3102', 'سود (زیان) انباشته', 'credit', '3', 1],
  ['4', 'درآمدها', 'credit', null, 0], ['4101', 'فروش', 'credit', '4', 1], ['5', 'هزینه‌ها', 'debit', null, 0], ['5101', 'هزینه‌های عمومی', 'debit', '5', 1],
];
const len = (s: string) => [...s].length;

async function company(db: Db, a: Actor, cid: number) {
  gate.assertCompany(a, cid);
  if (!(await db.val('SELECT 1 FROM companies WHERE id = ?', [cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
}

export async function seedStarterChart(db: Db, a: Actor, cid: number): Promise<number> {
  await gate.require_(db, a, 'accounting.manage'); await company(db, a, cid);
  if (await db.val('SELECT 1 FROM accounts WHERE company_id = ?', [cid])) throw new Invalid('برای این شرکت قبلاً سرفصل تعریف شده است.');
  return db.tx(async t => {
    const ids: Record<string, number> = {};
    for (const [code, name, nature, parent, post] of STARTER)
      ids[code] = await t.insert('INSERT INTO accounts (company_id,parent_id,code,name,nature,is_postable,created_at) VALUES (?,?,?,?,?,?,?)', [cid, parent ? ids[parent] : null, code, name, nature, post, t.now()]);
    await audit.log(t, a, 'account.seed', 'company', cid, { count: STARTER.length }, cid); return STARTER.length;
  });
}

export async function createAccount(db: Db, a: Actor, cid: number, parentId: number | null, code: string, name: string, postable: boolean): Promise<number> {
  await gate.require_(db, a, 'accounting.manage'); await company(db, a, cid);
  code = digits(code.trim()); name = name.trim();
  if (!/^\d{1,20}$/.test(code)) throw new Invalid('کد حساب باید فقط عدد باشد (حداکثر ۲۰ رقم).');
  if (len(name) < 2 || len(name) > 160) throw new Invalid('نام حساب باید بین ۲ تا ۱۶۰ کاراکتر باشد.');
  let nature = 'debit';
  if (parentId) {
    const par = await db.one('SELECT * FROM accounts WHERE id = ? AND company_id = ?', [parentId, cid]);
    if (!par) throw new Invalid('حساب والد نامعتبر است.');
    if (par.is_postable) throw new Invalid('زیر حساب قابل‌ثبت نمی‌تواند والد حساب دیگر باشد.');
    if (!code.startsWith(par.code)) throw new Invalid('کد حساب باید با کد والد شروع شود.');
    nature = par.nature;
  }
  if (await db.val('SELECT 1 FROM accounts WHERE company_id = ? AND code = ?', [cid, code])) throw new Invalid('این کد حساب قبلاً ثبت شده است.');
  const id = await db.insert('INSERT INTO accounts (company_id,parent_id,code,name,nature,is_postable,created_at) VALUES (?,?,?,?,?,?,?)', [cid, parentId || null, code, name, nature, postable ? 1 : 0, db.now()]);
  await audit.log(db, a, 'account.create', 'account', id, { code }, cid); return id;
}

export async function createPeriod(db: Db, a: Actor, cid: number, title: string, startJ: string, endJ: string): Promise<number> {
  await gate.require_(db, a, 'accounting.manage'); await company(db, a, cid);
  const s = J.parse(startJ), e = J.parse(endJ); title = title.trim();
  if (!s || !e) throw new Invalid('تاریخ شروع/پایان معتبر نیست (قالب: ۱۴۰۵/۰۱/۰۱).');
  if (s >= e) throw new Invalid('تاریخ پایان باید بعد از شروع باشد.');
  if (len(title) < 2) throw new Invalid('عنوان دوره را وارد کنید.');
  if (await db.val('SELECT 1 FROM fiscal_periods WHERE company_id = ? AND starts_on <= ? AND ends_on >= ?', [cid, e, s])) throw new Invalid('این بازه با یک دوره مالی دیگر هم‌پوشانی دارد.');
  const id = await db.insert('INSERT INTO fiscal_periods (company_id,title,starts_on,ends_on,created_at) VALUES (?,?,?,?,?)', [cid, title, s, e, db.now()]);
  await audit.log(db, a, 'period.create', 'period', id, {}, cid); return id;
}


/** Validates voucher lines (shared by create and edit): integer Rials, one side per row, postable active accounts of THIS company, balanced. */
async function normalizeLines(db: Db, cid: number, lines: Line[]) {
  const clean: [number, number, number, string | null][] = []; let sumD = 0, sumC = 0;
  for (const l of lines) {
    if ((l.debit ?? null) === null && (l.credit ?? null) === null) continue;      // empty row
    const d = Number(l.debit ?? 0), c = Number(l.credit ?? 0);
    if (!Number.isInteger(d) || !Number.isInteger(c) || d < 0 || c < 0 || (d > 0) === (c > 0)) throw new Invalid('هر ردیف باید دقیقاً یکی از «بدهکار» یا «بستانکار» را با مبلغ مثبت داشته باشد.');
    const acc = await db.one('SELECT is_postable, status FROM accounts WHERE id = ? AND company_id = ?', [Number(l.account_id), cid]);
    if (!acc) throw new Invalid('حساب انتخاب‌شده نامعتبر است.');
    if (!acc.is_postable || acc.status !== 'active') throw new Invalid('فقط حساب‌های فعال و قابل‌ثبت (معین) در سند قابل استفاده‌اند.');
    clean.push([Number(l.account_id), d, c, (l.description ?? '').trim().slice(0, 300) || null]); sumD += d; sumC += c;
  }
  if (clean.length < 2) throw new Invalid('سند حداقل دو ردیف دارد.');
  if (sumD !== sumC) throw new Invalid(`سند تراز نیست: جمع بدهکار ${money(sumD)} با جمع بستانکار ${money(sumC)} برابر نیست.`);
  return { clean, sumD, sumC };
}

export async function createVoucher(db: Db, a: Actor, cid: number, dateJ: string, description: string, lines: Line[], kind = 'normal', reverses: number | null = null): Promise<number> {
  await gate.require_(db, a, 'accounting.entry'); await company(db, a, cid);
  const date = J.parse(dateJ); description = description.trim();
  if (!date) throw new Invalid('تاریخ سند معتبر نیست (قالب: ۱۴۰۵/۰۸/۱۶).');
  if (len(description) < 3 || len(description) > 400) throw new Invalid('شرح سند باید بین ۳ تا ۴۰۰ کاراکتر باشد.');
  const period = await db.one('SELECT * FROM fiscal_periods WHERE company_id = ? AND starts_on <= ? AND ends_on >= ?', [cid, date, date]);
  if (!period) throw new Invalid('برای این تاریخ دوره مالی تعریف نشده است.');
  if (period.status !== 'open') throw new Invalid('دوره مالی بسته است.');
  const { clean, sumD } = await normalizeLines(db, cid, lines);
  return db.tx(async t => {
    const id = await t.insert('INSERT INTO vouchers (company_id,period_id,voucher_date,description,kind,reverses_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [cid, period.id, date, description, kind, reverses, a.id, t.now()]);
    for (const [i, [acc, d, c, desc]] of clean.entries()) await t.exec('INSERT INTO voucher_items (voucher_id,line_no,account_id,debit,credit,description) VALUES (?,?,?,?,?,?)', [id, i + 1, acc, d, c, desc]);
    await audit.log(t, a, 'voucher.create', 'voucher', id, { total: sumD, lines: clean.length }, cid); return id;
  });
}

export async function find(db: Db, a: Actor, id: number): Promise<Row> {
  await gate.require_(db, a, 'accounting.view');
  const v = await db.one('SELECT v.*, p.title AS period_title FROM vouchers v JOIN fiscal_periods p ON p.id = v.period_id WHERE v.id = ?', [id]);
  if (!v) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  gate.assertCompany(a, Number(v.company_id)); return v;
}
export const items = (db: Db, voucherId: number): Promise<Row[]> => db.all('SELECT i.*, a.code, a.name FROM voucher_items i JOIN accounts a ON a.id = i.account_id WHERE i.voucher_id = ? ORDER BY i.line_no', [voucherId]);

export async function deleteDraft(db: Db, a: Actor, id: number): Promise<void> {
  await gate.require_(db, a, 'accounting.entry'); const v = await find(db, a, id);
  if (v.status !== 'draft') throw new Invalid('فقط سند پیش‌نویس قابل حذف است.');
  await db.tx(async t => { await t.exec('DELETE FROM voucher_items WHERE voucher_id = ?', [v.id]); await t.exec('DELETE FROM vouchers WHERE id = ?', [v.id]); await audit.log(t, a, 'voucher.delete_draft', 'voucher', Number(v.id), {}, Number(v.company_id)); });
}

/** Maker != checker. A row lock on the period serialises numbering. */
export async function finalize(db: Db, a: Actor, id: number): Promise<number> {
  await gate.require_(db, a, 'accounting.finalize'); const v = await find(db, a, id);
  if (v.status !== 'draft') throw new Invalid('این سند قبلاً قطعی شده است.');
  if (Number(v.created_by) === Number(a.id) && env('ACCOUNTING_ALLOW_SELF_FINALIZE', '0') !== '1') throw new Invalid('قطعی‌کردن سند توسط ثبت‌کننده‌اش مجاز نیست (تفکیک وظایف).');
  return db.tx(async t => {
    const p = await t.one('SELECT status FROM fiscal_periods WHERE id = ? FOR UPDATE', [v.period_id]);
    if (p!.status !== 'open') throw new Invalid('دوره مالی بسته است.');
    const tot = await t.one('SELECT SUM(debit) AS d, SUM(credit) AS c FROM voucher_items WHERE voucher_id = ?', [v.id]);
    if (Number(tot!.d) !== Number(tot!.c) || Number(tot!.d) <= 0) throw new Invalid('سند تراز نیست.');
    const no = 1 + Number(await t.val('SELECT COALESCE(MAX(voucher_no), 0) FROM vouchers WHERE company_id = ? AND period_id = ?', [v.company_id, v.period_id]));
    await t.exec("UPDATE vouchers SET status = 'final', voucher_no = ?, finalized_by = ?, finalized_at = ? WHERE id = ? AND status = 'draft'", [no, a.id, t.now(), v.id]);
    await audit.log(t, a, 'voucher.finalize', 'voucher', Number(v.id), { no }, Number(v.company_id)); return no;
  });
}

/** Correct a final voucher by creating a mirrored draft (it still has to be finalised by a different person). */
export async function reverse(db: Db, a: Actor, id: number, dateJ: string): Promise<number> {
  await gate.require_(db, a, 'accounting.entry'); const v = await find(db, a, id);
  if (v.status !== 'final') throw new Invalid('فقط سند قطعی قابل برگشت است.');
  if (v.kind === 'adjusting') throw new Invalid('سند برگشتی را نمی‌توان دوباره برگشت زد.');
  if (await db.val('SELECT 1 FROM vouchers WHERE reverses_id = ?', [id])) throw new Invalid('برای این سند قبلاً سند برگشتی صادر شده است.');
  const lines: Line[] = (await items(db, id)).map(i => ({ account_id: Number(i.account_id), debit: Number(i.credit), credit: Number(i.debit), description: i.description }));
  return createVoucher(db, a, Number(v.company_id), dateJ, `برگشت سند شماره ${v.voucher_no} – ${v.description}`, lines, 'adjusting', id);
}

export async function closePeriod(db: Db, a: Actor, periodId: number): Promise<void> {
  await gate.require_(db, a, 'accounting.manage');
  const p = await db.one('SELECT * FROM fiscal_periods WHERE id = ?', [periodId]);
  if (!p) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  gate.assertCompany(a, Number(p.company_id));
  if (p.status !== 'open') throw new Invalid('دوره قبلاً بسته شده است.');
  if (await db.val("SELECT 1 FROM vouchers WHERE period_id = ? AND status = 'draft'", [periodId])) throw new Invalid('در این دوره هنوز سند پیش‌نویس وجود دارد.');
  await db.exec("UPDATE fiscal_periods SET status = 'closed' WHERE id = ?", [periodId]);
  await audit.log(db, a, 'period.close', 'period', periodId, {}, Number(p.company_id));
}

/** Trial balance over FINAL vouchers with roll-up to parents. Totals must always be equal. */
export async function trialBalance(db: Db, a: Actor, cid: number, periodId: number) {
  await gate.require_(db, a, 'accounting.view'); await company(db, a, cid);
  if (!(await db.val('SELECT 1 FROM fiscal_periods WHERE id = ? AND company_id = ?', [periodId, cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  const rows = await db.all(`SELECT a.id, a.parent_id, a.code, a.name, a.is_postable, COALESCE(SUM(i.debit),0) AS debit, COALESCE(SUM(i.credit),0) AS credit
    FROM accounts a LEFT JOIN voucher_items i ON i.account_id = a.id AND i.voucher_id IN (SELECT id FROM vouchers WHERE period_id = ? AND status = 'final')
    WHERE a.company_id = ? GROUP BY a.id, a.parent_id, a.code, a.name, a.is_postable ORDER BY a.code`, [periodId, cid]);
  const by = new Map<number, Row>(); for (const r of rows) by.set(Number(r.id), { ...r, id: Number(r.id), parent_id: r.parent_id === null ? null : Number(r.parent_id), debit: Number(r.debit), credit: Number(r.credit) });
  for (const r of by.values()) if (r.is_postable) for (let p = r.parent_id; p; p = by.get(p)!.parent_id) { by.get(p)!.debit += r.debit; by.get(p)!.credit += r.credit; }
  let td = 0, tc = 0;
  for (const r of by.values()) { r.balance_debit = Math.max(0, r.debit - r.credit); r.balance_credit = Math.max(0, r.credit - r.debit); if (r.is_postable) { td += r.debit; tc += r.credit; } }
  return { rows: [...by.values()], total_debit: td, total_credit: tc, balanced: td === tc };
}

export async function ledger(db: Db, a: Actor, accountId: number, periodId: number) {
  await gate.require_(db, a, 'accounting.view');
  const acc = await db.one('SELECT * FROM accounts WHERE id = ?', [accountId]);
  if (!acc) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  gate.assertCompany(a, Number(acc.company_id));
  const rows = await db.all(`SELECT v.id AS voucher_id, v.voucher_no, v.voucher_date, v.description, i.debit, i.credit FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id
    WHERE i.account_id = ? AND v.period_id = ? AND v.status = 'final' ORDER BY v.voucher_date, v.voucher_no, i.line_no`, [accountId, periodId]);
  let bal = 0; for (const r of rows) { bal += (acc.nature === 'debit' ? 1 : -1) * (Number(r.debit) - Number(r.credit)); r.balance = bal; }
  return { account: acc, rows, balance: bal };
}

// ───────────────────────── editing and status changes ─────────────────────────
export const ACCOUNT_STATUS: Record<string, string> = { active: 'فعال', inactive: 'غیرفعال' };
export async function getAccount(db: Db, a: Actor, id: number): Promise<Row> {
  await gate.require_(db, a, 'accounting.view'); const r = await db.one('SELECT * FROM accounts WHERE id = ?', [id]);
  if (!r) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(r.company_id)); return r;
}
/** The code never changes (it identifies the account in history); name can. */
export async function editAccount(db: Db, a: Actor, id: number, name: string, version?: string): Promise<void> {
  await gate.require_(db, a, 'accounting.manage'); const r = await getAccount(db, a, id); ch.assertVersion(r, version); name = name.trim();
  if (len(name) < 2 || len(name) > 160) throw new Invalid('نام حساب باید بین ۲ تا ۱۶۰ کاراکتر باشد.');
  const changes = ch.diff(r, { name }); if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => { await t.exec('UPDATE accounts SET name = ?, updated_at = ? WHERE id = ?', [name, t.now(), id]); await ch.record(t, a, Number(r.company_id), 'account', id, changes); });
}
/** Deactivation is refused while the account has a balance, open drafts, or active children; reactivation needs an active parent. */
export async function setAccountStatus(db: Db, a: Actor, id: number, status: string, note: string): Promise<void> {
  await gate.require_(db, a, 'accounting.manage'); const r = await getAccount(db, a, id);
  if (!ACCOUNT_STATUS[status]) throw new Invalid('وضعیت نامعتبر است.'); if (r.status === status) throw new Invalid('حساب از قبل در این وضعیت است.'); note = ch.requireNote(note);
  if (status === 'inactive') {
    const bal = await db.one("SELECT COALESCE(SUM(i.debit),0) AS d, COALESCE(SUM(i.credit),0) AS c FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id WHERE i.account_id = ? AND v.status = 'final'", [id]);
    if (Number(bal!.d) !== Number(bal!.c)) throw new Invalid('حساب دارای مانده است؛ ابتدا با سند اصلاحی مانده را صفر کنید.');
    if (await db.val("SELECT 1 FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id WHERE i.account_id = ? AND v.status = 'draft' LIMIT 1", [id])) throw new Invalid('این حساب در سند پیش‌نویس استفاده شده است.');
    if (await db.val("SELECT 1 FROM accounts WHERE parent_id = ? AND status = 'active' LIMIT 1", [id])) throw new Invalid('ابتدا زیرحساب‌های فعال را غیرفعال کنید.');
  } else if (r.parent_id && (await db.val('SELECT status FROM accounts WHERE id = ?', [r.parent_id])) !== 'active') throw new Invalid('حساب والد غیرفعال است.');
  await db.tx(async t => { await t.exec('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?', [status, t.now(), id]); await ch.record(t, a, Number(r.company_id), 'account', id, { status: [r.status, status] }, note); });
}
export async function reopenPeriod(db: Db, a: Actor, periodId: number, note: string): Promise<void> {
  await gate.require_(db, a, 'accounting.manage'); const p = await db.one('SELECT * FROM fiscal_periods WHERE id = ?', [periodId]);
  if (!p) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(p.company_id)); if (p.status !== 'closed') throw new Invalid('دوره باز است.'); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec("UPDATE fiscal_periods SET status = 'open' WHERE id = ?", [periodId]); await ch.record(t, a, Number(p.company_id), 'period', periodId, { status: ['closed', 'open'] }, note); });
}
/** Token of a draft's content: any change by someone else makes a stale edit form fail instead of overwriting. */
export async function voucherVersion(db: Db, id: number): Promise<string> {
  const v = await db.one('SELECT description, voucher_date FROM vouchers WHERE id = ?', [id]); const it = await db.all('SELECT account_id, debit, credit, description FROM voucher_items WHERE voucher_id = ? ORDER BY line_no', [id]);
  return sha256(JSON.stringify([v, it])).slice(0, 24);
}
/** Draft vouchers are fully editable by their maker (or an accounting manager) until finalised; every edit is recorded with before/after totals. */
export async function updateDraft(db: Db, a: Actor, id: number, dateJ: string, description: string, lines: Line[], version?: string): Promise<void> {
  if (!(await gate.can(db, a, 'accounting.entry')) && !(await gate.can(db, a, 'accounting.manage'))) await gate.require_(db, a, 'accounting.entry'); const v = await find(db, a, id);
  if (v.status !== 'draft') throw new Invalid('فقط سند پیش‌نویس قابل ویرایش است؛ سند قطعی با سند برگشتی اصلاح می‌شود.');
  if (Number(v.created_by) !== Number(a.id) && !(await gate.can(db, a, 'accounting.manage'))) throw new Invalid('فقط ثبت‌کننده سند (یا مدیر مالی) می‌تواند پیش‌نویس را ویرایش کند.');
  if (version && version !== (await voucherVersion(db, id))) throw new Invalid('این سند پس از باز شدن صفحه تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.');
  const cid = Number(v.company_id), date = J.parse(dateJ); description = description.trim();
  if (!date) throw new Invalid('تاریخ سند معتبر نیست (قالب: ۱۴۰۵/۰۸/۱۶).'); if (len(description) < 3 || len(description) > 400) throw new Invalid('شرح سند باید بین ۳ تا ۴۰۰ کاراکتر باشد.');
  const period = await db.one('SELECT * FROM fiscal_periods WHERE company_id = ? AND starts_on <= ? AND ends_on >= ?', [cid, date, date]);
  if (!period) throw new Invalid('برای این تاریخ دوره مالی تعریف نشده است.'); if (period.status !== 'open') throw new Invalid('دوره مالی بسته است.');
  const { clean, sumD } = await normalizeLines(db, cid, lines);
  const before = await db.one('SELECT COALESCE(SUM(debit),0) AS t, COUNT(*) AS n FROM voucher_items WHERE voucher_id = ?', [id]);
  await db.tx(async t => {
    await t.exec('DELETE FROM voucher_items WHERE voucher_id = ?', [id]);
    for (const [i, [acc2, d, c, desc]] of clean.entries()) await t.exec('INSERT INTO voucher_items (voucher_id,line_no,account_id,debit,credit,description) VALUES (?,?,?,?,?,?)', [id, i + 1, acc2, d, c, desc]);
    await t.exec('UPDATE vouchers SET voucher_date = ?, period_id = ?, description = ? WHERE id = ? AND status = ?', [date, period.id, description, id, 'draft']);
    await ch.record(t, a, cid, 'voucher', id, { ...ch.diff(v, { description, voucher_date: date }), ...(Number(before!.t) !== sumD ? { total: [Number(before!.t), sumD] } : {}), ...(Number(before!.n) !== clean.length ? { lines: [Number(before!.n), clean.length] } : {}), edited: [null, 'ردیف‌ها بازنویسی شد'] });
  });
}
