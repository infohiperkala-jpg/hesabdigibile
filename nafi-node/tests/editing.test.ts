import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser, makeProfile, rejects } from './helpers.js';
import { Db } from '../src/core/db.js';
import { Actor } from '../src/core/audit.js';
import * as org from '../src/services/org.js';
import * as acc from '../src/services/accounting.js';
import * as credit from '../src/services/credit.js';
import * as auth from '../src/services/auth.js';
import * as mfa from '../src/services/mfa.js';
import * as ch from '../src/core/changes.js';
import * as S from '../src/http/session.js';
import * as totp from '../src/core/totp.js';

let db: Db, drop: () => Promise<void>, owner: Actor, cA: number, cB: number, adminA: Actor, viewerA: Actor, adminB: Actor, roles: Record<string, number>;
beforeAll(async () => {
  ({ db, drop } = await freshDb()); owner = await makeOwner(db);
  cA = await org.createCompany(db, owner, 'شرکت الف', null, Number(await db.val('SELECT id FROM companies WHERE parent_id IS NULL'))); cB = await org.createCompany(db, owner, 'شرکت ب');
  adminA = await makeUser(db, owner, 'company_admin', 'a@t.test', cA, 'Alpha-pass-123'); viewerA = await makeUser(db, owner, 'viewer', 'v@t.test', cA, 'Viewer-pass-123'); adminB = await makeUser(db, owner, 'company_admin', 'b@t.test', cB, 'Bravo-pass-123');
  roles = Object.fromEntries((await db.all('SELECT id, code FROM roles')).map(r => [r.code, Number(r.id)]));
});
afterAll(async () => { await drop(); });

describe('editing infrastructure: concurrency + change history', () => {
  it('edit records before/after; no-op edit refused; stale form refused; viewer/other tenant cannot edit', async () => {
    const c = await org.getCompany(db, owner, cA), v = ch.versionOf(c);
    await org.editCompany(db, owner, cA, { name: 'شرکت الف (ویرایش)', legal_name: 'الف سهامی خاص' }, v);
    const h = await ch.history(db, 'company', cA); expect(h).toHaveLength(1); expect(JSON.parse(h[0].changes)).toEqual({ name: ['شرکت الف', 'شرکت الف (ویرایش)'], legal_name: [null, 'الف سهامی خاص'] });
    await rejects(() => org.editCompany(db, owner, cA, { name: 'شرکت الف (ویرایش)', legal_name: 'الف سهامی خاص' }), 'Invalid');
    await rejects(() => org.editCompany(db, owner, cA, { name: 'تغییر دوم', legal_name: null }, v), 'Invalid');             // v is stale now
    await org.editCompany(db, owner, cA, { name: 'تغییر دوم', legal_name: null }, ch.versionOf(await org.getCompany(db, owner, cA)));
    await rejects(() => org.editCompany(db, adminA, cA, { name: 'هک', legal_name: null }), 'HttpError', 403);
    await rejects(() => org.getCompany(db, adminB, cA), 'HttpError', 404);
  });
});

describe('company status', () => {
  it('mother company is protected; note required; suspension blocks logins and revokes sessions at once', async () => {
    const mother = Number(await db.val('SELECT id FROM companies WHERE parent_id IS NULL'));
    await rejects(() => org.setCompanyStatus(db, owner, mother, 'suspended', 'دلیل کافی است'), 'Invalid'); await rejects(() => org.setCompanyStatus(db, owner, cB, 'suspended', ''), 'Invalid');
    const sess0 = await S.create(db); await db.exec('UPDATE sessions SET user_id = ? WHERE id = ?', [adminB.id, sess0.id]); const sess = { ...sess0, user_id: adminB.id }; expect(await S.user(db, sess)).not.toBeNull();
    await org.setCompanyStatus(db, owner, cB, 'suspended', 'توقف همکاری تا بررسی مالی');
    expect(await S.user(db, sess)).toBeNull(); expect(await auth.attempt(db, 'b@t.test', 'Bravo-pass-123')).toBeNull();
    await org.setCompanyStatus(db, owner, cB, 'active', 'رفع توقف پس از بررسی'); expect(await auth.attempt(db, 'b@t.test', 'Bravo-pass-123')).not.toBeNull();
    const parent = Number(await db.val('SELECT parent_id FROM companies WHERE id = ?', [cA]));
    await rejects(() => org.setCompanyStatus(db, owner, parent, 'archived', 'تلاش برای بایگانی مادر'), 'Invalid');
  });
});

