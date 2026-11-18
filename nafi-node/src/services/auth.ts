import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { hashPassword, verifyPassword } from '../core/crypto.js';

export const MAX_FAILS = 5, LOCK_MINUTES = 15, IP_MAX_FAILS = 20, IP_WINDOW_MIN = 15;
const ts = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace('T', ' ');
let dummy: string | null = null;

/** Verifies credentials with account lockout and a per-IP throttle. Returns the user row or null; never reveals which part failed. */
export async function attempt(db: Db, email: string, password: string, ip: string | null = null): Promise<Row | null> {
  if (ip && Number(await db.val('SELECT COUNT(*) FROM login_attempts WHERE ip = ? AND created_at > ?', [ip, ts(-IP_WINDOW_MIN * 60000)])) >= IP_MAX_FAILS) {
    await audit.log(db, null, 'auth.ip_blocked', null, null, {}, null, ip); return null;           // stops password spraying across many accounts
  }
  const fail = async () => { if (ip) await db.exec('INSERT INTO login_attempts (ip,created_at) VALUES (?,?)', [ip, db.now()]); };
  const u = await db.one('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (!u) { await verifyPassword(dummy ??= await hashPassword('dummy-password-1'), password); await fail(); await audit.log(db, null, 'auth.fail', null, null, { reason: 'unknown' }, null, ip); return null; }
  const now = db.now();
  if (u.company_id !== null && (await db.val('SELECT status FROM companies WHERE id = ?', [u.company_id])) !== 'active') { await fail(); await audit.log(db, u as any, 'auth.company_inactive', 'user', u.id, {}, undefined, ip); return null; }   // suspended/archived company: nobody gets in
  if (u.locked_until && u.locked_until > now) { await audit.log(db, u as any, 'auth.locked', 'user', u.id, {}, undefined, ip); return null; }
  if (u.status !== 'active' || !(await verifyPassword(u.password_hash, password))) {
    await fail(); const fails = Number(u.failed_logins) + 1, lock = fails >= MAX_FAILS ? ts(LOCK_MINUTES * 60000) : null;
    await db.exec('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock, u.id]);
    await audit.log(db, u as any, lock ? 'auth.lockout' : 'auth.fail', 'user', u.id, {}, undefined, ip); return null;
  }
  await db.exec('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [now, u.id]);
  await audit.log(db, u as any, 'auth.login', 'user', u.id, {}, undefined, ip);
  return u;
}
