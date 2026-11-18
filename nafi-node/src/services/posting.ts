import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as J from '../core/jalali.js';
import * as acc from './accounting.js';

/**
 * Turns credit events into DRAFT vouchers. The accountant (accounting.entry) triggers it, so maker-checker still applies:
 * someone else must finalise. Never auto-finalises, never bypasses permissions.
 */
export const ROLES: Record<string, string> = { receivable: 'مطالبات اقساط', merchant_payable: 'پرداختنی به پذیرنده', fee_income: 'درآمد کارمزد', cash_bank: 'بانک/صندوق دریافت اقساط', commission_income: 'درآمد کمیسیون پذیرندگان' };
const NEED: Record<string, string[]> = { 'credit.activate': ['receivable', 'merchant_payable', 'fee_income'], 'credit.payment': ['cash_bank', 'receivable'], 'market.settlement': ['merchant_payable', 'cash_bank', 'commission_income'] };

async function company(db: Db, a: Actor, cid: number) {
  gate.assertCompany(a, cid);
  if (!(await db.val('SELECT 1 FROM companies WHERE id = ?', [cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
}
export async function setAccount(db: Db, a: Actor, cid: number, role: string, accountId: number): Promise<void> {
  await gate.require_(db, a, 'accounting.manage'); await company(db, a, cid);
  if (!ROLES[role]) throw new Invalid('نقش حساب نامعتبر است.');
  const r = await db.one('SELECT is_postable, status FROM accounts WHERE id = ? AND company_id = ?', [accountId, cid]);
  if (!r || !r.is_postable || r.status !== 'active') throw new Invalid('فقط حساب معین فعال همین شرکت قابل انتخاب است.');
  await db.tx(async t => { await t.exec('DELETE FROM posting_accounts WHERE company_id = ? AND role = ?', [cid, role]); await t.exec('INSERT INTO posting_accounts (company_id,role,account_id) VALUES (?,?,?)', [cid, role, accountId]); await audit.log(t, a, 'posting.map', 'company', cid, { role, account_id: accountId }, cid); });
}
export async function mapping(db: Db, cid: number): Promise<Record<string, number>> {
  return Object.fromEntries((await db.all('SELECT role, account_id FROM posting_accounts WHERE company_id = ?', [cid])).map(r => [r.role, Number(r.account_id)]));
}
export async function pending(db: Db, a: Actor, cid: number) {
  await gate.require_(db, a, 'accounting.view'); await company(db, a, cid);
  const not = (ev: string, alias: string) => `NOT EXISTS (SELECT 1 FROM voucher_sources s WHERE s.company_id = ${alias}.company_id AND s.event = '${ev}' AND s.ref_id = ${alias}.id)`;
  return {
    activations: await db.all(`SELECT ap.id, q.total_repayment, q.financed, q.fee_total, pr.first_name, pr.last_name FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id JOIN identity_profiles pr ON pr.id = ap.profile_id WHERE ap.company_id = ? AND ap.status IN ('active','completed') AND ${not('credit.activate', 'ap')} ORDER BY ap.id`, [cid]),
    payments: await db.all(`SELECT p.id, p.application_id, p.amount, p.reference, p.created_at FROM credit_payments p WHERE p.company_id = ? AND ${not('credit.payment', 'p')} ORDER BY p.id`, [cid]),
    settlements: await db.all(`SELECT ms.id, ms.gross, ms.commission, ms.net, ms.reference FROM merchant_settlements ms WHERE ms.company_id = ? AND ms.status = 'paid' AND ${not('market.settlement', 'ms')} ORDER BY ms.id`, [cid]),
  };
}
const jdate = (at: string) => { const [y, m, d] = at.slice(0, 10).split('-').map(Number); const [jy, jm, jd] = J.fromGregorian(y, m, d); return `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`; };

export async function post(db: Db, a: Actor, cid: number, event: string, refId: number): Promise<number> {
  await gate.require_(db, a, 'accounting.entry'); await company(db, a, cid);
  const map = await mapping(db, cid), need = NEED[event]; if (!need) throw new Invalid('نوع رویداد نامعتبر است.');
  for (const r of need) if (!map[r]) throw new Invalid(`ابتدا حساب نقش «${ROLES[r]}» را تعیین کنید.`);
  if (await db.val('SELECT 1 FROM voucher_sources WHERE company_id = ? AND event = ? AND ref_id = ?', [cid, event, refId])) throw new Invalid('برای این رویداد قبلاً سند ثبت شده است.');
  let lines: acc.Line[], desc: string, at: string;
  if (event === 'credit.activate') {
    const r = await db.one(`SELECT ap.id, ap.company_id, q.total_repayment, q.financed, q.fee_total, (SELECT MAX(h.created_at) FROM credit_status_history h WHERE h.application_id = ap.id AND h.to_status = 'active') AS at
      FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id WHERE ap.id = ? AND ap.status IN ('active','completed')`, [refId]);
    if (!r || Number(r.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    lines = [{ account_id: map.receivable, debit: Number(r.total_repayment) }, { account_id: map.merchant_payable, credit: Number(r.financed) }];
    if (Number(r.fee_total) > 0) lines.push({ account_id: map.fee_income, credit: Number(r.fee_total) });
    desc = 'اعتبار: فعال‌سازی درخواست شماره ' + refId; at = r.at;
  } else if (event === 'credit.payment') {
    const r = await db.one('SELECT id, company_id, amount, reference, created_at AS at FROM credit_payments WHERE id = ?', [refId]);
    if (!r || Number(r.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    lines = [{ account_id: map.cash_bank, debit: Number(r.amount) }, { account_id: map.receivable, credit: Number(r.amount) }]; desc = 'دریافت قسط – شناسه پیگیری ' + r.reference; at = r.at;
  } else {   // market.settlement: Dr payable to merchant (gross) / Cr bank (net) + Cr commission income
    const r = await db.one("SELECT id, company_id, gross, commission, net, paid_at AS at, reference FROM merchant_settlements WHERE id = ? AND status = 'paid'", [refId]);
    if (!r || Number(r.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    lines = [{ account_id: map.merchant_payable, debit: Number(r.gross) }, { account_id: map.cash_bank, credit: Number(r.net) }];
    if (Number(r.commission) > 0) lines.push({ account_id: map.commission_income, credit: Number(r.commission) });
    desc = 'تسویه با پذیرنده – شناسه پیگیری ' + r.reference; at = r.at;
  }
  return db.tx(async t => {
    const vid = await acc.createVoucher(t, a, cid, jdate(at), desc, lines);
    await t.exec('INSERT INTO voucher_sources (company_id,voucher_id,event,ref_id,created_at) VALUES (?,?,?,?,?)', [cid, vid, event, refId, t.now()]);
    await audit.log(t, a, 'posting.create', 'voucher', vid, { event, ref: refId }, cid); return vid;
  });
}

/** Subledger (instalments still owed) vs general ledger (receivable account, FINAL vouchers). A gap is normal while events are unposted or vouchers are drafts. */
export async function reconcile(db: Db, a: Actor, cid: number) {
  await gate.require_(db, a, 'accounting.view'); await company(db, a, cid);
  const map = await mapping(db, cid);
  const sub = Number(await db.val("SELECT COALESCE(SUM(i.amount - i.paid_amount),0) FROM installments i JOIN credit_applications ap ON ap.id = i.application_id WHERE i.company_id = ? AND ap.status IN ('active','completed')", [cid]));
  let ledger: number | null = null;
  if (map.receivable) {
    const r = (await db.one("SELECT COALESCE(SUM(i.debit),0) AS d, COALESCE(SUM(i.credit),0) AS c FROM voucher_items i JOIN vouchers v ON v.id = i.voucher_id WHERE v.status = 'final' AND v.company_id = ? AND i.account_id = ?", [cid, map.receivable]))!;
    ledger = Number(r.d) - Number(r.c);
  }
  const p = await pending(db, a, cid);
  const drafts = Number(await db.val("SELECT COUNT(*) FROM voucher_sources s JOIN vouchers v ON v.id = s.voucher_id WHERE s.company_id = ? AND v.status = 'draft'", [cid]));
  return { subledger: sub, ledger, difference: ledger === null ? null : sub - ledger, unposted: p.activations.length + p.payments.length + p.settlements.length, draft_vouchers: drafts };
}
