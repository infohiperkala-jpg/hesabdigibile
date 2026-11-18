import * as gate from '../core/gate.js';
import { HttpError } from '../core/errors.js';
import { fa } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

const kinds: Record<string,string> = {
 id_front:'روی کارت ملی', id_back:'پشت کارت ملی', other_id:'مدرک هویتی مکمل',
 supporting:'مدرک پشتیبان', contract:'قرارداد امضاشده'
};
const states: Record<string,string> = {
 stored:'ذخیره‌شده', manual_required:'نیازمند بررسی دستی', extracted:'متن استخراج‌شده',
 removed:'کنارگذاشته‌شده'
};
async function company(c:Ctx) {
 const group=gate.isGroup(c.A);
 const cid=group?Number(c.rq.query.get('c')??await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1')):Number(c.u.company_id);
 gate.assertCompany(c.A,cid);
 if(!cid||!(await c.db.val('SELECT 1 FROM companies WHERE id=?',[cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.',404);
 return {cid,hidden:group?html`<input type="hidden" name="c" value="${cid}">`:html` `,url:(p:string)=>p+(group?`?c=${cid}`:'')};
}
export async function handleDocuments(c:Ctx):Promise<Out|null>{
 const {rq,db,A}=c;
 if(rq.path!=='/documents') return null;
 await gate.require_(db,A,'document.view');
 const co=await company(c),cid=co.cid;
 const q=(rq.query.get('q')??'').trim().slice(0,100);
 const kind=rq.query.get('kind')??'';
 const state=rq.query.get('state')??'';
 const clauses=['d.company_id=?'],params:any[]=[cid];
 if(q){const like='%'+q.replace(/[\\%_]/g,m=>'\\'+m)+'%';clauses.push("(d.original_name LIKE ? ESCAPE '\\\\' OR f.folder_no LIKE ? ESCAPE '\\\\' OR p.first_name LIKE ? ESCAPE '\\\\' OR p.last_name LIKE ? ESCAPE '\\\\' OR p.mobile LIKE ?)");params.push(like,like,like,like,like);}
 if(kinds[kind]){clauses.push('d.kind=?');params.push(kind);}
 if(['stored','manual_required','extracted','removed'].includes(state)){clauses.push('d.processing_state=?');params.push(state);}
 const files=await db.all(`SELECT d.id,d.profile_id,d.folder_id,d.kind,d.original_name,d.mime,d.size_bytes,d.sha256,d.version,d.processing_state,d.created_at,p.first_name,p.last_name,p.mobile,p.status profile_status,f.folder_no,(SELECT COUNT(*) FROM document_access_logs l WHERE l.file_id=d.id) downloads,(SELECT MAX(l.created_at) FROM document_access_logs l WHERE l.file_id=d.id) last_access FROM document_files d JOIN identity_profiles p ON p.id=d.profile_id JOIN digital_folders f ON f.id=d.folder_id WHERE ${clauses.join(' AND ')} ORDER BY d.id DESC LIMIT 500`,params);
 const folders=await db.all(`SELECT f.id,f.folder_no,f.type,f.confidentiality,f.created_at,p.id profile_id,p.first_name,p.last_name,p.mobile,p.status,(SELECT COUNT(*) FROM document_files d WHERE d.folder_id=f.id AND d.processing_state<>'removed') file_count FROM digital_folders f JOIN identity_profiles p ON p.id=f.profile_id WHERE f.company_id=? ORDER BY f.id DESC LIMIT 300`,[cid]);
 const canDownload=await gate.can(db,A,'document.download');
 return c.render('زونکن دیجیتال و مدیریت اسناد',html`
 <div class="kpis"><div class="kpi"><b>${fa(String(folders.length))}</b><span>پرونده دیجیتال</span></div><div class="kpi"><b>${fa(String(files.length))}</b><span>سند مطابق فیلتر</span></div><div class="kpi"><b>${fa(String(files.reduce((n,x)=>n+Number(x.downloads),0)))}</b><span>دفعات دانلود ثبت‌شده</span></div></div>
 <form method="get" class="panel form">${co.hidden}<h2>جست‌وجوی اسناد</h2><label>نام فایل، شماره پرونده، نام یا موبایل<input name="q" value="${q}" maxlength="100"></label><label>نوع سند<select name="kind"><option value="">همه انواع</option>${Object.entries(kinds).map(([k,v])=>html`<option value="${k}" ${kind===k?'selected':''}>${v}</option>`)}</select></label><label>وضعیت پردازش<select name="state"><option value="">همه وضعیت‌ها</option>${Object.entries(states).map(([k,v])=>html`<option value="${k}" ${state===k?'selected':''}>${v}</option>`)}</select></label><button>اعمال فیلتر</button></form>
 <div class="panel"><h2>فهرست اسناد و نسخه‌ها</h2><table><tr><th>شماره پرونده</th><th>صاحب پرونده</th><th>نوع سند</th><th>نام فایل</th><th>نسخه</th><th>حجم</th><th>هش SHA-256</th><th>وضعیت</th><th>دسترسی</th></tr>${files.map(d=>html`<tr><td><a href="/registrations/${d.profile_id}">${d.folder_no}</a></td><td>${d.first_name} ${d.last_name}<small dir="ltr">${d.mobile}</small></td><td>${kinds[d.kind]||d.kind}</td><td>${d.original_name}</td><td>${fa(String(d.version))}</td><td>${fa(String(Math.ceil(Number(d.size_bytes)/1024)))} KB</td><td dir="ltr" title="${d.sha256}">${d.sha256.slice(0,16)}…</td><td>${states[d.processing_state]||d.processing_state}</td><td>${fa(String(d.downloads))} دانلود ${canDownload?html`<a href="/files/${d.id}">دریافت</a>`:html` `}</td></tr>`)}${files.length?'':html`<tr><td colspan="9" class="muted">سندی با این مشخصات یافت نشد.</td></tr>`}</table></div>
 <div class="panel"><h2>پرونده‌های دیجیتال</h2><table><tr><th>شماره زونکن</th><th>صاحب پرونده</th><th>نوع</th><th>محرمانگی</th><th>تعداد اسناد فعال</th><th>عملیات</th></tr>${folders.map(f=>html`<tr><td>${f.folder_no||'—'}</td><td>${f.first_name} ${f.last_name}</td><td>${f.type}</td><td>${f.confidentiality}</td><td>${fa(String(f.file_count))}</td><td><a href="/registrations/${f.profile_id}">مشاهده پرونده</a></td></tr>`)}${folders.length?'':html`<tr><td colspan="6" class="muted">پرونده دیجیتالی ثبت نشده است.</td></tr>`}</table></div>
 <p class="muted">فایل‌ها در مخزن خصوصی و رمزنگاری‌شده نگهداری می‌شوند. دریافت فایل فقط با مجوز دانلود انجام می‌شود؛ تعداد و زمان دسترسی‌ها ثبت می‌شود.</p>`);
}
