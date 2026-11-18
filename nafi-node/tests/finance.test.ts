import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser, makeProfile, rejects } from './helpers.js';
import { Db } from '../src/core/db.js';
import { Actor } from '../src/core/audit.js';
import * as org from '../src/services/org.js';
import * as acc from '../src/services/accounting.js';
import * as credit from '../src/services/credit.js';
import * as posting from '../src/services/posting.js';
import * as J from '../src/core/jalali.js';

let db: Db, drop: () => Promise<void>, owner: Actor, cA: number, cB: number;
let accountant: Actor, fin: Actor, finB: Actor, off: Actor, mgr: Actor, mgrB: Actor, viewerA: Actor, pid: number;
beforeAll(async () => {
  ({ db, drop } = await freshDb()); owner = await makeOwner(db);
  cA = await org.createCompany(db, owner, 'شرکت الف'); cB = await org.createCompany(db, owner, 'شرکت ب');
  accountant = await makeUser(db, owner, 'accountant', 'acc@t.test', cA); fin = await makeUser(db, owner, 'fin_manager', 'fin@t.test', cA); finB = await makeUser(db, owner, 'fin_manager', 'finb@t.test', cB);
  off = await makeUser(db, owner, 'credit_officer', 'off@t.test', cA); mgr = await makeUser(db, owner, 'credit_manager', 'mgr@t.test', cA); mgrB = await makeUser(db, owner, 'credit_manager', 'mgrb@t.test', cB);
  viewerA = await makeUser(db, owner, 'viewer', 'v@t.test', cA); pid = await makeProfile(db, owner, cA, '0499370899');
});
afterAll(async () => { await drop(); });

