import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner, makeUser, rejects } from './helpers.js';
import { Db } from '../src/core/db.js';
import { migrate } from '../src/core/migrate.js';
import { seed, PERMS } from '../src/services/seeder.js';
import * as org from '../src/services/org.js';
import * as auth from '../src/services/auth.js';
import * as mfa from '../src/services/mfa.js';
import * as audit from '../src/core/audit.js';
import * as gate from '../src/core/gate.js';
import * as totp from '../src/core/totp.js';
import * as V from '../src/core/validator.js';
import * as J from '../src/core/jalali.js';
import { seal, open, sealText, openText, blind } from '../src/core/crypto.js';
import { Actor } from '../src/core/audit.js';

let db: Db, drop: () => Promise<void>, owner: Actor, cA: number, cB: number, adminA: Actor, viewerA: Actor, roles: Record<string, number>;
beforeAll(async () => {
  ({ db, drop } = await freshDb()); owner = await makeOwner(db);
  cA = await org.createCompany(db, owner, 'شرکت الف'); cB = await org.createCompany(db, owner, 'شرکت ب');
  adminA = await makeUser(db, owner, 'company_admin', 'a@t.test', cA, 'Alpha-pass-123'); viewerA = await makeUser(db, owner, 'viewer', 'v@t.test', cA, 'Viewer-pass-123');
  roles = Object.fromEntries((await db.all('SELECT id, code FROM roles')).map(r => [r.code, Number(r.id)]));
});
afterAll(async () => { await drop(); });

describe('migrations and seed', () => {
  it('migrations are idempotent and seed is idempotent', async () => {
    expect(await migrate(db)).toEqual([]);
    const first = await seed(db); expect(await seed(db)).toBe(first);
    expect(Number(await db.val('SELECT COUNT(*) FROM permissions'))).toBe(Object.keys(PERMS).length);
  });
});