describe('brands and domains', () => {
  let brand = 0;
  it('edit, status with reason, domain add/remove, all in history', async () => {
    brand = await org.createBrand(db, adminA, cA, 'برند الف', 'brand-a', 'a.example.ir');
    await org.editBrand(db, adminA, brand, 'برند الف جدید', ch.versionOf(await org.getBrand(db, adminA, brand)));
    await org.addDomain(db, adminA, brand, 'shop.example.ir'); await rejects(() => org.addDomain(db, adminA, brand, 'shop.example.ir'), 'Invalid'); await rejects(() => org.addDomain(db, adminA, brand, 'bad host'), 'Invalid');
    const d = await db.one('SELECT id FROM domains WHERE host = ?', ['a.example.ir']); await rejects(() => org.removeDomain(db, adminA, brand, Number(d!.id), ''), 'Invalid'); await org.removeDomain(db, adminA, brand, Number(d!.id), 'دامنه منقضی شده است');
    await org.setBrandStatus(db, adminA, brand, 'suspended', 'تعلیق موقت برند'); await rejects(() => org.setBrandStatus(db, adminA, brand, 'suspended', 'دوباره تعلیق'), 'Invalid');
    const keys = (await ch.history(db, 'brand', brand)).map(r => Object.keys(JSON.parse(r.changes))[0]).reverse(); expect(keys).toEqual(['name', 'domain_added', 'domain_removed', 'status']);
    await rejects(() => org.editBrand(db, adminB, brand, 'هک'), 'HttpError', 404);
  });
});