describe('accounting', () => {
  let per = 0, v1 = 0; const A: Record<string, number> = {};
  const L = (account_id: number, debit: number | null, credit: number | null) => ({ account_id, debit, credit });
  it('chart: manage right only, once, tenant-scoped', async () => {
    await rejects(() => acc.seedStarterChart(db, accountant, cA), 'HttpError', 403);
    expect(await acc.seedStarterChart(db, fin, cA)).toBe(acc.STARTER.length);
    await rejects(() => acc.seedStarterChart(db, fin, cA), 'Invalid'); await rejects(() => acc.seedStarterChart(db, finB, cA), 'HttpError', 404);
    for (const c of ['1101', '1102', '1103', '2101', '4101', '5101', '1', '11']) A[c] = Number(await db.val('SELECT id FROM accounts WHERE company_id = ? AND code = ?', [cA, c]));
  });
  it('account rules: prefix, unique, postable cannot be parent', async () => {
    expect(await acc.createAccount(db, fin, cA, A['11'], '110101', 'صندوق مرکزی', true)).toBeGreaterThan(0);
    await rejects(() => acc.createAccount(db, fin, cA, null, '1101', 'تکراری', true), 'Invalid'); await rejects(() => acc.createAccount(db, fin, cA, A['1101'], '110102', 'زیر قابل‌ثبت', true), 'Invalid');
    await rejects(() => acc.createAccount(db, fin, cA, A['11'], '2999', 'پیشوند غلط', true), 'Invalid');
  });
  it('fiscal period created; overlap rejected', async () => {
    per = await acc.createPeriod(db, fin, cA, 'سال مالی ۱۴۰۵', '1405/01/01', '1405/12/29'); await rejects(() => acc.createPeriod(db, fin, cA, 'هم‌پوشان', '1405/06/01', '1406/01/10'), 'Invalid');
  });
  it('voucher validation: unbalanced, one-sided, group account, single line, no period, foreign account', async () => {
    const d = '1405/08/16';
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'نامتوازن', [L(A['1101'], 1000, null), L(A['4101'], null, 900)]), 'Invalid');
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'یک‌طرفه', [{ account_id: A['1101'], debit: 5, credit: 5 }, L(A['4101'], null, 5)]), 'Invalid');
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'غیرقابل‌ثبت', [L(A['1'], 100, null), L(A['4101'], null, 100)]), 'Invalid');
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'یک ردیف', [L(A['1101'], 100, null)]), 'Invalid');
    await rejects(() => acc.createVoucher(db, accountant, cA, '1409/01/01', 'بدون دوره', [L(A['1101'], 100, null), L(A['4101'], null, 100)]), 'Invalid');
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'اعشار', [L(A['1101'], 10.5, null), L(A['4101'], null, 10.5)]), 'Invalid');
    const foreign = await db.insert('INSERT INTO accounts (company_id,code,name,nature,is_postable,created_at) VALUES (?,?,?,?,?,?)', [cB, '1101', 'بیگانه', 'debit', 1, db.now()]);
    await rejects(() => acc.createVoucher(db, accountant, cA, d, 'حساب شرکت دیگر', [L(foreign, 100, null), L(A['4101'], null, 100)]), 'Invalid');
  });
  it('balanced voucher is a draft; viewer cannot create', async () => {
    v1 = await acc.createVoucher(db, accountant, cA, '1405/08/16', 'فروش نقدی', [L(A['1101'], 5000000, null), L(A['4101'], null, 5000000)]);
    expect((await acc.find(db, accountant, v1)).status).toBe('draft');
    await rejects(() => acc.createVoucher(db, viewerA, cA, '1405/08/16', 'ممنوع', [L(A['1101'], 1, null), L(A['4101'], null, 1)]), 'HttpError', 403);
  });
  it('maker-checker and sequential numbering', async () => {
    await rejects(() => acc.finalize(db, accountant, v1), 'HttpError', 403);
    const mine = await acc.createVoucher(db, owner, cA, '1405/08/17', 'ثبت توسط مالک', [L(A['1102'], 10, null), L(A['4101'], null, 10)]);
    await rejects(() => acc.finalize(db, owner, mine), 'Invalid'); await rejects(() => acc.finalize(db, finB, v1), 'HttpError', 404);
    expect(await acc.finalize(db, fin, v1)).toBe(1); expect(await acc.finalize(db, fin, mine)).toBe(2); await rejects(() => acc.finalize(db, fin, v1), 'Invalid');
  });
  it('final voucher is immutable in the database itself (triggers)', async () => {
    for (const sql of [`UPDATE voucher_items SET debit = 1 WHERE voucher_id = ${v1}`, `DELETE FROM voucher_items WHERE voucher_id = ${v1}`, `UPDATE vouchers SET description = 'x' WHERE id = ${v1}`, `DELETE FROM vouchers WHERE id = ${v1}`, `INSERT INTO voucher_items (voucher_id,line_no,account_id,debit,credit) VALUES (${v1},9,${A['1101']},1,0)`])
      await expect(db.exec(sql)).rejects.toThrow(/immutable/);
  });
  it('trial balance balances and rolls up; ledger running balance', async () => {
    const tb = await acc.trialBalance(db, accountant, cA, per); expect(tb.balanced).toBe(true); expect(tb.total_debit).toBe(5000010);
    const row = (c: string) => tb.rows.find(r => r.code === c)!;
    expect(row('1').debit).toBe(5000010); expect(row('11').balance_debit).toBe(5000010); expect(row('4101').balance_credit).toBe(5000010);
    const lg = await acc.ledger(db, accountant, A['1101'], per); expect(lg.balance).toBe(5000000); expect(lg.rows).toHaveLength(1);
    await acc.createVoucher(db, accountant, cA, '1405/08/18', 'پیش‌نویس بزرگ', [L(A['1101'], 999, null), L(A['4101'], null, 999)]);
    expect((await acc.trialBalance(db, accountant, cA, per)).total_debit).toBe(5000010);   // drafts do not count
  });
  it('reversal: mirrored draft, once only, nets to zero', async () => {
    const rv = await acc.reverse(db, accountant, v1, '1405/08/20'); await rejects(() => acc.reverse(db, accountant, v1, '1405/08/20'), 'Invalid');
    await acc.finalize(db, fin, rv); expect((await acc.ledger(db, accountant, A['1101'], per)).balance).toBe(0); await rejects(() => acc.reverse(db, accountant, rv, '1405/08/21'), 'Invalid');
  });
  it('drafts can be deleted, final cannot; period close rules', async () => {
    const d = await acc.createVoucher(db, accountant, cA, '1405/08/19', 'برای حذف', [L(A['1101'], 7, null), L(A['4101'], null, 7)]);
    await rejects(() => acc.find(db, finB, d), 'HttpError', 404); await acc.deleteDraft(db, accountant, d); await rejects(() => acc.deleteDraft(db, accountant, v1), 'Invalid');
    await rejects(() => acc.closePeriod(db, fin, per), 'Invalid');             // other drafts still open
    await db.exec("DELETE FROM voucher_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE status='draft')"); await db.exec("DELETE FROM vouchers WHERE status='draft'");
    await acc.closePeriod(db, fin, per); await rejects(() => acc.createVoucher(db, accountant, cA, '1405/09/01', 'بعد از بستن', [L(A['1101'], 5, null), L(A['4101'], null, 5)]), 'Invalid');
    await db.exec("UPDATE fiscal_periods SET status = 'open'");                // re-open for the credit/posting tests below
  });
});

