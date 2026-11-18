import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Db, Row } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';
import * as ch from '../core/changes.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as V from '../core/validator.js';
import { sealText, openText, blind, seal, open, sha256 } from '../core/crypto.js';
import { env } from '../core/env.js';

export const STATUS: Record<string, string> = { draft: 'پیش‌نویس', submitted: 'ثبت اولیه', awaiting_docs: 'منتظر مدارک', awaiting_review: 'در انتظار بررسی کارشناس', needs_fix: 'نیازمند اصلاح', approved_initial: 'تأیید اولیه', approved_final: 'تأیید نهایی', rejected: 'ردشده', expired: 'منقضی', archived: 'بایگانی‌شده' };
/** from => to => capability (manage = registrar, review = document expert). */
const FLOW: Record<string, Record<string, string>> = {
  draft: { submitted: 'manage' }, submitted: { awaiting_docs: 'review', awaiting_review: 'manage', rejected: 'review' }, awaiting_docs: { awaiting_review: 'manage', rejected: 'review' },
  needs_fix: { awaiting_review: 'manage', rejected: 'review' }, awaiting_review: { approved_initial: 'review', needs_fix: 'review', rejected: 'review' },
  approved_initial: { approved_final: 'review', needs_fix: 'review', rejected: 'review' }, approved_final: { expired: 'review', archived: 'review' }, expired: { archived: 'review' }, rejected: { archived: 'review' },
};
const NOTE_REQUIRED = ['awaiting_docs', 'needs_fix', 'rejected', 'expired', 'archived'];
const EDITABLE_BY_REGISTRAR = ['draft', 'submitted', 'awaiting_docs', 'needs_fix'], EDITABLE_BY_REVIEWER = [...EDITABLE_BY_REGISTRAR, 'awaiting_review', 'approved_initial'];
export const KINDS: Record<string, string> = { id_front: 'روی کارت ملی', id_back: 'پشت کارت ملی', other_id: 'مدرک هویتی مکمل', supporting: 'مدرک پشتیبان', contract: 'قرارداد امضاشده' };
export const CONSENT_VERSION = 'v1', MAX_BYTES = 8 * 1024 * 1024;
const len = (s: string) => [...s].length;

