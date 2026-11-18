import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import { Invalid } from '../core/errors.js';
import { sealText, openText, blind, hashPassword, verifyPassword } from '../core/crypto.js';
import * as totp from '../core/totp.js';
import * as V from '../core/validator.js';
import { randomBytes } from 'node:crypto';
import { MAX_FAILS, LOCK_MINUTES } from './auth.js';

const fresh = async (db: Db, id: number): Promise<Row> => (await db.one('SELECT * FROM users WHERE id = ?', [id]))!;

export async function begin(db: Db, user: Actor): Promise<string> {
  const u = await fresh(db, user.id);
  if (u.mfa_enabled) throw new Invalid('احراز هویت دومرحله‌ای قبلاً فعال شده است.');
  const secret = totp.newSecret(); await db.exec('UPDATE users SET totp_secret_enc = ? WHERE id = ?', [sealText(secret), u.id]); return secret;
}
export async function pendingSecret(db: Db, user: Actor): Promise<string | null> {
  const u = await fresh(db, user.id); return !u.mfa_enabled && u.totp_secret_enc ? openText(u.totp_secret_enc) : null;
}
/** @returns one-time recovery codes, shown to the user exactly once */
export async function confirm(db: Db, user: Actor, code: string, now = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const u = await fresh(db, user.id);
  if (u.mfa_enabled || !u.totp_secret_enc) throw new Invalid('ابتدا فرایند فعال‌سازی را شروع کنید.');
  const step = totp.verify(openText(u.totp_secret_enc), code, now, Number(u.totp_last_step));
  if (step === null) throw new Invalid('کد نادرست است. کد ۶ رقمی فعلی برنامه را وارد کنید.');
  return db.tx(async t => {
    await t.exec('UPDATE users SET mfa_enabled = 1, totp_last_step = ? WHERE id = ?', [step, u.id]);
    await t.exec('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [u.id]);
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = randomBytes(9).toString('base64').replace(/[+/=]/g, 'X').slice(0, 10).toUpperCase(); codes.push(c);
      await t.exec('INSERT INTO mfa_recovery_codes (user_id,code_hash,created_at) VALUES (?,?,?)', [u.id, blind('recovery|' + c), t.now()]);
    }
    await audit.log(t, u as any, 'mfa.enable', 'user', u.id); return codes;
  });
}
/** Second login factor: 6-digit TOTP or a one-time recovery code. 5 failures lock the account for 15 minutes. */
export async function verifyLogin(db: Db, uid: number, code: string, now = Math.floor(Date.now() / 1000), ip: string | null = null): Promise<boolean> {
  const u = await fresh(db, uid);
  if (!u.mfa_enabled || (u.locked_until && u.locked_until > db.now())) return false;
  const c = V.digits(code.trim()); let ok = false;
  if (/^\d{6}$/.test(c)) {
    const step = totp.verify(openText(u.totp_secret_enc), c, now, Number(u.totp_last_step));
    if (step !== null) { await db.exec('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, uid]); ok = true; }
  } else {
    const row = await db.one('SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [uid, blind('recovery|' + c.toUpperCase().replace(/[\s-]/g, ''))]);
    if (row) { await db.exec('UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?', [db.now(), row.id]); await audit.log(db, u as any, 'mfa.recovery_used', 'user', uid, {}, undefined, ip); ok = true; }
  }
  if (ok) { await db.exec('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [uid]); return true; }
  const fails = Number(u.failed_logins) + 1, lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString().slice(0, 19).replace('T', ' ') : null;
  await db.exec('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [lock ? 0 : fails, lock, uid]);
  await audit.log(db, u as any, 'mfa.fail', 'user', uid, {}, undefined, ip); return false;
}
export const remainingRecoveryCodes = async (db: Db, uid: number): Promise<number> => Number(await db.val('SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', [uid]));
export async function disable(db: Db, user: Actor, password: string, code: string): Promise<void> {
  const u = await fresh(db, user.id);
  if (!u.mfa_enabled) throw new Invalid('احراز هویت دومرحله‌ای فعال نیست.');
  if (!(await verifyPassword(u.password_hash, password))) throw new Invalid('گذرواژه نادرست است.');
  if (!(await verifyLogin(db, Number(u.id), code))) throw new Invalid('کد دومرحله‌ای نادرست است.');
  await db.tx(async t => {
    await t.exec('UPDATE users SET mfa_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', [u.id]);
    await t.exec('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [u.id]); await audit.log(t, u as any, 'mfa.disable', 'user', u.id);
  });
}
export async function changePassword(db: Db, user: Actor, current: string, next: string): Promise<void> {
  const u = await fresh(db, user.id);
  if (!(await verifyPassword(u.password_hash, current))) { await audit.log(db, u as any, 'auth.password_change_fail', 'user', u.id); throw new Invalid('گذرواژه فعلی نادرست است.'); }
  V.password(next, u.email);
  if (await verifyPassword(u.password_hash, next)) throw new Invalid('گذرواژه جدید باید با گذرواژه فعلی متفاوت باشد.');
  await db.exec('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(next), u.id]);
  await audit.log(db, u as any, 'auth.password_change', 'user', u.id);
}