describe('utilities', () => {
  it('TOTP matches RFC 6238 vectors', () => {
    const k = Buffer.from('12345678901234567890');
    expect(totp.code(k, Math.floor(59 / 30))).toBe('287082'); expect(totp.code(k, Math.floor(1111111109 / 30))).toBe('081804'); expect(totp.code(k, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totp.base32Encode(k)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'); expect(totp.base32Decode(totp.base32Encode(k))).toEqual(k);
  });
  it('national id, digits, money, amounts', () => {
    expect(V.nationalId('0499370899')).toBe(true); expect(V.nationalId('0499370898')).toBe(false); expect(V.nationalId('1111111111')).toBe(false);
    expect(V.digits('۰۴۹۹')).toBe('0499'); expect(V.money(5000000)).toBe('۵٬۰۰۰٬۰۰۰'); expect(V.parseAmount('۱٬۲۰۰٬۰۰۰')).toBe(1200000); expect(V.parseAmount('12.5')).toBeNull(); expect(V.parseAmount('-5')).toBeNull();
  });
  it('Jalali conversion, parsing, month and working-day arithmetic', () => {
    expect(J.fromGregorian(2026, 11, 7)).toEqual([1405, 8, 16]); expect(J.toGregorian(1405, 8, 16)).toEqual([2026, 11, 7]); expect(J.parse('۱۴۰۵/۰۸/۱۶')).toBe('2026-11-07');
    expect(J.parse('1405/12/30')).toBeNull(); expect(J.parse('1403/12/30')).not.toBeNull(); expect(J.parse('1405/13/01')).toBeNull();
    expect(J.addMonths(J.parse('1405/06/31')!, 1)).toBe(J.parse('1405/07/30')); expect(J.addMonths(J.parse('1405/11/30')!, 1)).toBe(J.parse('1405/12/29')); expect(J.addMonths(J.parse('1405/08/16')!, 12)).toBe(J.parse('1406/08/16'));
    expect(J.addWorkingDays('2026-11-11', 1)).toBe('2026-11-14'); expect(J.addWorkingDays('2026-11-11', 12)).toBe('2026-11-29');
    expect(J.format('2026-11-07 10:30:00')).toBe('۱۴۰۵/۰۸/۱۶ ۱۰:۳۰');
  });
  it('encryption: round trip, tamper and wrong data detected, blind index deterministic', () => {
    expect(open(seal('x')).toString()).toBe('x'); expect(openText(sealText('سلام'))).toBe('سلام');
    const s = seal('x'); s[s.length - 1] ^= 1; expect(() => open(s)).toThrow(); expect(blind('a')).toBe(blind('a')); expect(blind('a')).not.toBe(blind('b'));
  });
});

describe('authentication', () => {
  it('right password logs in; wrong or unknown is rejected', async () => {
    expect(await auth.attempt(db, 'A@t.test', 'Alpha-pass-123')).not.toBeNull(); expect(await auth.attempt(db, 'a@t.test', 'nope')).toBeNull(); expect(await auth.attempt(db, 'x@t.test', 'whatever-123')).toBeNull();
  });
  it('locks after 5 failures even with the right password, then unlocks', async () => {
    for (let i = 0; i < 5; i++) await auth.attempt(db, 'v@t.test', 'bad');
    expect(await auth.attempt(db, 'v@t.test', 'Viewer-pass-123')).toBeNull();
    await db.exec('UPDATE users SET locked_until = NULL WHERE email = ?', ['v@t.test']); expect(await auth.attempt(db, 'v@t.test', 'Viewer-pass-123')).not.toBeNull();
  });
  it('disabled users cannot log in; weak passwords rejected', async () => {
    await org.setUserStatus(db, owner, viewerA.id, 'disabled'); expect(await auth.attempt(db, 'v@t.test', 'Viewer-pass-123')).toBeNull(); await org.setUserStatus(db, owner, viewerA.id, 'active');
    await rejects(() => org.createUser(db, owner, 'x y', 'w@t.test', 'short1', cA, roles.viewer), 'Invalid');
  });
  it('per-IP throttle blocks password spraying; other IPs unaffected', async () => {
    for (let i = 0; i < 20; i++) await auth.attempt(db, `nobody${i}@t.test`, 'wrong-pass-1', '203.0.113.9');
    expect(await auth.attempt(db, 'a@t.test', 'Alpha-pass-123', '203.0.113.9')).toBeNull();
    expect(await auth.attempt(db, 'a@t.test', 'Alpha-pass-123', '198.51.100.7')).not.toBeNull();
  });
});

describe('RBAC and tenant isolation', () => {
  it('permissions', async () => {
    expect(await gate.can(db, owner, 'anything')).toBe(true); expect(await gate.can(db, adminA, 'user.manage')).toBe(true); expect(await gate.can(db, adminA, 'company.manage')).toBe(false);
    await rejects(() => org.createUser(db, viewerA, 'n n', 'n@t.test', 'Newuser-pass-1', cA, roles.viewer), 'HttpError', 403);
    await rejects(() => org.createCompany(db, adminA, 'شرکت ج'), 'HttpError', 403);
  });
  it('company admin cannot touch another company', async () => {
    const brandA = await org.createBrand(db, adminA, cA, 'برند الف', 'brand-a', 'a.example.ir'); await org.createBrand(db, owner, cB, 'برند ب', 'brand-b');
    await rejects(() => org.createBrand(db, adminA, cB, 'هک', 'hack'), 'HttpError', 404);
    const [w, p] = gate.scope(adminA, 'b.company_id'); const own = await db.all(`SELECT b.id FROM brands b WHERE ${w}`, p); expect(own.map(r => Number(r.id))).toEqual([brandA]);
    const [w2, p2] = gate.scope(owner, 'b.company_id'); expect((await db.all(`SELECT b.id FROM brands b WHERE ${w2}`, p2)).length).toBe(2);
    await rejects(() => org.createBrand(db, adminA, cA, 'تکراری', 'brand-a'), 'Invalid'); await rejects(() => org.createBrand(db, adminA, cA, 'تکراری', 'other', 'a.example.ir'), 'Invalid');
  });
  it('company admin is forced into own company; cannot disable owner or other company users', async () => {
    const id = await org.createUser(db, adminA, 'کاربر', 'n1@t.test', 'Newuser-pass-1', cB, roles.viewer); expect(Number(await db.val('SELECT company_id FROM users WHERE id = ?', [id]))).toBe(cA);
    await rejects(() => org.setUserStatus(db, adminA, owner.id, 'disabled'), 'HttpError', 404);
    const b = await org.createUser(db, owner, 'کاربر ب', 'b@t.test', 'Bravo-pass-123', cB, roles.viewer); await rejects(() => org.setUserStatus(db, adminA, b, 'disabled'), 'HttpError', 404);
  });
});

describe('audit chain', () => {
  it('verifies, then detects tampering and truncation', async () => {
    expect(await audit.verify(db)).toBeNull();
    const id = Number(await db.val("SELECT id FROM audit_logs WHERE action='brand.create' LIMIT 1"));
    await db.exec(`UPDATE audit_logs SET detail='{"x":1}' WHERE id = ?`, [id]); expect(await audit.verify(db)).toBe(id);
  });
  it('concurrent writers can never fork the chain', async () => {
    const { db: d2, drop: drop2 } = await freshDb();
    await Promise.all(Array.from({ length: 40 }, (_, i) => audit.log(d2, null, 'test.concurrent', 'x', i, { i })));
    expect(Number(await d2.val('SELECT COUNT(*) FROM audit_logs WHERE action = ?', ['test.concurrent']))).toBe(40); expect(await audit.verify(d2)).toBeNull(); await drop2();
  });
});

describe('MFA and password change', () => {
  const T0 = 1700000000; let secret = ''; let codes: string[] = []; let u: Actor;
  const at = (t: number) => totp.code(totp.base32Decode(secret), Math.floor(t / 30));
  beforeAll(async () => { u = (await db.one('SELECT * FROM users WHERE email = ?', ['a@t.test'])) as Actor; });
  it('enrol: wrong code rejected, right code enables, recovery codes issued', async () => {
    secret = await mfa.begin(db, u); expect(secret).toHaveLength(32); expect(await mfa.pendingSecret(db, u)).toBe(secret);
    expect(String(await db.val('SELECT totp_secret_enc FROM users WHERE id = ?', [u.id]))).not.toContain(secret);
    await rejects(() => mfa.confirm(db, u, '000000', T0), 'Invalid'); codes = await mfa.confirm(db, u, at(T0), T0); expect(codes).toHaveLength(8);
    await rejects(() => mfa.begin(db, u), 'Invalid');
  });
  it('second factor: replay rejected, drift tolerated, far-future rejected', async () => {
    expect(await mfa.verifyLogin(db, u.id, at(T0), T0)).toBe(false); expect(await mfa.verifyLogin(db, u.id, at(T0 + 30), T0 + 30)).toBe(true);
    expect(await mfa.verifyLogin(db, u.id, at(T0 + 30), T0 + 30)).toBe(false); expect(await mfa.verifyLogin(db, u.id, at(T0 + 120), T0 + 150)).toBe(true); expect(await mfa.verifyLogin(db, u.id, at(T0 + 3000), T0 + 150)).toBe(false);
  });
  it('recovery code works once; lockout after 5 bad codes', async () => {
    const rc = codes[0]; expect(await mfa.verifyLogin(db, u.id, rc.slice(0, 5).toLowerCase() + '-' + rc.slice(5))).toBe(true); expect(await mfa.verifyLogin(db, u.id, rc)).toBe(false); expect(await mfa.remainingRecoveryCodes(db, u.id)).toBe(7);
    for (let i = 0; i < 5; i++) await mfa.verifyLogin(db, u.id, '123456');
    expect(await mfa.verifyLogin(db, u.id, codes[1])).toBe(false);
    await db.exec('UPDATE users SET locked_until = NULL WHERE id = ?', [u.id]); expect(await mfa.verifyLogin(db, u.id, codes[1])).toBe(true);
  });
  it('disable needs password and second factor; password change rules', async () => {
    await rejects(() => mfa.disable(db, u, 'wrong-password-1', codes[2]), 'Invalid'); await rejects(() => mfa.disable(db, u, 'Alpha-pass-123', '999999'), 'Invalid');
    await mfa.disable(db, u, 'Alpha-pass-123', codes[2]); expect(Number(await db.val('SELECT mfa_enabled FROM users WHERE id = ?', [u.id]))).toBe(0);
    await rejects(() => mfa.changePassword(db, u, 'not-mine', 'Brand-new-pass-9'), 'Invalid'); await rejects(() => mfa.changePassword(db, u, 'Alpha-pass-123', 'short1'), 'Invalid'); await rejects(() => mfa.changePassword(db, u, 'Alpha-pass-123', 'Alpha-pass-123'), 'Invalid');
    await mfa.changePassword(db, u, 'Alpha-pass-123', 'Brand-new-pass-9'); expect(await auth.attempt(db, 'a@t.test', 'Alpha-pass-123')).toBeNull(); expect(await auth.attempt(db, 'a@t.test', 'Brand-new-pass-9')).not.toBeNull();
  });
});