describe('user management', () => {
  it('edit profile, change role, disable (sessions revoked), reset password, unlock', async () => {
    await org.editUser(db, adminA, viewerA.id, 'ناظر الف جدید', 'v2@t.test', ch.versionOf(await org.getUser(db, adminA, viewerA.id)));
    await rejects(() => org.editUser(db, adminA, viewerA.id, 'ناظر', 'a@t.test'), 'Invalid');                       // email already used
    await rejects(() => org.changeUserRole(db, adminA, viewerA.id, roles.registrar, ''), 'Invalid'); await org.changeUserRole(db, adminA, viewerA.id, roles.registrar, 'انتقال به واحد ثبت‌نام');
    expect(await db.val('SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [viewerA.id])).toBe('registrar');
    const s0 = await S.create(db); await db.exec('UPDATE sessions SET user_id = ? WHERE id = ?', [viewerA.id, s0.id]); const s = { ...s0, user_id: viewerA.id }; expect(await S.user(db, s)).not.toBeNull();
    await org.setUserStatusWithReason(db, adminA, viewerA.id, 'disabled', 'پایان همکاری'); expect(await S.user(db, s)).toBeNull(); expect(await auth.attempt(db, 'v2@t.test', 'Viewer-pass-123')).toBeNull();
    await org.setUserStatusWithReason(db, adminA, viewerA.id, 'active', 'بازگشت به کار');
    await rejects(() => org.adminResetPassword(db, adminA, viewerA.id, 'short1', 'فراموشی گذرواژه'), 'Invalid'); await org.adminResetPassword(db, adminA, viewerA.id, 'Reset-pass-456', 'فراموشی گذرواژه');
    expect(await auth.attempt(db, 'v2@t.test', 'Viewer-pass-123')).toBeNull(); expect(await auth.attempt(db, 'v2@t.test', 'Reset-pass-456')).not.toBeNull();
    for (let i = 0; i < 5; i++) await auth.attempt(db, 'v2@t.test', 'bad'); await org.unlockUser(db, adminA, viewerA.id); await rejects(() => org.unlockUser(db, adminA, viewerA.id), 'Invalid'); expect(await auth.attempt(db, 'v2@t.test', 'Reset-pass-456')).not.toBeNull();
    const pw = (await ch.history(db, 'user', viewerA.id)).find(r => JSON.parse(r.changes).password); expect(pw!.changes).not.toContain('Reset-pass-456');   // secrets never enter history
  });
  it('guards: cannot demote/disable yourself or the owner; other tenant invisible; MFA reset is group-owner only', async () => {
    await rejects(() => org.changeUserRole(db, adminA, adminA.id, roles.viewer, 'تغییر نقش خودم'), 'Invalid'); await rejects(() => org.setUserStatusWithReason(db, adminA, adminA.id, 'disabled', 'غیرفعال خودم'), 'Invalid');
    await rejects(() => org.getUser(db, adminA, owner.id), 'HttpError', 404); await rejects(() => org.editUser(db, adminB, viewerA.id, 'هک', 'h@t.test'), 'HttpError', 404);
    const u = (await db.one('SELECT * FROM users WHERE id = ?', [adminB.id])) as Actor; const secret = await mfa.begin(db, u); await mfa.confirm(db, u, totp.code(totp.base32Decode(secret), Math.floor(Date.now() / 30000)));
    await rejects(() => org.resetMfa(db, adminA, adminB.id, 'کاربر گوشی را گم کرده'), 'HttpError'); await rejects(() => org.resetMfa(db, owner, adminB.id, ''), 'Invalid');
    await org.resetMfa(db, owner, adminB.id, 'گم‌شدن گوشی و کدهای بازیابی'); expect(Number(await db.val('SELECT mfa_enabled FROM users WHERE id = ?', [adminB.id]))).toBe(0); expect(Number(await db.val('SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ?', [adminB.id]))).toBe(0);
  });
});

describe('accounting edits', () => {
  let fin: Actor, accountant: Actor, accountant2: Actor, A: Record<string, number> = {}, per = 0;
  const L = (account_id: number, debit: number | null, credit: number | null) => ({ account_id, debit, credit });
  beforeAll(async () => {
    fin = await makeUser(db, owner, 'fin_manager', 'fin@t.test', cA); accountant = await makeUser(db, owner, 'accountant', 'acc@t.test', cA); accountant2 = await makeUser(db, owner, 'accountant', 'acc2@t.test', cA);
    await acc.seedStarterChart(db, fin, cA); per = await acc.createPeriod(db, fin, cA, 'سال ۱۴۰۵', '1405/01/01', '1405/12/29');
    for (const c of ['1101', '1102', '4101', '5101', '11', '1']) A[c] = Number(await db.val('SELECT id FROM accounts WHERE company_id = ? AND code = ?', [cA, c]));
  });
  it('account: rename with history; deactivation guards (balance, draft use, active children); reactivation', async () => {
    await acc.editAccount(db, fin, A['1101'], 'صندوق مرکزی', ch.versionOf(await acc.getAccount(db, fin, A['1101']))); await rejects(() => acc.editAccount(db, accountant, A['1101'], 'هک'), 'HttpError', 403);
    const d = await acc.createVoucher(db, accountant, cA, '1405/08/16', 'فروش', [L(A['1101'], 1000, null), L(A['4101'], null, 1000)]);
    await rejects(() => acc.setAccountStatus(db, fin, A['1101'], 'inactive', 'بستن حساب صندوق'), 'Invalid');            // used in a draft
    await acc.finalize(db, fin, d); await rejects(() => acc.setAccountStatus(db, fin, A['1101'], 'inactive', 'بستن حساب صندوق'), 'Invalid');   // balance != 0
    await rejects(() => acc.setAccountStatus(db, fin, A['11'], 'inactive', 'بستن گروه جاری'), 'Invalid');            // active children
    await acc.setAccountStatus(db, fin, A['5101'], 'inactive', 'حساب استفاده نمی‌شود'); await rejects(() => acc.createVoucher(db, accountant, cA, '1405/08/17', 'هزینه', [L(A['5101'], 5, null), L(A['1102'], null, 5)]), 'Invalid');
    await acc.setAccountStatus(db, fin, A['5101'], 'active', 'نیاز مجدد'); expect((await ch.history(db, 'account', A['5101']))).toHaveLength(2);
  });
  it('draft voucher editing: maker or manager only, stale version refused, lines rewritten, history records totals; final cannot be edited', async () => {
    const id = await acc.createVoucher(db, accountant, cA, '1405/08/18', 'پیش‌نویس اولیه', [L(A['1101'], 5000, null), L(A['4101'], null, 5000)]), ver = await acc.voucherVersion(db, id);
    await rejects(() => acc.updateDraft(db, accountant2, id, '1405/08/18', 'سرقت ویرایش', [L(A['1101'], 1, null), L(A['4101'], null, 1)], ver), 'Invalid');   // not the maker
    await rejects(() => acc.updateDraft(db, accountant, id, '1405/08/18', 'نامتوازن', [L(A['1101'], 9000, null), L(A['4101'], null, 8000)], ver), 'Invalid');
    await acc.updateDraft(db, accountant, id, '1405/08/19', 'پیش‌نویس اصلاح‌شده', [L(A['1101'], 7000, null), L(A['1102'], 3000, null), L(A['4101'], null, 10000)], ver);
    expect((await acc.items(db, id)).map(i => Number(i.debit) + Number(i.credit))).toEqual([7000, 3000, 10000]);
    await rejects(() => acc.updateDraft(db, accountant, id, '1405/08/19', 'ویرایش با نسخه قدیمی', [L(A['1101'], 1, null), L(A['4101'], null, 1)], ver), 'Invalid');   // stale
    const h = JSON.parse((await ch.history(db, 'voucher', id))[0].changes); expect(h.total).toEqual([5000, 10000]); expect(h.lines).toEqual([2, 3]);
    await acc.updateDraft(db, fin, id, '1405/08/19', 'اصلاح توسط مدیر مالی', [L(A['1101'], 1, null), L(A['4101'], null, 1)]);   // a manager may
    await acc.finalize(db, fin, id); await rejects(() => acc.updateDraft(db, accountant, id, '1405/08/19', 'ویرایش قطعی', [L(A['1101'], 1, null), L(A['4101'], null, 1)]), 'Invalid');
  });
  it('period reopen needs a reason and a closed period; entries are allowed again', async () => {
    await db.exec("DELETE FROM voucher_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE status = 'draft')"); await db.exec("DELETE FROM vouchers WHERE status = 'draft'");
    await acc.closePeriod(db, fin, per); await rejects(() => acc.reopenPeriod(db, fin, per, ''), 'Invalid'); await rejects(() => acc.reopenPeriod(db, accountant, per, 'تلاش بدون مجوز'), 'HttpError', 403);
    await acc.reopenPeriod(db, fin, per, 'کشف خطا در ثبت تیر ماه'); await rejects(() => acc.reopenPeriod(db, fin, per, 'دوباره باز'), 'Invalid');
    expect(await acc.createVoucher(db, accountant, cA, '1405/09/01', 'ثبت پس از بازگشایی', [L(A['1101'], 5, null), L(A['4101'], null, 5)])).toBeGreaterThan(0);
  });
});

describe('credit plan editing', () => {
  const P = { name: 'طرح قابل ویرایش', min_amount: 1000000, max_amount: 100000000, min_down_bp: 0, max_down_bp: 5000, quote_ttl_min: 30, grace_days: 30, late_fee_bp_day: 10, settlement_work_days: 12 };
  it('editable until an application exists; then archive-only; archived plans cannot quote; cancellations need a reason', async () => {
    const mgr = await makeUser(db, owner, 'credit_manager', 'mgr@t.test', cA), off = await makeUser(db, owner, 'credit_officer', 'off@t.test', cA), pid = await makeProfile(db, owner, cA, '0499370899');
    const plan = await credit.createPlan(db, mgr, cA, P, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 100 }]);
    await credit.editPlan(db, mgr, plan, { ...P, name: 'طرح ویرایش‌شده', max_amount: 80000000 }, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 150 }, { installments: 6, monthly_fee_bp: 50, upfront_fee_bp: 0 }], ch.versionOf(await credit.getPlan(db, mgr, plan)));
    expect((await db.all('SELECT installments FROM credit_plan_terms WHERE plan_id = ? ORDER BY installments', [plan])).map(r => Number(r.installments))).toEqual([3, 6]);
    const h = JSON.parse((await ch.history(db, 'plan', plan))[0].changes); expect(h.name).toEqual(['طرح قابل ویرایش', 'طرح ویرایش‌شده']); expect(h.max_amount).toEqual([100000000, 80000000]); expect(h.terms).toBeTruthy();
    await rejects(() => credit.editPlan(db, mgr, plan, { ...P, max_amount: 5 }, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 0 }]), 'Invalid'); await rejects(() => credit.editPlan(db, off, plan, P, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 0 }]), 'HttpError', 403);
    const q = await credit.quote(db, off, cA, plan, 12000000, 2000000, 3), app = await credit.createApplication(db, off, q.quote_id, pid);
    await rejects(() => credit.editPlan(db, mgr, plan, { ...P, name: 'تغییر بعد از درخواست' }, [{ installments: 3, monthly_fee_bp: 0, upfront_fee_bp: 0 }]), 'Invalid');
    await rejects(() => credit.transition(db, off, app, 'cancelled', ''), 'Invalid'); await credit.transition(db, off, app, 'cancelled', 'انصراف متقاضی پیش از ارسال');
    await credit.setPlanStatus(db, mgr, plan, 'archived', 'جایگزین‌شدن با طرح جدید'); await rejects(() => credit.quote(db, off, cA, plan, 12000000, 2000000, 3), 'Invalid');
    await credit.setPlanStatus(db, mgr, plan, 'active', 'بازگرداندن طرح'); expect((await credit.quote(db, off, cA, plan, 12000000, 2000000, 3)).quote_id).toBeGreaterThan(0);
  });
});
