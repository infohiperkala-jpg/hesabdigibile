import { randomBytes } from 'node:crypto';
import { createPool, Db, openDb } from '../src/core/db.js';
import { migrate } from '../src/core/migrate.js';
import { seed } from '../src/services/seeder.js';
import { generateKey, hashPassword } from '../src/core/crypto.js';
import * as org from '../src/services/org.js';
import { Actor } from '../src/core/audit.js';

process.env.DB_USER ??= 'nafi'; process.env.DB_PASS ??= 'nafi-test-pass'; process.env.APP_KEY ??= generateKey();

/** Creates a brand-new empty MySQL database, migrates and seeds it. Each test file gets its own. */
export async function freshDb(): Promise<{ db: Db; name: string; drop: () => Promise<void> }> {
  const name = 'nafi_node_' + randomBytes(4).toString('hex');
  const admin = new Db(createPool('mysql'));
  await admin.exec(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  const db = openDb(name); await migrate(db); await seed(db);
  return { db, name, drop: async () => { await db.close(); await admin.exec(`DROP DATABASE \`${name}\``); await admin.close(); } };
}
export async function makeOwner(db: Db): Promise<Actor> {
  const id = await db.insert('INSERT INTO users (company_id,name,email,password_hash,is_owner,created_at) VALUES (NULL,?,?,?,1,?)', ['Owner', 'owner@t.test', await hashPassword('Owner-pass-1'), db.now()]);
  return { id, company_id: null, is_owner: 1 };
}
export async function makeUser(db: Db, owner: Actor, role: string, email: string, companyId: number, password = 'Strong-pass-123'): Promise<Actor> {
  const rid = await db.val('SELECT id FROM roles WHERE code = ? AND company_id IS NULL', [role]);
  const id = await org.createUser(db, owner, 'کاربر ' + role, email, password, companyId, rid);
  const u = (await db.one('SELECT * FROM users WHERE id = ?', [id]))!; return { ...u, id, company_id: Number(u.company_id) } as Actor;
}
export async function rejects(fn: () => Promise<any>, name: string, status?: number): Promise<void> {
  try { await fn(); } catch (e: any) { if (e.name !== name) throw new Error(`expected ${name}, got ${e.name}: ${e.message}`); if (status !== undefined && e.status !== status) throw new Error(`status ${e.status} != ${status}`); return; }
  throw new Error(`expected ${name}`);
}

import { sealText, blind } from '../src/core/crypto.js';
/** Inserts an identity profile + folder directly (the registration module is not ported yet). */
export async function makeProfile(db: Db, owner: Actor, companyId: number, nid: string, status = 'approved_final', first = 'علی', last = 'رضایی'): Promise<number> {
  const now = db.now();
  const id = await db.insert('INSERT INTO identity_profiles (company_id,first_name,last_name,national_id_enc,national_id_hash,national_id_last3,mobile,status,consent_at,consent_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [companyId, first, last, sealText(nid), blind(nid), nid.slice(-3), '09123456789', status, now, 'v1', owner.id, now, now]);
  await db.exec('INSERT INTO digital_folders (company_id,profile_id,folder_no,created_at) VALUES (?,?,?,?)', [companyId, id, `F-1405-${String(id).padStart(5, '0')}`, now]);
  return id;
}

import { deflateSync, crc32 } from 'node:zlib';
/** A valid truecolour PNG of the given size (for upload tests). */
export function png(w: number, h: number, shade = 0x90): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h, shade); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const chunk = (t: string, d: Buffer) => { const b = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(b)); const l = Buffer.alloc(4); l.writeUInt32BE(d.length); return Buffer.concat([l, b, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
