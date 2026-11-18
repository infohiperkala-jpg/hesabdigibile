import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as J from '../core/jalali.js';
import { money } from '../core/validator.js';
import { sha256 } from '../core/crypto.js';
import { env } from '../core/env.js';
import * as ch from '../core/changes.js';

/** Credit / instalment engine. Integer Rials + basis points only. No default rates exist: finance must enter official terms per plan. */
export const STATUS: Record<string, string> = { draft: 'پیش‌نویس', submitted: 'ثبت‌شده', docs_required: 'نیازمند تکمیل مدارک', under_review: 'در حال بررسی', approved: 'تأییدشده', rejected: 'ردشده', contracted: 'قرارداد امضاشده', active: 'فعال (در حال اقساط)', completed: 'تسویه‌شده', cancelled: 'لغوشده' };
/** from => to => capability. contracted/active/completed are reached only via signContract / activate / recordPayment. */
const FLOW: Record<string, Record<string, string>> = {
  draft: { submitted: 'entry', cancelled: 'entry' }, submitted: { docs_required: 'review', under_review: 'review', rejected: 'review', cancelled: 'entry' },
  docs_required: { submitted: 'entry', rejected: 'review', cancelled: 'entry' }, under_review: { approved: 'review', docs_required: 'review', rejected: 'review' },
  approved: { cancelled: 'entry' }, contracted: { cancelled: 'entry' },
};
const NOTE_REQUIRED = ['docs_required', 'rejected', 'approved', 'cancelled'];   // every cancellation is explained
const ts = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const len = (s: string) => [...s].length;