export async function createPerson(db: Db, a: Actor, input: Record<string, string | undefined>): Promise<number> {
  await gate.require_(db, a, 'registration.manage');
  const companyId = gate.isGroup(a) ? Number(input.company_id || 0) : Number(a.company_id); gate.assertCompany(a, companyId);
  if (!(await db.val('SELECT 1 FROM companies WHERE id = ?', [companyId]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  const fn = (input.first_name ?? '').trim(), ln = (input.last_name ?? '').trim(), nid = V.digits((input.national_id ?? '').trim()), mob = V.digits((input.mobile ?? '').trim());
  if (len(fn) < 2 || len(fn) > 60 || len(ln) < 2 || len(ln) > 60) throw new Invalid('نام و نام خانوادگی باید بین ۲ تا ۶۰ کاراکتر باشد.');
  if (!V.nationalId(nid)) throw new Invalid('ساختار کد ملی معتبر نیست.'); if (!V.mobile(mob)) throw new Invalid('شماره موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.');
  if (!input.consent) throw new Invalid('ثبت رضایت‌نامه الزامی است.');
  const hash = blind(nid); if (await db.val('SELECT 1 FROM identity_profiles WHERE company_id = ? AND national_id_hash = ?', [companyId, hash])) throw new Invalid('پرونده‌ای با این کد ملی قبلاً ثبت شده است.');
  return db.tx(async t => {
    const now = t.now(), id = await t.insert('INSERT INTO identity_profiles (company_id,first_name,last_name,national_id_enc,national_id_hash,national_id_last3,mobile,consent_at,consent_version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [companyId, fn, ln, sealText(nid), hash, nid.slice(-3), mob, now, CONSENT_VERSION, a.id, now, now]);
    const fid = await t.insert('INSERT INTO digital_folders (company_id,profile_id,type,created_at) VALUES (?,?,?,?)', [companyId, id, 'customer', now]);
    await t.exec('UPDATE digital_folders SET folder_no = ? WHERE id = ?', [`F-${new Date().getUTCFullYear()}-${String(fid).padStart(5, '0')}`, fid]);
    await t.exec('INSERT INTO profile_status_history (company_id,profile_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?,?)', [companyId, id, null, 'draft', a.id, 'ایجاد پرونده', now]);
    await audit.log(t, a, 'profile.create', 'profile', id, { folder: fid }, companyId); return id;   // no PII in audit detail
  });
}
export async function find(db: Db, a: Actor, id: number): Promise<Row> {
  await gate.require_(db, a, 'registration.view');
  const r = await db.one('SELECT p.*, f.id AS folder_id, f.folder_no FROM identity_profiles p JOIN digital_folders f ON f.profile_id = p.id WHERE p.id = ?', [id]);
  if (!r) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(r.company_id)); return r;
}
export async function search(db: Db, a: Actor, q = ''): Promise<Row[]> {
  await gate.require_(db, a, 'registration.view'); const [w, p] = gate.scope(a, 'p.company_id');
  let sql = `SELECT p.id, p.first_name, p.last_name, p.national_id_last3, p.mobile, p.status, p.created_at, f.folder_no FROM identity_profiles p JOIN digital_folders f ON f.profile_id = p.id WHERE ${w}`; q = V.digits(q.trim());
  if (q) {
    if (/^\d{10}$/.test(q)) { sql += ' AND p.national_id_hash = ?'; p.push(blind(q)); }   // exact national-ID lookup through the blind index
    else { const like = '%' + q.replace(/[|%_]/g, m => '|' + m) + '%'; sql += " AND (f.folder_no LIKE ? ESCAPE '|' OR p.first_name LIKE ? ESCAPE '|' OR p.last_name LIKE ? ESCAPE '|' OR p.mobile LIKE ? ESCAPE '|')"; p.push(like, like, like, like); }
  }
  return db.all(sql + ' ORDER BY p.id DESC LIMIT 100', p);
}
export async function allowed(db: Db, a: Actor, p: Row): Promise<Record<string, string>> {
  const o: Record<string, string> = {}; for (const [to, cap] of Object.entries(FLOW[p.status] ?? {})) if (await gate.can(db, a, `registration.${cap}`)) o[to] = STATUS[to]; return o;
}
async function liveFiles(db: Db, profileId: number, kind: string): Promise<boolean> { return !!(await db.val("SELECT 1 FROM document_files WHERE profile_id = ? AND kind = ? AND processing_state <> 'removed'", [profileId, kind])); }
export async function transition(db: Db, a: Actor, id: number, to: string, note = ''): Promise<void> {
  const p = await find(db, a, id), cap = FLOW[p.status]?.[to]; if (!cap) throw new Invalid('این تغییر وضعیت مجاز نیست.');
  await gate.require_(db, a, `registration.${cap}`); note = note.trim();
  if (NOTE_REQUIRED.includes(to) && len(note) < 5) throw new Invalid('برای این وضعیت، ثبت توضیح (حداقل ۵ کاراکتر) الزامی است.');
  if (to === 'awaiting_review' && !(await liveFiles(db, id, 'id_front'))) throw new Invalid('پیش از ارسال برای بررسی، تصویر روی کارت ملی را بارگذاری کنید.');
  if (to === 'approved_final' && !(await db.val("SELECT 1 FROM document_ocr_results r JOIN document_files f ON f.id = r.file_id WHERE f.profile_id = ? AND r.status = 'confirmed' AND f.processing_state <> 'removed'", [id]))) throw new Invalid('برای تأیید نهایی، تطبیق کد ملی مدرک با اطلاعات واردشده توسط کارشناس باید ثبت شود.');
  await db.tx(async t => {
    await t.exec('UPDATE identity_profiles SET status = ?, updated_at = ? WHERE id = ?', [to, t.now(), id]);
    await t.exec('INSERT INTO profile_status_history (company_id,profile_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?,?)', [p.company_id, id, p.status, to, a.id, note || null, t.now()]);
    await audit.log(t, a, 'profile.status', 'profile', id, { from: p.status, to }, Number(p.company_id));
  });
}
export const history = (db: Db, id: number): Promise<Row[]> => db.all('SELECT h.*, u.name AS uname FROM profile_status_history h LEFT JOIN users u ON u.id = h.user_id WHERE h.profile_id = ? ORDER BY h.id DESC', [id]);
/** Full national ID only for reviewers; every reveal is audited. */
export async function revealNationalId(db: Db, a: Actor, p: Row): Promise<string> { await gate.require_(db, a, 'registration.review'); await audit.log(db, a, 'profile.view_sensitive', 'profile', Number(p.id), {}, Number(p.company_id)); return openText(p.national_id_enc); }

// ───────── editing ─────────
export async function canEdit(db: Db, a: Actor, p: Row): Promise<boolean> {
  if (await gate.can(db, a, 'registration.review')) return EDITABLE_BY_REVIEWER.includes(p.status);
  return (await gate.can(db, a, 'registration.manage')) && EDITABLE_BY_REGISTRAR.includes(p.status);
}
export const versionOf = (p: Row) => ch.versionOf({ first_name: p.first_name, last_name: p.last_name, mobile: p.mobile, status: p.status, national_id_hash: p.national_id_hash });
/** Registrars edit while the file is still being assembled; reviewers also while it is under review. After final approval nothing can change (archive/expire instead). */
export async function editProfile(db: Db, a: Actor, id: number, input: { first_name: string; last_name: string; mobile: string }, version?: string): Promise<void> {
  const p = await find(db, a, id), isReviewer = await gate.can(db, a, 'registration.review');
  if (!isReviewer) await gate.require_(db, a, 'registration.manage');
  if (!(isReviewer ? EDITABLE_BY_REVIEWER : EDITABLE_BY_REGISTRAR).includes(p.status)) throw new Invalid('در این وضعیت امکان ویرایش مشخصات وجود ندارد.');
  if (version && version !== versionOf(p)) throw new Invalid('این پرونده پس از باز شدن صفحه تغییر کرده است؛ صفحه را دوباره بارگذاری کنید.');
  const fn = input.first_name.trim(), ln = input.last_name.trim(), mob = V.digits(input.mobile.trim());
  if (len(fn) < 2 || len(fn) > 60 || len(ln) < 2 || len(ln) > 60) throw new Invalid('نام و نام خانوادگی باید بین ۲ تا ۶۰ کاراکتر باشد.'); if (!V.mobile(mob)) throw new Invalid('شماره موبایل باید با ۰۹ شروع شود و ۱۱ رقم باشد.');
  const changes = ch.diff(p, { first_name: fn, last_name: ln, mobile: mob }); if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => { await t.exec('UPDATE identity_profiles SET first_name = ?, last_name = ?, mobile = ?, updated_at = ? WHERE id = ?', [fn, ln, mob, t.now(), id]); await ch.record(t, a, Number(p.company_id), 'profile', id, changes); });
}
/** National-ID correction is a reviewer action with a reason: it re-checks duplicates, invalidates every earlier document confirmation, and sends an approved file back for review. */
export async function correctNationalId(db: Db, a: Actor, id: number, newNid: string, note: string): Promise<void> {
  await gate.require_(db, a, 'registration.review'); const p = await find(db, a, id), nid = V.digits(newNid.trim());
  if (!EDITABLE_BY_REVIEWER.includes(p.status)) throw new Invalid('در این وضعیت امکان اصلاح کد ملی وجود ندارد.'); note = ch.requireNote(note);
  if (!V.nationalId(nid)) throw new Invalid('ساختار کد ملی معتبر نیست.'); const hash = blind(nid); if (hash === p.national_id_hash) throw new Invalid('کد ملی جدید با کد فعلی یکسان است.');
  if (await db.val('SELECT 1 FROM identity_profiles WHERE company_id = ? AND national_id_hash = ? AND id <> ?', [p.company_id, hash, id])) throw new Invalid('پرونده دیگری با این کد ملی وجود دارد.');
  await db.tx(async t => {
    await t.exec('UPDATE identity_profiles SET national_id_enc = ?, national_id_hash = ?, national_id_last3 = ?, updated_at = ? WHERE id = ?', [sealText(nid), hash, nid.slice(-3), t.now(), id]);
    await t.exec("UPDATE document_ocr_results SET status = 'superseded' WHERE status IN ('confirmed','mismatch') AND file_id IN (SELECT id FROM document_files WHERE profile_id = ?)", [id]);
    await ch.record(t, a, Number(p.company_id), 'profile', id, { national_id: [`•••${p.national_id_last3}`, `•••${nid.slice(-3)}`], review: ['تطبیق قبلی', 'باطل شد؛ تطبیق مجدد لازم است'] }, note);
    if (p.status === 'approved_initial') { await t.exec("UPDATE identity_profiles SET status = 'awaiting_review' WHERE id = ?", [id]); await t.exec('INSERT INTO profile_status_history (company_id,profile_id,from_status,to_status,user_id,note,created_at) VALUES (?,?,?,?,?,?,?)', [p.company_id, id, p.status, 'awaiting_review', a.id, 'بازگشت خودکار پس از اصلاح کد ملی', t.now()]); }
  });
}

// ───────── documents (encrypted vault) ─────────
export const vault = (): string => { const p = env('VAULT_PATH', 'storage/vault')!; return p.startsWith('/') ? p : join(process.cwd(), p); };
function imageSize(b: Buffer): [number, number] | null {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) { let i = 2; while (i + 9 < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)]; i += 2 + b.readUInt16BE(i + 2); } }
  return null;
}
const sniff = (b: Buffer): string | null => (b.subarray(0, 4).toString('latin1') === '%PDF' ? 'application/pdf' : b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : null);
export async function upload(db: Db, a: Actor, profileId: number, kind: string, bytes: Buffer, origName: string): Promise<number> {
  await gate.require_(db, a, kind === 'contract' ? 'contract.draft' : 'registration.manage'); const p = await find(db, a, profileId);
  if (!KINDS[kind]) throw new Invalid('نوع مدرک نامعتبر است.');
  if (kind !== 'contract' && !EDITABLE_BY_REVIEWER.includes(p.status)) throw new Invalid('در این وضعیت امکان بارگذاری مدرک جدید وجود ندارد.');
  if (!bytes.length) throw new Invalid('فایل خالی است.'); if (bytes.length > MAX_BYTES) throw new Invalid('حجم فایل نباید بیشتر از ۸ مگابایت باشد.');
  const mime = sniff(bytes); if (!mime) throw new Invalid('فقط تصویر JPG، PNG یا فایل PDF مجاز است.');   // real content is sniffed; extension and client type are ignored
  if (mime !== 'application/pdf') { const sz = imageSize(bytes); if (!sz) throw new Invalid('تصویر معتبر نیست.'); if (['id_front', 'id_back'].includes(kind) && (sz[0] < 600 || sz[1] < 380)) throw new Invalid('وضوح تصویر کم یا تصویر ناقص است؛ دوباره و نزدیک‌تر عکس بگیرید (حداقل ۶۰۰×۳۸۰ پیکسل).'); }
  const sha = sha256(bytes); if (await db.val("SELECT 1 FROM document_files WHERE profile_id = ? AND sha256 = ? AND processing_state <> 'removed'", [profileId, sha])) throw new Invalid('این فایل قبلاً در همین پرونده بارگذاری شده است.');
  const dir = join(vault(), String(p.company_id)); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rel = `${p.company_id}/${randomBytes(16).toString('hex')}.bin`;   // random name: the original name never touches the filesystem
  writeFileSync(join(vault(), rel), seal(bytes), { mode: 0o600 }); try { chmodSync(join(vault(), rel), 0o600); } catch { /* best effort */ }
  const name = origName.replace(/[\x00-\x1F\x7F\\/]/g, '').split(/[\\/]/).pop()!.slice(0, 120) || 'file';
  const version = 1 + Number(await db.val('SELECT COUNT(*) FROM document_files WHERE profile_id = ? AND kind = ?', [profileId, kind]));
  return db.tx(async t => {
    const id = await t.insert('INSERT INTO document_files (company_id,folder_id,profile_id,kind,original_name,mime,size_bytes,sha256,storage_path,version,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [p.company_id, p.folder_id, profileId, kind, name, mime, bytes.length, sha, rel, version, a.id, t.now()]);
    await audit.log(t, a, 'document.upload', 'document', id, { kind, size: bytes.length, sha256: sha, version }, Number(p.company_id));
    if (['id_front', 'id_back'].includes(kind)) await processOcr(t, id, bytes, mime);
    return id;
  });
}
export const forProfile = (db: Db, profileId: number, includeRemoved = false): Promise<Row[]> => db.all(`SELECT d.*, (SELECT r.id FROM document_ocr_results r WHERE r.file_id = d.id ORDER BY r.id DESC LIMIT 1) AS ocr_id FROM document_files d WHERE d.profile_id = ? ${includeRemoved ? '' : "AND d.processing_state <> 'removed'"} ORDER BY d.id`, [profileId]);
/** Documents are never deleted: "removing" hides the file from the working set (with a reason) while the encrypted original, hash and audit trail remain. */
export async function removeDocument(db: Db, a: Actor, fileId: number, note: string): Promise<void> {
  await gate.require_(db, a, 'registration.manage'); const f = await db.one('SELECT * FROM document_files WHERE id = ?', [fileId]); if (!f) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(f.company_id));
  const p = await find(db, a, Number(f.profile_id)); if (!EDITABLE_BY_REVIEWER.includes(p.status) || f.kind === 'contract') throw new Invalid('در این وضعیت امکان حذف مدرک وجود ندارد.');
  if (f.processing_state === 'removed') throw new Invalid('این مدرک قبلاً حذف شده است.'); note = ch.requireNote(note);
  await db.tx(async t => {
    await t.exec("UPDATE document_files SET processing_state = 'removed' WHERE id = ?", [fileId]); await t.exec("UPDATE document_ocr_results SET status = 'superseded' WHERE file_id = ? AND status IN ('confirmed','mismatch')", [fileId]);
    await ch.record(t, a, Number(f.company_id), 'profile', Number(f.profile_id), { document_removed: [`${KINDS[f.kind]} نسخه ${f.version} (${f.original_name})`, null] }, note);
  });
}
/** Authorised, tenant-checked, logged decryption of a stored file; the stored hash detects tampering. */
export async function read(db: Db, a: Actor, fileId: number, ip: string | null = null): Promise<{ mime: string; name: string; bytes: Buffer }> {
  await gate.require_(db, a, 'document.download'); const f = await db.one('SELECT * FROM document_files WHERE id = ?', [fileId]); if (!f) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(f.company_id));
  const path = join(vault(), f.storage_path); if (!existsSync(path)) throw new HttpError('فایل در مخزن یافت نشد.', 404);
  const bytes = open(readFileSync(path)); if (sha256(bytes) !== f.sha256) throw new Error('File integrity check failed');
  await db.exec('INSERT INTO document_access_logs (company_id,file_id,user_id,action,ip,created_at) VALUES (?,?,?,?,?,?)', [f.company_id, fileId, a.id, 'download', ip, db.now()]);
  await audit.log(db, a, 'document.download', 'document', fileId, {}, Number(f.company_id), ip); return { mime: f.mime, name: f.original_name, bytes };
}

