import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { freshDb, makeOwner } from './helpers.js';
import { Db } from '../src/core/db.js';
import { makeHandler } from '../src/http/app.js';
import * as org from '../src/services/org.js';

let db: Db, drop: () => Promise<void>, h: ReturnType<typeof makeHandler>;
class Browser {
  tok: string | undefined; last = '';
  async req(method: string, path: string, form: Record<string,string> = {}) {
    const q = new URL(path, 'http://x');
    const r = await h({ method, path: q.pathname, query: q.searchParams, form: new URLSearchParams(form), ip: '10.0.0.9', secure: false }, this.tok);
    const cookie = r.cookie ?? r.headers?.['Set-Cookie'];
    const token = cookie?.match(/nafi_sid=([a-f0-9]+)/)?.[1]; if (token) this.tok = token;
    this.last = r.body; return r;
  }
  csrf() { return this.last.match(/name="_csrf" value="([a-f0-9]+)"/)?.[1] ?? ''; }
  async login() { await this.req('GET','/login'); await this.req('POST','/login',{email:'owner@t.test',password:'Owner-pass-1',_csrf:this.csrf()}); return this; }
  async post(path:string, form:Record<string,string>={}, from='/contracts') { await this.req('GET',from); return this.req('POST',path,{...form,_csrf:this.csrf()}); }
}
const location = (r:{headers?:Record<string,string>}) => r.headers?.Location;

beforeAll(async()=>{
  process.env.MFA_REQUIRED='0';
  ({db,drop}=await freshDb()); h=makeHandler(db);
  const owner=await makeOwner(db); await org.createCompany(db,owner,'شرکت قراردادها');
});
afterAll(async()=>{await drop();});

describe('contracts through HTTP',()=>{
  it('creates immutable versions, rejects stale edits and only allows revision while draft',async()=>{
    const b=await new Browser().login();
    const create=await b.post('/contracts/create',{
      number:'CN-1405-001',title:'قرارداد تأمین خدمات',party_name:'شرکت طرف قرارداد',
      body:'متن اولیه قرارداد شامل تمام شرایط و تعهدات طرفین است.',
      amount:'125000000',starts_on:'2026-01-01',ends_on:'2026-12-29'
    });
    expect(location(create)).toBe('/contracts');
    let row=await db.one('SELECT id,current_version FROM contracts WHERE number=?',['CN-1405-001']);
    expect(row).toBeTruthy(); const id=Number(row!.id);
    const first=await db.one('SELECT body_hash FROM contract_versions WHERE contract_id=? AND version=1',[id]);
    const hash=String(first!.body_hash);

    const revise=await b.post(`/contracts/${id}/revise`,{
      version:'1',body_hash:hash,body:'متن اصلاح‌شده قرارداد با شرایط تکمیلی و تعهدات جدید طرفین.',
      note:'اصلاح بندهای مالی و تعهدات'
    },'/contracts');
    expect(location(revise)).toBe('/contracts');
    row=await db.one('SELECT current_version FROM contracts WHERE id=?',[id]);
    expect(Number(row!.current_version)).toBe(2);
    expect(Number(await db.val('SELECT COUNT(*) FROM contract_versions WHERE contract_id=?',[id]))).toBe(2);

    const stale=await b.post(`/contracts/${id}/revise`,{
      version:'1',body_hash:hash,body:'یک متن متفاوت دیگر برای نسخه قدیمی قرارداد.',
      note:'تلاش با نسخه منسوخ'
    },'/contracts');
    expect(location(stale)).toBe('/contracts');
    expect((await b.req('GET','/contracts')).body).toContain('در صفحه دیگری تغییر کرده است');
    expect(Number(await db.val('SELECT current_version FROM contracts WHERE id=?',[id]))).toBe(2);

    const approve=await b.post(`/contracts/${id}/approve`,{},'/contracts');
    expect(location(approve)).toBe('/contracts');
    const locked=await b.post(`/contracts/${id}/revise`,{
      version:'2',body_hash:String(await db.val('SELECT body_hash FROM contract_versions WHERE contract_id=? AND version=2',[id])),
      body:'تغییر پس از تأیید که نباید مجاز باشد.',note:'تلاش تغییر بعد از تأیید'
    },'/contracts');
    expect(location(locked)).toBe('/contracts');
    expect((await b.req('GET','/contracts')).body).toContain('فقط پیش‌نویس قرارداد قابل ویرایش است');
    expect(Number(await db.val('SELECT COUNT(*) FROM contract_versions WHERE contract_id=?',[id]))).toBe(2);
  });
});
