import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { freshDb, makeOwner, makeUser, png } from './helpers.js';
import { Db } from '../src/core/db.js';
import { makeHandler } from '../src/http/app.js';
import { parseMultipart } from '../src/http/multipart.js';
import * as org from '../src/services/org.js';

let db: Db, drop: () => Promise<void>, h: ReturnType<typeof makeHandler>, cA: number;
class Browser {
  tok: string | undefined; last = ''; lastR: any;
  async req(method: string, path: string, form: Record<string, string> = {}, files: { field: string; filename: string; type: string; data: Buffer }[] = []) {
    const q = new URL(path, 'http://x'), r = await h({ method, path: q.pathname, query: q.searchParams, form: new URLSearchParams(form), files, ip: '10.0.0.9', secure: false }, this.tok);
    const t = (r.cookie ?? r.headers?.['Set-Cookie'])?.match(/nafi_sid=([a-f0-9]+)/)?.[1]; if (t) this.tok = t; this.last = r.body; this.lastR = r; return r;
  }
  csrf() { return this.last.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? ''; }
  hidden(name: string) { return this.last.match(new RegExp(`name="${name}" value="([^"]*)"`))?.[1] ?? ''; }
  async login(email: string, pass: string) { await this.req('GET', '/login'); await this.req('POST', '/login', { email, password: pass, _csrf: this.csrf() }); return this; }
  async post(path: string, form: Record<string, string> = {}, from = '/', files: any[] = []) { await this.req('GET', from); return this.req('POST', path, { ...form, _csrf: this.csrf() }, files); }
}
beforeAll(async () => {
  process.env.MFA_REQUIRED = '0'; process.env.VAULT_PATH = '/tmp/nafi-vault-http-' + Math.random().toString(36).slice(2); ({ db, drop } = await freshDb()); h = makeHandler(db);
  const owner = await makeOwner(db); cA = await org.createCompany(db, owner, 'شرکت الف');
  await makeUser(db, owner, 'registrar', 'reg@t.test', cA); await makeUser(db, owner, 'doc_expert', 'exp@t.test', cA); await makeUser(db, owner, 'viewer', 'viewer@t.test', cA);
});
afterAll(async () => { await drop(); rmSync(process.env.VAULT_PATH!, { recursive: true, force: true }); });

describe('multipart parser', () => {
  it('parses fields and a binary file exactly', () => {
    const bin = Buffer.from([0, 255, 13, 10, 45, 45, 1, 2, 3]), b = '----X1', body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="kind"\r\n\r\nid_front\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), bin, Buffer.from(`\r\n--${b}--\r\n`)]);
    const r = parseMultipart(body, `multipart/form-data; boundary=${b}`); expect(r.fields.get('kind')).toBe('id_front'); expect(r.files).toHaveLength(1); expect(r.files[0].data.equals(bin)).toBe(true); expect(r.files[0].filename).toBe('a.png');
  });
});