async function company(db: Db, a: Actor, cid: number) {
  gate.assertCompany(a, cid);
  if (!(await db.val('SELECT 1 FROM companies WHERE id = ?', [cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
}
export interface PlanInput { name: string; min_amount: number; max_amount: number; min_down_bp: number; max_down_bp: number; quote_ttl_min: number; grace_days: number; late_fee_bp_day: number; settlement_work_days: number }
export interface Term { installments: number; monthly_fee_bp: number; upfront_fee_bp: number }

function checkPlan(p: PlanInput, terms: Term[]): string {
  const name = (p.name ?? '').trim();
  if (len(name) < 2 || len(name) > 160) throw new Invalid('نام طرح باید بین ۲ تا ۱۶۰ کاراکتر باشد.');
  if (!(p.min_amount >= 1) || p.max_amount < p.min_amount || p.max_amount > 1_000_000_000_000) throw new Invalid('حداقل/حداکثر مبلغ طرح نامعتبر است.');
  if (p.min_down_bp < 0 || p.max_down_bp > 10000 || p.min_down_bp > p.max_down_bp) throw new Invalid('محدوده پیش‌پرداخت (۰ تا ۱۰۰ درصد) نامعتبر است.');
  if (p.quote_ttl_min < 5 || p.quote_ttl_min > 1440) throw new Invalid('مدت اعتبار پیش‌فاکتور باید بین ۵ تا ۱۴۴۰ دقیقه باشد.');
  if (p.grace_days < 0 || p.grace_days > 90 || p.late_fee_bp_day < 0 || p.late_fee_bp_day > 100 || p.settlement_work_days < 0 || p.settlement_work_days > 60) throw new Invalid('مهلت، جریمه یا مدت تسویه خارج از محدوده مجاز است.');
  if (!terms.length || terms.length > 24) throw new Invalid('حداقل یک و حداکثر ۲۴ گزینه تعداد اقساط تعریف کنید.');
  const seen = new Set<number>();
  for (const t of terms) { if (t.installments < 1 || t.installments > 60 || seen.has(t.installments) || t.monthly_fee_bp < 0 || t.monthly_fee_bp > 2000 || t.upfront_fee_bp < 0 || t.upfront_fee_bp > 2000) throw new Invalid('گزینه اقساط نامعتبر یا تکراری است.'); seen.add(t.installments); }
  return name;
}

export async function createPlan(db: Db, a: Actor, cid: number, p: PlanInput, terms: Term[]): Promise<number> {
  await gate.require_(db, a, 'credit.manage'); await company(db, a, cid);
  const name = checkPlan(p, terms);
  return db.tx(async tx => {
    const id = await tx.insert('INSERT INTO credit_plans (company_id,name,min_amount,max_amount,min_down_bp,max_down_bp,quote_ttl_min,grace_days,late_fee_bp_day,settlement_work_days,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [cid, name, p.min_amount, p.max_amount, p.min_down_bp, p.max_down_bp, p.quote_ttl_min, p.grace_days, p.late_fee_bp_day, p.settlement_work_days, tx.now()]);
    for (const t of terms) await tx.exec('INSERT INTO credit_plan_terms (plan_id,installments,monthly_fee_bp,upfront_fee_bp) VALUES (?,?,?,?)', [id, t.installments, t.monthly_fee_bp, t.upfront_fee_bp]);
    await audit.log(tx, a, 'credit.plan_create', 'plan', id, { terms: terms.length }, cid); return id;
  });
}

/** Pure, deterministic: fee = floor(financed*upfront/1e4) + floor(financed*monthly*count/1e4); the division remainder lands on the LAST instalment. */
export function compute(amount: number, down: number, count: number, monthlyBp: number, upfrontBp: number) {
  const financed = amount - down, fee = Math.floor(financed * upfrontBp / 10000) + Math.floor(financed * monthlyBp * count / 10000), total = financed + fee, each = Math.floor(total / count);
  return { financed, fee_total: fee, total_repayment: total, installment_amount: each, last_installment_amount: total - each * (count - 1) };
}

export async function quote(db: Db, a: Actor, cid: number, planId: number, amount: number, down: number, count: number) {
  await gate.require_(db, a, 'credit.entry'); await company(db, a, cid);
  const plan = await db.one('SELECT * FROM credit_plans WHERE id = ? AND company_id = ?', [planId, cid]);
  if (!plan || plan.status !== 'active') throw new Invalid('طرح انتخاب‌شده فعال نیست.');
  if (amount < Number(plan.min_amount) || amount > Number(plan.max_amount)) throw new Invalid(`مبلغ خارج از محدوده مجاز طرح است (${money(plan.min_amount)} تا ${money(plan.max_amount)} ریال).`);
  if (!Number.isInteger(down) || down < 0 || down >= amount) throw new Invalid('پیش‌پرداخت نامعتبر است.');
  const bp = Math.floor(down * 10000 / amount);
  if (bp < Number(plan.min_down_bp) || bp > Number(plan.max_down_bp)) throw new Invalid('پیش‌پرداخت خارج از محدوده مجاز طرح است.');
  const term = await db.one('SELECT * FROM credit_plan_terms WHERE plan_id = ? AND installments = ?', [planId, count]);
  if (!term) throw new Invalid('تعداد اقساط در این طرح تعریف نشده است.');
  const r = compute(amount, down, count, Number(term.monthly_fee_bp), Number(term.upfront_fee_bp)), exp = ts(Date.now() + Number(plan.quote_ttl_min) * 60000);
  const id = await db.insert('INSERT INTO credit_quotes (company_id,plan_id,amount,down_payment,financed,installments,fee_total,total_repayment,installment_amount,last_installment_amount,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [cid, planId, amount, down, r.financed, count, r.fee_total, r.total_repayment, r.installment_amount, r.last_installment_amount, exp, a.id, db.now()]);
  return { quote_id: id, expires_at: exp, amount, down_payment: down, installments: count, ...r };
}

export async function get(db: Db, a: Actor, id: number): Promise<Row> {
  await gate.require_(db, a, 'credit.view');
  const r = await db.one(`SELECT ap.*, q.amount, q.down_payment, q.financed, q.installments AS inst_count, q.fee_total, q.total_repayment, q.installment_amount, q.last_installment_amount, q.plan_id, p.first_name, p.last_name, p.folder_no
    FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id JOIN (SELECT ip.id, ip.first_name, ip.last_name, f.folder_no FROM identity_profiles ip JOIN digital_folders f ON f.profile_id = ip.id) p ON p.id = ap.profile_id WHERE ap.id = ?`, [id]);
  if (!r) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  gate.assertCompany(a, Number(r.company_id)); return r;
}

async function setStatus(t: Db, a: Actor, ap: Row, from: string | null, to: string, note = '') {
  await t.exec('INSERT INTO credit_status_history (company_id,application_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?,?)', [ap.company_id, ap.id, from, to, a.id, note || null, t.now()]);
  await t.exec('UPDATE credit_applications SET status = ?, updated_at = ? WHERE id = ?', [to, t.now(), ap.id]);
  await audit.log(t, a, 'credit.status', 'application', Number(ap.id), { from, to }, Number(ap.company_id));
}

export async function createApplication(db: Db, a: Actor, quoteId: number, profileId: number): Promise<number> {
  await gate.require_(db, a, 'credit.entry');
  const q = await db.one('SELECT * FROM credit_quotes WHERE id = ?', [quoteId]);
  if (!q) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  gate.assertCompany(a, Number(q.company_id));
  const p = await db.one('SELECT id, company_id, status FROM identity_profiles WHERE id = ?', [profileId]);
  if (!p || Number(p.company_id) !== Number(q.company_id)) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  if (q.expires_at < db.now()) throw new Invalid('پیش‌فاکتور منقضی شده است؛ پیش‌فاکتور جدید بگیرید.');
  if (await db.val('SELECT 1 FROM credit_applications WHERE quote_id = ?', [quoteId])) throw new Invalid('برای این پیش‌فاکتور قبلاً درخواست ثبت شده است.');
  if (p.status !== 'approved_final') throw new Invalid('پرونده هویتی متقاضی باید «تأیید نهایی» شده باشد.');
  return db.tx(async t => {
    const now = t.now(), id = await t.insert('INSERT INTO credit_applications (company_id,profile_id,quote_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)', [q.company_id, profileId, q.id, a.id, now, now]);
    await t.exec('INSERT INTO credit_status_history (company_id,application_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?,?)', [q.company_id, id, null, 'draft', a.id, 'ایجاد درخواست', now]);
    await audit.log(t, a, 'credit.application_create', 'application', id, {}, Number(q.company_id)); return id;
  });
}

export async function transition(db: Db, a: Actor, id: number, to: string, note = ''): Promise<void> {
  const ap = await get(db, a, id), cap = FLOW[ap.status]?.[to];
  if (!cap) throw new Invalid('این تغییر وضعیت مجاز نیست.');
  await gate.require_(db, a, `credit.${cap}`); note = note.trim();
  if (NOTE_REQUIRED.includes(to) && len(note) < 5) throw new Invalid('برای این وضعیت، ثبت توضیح (حداقل ۵ کاراکتر) الزامی است.');
  if (to === 'approved' && Number(ap.created_by) === Number(a.id) && env('CREDIT_ALLOW_SELF_APPROVE', '0') !== '1') throw new Invalid('تأیید درخواست توسط ثبت‌کننده‌اش مجاز نیست (تفکیک وظایف).');
  await db.tx(t => setStatus(t, a, ap, ap.status, to, note));
}

/** Freezes the exact financial terms with a SHA-256. A RECORD of consent, not a legal e-signature service. */
export async function signContract(db: Db, a: Actor, id: number, note: string): Promise<number> {
  await gate.require_(db, a, 'credit.entry'); const ap = await get(db, a, id);
  if (ap.status !== 'approved') throw new Invalid('فقط درخواست تأییدشده قابل صدور قرارداد است.');
  if (len(note.trim()) < 5) throw new Invalid('نحوه/مستند امضا را ثبت کنید (حداقل ۵ کاراکتر).');
  const terms = JSON.stringify([ap.amount, ap.down_payment, ap.financed, ap.inst_count, ap.fee_total, ap.total_repayment, ap.installment_amount, ap.last_installment_amount, ap.profile_id].map(Number));
  return db.tx(async t => {
    const cid = await t.insert('INSERT INTO credit_contracts (company_id,application_id,terms_hash,status,signed_at,signed_note,recorded_by,created_at) VALUES (?,?,?,?,?,?,?,?)', [ap.company_id, ap.id, sha256(terms), 'signed', t.now(), note.trim().slice(0, 300), a.id, t.now()]);
    await setStatus(t, a, ap, 'approved', 'contracted', 'قرارداد ثبت شد'); return cid;
  });
}

/** Generates the instalment schedule (Jalali monthly dues) and the expected merchant settlement date. */
export async function activate(db: Db, a: Actor, id: number, contractDateJ: string): Promise<number> {
  await gate.require_(db, a, 'credit.entry'); const ap = await get(db, a, id);
  if (ap.status !== 'contracted') throw new Invalid('فقط درخواست دارای قرارداد امضاشده قابل فعال‌سازی است.');
  const d0 = J.parse(contractDateJ); if (!d0) throw new Invalid('تاریخ نامعتبر است (قالب: ۱۴۰۵/۰۸/۱۶).');
  const plan = (await db.one('SELECT grace_days, settlement_work_days FROM credit_plans WHERE id = ?', [ap.plan_id]))!;
  const first = new Date(new Date(d0 + 'T00:00:00Z').getTime() + Number(plan.grace_days) * 86400000).toISOString().slice(0, 10), n = Number(ap.inst_count);
  return db.tx(async t => {
    for (let i = 1; i <= n; i++) await t.exec('INSERT INTO installments (company_id,application_id,seq,due_date,amount) VALUES (?,?,?,?,?)', [ap.company_id, ap.id, i, J.addMonths(first, i - 1), i === n ? ap.last_installment_amount : ap.installment_amount]);
    await t.exec('UPDATE credit_applications SET settlement_expected_on = ? WHERE id = ?', [J.addWorkingDays(d0, Number(plan.settlement_work_days)), ap.id]);
    await setStatus(t, a, ap, 'contracted', 'active', 'فعال‌سازی و تولید جدول اقساط'); return n;
  });
}

export const installments = (db: Db, appId: number): Promise<Row[]> => db.all('SELECT * FROM installments WHERE application_id = ? ORDER BY seq', [appId]);

/** Idempotent by reference. Allocates to the oldest unpaid instalments first; partial payments allowed; overpayment rejected. */
export async function recordPayment(db: Db, a: Actor, id: number, amount: number, reference: string): Promise<{ payment_id: number; duplicate: boolean; completed?: boolean }> {
  await gate.require_(db, a, 'credit.payment'); const ap = await get(db, a, id); reference = reference.trim();
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(reference)) throw new Invalid('شناسه پیگیری پرداخت باید ۶ تا ۸۰ حرف/عدد انگلیسی باشد.');
  if (!Number.isInteger(amount) || amount < 1) throw new Invalid('مبلغ پرداخت نامعتبر است.');
  const dup = await db.one('SELECT * FROM credit_payments WHERE company_id = ? AND reference = ?', [ap.company_id, reference]);
  if (dup) { if (Number(dup.application_id) === id && Number(dup.amount) === amount) return { payment_id: Number(dup.id), duplicate: true }; throw new Invalid('این شناسه پیگیری قبلاً برای پرداخت دیگری ثبت شده است.'); }
  if (ap.status !== 'active') throw new Invalid('پرداخت فقط برای درخواست فعال ثبت می‌شود.');
  return db.tx(async t => {
    const rows = await t.all("SELECT * FROM installments WHERE application_id = ? AND status <> 'paid' ORDER BY seq FOR UPDATE", [ap.id]);
    const due = rows.reduce((s, r) => s + Number(r.amount) - Number(r.paid_amount), 0);
    if (amount > due) throw new Invalid(`مبلغ پرداخت از مانده اقساط (${money(due)} ریال) بیشتر است.`);
    const pid = await t.insert('INSERT INTO credit_payments (company_id,application_id,amount,reference,created_by,created_at) VALUES (?,?,?,?,?,?)', [ap.company_id, ap.id, amount, reference, a.id, t.now()]);
    let left = amount;
    for (const r of rows) {
      if (left <= 0) break;
      const need = Number(r.amount) - Number(r.paid_amount), take = Math.min(need, left); left -= take;
      await t.exec('UPDATE installments SET paid_amount = paid_amount + ?, status = ?, paid_at = ? WHERE id = ?', [take, take === need ? 'paid' : 'partial', take === need ? t.now() : null, r.id]);
    }
    const done = !(await t.val("SELECT 1 FROM installments WHERE application_id = ? AND status <> 'paid'", [ap.id]));
    await audit.log(t, a, 'credit.payment', 'application', Number(ap.id), { payment_id: pid, amount }, Number(ap.company_id));
    if (done) await setStatus(t, a, ap, 'active', 'completed', 'همه اقساط پرداخت شد');
    return { payment_id: pid, duplicate: false, completed: done };
  });
}

export const markOverdue = (db: Db, cid: number | null, todayIso: string): Promise<number> =>
  db.exec(`UPDATE installments SET status = 'overdue' WHERE status IN ('pending','partial') AND due_date < ?${cid ? ' AND company_id = ?' : ''}`, cid ? [todayIso, cid] : [todayIso]);

/** Informational late fee (not booked automatically): unpaid * late_bp_per_day * days_late / 1e4. */
export function lateFee(inst: Row, lateBpDay: number, todayIso: string): number {
  const days = Math.floor((new Date(todayIso + 'T00:00:00Z').getTime() - new Date(inst.due_date + 'T00:00:00Z').getTime()) / 86400000);
  return days > 0 && inst.status !== 'paid' ? Math.floor((Number(inst.amount) - Number(inst.paid_amount)) * lateBpDay * days / 10000) : 0;
}
export const history = (db: Db, id: number): Promise<Row[]> => db.all('SELECT h.*, u.name AS uname FROM credit_status_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.application_id = ? ORDER BY h.id DESC', [id]);
export async function allowed(db: Db, a: Actor, ap: Row): Promise<Record<string, string>> {
  const o: Record<string, string> = {}; for (const [to, cap] of Object.entries(FLOW[ap.status] ?? {})) if (await gate.can(db, a, `credit.${cap}`)) o[to] = STATUS[to]; return o;
}

// ───────────────────────── plan editing and status ─────────────────────────
export const PLAN_STATUS: Record<string, string> = { active: 'فعال', archived: 'بایگانی‌شده' };
export async function getPlan(db: Db, a: Actor, id: number): Promise<Row> {
  await gate.require_(db, a, 'credit.view'); const r = await db.one('SELECT * FROM credit_plans WHERE id = ?', [id]);
  if (!r) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(r.company_id)); return r;
}
/** A plan that already has applications is part of signed financial terms: it cannot be edited, only archived (create a new plan for new terms). */
export async function editPlan(db: Db, a: Actor, id: number, p: PlanInput, terms: Term[], version?: string): Promise<void> {
  await gate.require_(db, a, 'credit.manage'); const cur = await getPlan(db, a, id); ch.assertVersion(cur, version);
  if (await db.val('SELECT 1 FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id WHERE q.plan_id = ? LIMIT 1', [id])) throw new Invalid('برای این طرح درخواست ثبت شده است و شرایط آن قابل ویرایش نیست؛ طرح جدید بسازید و این طرح را بایگانی کنید.');
  const name = checkPlan(p, terms), old = await db.all('SELECT installments, monthly_fee_bp, upfront_fee_bp FROM credit_plan_terms WHERE plan_id = ? ORDER BY installments', [id]);
  const fmtT = (ts: Row[]) => ts.map(t => `${t.installments}:${t.monthly_fee_bp}/${t.upfront_fee_bp}`).sort().join(' ');
  const changes = { ...ch.diff(cur, { name, min_amount: p.min_amount, max_amount: p.max_amount, min_down_bp: p.min_down_bp, max_down_bp: p.max_down_bp, quote_ttl_min: p.quote_ttl_min, grace_days: p.grace_days, late_fee_bp_day: p.late_fee_bp_day, settlement_work_days: p.settlement_work_days }), ...(fmtT(old) !== fmtT(terms as any) ? { terms: [fmtT(old), fmtT(terms as any)] as [unknown, unknown] } : {}) };
  if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => {
    await t.exec('UPDATE credit_plans SET name=?, min_amount=?, max_amount=?, min_down_bp=?, max_down_bp=?, quote_ttl_min=?, grace_days=?, late_fee_bp_day=?, settlement_work_days=?, updated_at=? WHERE id=?', [name, p.min_amount, p.max_amount, p.min_down_bp, p.max_down_bp, p.quote_ttl_min, p.grace_days, p.late_fee_bp_day, p.settlement_work_days, t.now(), id]);
    await t.exec('DELETE FROM credit_plan_terms WHERE plan_id = ?', [id]); for (const x of terms) await t.exec('INSERT INTO credit_plan_terms (plan_id,installments,monthly_fee_bp,upfront_fee_bp) VALUES (?,?,?,?)', [id, x.installments, x.monthly_fee_bp, x.upfront_fee_bp]);
    await ch.record(t, a, Number(cur.company_id), 'plan', id, changes);
  });
}
export async function setPlanStatus(db: Db, a: Actor, id: number, status: string, note: string): Promise<void> {
  await gate.require_(db, a, 'credit.manage'); const cur = await getPlan(db, a, id); if (!PLAN_STATUS[status]) throw new Invalid('وضعیت نامعتبر است.'); if (cur.status === status) throw new Invalid('طرح از قبل در این وضعیت است.'); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec('UPDATE credit_plans SET status = ?, updated_at = ? WHERE id = ?', [status, t.now(), id]); await ch.record(t, a, Number(cur.company_id), 'plan', id, { status: [cur.status, status] }, note); });
}