describe('credit engine', () => {
  let plan = 0, qt: any, app = 0;
  const P = { name: 'طرح آزمایشی', min_amount: 1000000, max_amount: 100000000, min_down_bp: 0, max_down_bp: 5000, quote_ttl_min: 30, grace_days: 30, late_fee_bp_day: 10, settlement_work_days: 12 };
  const T = (installments: number, monthly_fee_bp: number, upfront_fee_bp: number) => ({ installments, monthly_fee_bp, upfront_fee_bp });
  it('plan: only credit.manage; invalid terms rejected', async () => {
    await rejects(() => credit.createPlan(db, off, cA, P, [T(3, 0, 100)]), 'HttpError', 403);
    await rejects(() => credit.createPlan(db, mgr, cA, { ...P, max_amount: 5 }, [T(3, 0, 100)]), 'Invalid'); await rejects(() => credit.createPlan(db, mgr, cA, P, [T(3, 0, 0), T(3, 1, 0)]), 'Invalid'); await rejects(() => credit.createPlan(db, mgr, cA, P, []), 'Invalid');
    plan = await credit.createPlan(db, mgr, cA, P, [T(3, 0, 100), T(12, 100, 0)]); expect(plan).toBeGreaterThan(0);
  });
  it('quote maths: exact, remainder on last instalment', () => {
    expect(credit.compute(50000000, 5000000, 12, 100, 0)).toEqual({ financed: 45000000, fee_total: 5400000, total_repayment: 50400000, installment_amount: 4200000, last_installment_amount: 4200000 });
    const r = credit.compute(10000000, 0, 3, 0, 100); expect([r.fee_total, r.installment_amount, r.last_installment_amount]).toEqual([100000, 3366666, 3366668]); expect(r.installment_amount * 2 + r.last_installment_amount).toBe(r.total_repayment);
  });
  it('quote rules: bounds, down payment, unknown term, tenant, role', async () => {
    await rejects(() => credit.quote(db, off, cA, plan, 500, 0, 3), 'Invalid'); await rejects(() => credit.quote(db, off, cA, plan, 200000000, 0, 3), 'Invalid'); await rejects(() => credit.quote(db, off, cA, plan, 10000000, 6000000, 3), 'Invalid');
    await rejects(() => credit.quote(db, off, cA, plan, 10000000, 0, 7), 'Invalid'); await rejects(() => credit.quote(db, off, cA, plan, 10000000, -1, 3), 'Invalid');
    await rejects(() => credit.quote(db, off, cB, plan, 10000000, 0, 3), 'HttpError', 404); await rejects(() => credit.quote(db, mgrB, cA, plan, 10000000, 0, 3), 'HttpError');
  });
  it('application needs approved_final identity; quote used once; expiry enforced', async () => {
    qt = await credit.quote(db, off, cA, plan, 12000000, 2000000, 3); expect([qt.financed, qt.total_repayment, qt.installment_amount]).toEqual([10000000, 10100000, 3366666]);
    const draft = await makeProfile(db, owner, cA, '0084575948', 'draft', 'سارا', 'احمدی'); const q2 = await credit.quote(db, off, cA, plan, 12000000, 2000000, 3);
    await rejects(() => credit.createApplication(db, off, q2.quote_id, draft), 'Invalid');
    app = await credit.createApplication(db, off, qt.quote_id, pid); await rejects(() => credit.createApplication(db, off, qt.quote_id, pid), 'Invalid');
    const q3 = await credit.quote(db, off, cA, plan, 12000000, 2000000, 3); await db.exec("UPDATE credit_quotes SET expires_at = '2000-01-01 00:00:00' WHERE id = ?", [q3.quote_id]); await rejects(() => credit.createApplication(db, off, q3.quote_id, pid), 'Invalid');
  });
  it('workflow: roles, notes, maker-checker', async () => {
    await rejects(() => credit.transition(db, off, app, 'approved'), 'Invalid'); await credit.transition(db, off, app, 'submitted');
    await rejects(() => credit.transition(db, off, app, 'under_review'), 'HttpError', 403); await rejects(() => credit.get(db, mgrB, app), 'HttpError', 404);
    await credit.transition(db, mgr, app, 'under_review'); await rejects(() => credit.transition(db, mgr, app, 'approved', ''), 'Invalid');
    await credit.transition(db, mgr, app, 'approved', 'مدارک و ظرفیت بازپرداخت تأیید شد'); expect((await credit.get(db, mgr, app)).status).toBe('approved');
    const q = await credit.quote(db, owner, cA, plan, 12000000, 2000000, 3), a2 = await credit.createApplication(db, owner, q.quote_id, pid);
    await credit.transition(db, owner, a2, 'submitted'); await credit.transition(db, owner, a2, 'under_review'); await rejects(() => credit.transition(db, owner, a2, 'approved', 'تأیید توسط خودم'), 'Invalid');
  });
  it('contract hash + Jalali schedule + settlement date', async () => {
    await rejects(() => credit.activate(db, off, app, '1405/08/16'), 'Invalid'); await rejects(() => credit.signContract(db, off, app, 'x'), 'Invalid');
    expect(await credit.signContract(db, off, app, 'امضا حضوری در شعبه – نسخه کاغذی بایگانی شد')).toBeGreaterThan(0);
    expect(String(await db.val('SELECT terms_hash FROM credit_contracts WHERE application_id = ?', [app]))).toHaveLength(64);
    expect(await credit.activate(db, off, app, '1405/08/16')).toBe(3);
    const inst = await credit.installments(db, app); expect(inst.reduce((s, r) => s + Number(r.amount), 0)).toBe(10100000); expect(Number(inst[2].amount)).toBe(3366668);
    expect(inst[1].due_date).toBe(J.addMonths(inst[0].due_date, 1));
    expect(await db.val('SELECT settlement_expected_on FROM credit_applications WHERE id = ?', [app])).toBe(J.addWorkingDays(J.parse('1405/08/16')!, 12));
  });
  it('payments: partial, oldest-first, idempotent, conflicts, overpay, completion', async () => {
    await rejects(() => credit.recordPayment(db, mgr, app, 100, 'REF-000001'), 'HttpError', 403);
    const r = await credit.recordPayment(db, off, app, 1000000, 'REF-000001'); expect(r.duplicate).toBe(false);
    const r2 = await credit.recordPayment(db, off, app, 1000000, 'REF-000001'); expect(r2.duplicate).toBe(true); expect(r2.payment_id).toBe(r.payment_id);
    expect(Number(await db.val('SELECT COUNT(*) FROM credit_payments WHERE application_id = ?', [app]))).toBe(1);
    await rejects(() => credit.recordPayment(db, off, app, 999, 'REF-000001'), 'Invalid');
    let inst = await credit.installments(db, app); expect([inst[0].status, Number(inst[0].paid_amount), inst[1].status]).toEqual(['partial', 1000000, 'pending']);
    await rejects(() => credit.recordPayment(db, off, app, 99999999, 'REF-000002'), 'Invalid');
    await credit.recordPayment(db, off, app, 2366666 + 3366666, 'REF-000003'); inst = await credit.installments(db, app); expect([inst[0].status, inst[1].status, inst[2].status]).toEqual(['paid', 'paid', 'pending']);
    expect((await credit.recordPayment(db, off, app, 3366668, 'REF-000004')).completed).toBe(true); expect((await credit.get(db, mgr, app)).status).toBe('completed');
    await rejects(() => credit.recordPayment(db, off, app, 1, 'REF-000005'), 'Invalid');
  });
  it('concurrent duplicate payment requests book exactly once', async () => {
    const q = await credit.quote(db, off, cA, plan, 12000000, 2000000, 3), a3 = await credit.createApplication(db, off, q.quote_id, pid);
    await credit.transition(db, off, a3, 'submitted'); await credit.transition(db, mgr, a3, 'under_review'); await credit.transition(db, mgr, a3, 'approved', 'تأیید برای آزمون همزمانی'); await credit.signContract(db, off, a3, 'امضا حضوری آزمون همزمانی'); await credit.activate(db, off, a3, '1405/08/17');
    const res = await Promise.allSettled(Array.from({ length: 6 }, () => credit.recordPayment(db, off, a3, 1000000, 'REF-RACE-01')));
    expect(Number(await db.val('SELECT COUNT(*) FROM credit_payments WHERE application_id = ?', [a3]))).toBe(1);
    expect(Number(await db.val('SELECT SUM(paid_amount) FROM installments WHERE application_id = ?', [a3]))).toBe(1000000);
    expect(res.some(r => r.status === 'fulfilled')).toBe(true);
  });
  it('late fee is informational', () => {
    expect(credit.lateFee({ due_date: '2026-11-01', amount: 1000000, paid_amount: 0, status: 'overdue' }, 10, '2026-11-11')).toBe(10000);
    expect(credit.lateFee({ due_date: '2026-11-20', amount: 1000000, paid_amount: 0, status: 'pending' }, 10, '2026-11-11')).toBe(0);
  });
});

