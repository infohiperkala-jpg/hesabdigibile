import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser, makeProfile } from './helpers.js';
import { Db } from '../src/core/db.js';
import { makeHandler } from '../src/http/app.js';
import * as org from '../src/services/org.js';

let db: Db, drop: () => Promise<void>, h: ReturnType<typeof makeHandler>, cA: number, mother: number, ownerPass = 'Owner-pass-1';
class Browser {
  tok: string | undefined; last = '';
  async req(method: string, path: string, form: Record<string, string | string[]> = {}) {
    const q = new URL(path, 'http://x'), fd = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
    const r = await h({ method, path: q.pathname, query: q.searchParams, form: fd, ip: '10.0.0.7', secure: false }, this.tok);
    const t = (r.cookie ?? r.headers?.['Set-Cookie'])?.match(/nafi_sid=([a-f0-9]+)/)?.[1]; if (t) this.tok = t; this.last = r.body; return r;
  }
  csrf() { return this.last.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? ''; }
  async login(email: string, pass: string) { await this.req('GET', '/login'); await this.req('POST', '/login', { email, password: pass, _csrf: this.csrf() }); return this; }
  async post(path: string, form: Record<string, string | string[]> = {}, from = '/') { await this.req('GET', from); return this.req('POST', path, { ...form, _csrf: this.csrf() }); }
  hidden(name: string) { return this.last.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? ''; }
}
beforeAll(async () => {
  process.env.MFA_REQUIRED = '0'; ({ db, drop } = await freshDb()); h = makeHandler(db);
  const owner = await makeOwner(db); mother = Number(await db.val('SELECT id FROM companies WHERE parent_id IS NULL')); cA = await org.createCompany(db, owner, 'شرکت الف', null, mother);
});
afterAll(async () => { await drop(); });

