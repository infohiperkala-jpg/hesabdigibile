import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import { HttpError, Invalid } from '../core/errors.js';
import { fa, money } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

async function company(c: Ctx) {
  const group = gate.isGroup(c.A);
  const cid = group ? Number(c.rq.query.get('c') ?? c.rq.form.get('c') ?? await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1')) : Number(c.u.company_id);
  gate.assertCompany(c.A, cid);
  if (!cid || !(await c.db.val('SELECT 1 FROM companies WHERE id=?', [cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.', 404);
  return { cid, hidden: group ? html`<input type="hidden" name="c" value="${cid}">` : html` `,
    url: (path: string) => path + (group ? `?c=${cid}` : '') };
}

/** Sales order workflow: reserve stock atomically and keep a traceable order record. */
export async function handleOrders(c: Ctx): Promise<Out | null> {
  const { rq, db, A } = c;
  if (!['/orders', '/orders/new'].includes(rq.path) && !rq.path.startsWith('/orders/')) return null;
  await gate.require_(db, A, 'market.view');
  const co = await company(c), cid = co.cid, back = co.url('/orders');
  const manage = await gate.can(db, A, 'market.manage');

  if (rq.method === 'POST' && rq.path === '/orders') {
    if (!manage) throw new HttpError('دسترسی ثبت سفارش ندارید.', 403);
    const productId = Number(c.f('product_id')), qty = Number(c.f('qty'));
    const method = c.f('method'), profileRaw = c.f('profile_id').trim(), reference = c.f('pay_reference').trim();
    const profileId = profileRaw ? Number(profileRaw) : null;
    if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(qty) || qty < 1 || qty > 100000) throw new Invalid('کالا و تعداد معتبر انتخاب کنید.');
    if (!['cash','credit'].includes(method)) throw new Invalid('روش فروش معتبر نیست.');
    if (profileRaw && (!Number.isSafeInteger(profileId) || !profileId)) throw new Invalid('شناسه مشتری معتبر نیست.');
    if (reference.length > 80) throw new Invalid('شماره پیگیری بیش از حد مجاز است.');
    return c.done(back, () => db.tx(async t => {
      const p = await t.one('SELECT id,merchant_id,name,price,stock FROM products WHERE id=? AND company_id=? AND status="active" FOR UPDATE',[productId,cid]);
      if (!p) throw new Invalid('کالای فعال یافت نشد.');
      if (Number(p.stock) < qty) throw new Invalid('موجودی کافی نیست.');
      if (profileId && !(await t.val('SELECT 1 FROM identity_profiles WHERE id=? AND company_id=?',[profileId,cid]))) throw new Invalid('مشتری متعلق به این شرکت نیست.');
      const subtotal = Number(p.price) * qty;
      if (!Number.isSafeInteger(subtotal) || subtotal < 0) throw new Invalid('مبلغ سفارش خارج از محدوده مجاز است.');
      const orderId = await t.insert('INSERT INTO orders(company_id,merchant_id,profile_id,method,status,subtotal,pay_reference,created_by,created_at) VALUES(?,?,?,?, "placed",?,?,?,?)',
        [cid,p.merchant_id,profileId,method,subtotal,reference || null,A.id,db.now()]);
      await t.insert('INSERT INTO order_items(order_id,product_id,name,qty,unit_price) VALUES(?,?,?,?,?)',[orderId,p.id,p.name,qty,p.price]);
      await t.exec('UPDATE products SET stock=stock-? WHERE id=?',[qty,p.id]);
      await audit.log(t,A,'order.create','order',orderId,{product_id:p.id,qty,subtotal,method},cid);
    }), 'سفارش ثبت شد و موجودی کالا به‌روزرسانی شد.');
  }

  if (rq.path === '/orders/new') {
    if (!manage) throw new HttpError('دسترسی ثبت سفارش ندارید.',403);
    const products = await db.all('SELECT id,name,sku,price,stock FROM products WHERE company_id=? AND status="active" AND stock>0 ORDER BY name',[cid]);
    const profiles = await db.all('SELECT id,first_name,last_name,mobile FROM identity_profiles WHERE company_id=? ORDER BY id DESC LIMIT 300',[cid]);
    return c.render('ثبت سفارش جدید',html`
      <div class="panel"><form method="post" action="/orders" class="form">${c.csrf}${co.hidden}<h2>اطلاعات سفارش</h2>
      <label>کالا<select name="product_id" required><option value="">انتخاب کالا</option>${products.map(p=>html`<option value="${p.id}">${p.name} — ${p.sku} | موجودی ${fa(String(p.stock))} | ${money(p.price)} ریال</option>`)}</select></label>
      <label>تعداد<input name="qty" type="number" min="1" max="100000" value="1" required></label>
      <label>مشتری (اختیاری)<select name="profile_id"><option value="">بدون اتصال به پرونده</option>${profiles.map(p=>html`<option value="${p.id}">${p.first_name} ${p.last_name} — ${p.mobile}</option>`)}</select></label>
      <label>روش فروش<select name="method"><option value="cash">نقدی</option><option value="credit">اعتباری</option></select></label>
      <label>شماره پیگیری پرداخت (اختیاری)<input name="pay_reference" maxlength="80" dir="ltr"></label><button>ثبت سفارش و کسر موجودی</button></form></div>`);
  }

  const match = rq.path.match(/^\/orders\/(\d+)$/);
  if (match) {
    const id = Number(match[1]);
    const order = await db.one('SELECT o.*,m.name merchant_name,CONCAT(COALESCE(i.first_name,"")," ",COALESCE(i.last_name,"")) customer_name FROM orders o JOIN merchants m ON m.id=o.merchant_id LEFT JOIN identity_profiles i ON i.id=o.profile_id WHERE o.id=? AND o.company_id=?',[id,cid]);
    if (!order) throw new HttpError('سفارش یافت نشد.',404);
    const items = await db.all('SELECT name,qty,unit_price,qty*unit_price line_total FROM order_items WHERE order_id=? ORDER BY id',[id]);
    return c.render(`سفارش شماره ${fa(String(id))}`,html`
      <p><a href="${back}">بازگشت به سفارش‌ها</a></p><div class="panel"><h2>مشخصات سفارش</h2>
      <p>پذیرنده: <b>${order.merchant_name}</b></p><p>مشتری: <b>${order.customer_name?.trim() || 'ثبت نشده'}</b></p>
      <p>روش: ${order.method==='cash'?'نقدی':'اعتباری'} | وضعیت: ${order.status}</p>
      <p>تاریخ ثبت: ${order.created_at}</p><p>مبلغ کل: <b>${money(order.subtotal)} ریال</b></p>
      <table><tr><th>شرح کالا</th><th>تعداد</th><th>قیمت واحد</th><th>جمع</th></tr>${items.map(i=>html`<tr><td>${i.name}</td><td>${fa(String(i.qty))}</td><td>${money(i.unit_price)}</td><td>${money(i.line_total)}</td></tr>`)}</table></div>`);
  }

  const status = rq.query.get('status')?.trim() ?? '';
  const validStatus = ['placed','paid','cancelled','fulfilled'].includes(status) ? status : '';
  const rows = await db.all('SELECT o.id,o.status,o.method,o.subtotal,o.created_at,m.name merchant_name,COUNT(oi.id) item_count FROM orders o JOIN merchants m ON m.id=o.merchant_id LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.company_id=? AND (?="" OR o.status=?) GROUP BY o.id ORDER BY o.id DESC LIMIT 300',[cid,validStatus,validStatus]);
  const total = rows.reduce((n,r)=>n+Number(r.subtotal),0);
  return c.render('فروش و سفارشات',html`
    <div class="kpis"><div class="kpi"><b>${fa(String(rows.length))}</b><span>سفارش‌های نمایش‌داده‌شده</span></div><div class="kpi"><b>${money(total)}</b><span>جمع مبلغ سفارش‌ها (ریال)</span></div></div>
    <div class="panel" style="display:flex;justify-content:space-between;align-items:center;gap:12px"><form method="get"><label>وضعیت<select name="status"><option value="">همه وضعیت‌ها</option>${[['placed','ثبت‌شده'],['paid','پرداخت‌شده'],['fulfilled','تکمیل‌شده'],['cancelled','لغوشده']].map(([v,l])=>html`<option value="${v}"${validStatus===v?' selected':''}>${l}</option>`)}</select></label><button class="ghost">اعمال</button></form>${manage?html`<a class="button" href="/orders/new">ثبت سفارش جدید</a>`:html` `}</div>
    <div class="panel"><h2>فهرست سفارش‌ها</h2><table><tr><th>شماره</th><th>پذیرنده</th><th>اقلام</th><th>روش</th><th>مبلغ (ریال)</th><th>وضعیت</th><th>تاریخ</th></tr>${rows.map(r=>html`<tr><td><a href="/orders/${r.id}">#${fa(String(r.id))}</a></td><td>${r.merchant_name}</td><td>${fa(String(r.item_count))}</td><td>${r.method==='cash'?'نقدی':'اعتباری'}</td><td>${money(r.subtotal)}</td><td>${r.status==='placed'?'ثبت‌شده':r.status==='paid'?'پرداخت‌شده':r.status==='fulfilled'?'تکمیل‌شده':r.status}</td><td>${r.created_at}</td></tr>`)}</table></div>`);
}
