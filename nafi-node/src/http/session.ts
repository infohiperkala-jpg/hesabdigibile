import { randomBytes } from 'node:crypto';
import { Db, Row } from '../core/db.js';
import { sha256, safeEqual } from '../core/crypto.js';

export const IDLE_SEC = 1800, MFA_SEC = 300;
export interface Sess { id: string; token: string | null; user_id: number | null; mfa_user_id: number | null; csrf: string; flash: [string, string] | null; created_at: string; seen_at: string }
const age = (ts: string) => (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;

export async function load(db: Db, token: string | undefined): Promise<Sess> {
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    const r = await db.one('SELECT * FROM sessions WHERE id = ?', [sha256(token)]);
    if (r && age(r.seen_at) <= IDLE_SEC) {
      await db.exec('UPDATE sessions SET seen_at = ? WHERE id = ?', [db.now(), r.id]);
      return { ...r as any, token, flash: r.flash ? JSON.parse(r.flash) : null, user_id: r.user_id === null ? null : Number(r.user_id), mfa_user_id: r.mfa_user_id === null ? null : Number(r.mfa_user_id) };
    }
    if (r) await db.exec('DELETE FROM sessions WHERE id = ?', [r.id]);
  }
  return create(db);
}
export async function create(db: Db): Promise<Sess> {
  const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex'), now = db.now();
  await db.exec('INSERT INTO sessions (id,csrf,created_at,seen_at) VALUES (?,?,?,?)', [sha256(token), csrf, now, now]);
  return { id: sha256(token), token, user_id: null, mfa_user_id: null, csrf, flash: null, created_at: now, seen_at: now };
}
/** Session fixation defence: a fresh id (and csrf token) is issued whenever privilege changes. */
export async function rotate(db: Db, s: Sess, patch: { user_id?: number | null; mfa_user_id?: number | null }): Promise<Sess> {
  await db.exec('DELETE FROM sessions WHERE id = ?', [s.id]); const n = await create(db);
  await db.exec('UPDATE sessions SET user_id = ?, mfa_user_id = ? WHERE id = ?', [patch.user_id ?? null, patch.mfa_user_id ?? null, n.id]);
  return { ...n, user_id: patch.user_id ?? null, mfa_user_id: patch.mfa_user_id ?? null };
}
export const destroy = (db: Db, s: Sess) => db.exec('DELETE FROM sessions WHERE id = ?', [s.id]);
export const setFlash = (db: Db, s: Sess, msg: string, type: 'ok' | 'err' = 'ok') => db.exec('UPDATE sessions SET flash = ? WHERE id = ?', [JSON.stringify([msg, type]), s.id]);
export const popFlash = async (db: Db, s: Sess) => { if (s.flash) await db.exec('UPDATE sessions SET flash = NULL WHERE id = ?', [s.id]); return s.flash; };
export const csrfOk = (s: Sess, t: unknown) => typeof t === 'string' && safeEqual(s.csrf, t);
export const mfaPendingValid = (s: Sess) => s.mfa_user_id !== null && age(s.created_at) <= MFA_SEC;
export async function user(db: Db, s: Sess): Promise<Row | null> {
  if (!s.user_id) return null;
  const u = await db.one("SELECT x.* FROM users x LEFT JOIN companies c ON c.id = x.company_id WHERE x.id = ? AND x.status = 'active' AND (x.company_id IS NULL OR c.status = 'active')", [s.user_id]);
  return u ? { ...u, id: Number(u.id), company_id: u.company_id === null ? null : Number(u.company_id) } : null;
}
