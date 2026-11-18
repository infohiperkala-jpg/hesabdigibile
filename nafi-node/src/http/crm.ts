import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import { HttpError, Invalid } from '../core/errors.js';
import { fa } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

async function company(c: Ctx) {
  const group=gate.isGroup(c.A);
  const cid=group?Number(c.rq.query.get('c')??c.rq.form.get('c')??await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1')):Number(c.u.company_id);
  gate.assertCompany(c.A,cid);
  if(!cid||!(await c.db.val('SELECT 1 FROM companies WHERE id=?',[cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.',404);
  return {cid,hidden:group?html`<input type="hidden" name="c" value="${cid}">`:html` `,url:(p:string)=>p+(group?`?c=${cid}`:'')};
}
const validDate=(s:string)=>/^\\d{4}-\\d{2}-\\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'));
const stages:Record<string,string>={lead:'سرنخ',customer:'مشتری',inactive:'غیرفعال'};

export async function handleCrm(c:Ctx):Promise<Out|null>{
 const {rq,db,A}=c;
 if(!rq.path.startsWith('/crm')) return null;
 await gate.require_(db,A,'crm.view');
 const co=await company(c),cid=co.cid,back=co.url('/crm');
 const manage=await gate.can(db,A,'crm.manage');
 if(rq.method==='POST'&&rq.path==='/crm/customers'){
  if(!manage) throw new HttpError('دسترسی ثبت مشتری ندارید.',403);
  const name=c.f('name').trim(),phone=c.f('phone').trim(),email=c.f('email').trim(),kind=c.f('kind'),companyName=c.f('company_name').trim(),note=c.f('note').trim();
  if(name.length<2||name.length>160||phone.length>30||email.length>190||companyName.length>160||note.length>1000||!['lead','customer'].includes(kind)||(email&&!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email))) throw new Invalid('اطلاعات مشتری معتبر نیست.');
  return c.done(back,()=>db.tx(async t=>{
   const id=await t.insert('INSERT INTO crm_customers(company_id,name,company_name,phone,email,stage,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',[cid,name,companyName||null,phone||null,email||null,kind,note||null,A.id,db.now(),db.now()]);
   await audit.log(t,A,'crm.customer.create','crm_customer',id,{name,stage:kind},cid);
  }),'پرونده مشتری ثبت شد.');
 }
 if(rq.method==='POST'&&rq.path==='/crm/activities'){
  if(!manage) throw new HttpError('دسترسی ثبت پیگیری ندارید.',403);
  const customer=Number(c.f('customer_id')),kind=c.f('kind'),subject=c.f('subject').trim(),body=c.f('body').trim(),due=c.f('due_on');
  if(!customer||!['call','meeting','email','note'].includes(kind)||subject.length<2||subject.length>180||body.length>1500||(due&&!validDate(due))) throw new Invalid('اطلاعات پیگیری معتبر نیست.');
  return c.done(back,()=>db.tx(async t=>{
   const exists=await t.one('SELECT id FROM crm_customers WHERE id=? AND company_id=? AND stage<>"inactive" FOR UPDATE',[customer,cid]);
   if(!exists) throw new Invalid('مشتری انتخاب‌شده معتبر نیست.');
   const id=await t.insert('INSERT INTO crm_activities(company_id,customer_id,kind,subject,body,due_on,status,created_by,created_at) VALUES(?,?,?,?,?,?, "open",?,?)',[cid,customer,kind,subject,body||null,due||null,A.id,db.now()]);
   await audit.log(t,A,'crm.activity.create','crm_activity',id,{customer_id:customer,kind,due_on:due||null},cid);
  }),'پیگیری مشتری ثبت شد.');
 }
 const doneMatch=rq.path.match(/^\\/crm\\/activities\\/(\\d+)\\/complete$/);
 if(rq.method==='POST'&&doneMatch){
  if(!manage) throw new HttpError('دسترسی بستن پیگیری ندارید.',403);
  const id=Number(doneMatch[1]);
  return c.done(back,()=>db.tx(async t=>{
   const a=await t.one('SELECT id,status FROM crm_activities WHERE id=? AND company_id=? FOR UPDATE',[id,cid]);
   if(!a) throw new Invalid('پیگیری پیدا نشد.');
   if(a.status==='done') return;
   await t.exec('UPDATE crm_activities SET status="done",completed_at=? WHERE id=? AND company_id=?',[db.now(),id,cid]);
   await audit.log(t,A,'crm.activity.complete','crm_activity',id,{},cid);
  }),'پیگیری بسته شد.');
 }
 const customers=await db.all('SELECT c.*, (SELECT COUNT(*) FROM crm_activities a WHERE a.customer_id=c.id) activity_count FROM crm_customers c WHERE c.company_id=? ORDER BY c.id DESC LIMIT 500',[cid]);
 const activities=await db.all('SELECT a.*,c.name customer_name FROM crm_activities a JOIN crm_customers c ON c.id=a.customer_id WHERE a.company_id=? ORDER BY (a.status="open") DESC,a.due_on IS NULL,a.due_on,a.id DESC LIMIT 300',[cid]);
 const open=activities.filter(a=>a.status==='open').length;
 return c.render('CRM و مدیریت مشتریان',html`
 <div class="kpis"><div class="kpi"><b>${fa(String(customers.length))}</b><span>پرونده مشتری</span></div><div class="kpi"><b>${fa(String(customers.filter(x=>x.stage==='lead').length))}</b><span>سرنخ فروش</span></div><div class="kpi"><b>${fa(String(open))}</b><span>پیگیری باز</span></div></div>
 <div class="panel"><h2>دفتر مشتریان</h2><table><tr><th>نام</th><th>سازمان</th><th>تلفن</th><th>ایمیل</th><th>نوع پرونده</th><th>پیگیری‌ها</th></tr>${customers.map(x=>html`<tr><td>${x.name}</td><td>${x.company_name||'—'}</td><td>${x.phone||'—'}</td><td>${x.email||'—'}</td><td>${stages[x.stage]||x.stage}</td><td>${fa(String(x.activity_count))}</td></tr>`)}</table></div>
 ${manage?html`<form method="post" action="/crm/customers" class="panel form">${c.csrf}${co.hidden}<h2>ثبت مشتری یا سرنخ جدید</h2><label>نام و نام خانوادگی / عنوان<input name="name" maxlength="160" required></label><label>نام شرکت<input name="company_name" maxlength="160"></label><label>تلفن<input name="phone" maxlength="30" dir="ltr"></label><label>ایمیل<input name="email" maxlength="190" type="email" dir="ltr"></label><label>نوع پرونده<select name="kind"><option value="lead">سرنخ فروش</option><option value="customer">مشتری</option></select></label><label>یادداشت<textarea name="note" maxlength="1000"></textarea></label><button>ثبت پرونده</button></form>`:html` `}
 ${manage&&customers.some(x=>x.stage!=='inactive')?html`<form method="post" action="/crm/activities" class="panel form">${c.csrf}${co.hidden}<h2>ثبت تماس، جلسه یا یادآوری</h2><label>مشتری<select name="customer_id" required><option value="">انتخاب کنید</option>${customers.filter(x=>x.stage!=='inactive').map(x=>html`<option value="${x.id}">${x.name}</option>`)}</select></label><label>نوع فعالیت<select name="kind"><option value="call">تماس تلفنی</option><option value="meeting">جلسه</option><option value="email">ایمیل</option><option value="note">یادداشت</option></select></label><label>موضوع<input name="subject" maxlength="180" required></label><label>شرح<textarea name="body" maxlength="1500"></textarea></label><label>تاریخ سررسید<input type="date" name="due_on"></label><button>ثبت پیگیری</button></form>`:html` `}
 <div class="panel"><h2>سوابق و پیگیری‌ها</h2><table><tr><th>مشتری</th><th>نوع</th><th>موضوع</th><th>سررسید</th><th>وضعیت</th><th>عملیات</th></tr>${activities.map(a=>html`<tr><td>${a.customer_name}</td><td>${({call:'تماس',meeting:'جلسه',email:'ایمیل',note:'یادداشت'} as Record<string,string>)[a.kind]||a.kind}</td><td>${a.subject}${a.body?html`<small>${a.body}</small>`:html` `}</td><td>${a.due_on||'—'}</td><td>${a.status==='done'?'انجام‌شده':'باز'}</td><td>${a.status==='open'&&manage?html`<form method="post" action="/crm/activities/${a.id}/complete">${c.csrf}${co.hidden}<button class="ghost">بستن پیگیری</button></form>`:html`—`}</td></tr>`)}</table></div>`);
}