describe('registration through HTTP', () => {
  let reg: Browser, exp: Browser, id = 0, page = '';
  const file = (data: Buffer, filename = 'front.png') => [{ field: 'file', filename, type: 'image/png', data }];
  it('registrar creates a profile; ID is masked for registrar and shown (audited) to the expert', async () => {
    reg = await new Browser().login('reg@t.test', 'Strong-pass-123'); exp = await new Browser().login('exp@t.test', 'Strong-pass-123');
    const r = await reg.post('/registrations', { first_name: '<b>علی</b>', last_name: 'رضایی', national_id: '۰۴۹۹۳۷۰۸۹۹', mobile: '09123456789', consent: '1' }, '/registrations'); id = Number(r.headers!.Location!.split('/').pop()); page = `/registrations/${id}`;
    const pr = (await reg.req('GET', page)).body; expect(pr).not.toContain('0499370899'); expect(pr).toContain('899'); expect(pr).not.toContain('<b>علی</b>'); expect(pr).toContain('&lt;b&gt;');
    expect((await exp.req('GET', page)).body).toContain('0499370899'); expect(Number(await db.val("SELECT COUNT(*) FROM audit_logs WHERE action = 'profile.view_sensitive'"))).toBe(1);
  });
  it('multipart upload: fake file refused with a message; real PNG stored encrypted; expert can download identical bytes, registrar cannot', async () => {
    await reg.post(`${page}/upload`, { kind: 'id_front' }, page, file(Buffer.from('<?php evil ?>'), 'x.png')); expect((await reg.req('GET', page)).body).toContain('فقط تصویر JPG');
    await reg.post(`${page}/upload`, { kind: 'id_front' }, page, file(png(640, 400))); expect(Number(await db.val('SELECT COUNT(*) FROM document_files'))).toBe(1);
    const d = await exp.req('GET', '/files/1'); expect(d.status).toBe(200); expect(d.headers!['Content-Type']).toBe('image/png'); expect((d as any).binary.equals(png(640, 400))).toBe(true);
    expect((await reg.req('GET', '/files/1')).status).toBe(403);
  });
  it('edit form with version; stale version refused; locked for the registrar once under review', async () => {
    await reg.req('GET', page); const v = reg.hidden('version'); await reg.req('POST', `${page}/edit`, { first_name: 'علی', last_name: 'رضایی', mobile: '09120000000', version: v, _csrf: reg.csrf() });
    expect(await db.val('SELECT mobile FROM identity_profiles WHERE id = ?', [id])).toBe('09120000000');
    await reg.req('GET', page); await reg.req('POST', `${page}/edit`, { first_name: 'علی', last_name: 'رضایی', mobile: '09121111111', version: v, _csrf: reg.csrf() }); expect(await db.val('SELECT mobile FROM identity_profiles WHERE id = ?', [id])).toBe('09120000000');
    await reg.post(`${page}/transition`, { to: 'submitted' }, page); await reg.post(`${page}/transition`, { to: 'awaiting_review' }, page);
    expect((await reg.req('GET', page)).body).toContain('مشخصات قابل ویرایش نیست'); expect((await exp.req('GET', page)).body).toContain('ویرایش مشخصات');
  });
  it('final approval is blocked until a matching review; mismatch warns; correction needs a reason; removal needs a reason', async () => {
    await exp.post(`${page}/transition`, { to: 'approved_initial' }, page); await exp.post(`${page}/transition`, { to: 'approved_final' }, page); expect(await db.val('SELECT status FROM identity_profiles WHERE id = ?', [id])).toBe('approved_initial');
    await exp.post(`${page}/review`, { result_id: '1', national_id: '0084575948', first_name: 'علی', last_name: 'رضایی' }, page); expect((await exp.req('GET', page)).body).toContain('مغایرت');
    await exp.post(`${page}/review`, { result_id: '1', national_id: '0499370899', first_name: 'علی', last_name: 'رضایی' }, page); expect(await db.val('SELECT status FROM document_ocr_results WHERE id = 1')).toBe('confirmed');
    await exp.post(`${page}/correct-nid`, { national_id: '0013542419', note: '' }, page); expect(await db.val('SELECT status FROM document_ocr_results WHERE id = 1')).toBe('confirmed');   // refused: no reason
    await exp.post(`${page}/correct-nid`, { national_id: '0013542419', note: 'اشتباه تایپی هنگام ثبت اولیه' }, page); expect(await db.val('SELECT status FROM document_ocr_results WHERE id = 1')).toBe('superseded'); expect(await db.val('SELECT status FROM identity_profiles WHERE id = ?', [id])).toBe('awaiting_review');
    await reg.post(`${page}/remove`, { file_id: '1', note: '' }, page); expect(await db.val('SELECT processing_state FROM document_files WHERE id = 1')).not.toBe('removed');
  });
  it('digital vault lists company documents, folder metadata and restricts the page by permission', async () => {
    const r = await reg.req('GET', '/documents');
    expect(r.status).toBe(200); expect(r.body).toContain('زونکن دیجیتال'); expect(r.body).toContain('F-'); expect(r.body).toContain('front.png'); expect(r.body).toContain('شناسه پرونده');
    const e = await exp.req('GET', '/documents'); expect(e.status).toBe(200); expect(e.body).toContain('front.png');
    const no = await new Browser().login('viewer@t.test', 'Strong-pass-123');
    expect((await no.req('GET', '/documents')).status).toBe(403);
  });
  it('history panels show who changed what, with reasons', async () => {
    const p = (await exp.req('GET', page)).body; expect(p).toContain('اشتباه تایپی هنگام ثبت اولیه'); expect(p).toContain('تاریخچه تغییرات'); expect(p).toContain('تاریخچه وضعیت'); expect(p).not.toContain('0013542419\n');
    expect(p).toContain('09123456789');   // old mobile is in the change history
  });
});
