import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import { HttpError, Invalid } from '../core/errors.js';
import { fa, money, parseAmount } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

async function company(c: Ctx) {
  const group=gate.isGroup(c.A);
  const cid=group?Number(c.rq.query.get('c')??c.rq.form.get('c')??await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1')):Number(c.u.company_id);
  gate.assertCompany(c.A,cid);
  if(!cid||!(await c.db.val('SELECT 1 FROM companies WHERE id=?',[cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.',404);
  return {cid,hidden:group?html`<input type="hidden" name="c" value="${cid}">`:html` `,url:(p:string)=>p+(group?`?c=${cid}`:'')};
}
const dateOk=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+'T00:00:00Z'));

export async function handlePurchases(c:Ctx):Promise<Out|null>{
 const {rq,db,A}=c;
 if(!rq.path.startsWith('/purchases')) return null;
 await gate.require_(db,A,'purchase.view');
 const co=await company(c),cid=co.cid,back=co.url('/purchases');
 const manage=await gate.can(db,A,'purchase.manage'),receive=await gate.can(db,A,'purchase.receive');
 if(rq.method==='POST'&&rq.path==='/purchases/suppliers'){
  if(!manage) throw new HttpError('دسترسی مدیریت تأمین‌کنندگان ندارید.',403);
  const name=c.f('name').trim(),contact=c.f('contact_name').trim(),phone=c.f('phone').trim(),email=c.f('email').trim(),address=c.f('address').trim();
  if(name.length<2||name.length>160||contact.length>120||phone.length>30||email.length>190||address.length>500|| (email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Invalid('اطلاعات تأمین‌کننده معتبر نیست.');
  return c.done(back,()=>db.tx(async t=>{
   const id=await t.insert('INSERT INTO suppliers(company_id,name,contact_name,phone,email,address,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',[cid,name,contact||null,phone||null,email||null,address||null,A.id,db.now()]);
   await audit.log(t,A,'supplier.create','supplier',id,{name,phone,email},cid);
  }),'تأمین‌کننده ثبت شد.');
 }
 if(rq.method==='POST'&&rq.path==='/purchases/orders'){
  if(!manage) throw new HttpError('دسترسی ثبت سفارش خرید ندارید.',403);
  const supplier=Number(c.f('supplier_id')),product=Number(c.f('product_id')),qty=Number(c.f('qty')),cost=parseAmount(c.f('unit_cost')),expected=c.f('expected_on'),note=c.f('note').trim();
  if(!supplier||!product||!Number.isSafeInteger(qty)||qty<1||qty>1000000||cost===null||cost<0||cost>9000000000000000||note.length>500||(expected&&!dateOk(expected))) throw new Invalid('اطلاعات سفارش خرید معتبر نیست.');
  return c.done(back,()=>db.tx(async t=>{
   const s=await t.one('SELECT id FROM suppliers WHERE id=? AND company_id=? AND status="active" FOR UPDATE',[supplier,cid]);
   const p=await t.one('SELECT id,name FROM products WHERE id=? AND company_id=? AND status="active" FOR UPDATE',[product,cid]);
   if(!s||!p) throw new Invalid('تأمین‌کننده یا کالای فعال متعلق به این شرکت انتخاب کنید.');
   const total=qty*cost;
   if(!Number.isSafeInteger(total)) throw new Invalid('مبلغ کل سفارش بیش از حد مجاز است.');
   const id=await t.insert('INSERT INTO purchase_orders(company_id,supplier_id,status,total,expected_on,note,created_by,created_at) VALUES(?,?, "ordered",?,?,?,?,?)',[cid,supplier,total,expected||null,note||null,A.id,db.now()]);
   await t.insert('INSERT INTO purchase_order_items(purchase_order_id,product_id,product_name,qty,unit_cost) VALUES(?,?,?,?,?)',[id,product,p.name,qty,cost]);
   await audit.log(t,A,'purchase.order.create','purchase_order',id,{supplier_id:supplier,product_id:product,qty,unit_cost:cost,total},cid);
  }),'سفارش خرید ثبت شد.');
 }
 const match=rq.path.match(/^\/purchases\/(\d+)\/receive$/);
 if(rq.method==='POST'&&match){
  if(!receive) throw new HttpError('دسترسی ثبت رسید خرید ندارید.',403);
  const id=Number(match[1]);
  return c.done(back,()=>db.tx(async t=>{
   const order=await t.one('SELECT * FROM purchase_orders WHERE id=? AND company_id=? FOR UPDATE',[id,cid]);
   if(!order||order.status!=='ordered') throw new Invalid('سفارش پیدا نشد یا قبلاً دریافت شده است.');
   const items=await t.all('SELECT * FROM purchase_order_items WHERE purchase_order_id=? FOR UPDATE',[id]);
   if(!items.length) throw new Invalid('سفارش فاقد اقلام است.');
   for(const item of items){
    const p=await t.one('SELECT id,stock FROM products WHERE id=? AND company_id=? FOR UPDATE',[item.product_id,cid]);
    if(!p) throw new Invalid('کالای سفارش دیگر در این شرکت موجود نیست.');
    const next=Number(p.stock)+Number(item.qty);
    if(!Number.isSafeInteger(next)||next>2147483647) throw new Invalid('موجودی نهایی از ظرفیت مجاز بیشتر می‌شود.');
    await t.exec('UPDATE products SET stock=? WHERE id=?',[next,item.product_id]);
    await t.exec('UPDATE purchase_order_items SET received_qty=qty WHERE id=?',[item.id]);
   }
   await t.exec('UPDATE purchase_orders SET status="received",received_at=? WHERE id=?',[db.now(),id]);
   await audit.log(t,A,'purchase.order.receive','purchase_order',id,{items:items.length,total:order.total},cid);
  }),'رسید خرید ثبت شد و موجودی انبار افزایش یافت.');
 }
 const suppliers=await db.all('SELECT * FROM suppliers WHERE company_id=? ORDER BY name',[cid]);
 const products=await db.all('SELECT id,name,sku,stock FROM products WHERE company_id=? AND status="active" ORDER BY name',[cid]);
 const orders=await db.all('SELECT o.*,s.name supplier_name,(SELECT COUNT(*) FROM purchase_order_items i WHERE i.purchase_order_id=o.id) item_count FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id WHERE o.company_id=? ORDER BY o.id DESC LIMIT 300',[cid]);
 const outstanding=orders.filter(o=>o.status==='ordered').reduce((n,o)=>n+Number(o.total),0);
 return c.render('خرید و تأمین‌کنندگان',html`
 <div class="kpis"><div class="kpi"><b>${fa(String(suppliers.length))}</b><span>تأمین‌کننده</span></div><div class="kpi"><b>${fa(String(orders.length))}</b><span>سفارش خرید</span></div><div class="kpi"><b>${money(outstanding)}</b><span>ارزش سفارش‌های دریافت‌نشده (ریال)</span></div></div>
 <div class="panel"><h2>فهرست سفارش‌های خرید</h2><table><tr><th>شماره</th><th>تأمین‌کننده</th><th>اقلام</th><th>مبلغ کل (ریال)</th><th>تاریخ مورد انتظار</th><th>وضعیت</th><th>عملیات</th></tr>${orders.map(o=>html`<tr><td>${fa(String(o.id))}</td><td>${o.supplier_name}</td><td>${fa(String(o.item_count))}</td><td>${money(o.total)}</td><td>${o.expected_on||'—'}</td><td>${o.status==='received'?'دریافت‌شده':'در انتظار دریافت'}</td><td>${o.status==='ordered'&&receive?html`<form method="post" action="/purchases/${o.id}/receive">${c.csrf}${co.hidden}<button>ثبت رسید و ورود به انبار</button></form>`:html`—`}</td></tr>`)}</table></div>
 ${manage?html`<form method="post" action="/purchases/suppliers" class="panel form">${c.csrf}${co.hidden}<h2>ثبت تأمین‌کننده</h2><label>نام شرکت / شخص<input name="name" maxlength="160" required></label><label>نام رابط<input name="contact_name" maxlength="120"></label><label>تلفن<input name="phone" maxlength="30" dir="ltr"></label><label>ایمیل<input name="email" maxlength="190" type="email" dir="ltr"></label><label>نشانی<input name="address" maxlength="500"></label><button>ثبت تأمین‌کننده</button></form>`:html` `}
 ${manage?html`<form method="post" action="/purchases/orders" class="panel form">${c.csrf}${co.hidden}<h2>ایجاد سفارش خرید</h2><label>تأمین‌کننده<select name="supplier_id" required><option value="">انتخاب کنید</option>${suppliers.filter(s=>s.status==='active').map(s=>html`<option value="${s.id}">${s.name}</option>`)}</select></label><label>کالا<select name="product_id" required><option value="">انتخاب کنید</option>${products.map(p=>html`<option value="${p.id}">${p.name} — موجودی فعلی: ${fa(String(p.stock))}</option>`)}</select></label><label>تعداد<input name="qty" type="number" min="1" max="1000000" required></label><label>قیمت واحد (ریال)<input name="unit_cost" inputmode="numeric" required></label><label>تاریخ مورد انتظار دریافت<input name="expected_on" type="date"></label><label>توضیحات<input name="note" maxlength="500"></label><button>ثبت سفارش خرید</button></form>`:html` `}
 <div class="panel"><h2>تأمین‌کنندگان</h2><table><tr><th>نام</th><th>رابط</th><th>تلفن</th><th>ایمیل</th><th>وضعیت</th></tr>${suppliers.map(s=>html`<tr><td>${s.name}</td><td>${s.contact_name||'—'}</td><td>${s.phone||'—'}</td><td>${s.email||'—'}</td><td>${s.status==='active'?'فعال':'غیرفعال'}</td></tr>`)}</table></div>`);
}