describe('editing and status through HTTP', () => {
  let owner: Browser;
  it('company: edit form carries a version; stale save is refused; history shows before and after', async () => {
    owner = await new Browser().login('owner@t.test', ownerPass); const page = `/companies/${cA}`;
    await owner.req('GET', page); const v1 = owner.hidden('version'); expect(v1).toHaveLength(20);
    await owner.req('POST', `${page}/edit`, { name: 'شرکت الف جدید', legal_name: '', version: v1, _csrf: owner.csrf() });
    await owner.req('GET', page);                                                                                                             // fresh CSRF token, but we keep the OLD version value (a form left open in another tab)
    await owner.req('POST', `${page}/edit`, { name: 'ویرایش با فرم قدیمی', legal_name: '', version: v1, _csrf: owner.csrf() });          // stale
    const p = (await owner.req('GET', page)).body; expect(p).toContain('شرکت الف جدید'); expect(p).toContain('توسط کاربر دیگری تغییر کرده'); expect(p).toContain('text-decoration:line-through');
    expect(Number(await db.val("SELECT COUNT(*) FROM change_log WHERE entity = 'company'"))).toBe(1);
  });
  it('status changes demand a reason; with one they apply and appear in the history', async () => {
    const page = `/companies/${cA}`, miss = await owner.post(`${page}/status`, { status: 'suspended', note: '' }, page); expect(miss.headers?.Location).toBe(page);
    expect(await db.val('SELECT status FROM companies WHERE id = ?', [cA])).toBe('active');
    await owner.post(`${page}/status`, { status: 'suspended', note: 'توقف همکاری تا بررسی مالی' }, page); expect(await db.val('SELECT status FROM companies WHERE id = ?', [cA])).toBe('suspended');
    expect((await owner.req('GET', page)).body).toContain('توقف همکاری تا بررسی مالی');
    await owner.post(`${page}/status`, { status: 'active', note: 'رفع توقف پس از بررسی' }, page);
  });
  it('brand domains: add and remove (reason required) are recorded', async () => {
    await owner.post('/brands', { company_id: String(cA), name: 'برند الف', slug: 'brand-a', host: 'a.example.ir' }, '/brands'); const id = Number(await db.val("SELECT id FROM brands WHERE slug = 'brand-a'")), page = `/brands/${id}`;
    await owner.post(`${page}/domains`, { host: 'shop.example.ir' }, page); expect((await owner.req('GET', page)).body).toContain('shop.example.ir');
    const did = Number(await db.val("SELECT id FROM domains WHERE host = 'a.example.ir'")); await owner.post(`${page}/domains/remove`, { domain_id: String(did), note: '' }, page); expect(Number(await db.val('SELECT COUNT(*) FROM domains WHERE id = ?', [did]))).toBe(1);
    await owner.post(`${page}/domains/remove`, { domain_id: String(did), note: 'دامنه منقضی شده است' }, page); expect(Number(await db.val('SELECT COUNT(*) FROM domains WHERE id = ?', [did]))).toBe(0);
    await owner.post(`${page}/status`, { status: 'archived', note: 'پایان فعالیت برند' }, page); expect((await owner.req('GET', page)).body).toContain('بایگانی‌شده');
  });
  it('user: password reset by admin revokes the target\'s live session; role change and disable work with reasons', async () => {
    const o = await org.getCompany(db, { id: 1, company_id: null, is_owner: 1 } as any, cA); void o;
    const admin = await makeUser(db, { id: 1, company_id: null, is_owner: 1 } as any, 'company_admin', 'adm@t.test', cA, 'Admin-pass-123'), victim = await makeUser(db, { id: 1, company_id: null, is_owner: 1 } as any, 'viewer', 'vic@t.test', cA, 'Victim-pass-123');
    const vb = await new Browser().login('vic@t.test', 'Victim-pass-123'); expect((await vb.req('GET', '/companies')).status).toBe(200);
    const ab = await new Browser().login('adm@t.test', 'Admin-pass-123'), page = `/users/${victim.id}`;
    expect((await ab.post(`${page}/password`, { password: 'short1', note: 'فراموشی گذرواژه' }, page)).headers?.Location).toBe(page);       // policy still applies
    await ab.post(`${page}/password`, { password: 'Reset-pass-456', note: 'فراموشی گذرواژه توسط کاربر' }, page);
    expect((await vb.req('GET', '/companies')).headers?.Location).toBe('/login');                                                              // live session is gone
    await new Browser().login('vic@t.test', 'Victim-pass-123').then(async b => expect((await b.req('GET', '/')).headers?.Location).toBe('/login'));
    expect((await (await new Browser().login('vic@t.test', 'Reset-pass-456')).req('GET', '/')).status).toBe(200);
    const roleId = String(await db.val("SELECT id FROM roles WHERE code = 'registrar' AND company_id IS NULL")); await ab.post(`${page}/role`, { role_id: roleId, note: 'انتقال به واحد ثبت‌نام' }, page);
    expect(await db.val('SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [victim.id])).toBe('registrar');
    await ab.post(`${page}/status`, { status: 'disabled', note: 'پایان همکاری' }, page); expect((await (await new Browser().login('vic@t.test', 'Reset-pass-456')).req('GET', '/')).headers?.Location).toBe('/login');
    expect((await ab.req('GET', `/users/${admin.id}`)).body).toContain('حساب من');   // cannot manage yourself from here
  });
  it('suspending a company kicks out its logged-in users immediately', async () => {
    const u = await new Browser().login('adm@t.test', 'Admin-pass-123'); expect((await u.req('GET', '/companies')).status).toBe(200);
    await owner.post(`/companies/${cA}/status`, { status: 'suspended', note: 'توقف فوری به دلیل بررسی' }, `/companies/${cA}`); expect((await u.req('GET', '/companies')).headers?.Location).toBe('/login');
    await owner.post(`/companies/${cA}/status`, { status: 'active', note: 'رفع توقف' }, `/companies/${cA}`);
  });
});

describe('accounting and credit editing through HTTP', () => {
  let fin: Browser, acc: Browser, mgr: Browser, off: Browser; const ids: Record<string, string> = {};
  beforeAll(async () => {
    const o = { id: 1, company_id: null, is_owner: 1 } as any;
    for (const [role, mail] of [['fin_manager', 'fin'], ['accountant', 'acc'], ['credit_manager', 'mgr'], ['credit_officer', 'off']]) await makeUser(db, o, role, `${mail}@t.test`, cA);
    await makeProfile(db, o, cA, '0499370899'); fin = await new Browser().login('fin@t.test', 'Strong-pass-123'); acc = await new Browser().login('acc@t.test', 'Strong-pass-123'); mgr = await new Browser().login('mgr@t.test', 'Strong-pass-123'); off = await new Browser().login('off@t.test', 'Strong-pass-123');
    await fin.post('/accounting/seed', {}, '/accounting'); await fin.post('/accounting/periods', { title: 'سال ۱۴۰۵', starts: '1405/01/01', ends: '1405/12/29' }, '/accounting');
    const f = await acc.req('GET', '/accounting/vouchers/new'); for (const code of ['1101', '4101']) ids[code] = f.body.match(new RegExp(`<option value="(\\d+)">${code} `))![1];
  });
  it('ledger account: rename through its page, history recorded; deactivation needs a reason', async () => {
    const page = `/accounting/accounts/${ids['1101']}`; await fin.req('GET', page); const v = fin.hidden('version');
    await fin.req('POST', `${page}/edit`, { name: 'صندوق مرکزی', version: v, _csrf: fin.csrf() }); expect(await db.val('SELECT name FROM accounts WHERE id = ?', [ids['1101']])).toBe('صندوق مرکزی');
    expect((await fin.req('GET', page)).body).toContain('تاریخچه تغییرات'); expect((await acc.req('GET', page)).body).not.toContain('ویرایش نام');   // accountant sees no edit form
  });
  let vid = '';
  it('draft voucher is editable by its maker, with stale-version protection; a final voucher is not editable', async () => {
    const r = await acc.post('/accounting/vouchers', { date: '1405/08/16', description: 'فروش اولیه', 'acc[]': [ids['1101'], ids['4101']], 'debit[]': ['5000', ''], 'credit[]': ['', '5000'], 'ldesc[]': ['', ''] }, '/accounting/vouchers/new');
    vid = r.headers!.Location!.split('/').pop()!; const page = `/accounting/vouchers/${vid}/edit`; await acc.req('GET', page); const ver = acc.hidden('version'), body = (d: string, n: string) => ({ date: '1405/08/17', description: d, 'acc[]': [ids['1101'], ids['4101']], 'debit[]': [n, ''], 'credit[]': ['', n], 'ldesc[]': ['', ''], version: ver, _csrf: acc.csrf() });
    await acc.req('POST', page, body('فروش اصلاح‌شده', '9000')); expect(Number(await db.val('SELECT SUM(debit) FROM voucher_items WHERE voucher_id = ?', [vid]))).toBe(9000);
    await acc.req('GET', page); await acc.req('POST', page, body('با نسخه قدیمی', '1')); expect(await db.val('SELECT description FROM vouchers WHERE id = ?', [vid])).toBe('فروش اصلاح‌شده');   // stale refused (token already moved on)
    expect((await acc.req('GET', page)).body).toContain('تاریخچه تغییرات');
    await fin.post(`/accounting/vouchers/${vid}/finalize`, {}, `/accounting/vouchers/${vid}`); expect((await acc.req('GET', page)).body).toContain('سند قطعی قابل ویرایش نیست');
  });
  it('period: close then reopen with a reason', async () => {
    await db.exec("DELETE FROM voucher_items WHERE voucher_id IN (SELECT id FROM vouchers WHERE status = 'draft')"); await db.exec("DELETE FROM vouchers WHERE status = 'draft'");
    await fin.post('/accounting/periods/close', { period_id: '1' }, '/accounting'); expect(await db.val('SELECT status FROM fiscal_periods WHERE id = 1')).toBe('closed');
    await fin.post('/accounting/periods/1/reopen', { note: '' }, '/accounting'); expect(await db.val('SELECT status FROM fiscal_periods WHERE id = 1')).toBe('closed');
    await fin.post('/accounting/periods/1/reopen', { note: 'کشف خطا در ثبت تیر ماه' }, '/accounting'); expect(await db.val('SELECT status FROM fiscal_periods WHERE id = 1')).toBe('open');
  });
  it('credit plan: editable via its page until an application exists, then locked; archive with reason', async () => {
    await mgr.post('/credit/plans', { name: 'طرح قابل ویرایش', min_amount: '1000000', max_amount: '100000000', min_down_bp: '0', max_down_bp: '5000', quote_ttl_min: '30', grace_days: '30', late_fee_bp_day: '10', settlement_work_days: '12', 't_count[]': ['3'], 't_monthly[]': ['0'], 't_upfront[]': ['100'] }, '/credit');
    const page = '/credit/plans/1'; await mgr.req('GET', page); expect(mgr.last).toContain('ویرایش شرایط');
    await mgr.req('POST', `${page}/edit`, { name: 'طرح ویرایش‌شده', min_amount: '1000000', max_amount: '90000000', min_down_bp: '0', max_down_bp: '5000', quote_ttl_min: '30', grace_days: '30', late_fee_bp_day: '10', settlement_work_days: '12', 't_count[]': ['3', '6'], 't_monthly[]': ['0', '50'], 't_upfront[]': ['100', '0'], version: mgr.hidden('version'), _csrf: mgr.csrf() });
    expect(await db.val('SELECT name FROM credit_plans WHERE id = 1')).toBe('طرح ویرایش‌شده'); expect(Number(await db.val('SELECT COUNT(*) FROM credit_plan_terms WHERE plan_id = 1'))).toBe(2);
    await off.post('/credit/quote', { plan_id: '1', amount: '12000000', down: '2000000', count: '3', profile_id: '1' }, '/credit');
    expect((await mgr.req('GET', page)).body).toContain('شرایط قابل ویرایش نیست'); expect((await mgr.req('GET', page)).body).not.toContain('ویرایش شرایط');
    await mgr.post(`${page}/status`, { status: 'archived', note: 'جایگزین‌شدن با طرح جدید' }, page); expect(await db.val('SELECT status FROM credit_plans WHERE id = 1')).toBe('archived');
  });
});
