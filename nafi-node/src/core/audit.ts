import { Db, Row } from './db.js';
import { sha256 } from './crypto.js';

export interface Actor { id: number; company_id: number | null; is_owner: number | boolean; [k: string]: any }
const ZERO = '0'.repeat(64);
const h = (prev: string, c: any, u: any, a: string, e: any, eid: any, d: any, at: string) => sha256([prev, c ?? '', u ?? '', a, e ?? '', eid ?? '', d ?? '', at].join('|'));

/**
 * Append-only audit trail with a hash chain. Writers are serialised by the row lock on audit_head, which is held until the
 * surrounding transaction commits (so concurrent writers can never fork the chain).
 */
export async function log(db: Db, user: Actor | null, action: string, entity: string | null = null, entityId: number | null = null, detail: object = {}, companyId?: number | null, ip: string | null = null): Promise<void> {
  const json = Object.keys(detail).length ? JSON.stringify(detail) : null;
  const cid = companyId !== undefined ? companyId : (user?.company_id ?? null);
  await db.tx(async t => {
    const head = await t.one('SELECT last_hash FROM audit_head WHERE id = 1 FOR UPDATE');
    const prev = head?.last_hash ?? ZERO, at = t.now();
    const hash = h(prev, cid, user?.id, action, entity, entityId, json, at);
    await t.exec('INSERT INTO audit_logs (company_id,user_id,action,entity,entity_id,detail,ip,prev_hash,hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [cid, user?.id ?? null, action, entity, entityId, json, ip, prev, hash, at]);
    await t.exec('UPDATE audit_head SET last_hash = ? WHERE id = 1', [hash]);
  });
}

/** @returns id of the first broken row, or null when the whole chain is intact */
export async function verify(db: Db): Promise<number | null> {
  let prev = ZERO;
  for (const r of await db.all<Row>('SELECT * FROM audit_logs ORDER BY id')) {
    if (r.prev_hash !== prev || r.hash !== h(prev, r.company_id, r.user_id, r.action, r.entity, r.entity_id, r.detail, r.created_at)) return Number(r.id);
    prev = r.hash;
  }
  const head = await db.val('SELECT last_hash FROM audit_head WHERE id = 1');
  return head === prev ? null : -1;   // -1: the tail of the chain was truncated
}
