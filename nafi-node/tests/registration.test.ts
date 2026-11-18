import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, makeOwner, makeUser, rejects, png } from './helpers.js';
import { Db } from '../src/core/db.js';
import { Actor } from '../src/core/audit.js';
import * as org from '../src/services/org.js';
import * as reg from '../src/services/registration.js';
import * as ch from '../src/core/changes.js';
import { openText } from '../src/core/crypto.js';

let db: Db, drop: () => Promise<void>, owner: Actor, cA: number, cB: number, registrar: Actor, expert: Actor, expertB: Actor, pid = 0, front = 0;
const person = { first_name: 'علی', last_name: 'رضایی', national_id: '۰۴۹۹۳۷۰۸۹۹', mobile: '۰۹۱۲۳۴۵۶۷۸۹', consent: '1' };
beforeAll(async () => {
  process.env.VAULT_PATH = '/tmp/nafi-vault-' + Math.random().toString(36).slice(2); ({ db, drop } = await freshDb()); owner = await makeOwner(db);
  cA = await org.createCompany(db, owner, 'شرکت الف'); cB = await org.createCompany(db, owner, 'شرکت ب');
  registrar = await makeUser(db, owner, 'registrar', 'reg@t.test', cA); expert = await makeUser(db, owner, 'doc_expert', 'exp@t.test', cA); expertB = await makeUser(db, owner, 'doc_expert', 'expb@t.test', cB);
});
afterAll(async () => { await drop(); rmSync(process.env.VAULT_PATH!, { recursive: true, force: true }); });

describe('profiles', () => {
  it('create: Persian digits normalised, folder number, national ID encrypted, no PII in audit', async () => {
    pid = await reg.createPerson(db, registrar, person); expect(String(await db.val('SELECT folder_no FROM digital_folders WHERE profile_id = ?', [pid]))).toMatch(/^F-\d{4}-\d{5}$/);
    const row = (await db.one('SELECT * FROM identity_profiles WHERE id = ?', [pid]))!; expect(JSON.stringify(row)).not.toContain('0499370899'); expect(row.national_id_last3).toBe('899'); expect(openText(row.national_id_enc)).toBe('0499370899');
    expect(String(await db.val('SELECT GROUP_CONCAT(detail) FROM audit_logs'))).not.toContain('0499370899');
  });
  it('validation and duplicates', async () => {
    await rejects(() => reg.createPerson(db, registrar, person), 'Invalid'); await rejects(() => reg.createPerson(db, registrar, { ...person, national_id: '1234567890' }), 'Invalid');
    await rejects(() => reg.createPerson(db, registrar, { ...person, consent: '' }), 'Invalid'); await rejects(() => reg.createPerson(db, registrar, { ...person, national_id: '0084575948', mobile: '12345' }), 'Invalid');
  });
  it('search by exact national ID (blind index) and by name; other tenant sees nothing', async () => {
    expect(await reg.search(db, registrar, '0499370899')).toHaveLength(1); expect(await reg.search(db, registrar, 'رضایی')).toHaveLength(1); expect(await reg.search(db, registrar, '0084575948')).toHaveLength(0); expect(await reg.search(db, registrar, "100%_|")).toHaveLength(0);
    expect(await reg.search(db, expertB, 'رضایی')).toHaveLength(0); await rejects(() => reg.find(db, expertB, pid), 'HttpError', 404);
  });
});