describe('credit to accounting posting', () => {
  const ids: Record<string, number> = {};
  it('mapping rules', async () => {
    for (const [code, role] of [['1103', 'receivable'], ['2101', 'merchant_payable'], ['4101', 'fee_income'], ['1102', 'cash_bank']]) ids[role] = Number(await db.val('SELECT id FROM accounts WHERE company_id = ? AND code = ?', [cA, code]));
    await rejects(() => posting.setAccount(db, accountant, cA, 'receivable', ids.receivable), 'HttpError', 403);
    const group = Number(await db.val('SELECT id FROM accounts WHERE company_id = ? AND code = ?', [cA, '1']));
    await rejects(() => posting.setAccount(db, fin, cA, 'receivable', group), 'Invalid');
    await rejects(() => posting.setAccount(db, finB, cA, 'receivable', ids.receivable), 'HttpError', 404); await rejects(() => posting.setAccount(db, fin, cA, 'nonsense', ids.receivable), 'Invalid');
  });
  it('posting refused until roles mapped; then activation becomes a balanced draft once only', async () => {
    const app = Number(await db.val("SELECT id FROM credit_applications WHERE status = 'completed' LIMIT 1"));
    await rejects(() => posting.post(db, accountant, cA, 'credit.activate', app), 'Invalid');
    for (const [role, id] of Object.entries(ids)) await posting.setAccount(db, fin, cA, role, id);
    const v = await posting.post(db, accountant, cA, 'credit.activate', app), items = await acc.items(db, v);
    expect(items).toHaveLength(3); expect(items.reduce((s, i) => s + Number(i.debit), 0)).toBe(10100000); expect(items.reduce((s, i) => s + Number(i.credit), 0)).toBe(10100000);
    expect((await acc.find(db, accountant, v)).status).toBe('draft'); await rejects(() => posting.post(db, accountant, cA, 'credit.activate', app), 'Invalid');
    await rejects(() => posting.post(db, fin, cA, 'credit.payment', 1), 'HttpError');                 // fin_manager has no entry right
  });
  it('payments post one by one; reconciliation gap is visible, then closes after maker-checker finalisation', async () => {
    const completed = Number(await db.val("SELECT id FROM credit_applications WHERE status = 'completed' LIMIT 1")), race = Number(await db.val("SELECT id FROM credit_applications WHERE status = 'active' LIMIT 1"));
    const p0 = await posting.pending(db, fin, cA), mine = p0.payments.filter(p => Number(p.application_id) === completed); expect(mine).toHaveLength(3);
    const vs = [Number(await db.val("SELECT voucher_id FROM voucher_sources WHERE event = 'credit.activate' AND ref_id = ?", [completed]))];
    for (const p of mine) vs.push(await posting.post(db, accountant, cA, 'credit.payment', Number(p.id)));
    for (const v of vs) await acc.finalize(db, fin, v);
    const gap = await posting.reconcile(db, fin, cA);   // the second application (active, 1,000,000 paid) is not in the books yet
    expect([gap.subledger, gap.ledger, gap.difference, gap.unposted]).toEqual([9100000, 0, 9100000, 2]);
    const more = [await posting.post(db, accountant, cA, 'credit.activate', race)];
    for (const p of (await posting.pending(db, fin, cA)).payments) more.push(await posting.post(db, accountant, cA, 'credit.payment', Number(p.id)));
    expect((await posting.reconcile(db, fin, cA)).draft_vouchers).toBe(more.length);
    for (const v of more) await acc.finalize(db, fin, v);
    const ok = await posting.reconcile(db, fin, cA); expect([ok.subledger, ok.ledger, ok.difference, ok.unposted, ok.draft_vouchers]).toEqual([9100000, 9100000, 0, 0, 0]);
    const per = Number(await db.val('SELECT id FROM fiscal_periods WHERE company_id = ?', [cA])); expect((await acc.trialBalance(db, fin, cA, per)).balanced).toBe(true);
  });
});
