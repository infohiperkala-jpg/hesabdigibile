import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser, makeProfile } from './helpers.js';
import { Db } from '../src/core/db.js';
import { makeHandler } from '../src/http/app.js';
import * as org from '../src/services/org.js';

let db: Db, drop: () => Promise<void>, h: ReturnType<typeof makeHandler>, cA: number, pid: number;
/** A tiny cookie-keeping browser: one instance per user. */
class Browser {
  tok: string | undefined; last = '';
  async req(method: string, path: string, form: Record<string, string | string[]> = {}) {
    const q = new URL(path, 'http://x'), fd = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
    const r = await h({ method, path: q.pathname, query: q.searchParams, form: fd, ip: '10.0.0.5', secure: false }, this.tok);
    const t = (r.cookie ?? r.headers?.['Set-Cookie'])?.match(/nafi_sid=([a-f0-9]+)/)?.[1]; if (t) this.tok = t; this.last = r.body; return r;
  }
  csrf() { return this.last.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? ''; }
  async login(email: string, pass: string) { await this.req('GET', '/login'); await this.req('POST', '/login', { email, password: pass, _csrf: this.csrf() }); return this; }
  async post(path: string, form: Record<string, string | string[]> = {}, from = '/') { await this.req('GET', from); return this.req('POST', path, { ...form, _csrf: this.csrf() }); }
}
const loc = (r: { headers?: Record<string, string> }) => r.headers?.Location;

beforeAll(async () => {
  process.env.MFA_REQUIRED = '0'; ({ db, drop } = await freshDb()); h = makeHandler(db);
  const owner = await makeOwner(db); cA = await org.createCompany(db, owner, 'شرکت الف');
  for (const [role, mail] of [['fin_manager', 'fin'], ['accountant', 'acc'], ['credit_officer', 'off'], ['credit_manager', 'mgr']]) await makeUser(db, owner, role, `${mail}@t.test`, cA);
  pid = await makeProfile(db, owner, cA, '0499370899');
});
afterAll(async () => { await drop(); });

describe('accounting through HTTP', () => {
  let fin: Browser, acc: Browser;
  it('setup: chart, period', async () => {
    fin = await new Browser().login('fin@t.test', 'Strong-pass-123'); acc = await new Browser().login('acc@t.test', 'Strong-pass-123');
    expect((await acc.post('/accounting/seed', {}, '/accounting')).status).toBe(403);
    expect(loc(await fin.post('/accounting/seed', {}, '/accounting'))).toBe('/accounting');
    await fin.post('/accounting/periods', { title: 'سال ۱۴۰۵', starts: '1405/01/01', ends: '1405/12/29' }, '/accounting');
    expect(Number(await db.val('SELECT COUNT(*) FROM accounts'))).toBe(16); expect(Number(await db.val('SELECT COUNT(*) FROM fiscal_periods'))).toBe(1);
  });
  const ids: Record<string, string> = {};
  it('voucher form lists postable accounts; unbalanced is refused with a message; balanced becomes a draft', async () => {
    const f = await acc.req('GET', '/accounting/vouchers/new'); for (const code of ['1101', '4101']) ids[code] = f.body.match(new RegExp(`<option value="(\\d+)">${code} `))![1];
    const bad = await acc.post('/accounting/vouchers', { date: '1405/08/16', description: 'نامتوازن', 'acc[]': [ids['1101'], ids['4101']], 'debit[]': ['5000', ''], 'credit[]': ['', '4000'], 'ldesc[]': ['', ''] }, '/accounting/vouchers/new');
    expect(loc(bad)).toBe('/accounting/vouchers/new'); expect((await acc.req('GET', '/accounting/vouchers/new')).body).toContain('سند تراز نیست');
    const ok = await acc.post('/accounting/vouchers', { date: '1405/08/16', description: '<b>فروش</b> نقدی', 'acc[]': [ids['1101'], ids['4101']], 'debit[]': ['۵٬۰۰۰٬۰۰۰', ''], 'credit[]': ['', '5000000'], 'ldesc[]': ['', ''] }, '/accounting/vouchers/new');
    expect(loc(ok)).toMatch(/^\/accounting\/vouchers\/\d+$/); const page = (await acc.req('GET', loc(ok)!)).body;
    expect(page).toContain('پیش‌نویس'); expect(page).not.toContain('<b>فروش</b>'); expect(page).toContain('&lt;b&gt;');   // XSS-safe
  });
  it('maker-checker over HTTP: accountant cannot finalise (403); finance manager can; trial balance is balanced', async () => {
    expect((await acc.post('/accounting/vouchers/1/finalize', {}, '/accounting/vouchers/1')).status).toBe(403);
    expect(loc(await fin.post('/accounting/vouchers/1/finalize', {}, '/accounting/vouchers/1'))).toBe('/accounting/vouchers/1');
    expect((await fin.req('GET', '/accounting/vouchers/1')).body).toContain('قطعی');
    const tb = (await fin.req('GET', '/accounting/reports?p=1')).body; expect(tb).toContain('متوازن است'); expect(tb).toContain('۵٬۰۰۰٬۰۰۰');
    expect((await acc.post('/accounting/vouchers/1/reverse', { date: '1405/08/20' }, '/accounting/vouchers/1')).status).toBe(303);
    expect(Number(await db.val("SELECT COUNT(*) FROM vouchers WHERE reverses_id = 1"))).toBe(1);
  });
});