describe('documents', () => {
  it('upload rejects fake image and tiny image; accepts a valid PNG; duplicate rejected', async () => {
    await rejects(() => reg.upload(db, registrar, pid, 'id_front', Buffer.from('<?php echo 1;'), 'evil.png'), 'Invalid'); await rejects(() => reg.upload(db, registrar, pid, 'id_front', png(100, 60), 'small.png'), 'Invalid');
    front = await reg.upload(db, registrar, pid, 'id_front', png(640, 400), '../../x/front.png'); expect(front).toBeGreaterThan(0); await rejects(() => reg.upload(db, registrar, pid, 'id_front', png(640, 400), 'again.png'), 'Invalid');
  });
  it('stored encrypted with a random name, sanitised original name, OCR asks for manual entry', async () => {
    const f = (await db.one('SELECT * FROM document_files WHERE id = ?', [front]))!, raw = readFileSync(join(reg.vault(), f.storage_path));
    expect(raw.includes(Buffer.from('PNG'))).toBe(false); expect(f.storage_path.endsWith('.bin')).toBe(true); expect(f.original_name).not.toContain('/'); expect(Number(f.version)).toBe(1);
    expect(await db.val('SELECT status FROM document_ocr_results WHERE file_id = ?', [front])).toBe('manual_required');
  });
  it('download: permission, tenant, access log, identical bytes; tampering detected', async () => {
    await rejects(() => reg.read(db, registrar, front), 'HttpError', 403); await rejects(() => reg.read(db, expertB, front), 'HttpError', 404);
    const r = await reg.read(db, expert, front, '10.0.0.1'); expect(r.mime).toBe('image/png'); expect(r.bytes.equals(png(640, 400))).toBe(true); expect(Number(await db.val('SELECT COUNT(*) FROM document_access_logs WHERE file_id = ?', [front]))).toBe(1);
    const f = (await db.one('SELECT * FROM document_files WHERE id = ?', [front]))!, path = join(reg.vault(), f.storage_path), good = readFileSync(path), bad = Buffer.from(good); bad[40] ^= 1;
    (await import('node:fs')).writeFileSync(path, bad); await expect(reg.read(db, expert, front)).rejects.toThrow(); (await import('node:fs')).writeFileSync(path, good);
  });
});

