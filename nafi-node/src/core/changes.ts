import { Db, Row } from './db.js';
import { Actor } from './audit.js';
import * as audit from './audit.js';
import { Invalid } from './errors.js';

export type Changes = Record<string, [unknown, unknown]>;
import { createHash } from 'node:crypto';
/** Volatile columns that change without anybody "editing" the record (logins, lockouts): they must not invalidate an open edit form. */
const VOLATILE = new Set(['last_login_at', 'failed_logins', 'locked_until', 'totp_last_step']);
/** Concurrency token of a row = hash of its content (second-resolution timestamps would collide for two quick edits). */
export const versionOf = (r: Row): string => createHash('sha256').update(JSON.stringify(Object.entries(r).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)))).digest('hex').slice(0, 20);

/** Optimistic concurrency: if the form was rendered before somebody else saved, refuse instead of silently overwriting. */
export function assertVersion(row: Row, expected: string | undefined | null): void {
  if (expected !== undefined && expected !== null && expected !== versionOf(row)) throw new Invalid('این رکورد پس از باز شدن صفحه توسط کاربر دیگری تغییر کرده است؛ صفحه را دوباره بارگذاری کنید و تغییرات را دوباره اعمال کنید.');
}
/** Only the fields that really changed. Strings compared trimmed; numbers numerically. */
export function diff(before: Row, after: Record<string, unknown>): Changes {
  const out: Changes = {};
  for (const [k, v] of Object.entries(after)) { const o = before[k]; if (String(o ?? '') !== String(v ?? '')) out[k] = [o ?? null, v ?? null]; }
  return out;
}
/** Writes the field-level before/after record (visible on the entity's history panel) and an audit entry. */
export async function record(db: Db, a: Actor | null, companyId: number | null, entity: string, entityId: number, changes: Changes, note = ''): Promise<void> {
  if (!Object.keys(changes).length) return;
  await db.exec('INSERT INTO change_log (company_id,entity,entity_id,user_id,changes,note,created_at) VALUES (?,?,?,?,?,?,?)', [companyId, entity, entityId, a?.id ?? null, JSON.stringify(changes), note.trim().slice(0, 500) || null, db.now()]);
  await audit.log(db, a, `${entity}.update`, entity, entityId, { fields: Object.keys(changes) }, companyId);
}
export const history = (db: Db, entity: string, entityId: number): Promise<Row[]> =>
  db.all('SELECT c.*, u.name AS uname FROM change_log c LEFT JOIN users u ON u.id = c.user_id WHERE c.entity = ? AND c.entity_id = ? ORDER BY c.id DESC', [entity, entityId]);
export function requireNote(note: string, min = 5): string { note = note.trim(); if ([...note].length < min) throw new Invalid(`ثبت دلیل (حداقل ${min} کاراکتر) الزامی است.`); return note.slice(0, 500); }