describe('credit through HTTP', () => {
  let off: Browser, mgr: Browser, fin: Browser, acc: Browser;
  it('plan, quote, application, workflow, contract, activation', async () => {
    off = await new Browser().login('off@t.test', 'Strong-pass-123'); mgr = await new Browser().login('mgr@t.test', 'Strong-pass-123');
    expect((await off.post('/credit/plans', { name: 'x' }, '/credit')).status).toBe(403);
    await mgr.post('/credit/plans', { name: 'طرح آزمایشی', min_amount: '1000000', max_amount: '100000000', min_down_bp: '0', max_down_bp: '5000', quote_ttl_min: '30', grace_days: '30', late_fee_bp_day: '10', settlement_work_days: '12', 't_count[]': ['3', ''], 't_monthly[]': ['0', '0'], 't_upfront[]': ['100', '0'] }, '/credit');
    expect(Number(await db.val('SELECT COUNT(*) FROM credit_plans'))).toBe(1);
    await off.post('/credit/quote', { plan_id: '1', amount: '۱۲٬۰۰۰٬۰۰۰', down: '2000000', count: '3' }, '/credit'); expect((await off.req('GET', '/credit')).body).toContain('۳٬۳۶۶٬۶۶۶');   // quote computed by the server, shown in the flash
    const r = await off.post('/credit/quote', { plan_id: '1', amount: '12000000', down: '2000000', count: '3', profile_id: String(pid) }, '/credit'); expect(loc(r)).toBe('/credit/applications/1');
    const A = '/credit/applications/1';
    await off.post(`${A}/transition`, { to: 'submitted' }, A); expect((await off.post(`${A}/transition`, { to: 'under_review' }, A)).status).toBe(403);
    await mgr.post(`${A}/transition`, { to: 'under_review' }, A); await mgr.post(`${A}/transition`, { to: 'approved', note: 'تأیید پس از بررسی کامل' }, A);
    await off.post(`${A}/contract`, { note: 'امضا حضوری و اصل بایگانی شد' }, A); await off.post(`${A}/activate`, { date: '1405/08/16' }, A);
    expect(Number(await db.val('SELECT COUNT(*) FROM installments'))).toBe(3); expect((await off.req('GET', A)).body).toContain('فعال');
  });
  it('payment through HTTP is idempotent: a double submit books once', async () => {
    const A = '/credit/applications/1', pay = () => off.post(`${A}/pay`, { amount: '1000000', reference: 'REF-HTTP-01' }, A);
    await pay(); await pay(); expect(Number(await db.val('SELECT COUNT(*) FROM credit_payments'))).toBe(1);
    const body = (await off.req('GET', A)).body; expect(body).toContain('پرداخت جزئی');
  });
  it('credit to accounting posting through HTTP, then reconciliation shows the gap', async () => {
    fin = await new Browser().login('fin@t.test', 'Strong-pass-123'); acc = await new Browser().login('acc@t.test', 'Strong-pass-123');
    const accounts = await db.all('SELECT id, code FROM accounts WHERE company_id = ?', [cA]), id = (c: string) => String(accounts.find(a => a.code === c)!.id);
    for (const [role, code] of [['receivable', '1103'], ['merchant_payable', '2101'], ['fee_income', '4101'], ['cash_bank', '1102'], ['commission_income', '4101']]) await fin.post('/accounting/posting/map', { role, account_id: id(code) }, '/accounting/posting');
    const r = await acc.post('/accounting/posting/post', { event: 'credit.activate', ref: '1' }, '/accounting/posting'); expect(loc(r)).toMatch(/^\/accounting\/vouchers\/\d+$/);
    const again = await acc.post('/accounting/posting/post', { event: 'credit.activate', ref: '1' }, '/accounting/posting'); expect(loc(again)).toBe('/accounting/posting'); expect((await acc.req('GET', '/accounting/posting')).body).toContain('قبلاً سند ثبت شده');
    const page = (await fin.req('GET', '/accounting/posting')).body; expect(page).toContain('مغایرت‌گیری'); expect(page).toContain('۹٬۱۰۰٬۰۰۰');   // 10,100,000 - 1,000,000 still owed
  });
  it('a viewer cannot reach credit pages at all', async () => {
    const v = await makeUser(db, { id: 1, company_id: null, is_owner: 1 } as any, 'viewer', 'v@t.test', cA); void v;
    const b = await new Browser().login('v@t.test', 'Strong-pass-123'); expect((await b.req('GET', '/credit')).status).toBe(403); expect((await b.req('GET', '/accounting')).status).toBe(403);
  });
});
