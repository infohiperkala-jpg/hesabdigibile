import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser } from './helpers.js';
import { Db } from '../src/core/db.js';
import { makeHandler } from '../src/http/app.js';
import * as org from '../src/services/org.js';
import * as totp from '../src/core/totp.js';

let db: Db, drop: () => Promise<void>, h: ReturnType<typeof makeHandler>, ownerPass: string;
const tokenOf = (c?: string) => c?.match(/nafi_sid=([a-f0-9]+)/)?.[1];
const csrfOf = (b: string) => b.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? '';
let tok: string | undefined;
async function call(method: string, path: string, form: Record<string, string> = {}, ip = '10.0.0.1') {
  const r = await h({ method, path, query: new URLSearchParams(), form: new URLSearchParams(form), ip, secure: false }, tok);
  const t = tokenOf(r.cookie) ?? tokenOf(r.headers?.['Set-Cookie']); if (t) tok = t; if (r.headers?.['Set-Cookie']?.includes('Max-Age=0')) tok = undefined; return r;
}
async function login(email: string, pass: string) { tok = undefined; const g = await call('GET', '/login'); return call('POST', '/login', { email, password: pass, _csrf: csrfOf(g.body) }); }
beforeAll(async () => {
  process.env.MFA_REQUIRED = '1'; ({ db, drop } = await freshDb()); h = makeHandler(db);
  const owner = await makeOwner(db); const c = await org.createCompany(db, owner, 'شرکت الف'); await makeUser(db, owner, 'viewer', 'v@t.test', c, 'Viewer-pass-123'); ownerPass = 'Owner-pass-1';
});
afterAll(async () => { await drop(); });

describe('HTTP layer', () => {
  it('anonymous users are sent to /login; forged CSRF is rejected (419)', async () => {
    tok = undefined; expect((await call('GET', '/')).headers?.Location).toBe('/login');
    const g = await call('GET', '/login'); expect(csrfOf(g.body)).toHaveLength(64);
    expect((await call('POST', '/login', { email: 'owner@t.test', password: ownerPass, _csrf: 'forged' })).status).toBe(419);
  });
  it('wrong password does not log in; the session id changes after login (fixation defence)', async () => {
    tok = undefined; let g = await call('GET', '/login'); const before = tok;
    expect((await call('POST', '/login', { email: 'owner@t.test', password: 'nope-nope-1', _csrf: csrfOf(g.body) })).headers?.Location).toBe('/login');
    g = await call('GET', '/login'); await call('POST', '/login', { email: 'owner@t.test', password: ownerPass, _csrf: csrfOf(g.body) }); expect(tok).not.toBe(before);
  });
  it('MFA is enforced: pages redirect to /account until enrolled; then second factor is required at login', async () => {
    expect((await call('GET', '/companies')).headers?.Location).toBe('/account');
    let a = await call('GET', '/account'); await call('POST', '/account/mfa', { action: 'begin', _csrf: csrfOf(a.body) });
    a = await call('GET', '/account'); const secret = a.body.match(/<pre>([A-Z2-7]{32})<\/pre>/)![1], now = Math.floor(Date.now() / 1000);
    const code = (t: number) => totp.code(totp.base32Decode(secret), Math.floor(t / 30));
    const c = await call('POST', '/account/mfa', { action: 'confirm', code: code(now), _csrf: csrfOf(a.body) }); expect(c.body).toMatch(/<pre>[A-Z0-9]{10}/);
    expect((await call('GET', '/companies')).status).toBe(200);
    await call('POST', '/logout', { _csrf: csrfOf((await call('GET', '/')).body) });
    const l = await login('owner@t.test', ownerPass); expect(l.headers?.Location).toBe('/login/mfa');
    expect((await call('GET', '/')).headers?.Location).toBe('/login');                         // password alone grants nothing
    let m = await call('GET', '/login/mfa'); expect((await call('POST', '/login/mfa', { code: '111111', _csrf: csrfOf(m.body) })).headers?.Location).toBe('/login/mfa');
    m = await call('GET', '/login/mfa'); expect((await call('POST', '/login/mfa', { code: code(now + 30), _csrf: csrfOf(m.body) })).headers?.Location).toBe('/');
    expect((await call('GET', '/')).status).toBe(200);
  });
  it('user input is HTML-escaped on output (XSS) and errors never leak internals', async () => {
    const g = await call('GET', '/companies'); await call('POST', '/companies', { name: '<script>alert(1)</script> شرکت', _csrf: csrfOf(g.body) });
    const p = (await call('GET', '/companies')).body; expect(p).not.toContain('<script>alert'); expect(p).toContain('&lt;script&gt;');
    const nf = await call('GET', '/definitely-missing'); expect(nf.status).toBe(404); expect(nf.body).not.toMatch(/stack|node_modules|\.ts:/);
  });
  it('a restricted role gets 403 on pages it has no permission for', async () => {
    process.env.MFA_REQUIRED = '0'; await login('v@t.test', 'Viewer-pass-123'); expect((await call('GET', '/audit')).status).toBe(403); expect((await call('GET', '/users')).status).toBe(403); expect((await call('GET', '/companies')).status).toBe(200);
    process.env.MFA_REQUIRED = '1';
  });
  it('logout destroys the session server-side', async () => {
    process.env.MFA_REQUIRED = '0'; await login('v@t.test', 'Viewer-pass-123'); const old = tok!; const g = await call('GET', '/'); await call('POST', '/logout', { _csrf: csrfOf(g.body) });
    tok = old; expect((await call('GET', '/')).headers?.Location).toBe('/login'); process.env.MFA_REQUIRED = '1';
  });
});