// ───────── OCR (suggestion only: never proof of identity) ─────────
export const nationalIdCandidates = (text: string): string[] => [...new Set((V.digits(text).match(/(?<!\d)\d{10}(?!\d)/g) ?? []).filter(V.nationalId))];
async function processOcr(db: Db, fileId: number, bytes: Buffer, mime: string): Promise<number> {
  const f = (await db.one('SELECT company_id FROM document_files WHERE id = ?', [fileId]))!; let text: string | null = null;
  if (env('OCR_PROVIDER', 'manual') === 'tesseract' && mime !== 'application/pdf') { const tmp = join(process.env.TMPDIR ?? '/tmp', `ocr-${randomBytes(6).toString('hex')}`); try { writeFileSync(tmp, bytes, { mode: 0o600 }); const r = spawnSync('tesseract', [tmp, 'stdout', '-l', 'fas+eng'], { timeout: 30000, encoding: 'utf8' }); if (r.status === 0) text = r.stdout; } finally { try { writeFileSync(tmp, ''); } catch { /* */ } } }   // argv array: no shell
  const status = text === null ? 'manual_required' : 'extracted';
  await db.exec('UPDATE document_files SET processing_state = ? WHERE id = ?', [status, fileId]);
  return db.insert('INSERT INTO document_ocr_results (company_id,file_id,provider,status,payload,created_at) VALUES (?,?,?,?,?,?)', [f.company_id, fileId, text === null ? 'manual' : 'tesseract', status, text === null ? null : sealText(JSON.stringify({ raw_text: text, national_id_candidates: nationalIdCandidates(text) })), db.now()]);
}
export async function suggestion(db: Db, a: Actor, r: Row): Promise<{ raw_text?: string; national_id_candidates?: string[] }> { await gate.require_(db, a, 'registration.review'); return r.payload ? JSON.parse(openText(r.payload)) : {}; }
/** The reviewer records what the document actually says; it counts as CONFIRMED only if that national ID equals the one on the file. */
export async function review(db: Db, a: Actor, resultId: number, nationalId: string, first: string, last: string): Promise<boolean> {
  await gate.require_(db, a, 'registration.review'); const r = await db.one('SELECT r.*, f.profile_id FROM document_ocr_results r JOIN document_files f ON f.id = r.file_id WHERE r.id = ?', [resultId]);
  if (!r) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(r.company_id)); const nid = V.digits(nationalId.trim());
  if (!V.nationalId(nid)) throw new Invalid('ساختار کد ملی واردشده معتبر نیست.');
  const profile = (await db.one('SELECT national_id_hash FROM identity_profiles WHERE id = ?', [r.profile_id]))!, match = profile.national_id_hash === blind(nid);
  await db.exec('UPDATE document_ocr_results SET reviewed_payload = ?, status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', [sealText(JSON.stringify({ national_id: nid, first_name: first.trim(), last_name: last.trim(), match })), match ? 'confirmed' : 'mismatch', a.id, db.now(), resultId]);
  await audit.log(db, a, 'ocr.review', 'ocr_result', resultId, { match }, Number(r.company_id)); return match;
}