describe('workflow', () => {
  it('roles, notes and illegal jumps', async () => {
    await rejects(() => reg.transition(db, registrar, pid, 'approved_final'), 'Invalid'); await reg.transition(db, registrar, pid, 'submitted');
    await rejects(() => reg.transition(db, registrar, pid, 'rejected', 'دلیل کافی است'), 'HttpError', 403); await rejects(() => reg.transition(db, expert, pid, 'awaiting_docs', ''), 'Invalid');
    await reg.transition(db, registrar, pid, 'awaiting_review');
  });
  it('registrar can no longer edit once under review; reviewer can; stale form refused; no-op refused', async () => {
    await rejects(() => reg.editProfile(db, registrar, pid, { first_name: 'علی', last_name: 'رضایی', mobile: '09120000000' }), 'Invalid');
    const v = reg.versionOf(await reg.find(db, expert, pid)); await reg.editProfile(db, expert, pid, { first_name: 'علیرضا', last_name: 'رضایی', mobile: '09120000000' }, v);
    await rejects(() => reg.editProfile(db, expert, pid, { first_name: 'x y', last_name: 'رضایی', mobile: '09120000000' }, v), 'Invalid');            // stale
    await rejects(() => reg.editProfile(db, expert, pid, { first_name: 'علیرضا', last_name: 'رضایی', mobile: '09120000000' }), 'Invalid');             // nothing changed
    expect(JSON.parse((await ch.history(db, 'profile', pid))[0].changes)).toEqual({ first_name: ['علی', 'علیرضا'], mobile: ['09123456789', '09120000000'] });
  });
  it('final approval is blocked until the reviewer confirms a matching national ID; mismatch is detected', async () => {
    await reg.transition(db, expert, pid, 'approved_initial'); await rejects(() => reg.transition(db, expert, pid, 'approved_final'), 'Invalid');
    const rid = Number(await db.val('SELECT id FROM document_ocr_results WHERE file_id = ?', [front]));
    expect(await reg.review(db, expert, rid, '0084575948', 'علی', 'رضایی')).toBe(false); await rejects(() => reg.transition(db, expert, pid, 'approved_final'), 'Invalid');
    expect(await reg.review(db, expert, rid, '۰۴۹۹۳۷۰۸۹۹', 'علی', 'رضایی')).toBe(true);
  });
  it('national-ID correction: reviewer + reason, duplicate check, confirmation invalidated, approved file returns to review', async () => {
    await reg.createPerson(db, registrar, { ...person, national_id: '0084575948', first_name: 'سارا', last_name: 'احمدی' });
    await rejects(() => reg.correctNationalId(db, registrar, pid, '0013542419', 'اصلاح اشتباه تایپی'), 'HttpError', 403); await rejects(() => reg.correctNationalId(db, expert, pid, '0013542419', ''), 'Invalid');
    await rejects(() => reg.correctNationalId(db, expert, pid, '0084575948', 'اصلاح اشتباه تایپی'), 'Invalid');           // belongs to another profile
    await rejects(() => reg.correctNationalId(db, expert, pid, '0499370899', 'اصلاح اشتباه تایپی'), 'Invalid');           // same as current
    await reg.correctNationalId(db, expert, pid, '0013542419', 'اصلاح اشتباه تایپی کد ملی هنگام ثبت');
    const p = await reg.find(db, expert, pid); expect(p.status).toBe('awaiting_review'); expect(openText(p.national_id_enc)).toBe('0013542419'); expect(await db.val('SELECT status FROM document_ocr_results WHERE file_id = ?', [front])).toBe('superseded');
    await rejects(() => reg.transition(db, expert, pid, 'approved_final'), 'Invalid');
    const h = JSON.parse((await ch.history(db, 'profile', pid))[0].changes); expect(JSON.stringify(h)).not.toContain('0013542419');   // the full ID never lands in history
  });
  it('documents: removal needs a reason and keeps the original; replacement raises the version; id_front is required before review', async () => {
    const f2 = await reg.upload(db, registrar, pid, 'id_front', png(700, 450, 0x70), 'front-v2.png'); expect(Number((await db.one('SELECT version FROM document_files WHERE id = ?', [f2]))!.version)).toBe(2);
    await rejects(() => reg.removeDocument(db, registrar, front, ''), 'Invalid'); await reg.removeDocument(db, registrar, front, 'تصویر تار بود و جایگزین شد');
    expect((await reg.forProfile(db, pid)).map(r => Number(r.id))).toEqual([f2]); expect((await reg.forProfile(db, pid, true))).toHaveLength(2); expect((await reg.read(db, expert, front)).bytes.length).toBeGreaterThan(0);   // original retained
    await rejects(() => reg.removeDocument(db, registrar, front, 'دوباره حذف'), 'Invalid');
    await reg.removeDocument(db, registrar, f2, 'مدرک اشتباه بارگذاری شده بود'); await reg.transition(db, expert, pid, 'needs_fix', 'کارت ملی دوباره بارگذاری شود');
    await rejects(() => reg.transition(db, registrar, pid, 'awaiting_review'), 'Invalid');       // no live id_front
    await reg.upload(db, registrar, pid, 'id_front', png(800, 500, 0x55), 'front-v3.png'); await reg.transition(db, registrar, pid, 'awaiting_review');
  });
  it('after final approval nothing is editable; reveal of full national ID is audited; history is complete', async () => {
    const f3 = Number(await db.val("SELECT id FROM document_files WHERE profile_id = ? AND processing_state <> 'removed'", [pid])), rid = Number(await db.val('SELECT id FROM document_ocr_results WHERE file_id = ?', [f3]));
    await reg.transition(db, expert, pid, 'approved_initial'); expect(await reg.review(db, expert, rid, '0013542419', 'علی', 'رضایی')).toBe(true); await reg.transition(db, expert, pid, 'approved_final');
    await rejects(() => reg.editProfile(db, expert, pid, { first_name: 'تغییر', last_name: 'نهایی', mobile: '09120000000' }), 'Invalid'); await rejects(() => reg.upload(db, registrar, pid, 'supporting', png(640, 400, 0x33), 's.png'), 'Invalid');
    await rejects(() => reg.correctNationalId(db, expert, pid, '0499370899', 'تلاش پس از تأیید نهایی'), 'Invalid');
    expect(await reg.revealNationalId(db, expert, await reg.find(db, expert, pid))).toBe('0013542419'); expect(Number(await db.val("SELECT COUNT(*) FROM audit_logs WHERE action = 'profile.view_sensitive'"))).toBe(1);
    expect((await reg.history(db, pid)).length).toBeGreaterThanOrEqual(7);
  });
});
