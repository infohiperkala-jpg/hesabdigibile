import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import { HttpError, Invalid } from '../core/errors.js';
import { fa, money, parseAmount } from '../core/validator.js';
import { html } from './view.js';
import { Ctx, Out } from './types.js';

async function company(c: Ctx) {
  const group = gate.isGroup(c.A);
  const cid = group
    ? Number(c.rq.query.get('c') ?? c.rq.form.get('c') ?? await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1'))
    : Number(c.u.company_id);
  gate.assertCompany(c.A, cid);
  if (!cid || !(await c.db.val('SELECT 1 FROM companies WHERE id=?', [cid]))) throw new HttpError('شرکت انتخاب‌شده معتبر نیست.', 404);
  return { cid, group, hidden: group ? html`<input type="hidden" name="c" value="${cid}">` : html``,
    url: (path: string) => path + (group ? `?c=${cid}` : '') };
}

/** Operational marketplace catalog and inventory screens backed by the existing MySQL tables. */
export async function handleMarketplace(c: Ctx): Promise<Out | null> {
  const { rq, db, A } = c, path = rq.path;
  if (!['/market','/products','/inventory'].includes(path)) return null;
  const perm = path === '/market' ? 'market.view' : 'market.catalog';
  await gate.require_(db, A, perm);
  const co = await company(c), { cid } = co;
  const canManage = await gate.can(db, A, 'market.manage');
  const canCatalog = await gate.can(db, A, 'market.catalog');
  const back = co.url(path);

  if (rq.method === 'POST') {
    if (path === '/market' && rq.path === '/market') {
      const name = c.f('name').trim(), slug = c.f('slug').trim().toLowerCase();
      const commission = Number(c.f('commission'));
      if (name.length < 2 || !/^[a-z0-9][a-z0-9-]{1,78}$/.test(slug)) throw new Invalid('نام پذیرنده و شناسه لاتین معتبر الزامی است.');
      if (!Number.isInteger(commission) || commission < 0 || commission > 10000) throw new Invalid('درصد کارمزد باید بین صفر تا ۱۰۰ باشد.');
      return c.done(back, async () => {
        const id = await db.insert('INSERT INTO merchants(company_id,name,slug,status,commission_bp,created_by,created_at) VALUES(?,?,?,"pending",?,?,?)',
          [cid,name,slug,commission,A.id,db.now()]);
        await audit.log(db,A,'merchant.create','merchant',id,{name,slug,commission_bp:commission},cid);
      }, 'پذیرنده ثبت شد و در انتظار فعال‌سازی است.');
    }
    if (path === '/products') {
      if (!canCatalog) throw new HttpError('دسترسی مدیریت کاتالوگ ندارید.',403);
      const merchant = Number(c.f('merchant_id')), name = c.f('name').trim(), sku = c.f('sku').trim();
      const price = parseAmount(c.f('price')), stock = Number(c.f('stock'));
      if (!merchant || name.length < 2 || !/^[A-Za-z0-9._-]{2,60}$/.test(sku)) throw new Invalid('پذیرنده، نام کالا و کد SKU معتبر الزامی است.');
      if (price === null || price < 0 || !Number.isSafeInteger(stock) || stock < 0) throw new Invalid('قیمت و موجودی باید عدد صحیح نامنفی باشند.');
      return c.done(back, async () => {
        if (!(await db.val('SELECT 1 FROM merchants WHERE id=? AND company_id=? AND status="active"',[merchant,cid]))) throw new Invalid('پذیرنده فعال متعلق به این شرکت انتخاب کنید.');
        const id = await db.insert('INSERT INTO products(company_id,merchant_id,name,sku,category,price,stock,status,created_at) VALUES(?,?,?,?,?,?,?,"active",?)',
          [cid,merchant,name,sku,c.f('category').trim() || null,price,stock,db.now()]);
        await audit.log(db,A,'product.create','product',id,{name,sku,price,stock},cid);
      }, 'کالا به کاتالوگ اضافه شد.');
    }
    if (path === '/inventory') {
      if (!canCatalog) throw new HttpError('دسترسی مدیریت موجودی ندارید.',403);
      const id = Number(c.f('product_id')), delta = Number(c.f('delta')), reason = c.f('reason').trim();
      if (!id || !Number.isSafeInteger(delta) || delta === 0 || reason.length < 5) throw new Invalid('کالا، مقدار تغییر غیرصفر و علت حداقل پنج‌کاراکتری الزامی است.');
      return c.done(back, async () => db.tx(async t => {
        const p = await t.one('SELECT id,stock,name FROM products WHERE id=? AND company_id=? FOR UPDATE',[id,cid]);
        if (!p) throw new Invalid('کالا یافت نشد.');
        const next = Number(p.stock) + delta;
        if (next < 0) throw new Invalid('موجودی نهایی نمی‌تواند منفی باشد.');
        await t.exec('UPDATE products SET stock=? WHERE id=?',[next,id]);
        await audit.log(t,A,'inventory.adjust','product',id,{before:Number(p.stock),delta,after:next,reason},cid);
      }), 'موجودی کالا اصلاح شد.');
    }
  }

  if (path === '/market') {
    const rows = await db.all('SELECT m.*, (SELECT COUNT(*) FROM products p WHERE p.merchant_id=m.id) product_count FROM merchants m WHERE m.company_id=? ORDER BY m.id DESC LIMIT 250',[cid]);
    return c.render('بازارگاه و پذیرندگان',html`
      <div class="kpis"><div class="kpi"><b>${fa(String(rows.length))}</b><span>پذیرندگان ثبت‌شده</span></div><div class="kpi"><b>${fa(String(rows.filter(x=>x.status==='active').length))}</b><span>پذیرندگان فعال</span></div></div>
      <div class="panel"><h2>فهرست پذیرندگان</h2><table><tr><th>نام</th><th>شناسه</th><th>کالاها</th><th>کارمزد</th><th>وضعیت</th></tr>${rows.map(r=>html`<tr><td>${r.name}</td><td dir="ltr">${r.slug}</td><td>${fa(String(r.product_count))}</td><td>${fa((Number(r.commission_bp)/100).toFixed(2))}٪</td><td>${r.status==='active'?'فعال':r.status==='pending'?'در انتظار بررسی':r.status}</td></tr>`)}</table></div>
      ${canManage?html`<form method="post" action="/market" class="panel form">${c.csrf}${co.hidden}<h2>ثبت پذیرنده جدید</h2><label>نام پذیرنده<input name="name" required minlength="2" maxlength="160"></label><label>شناسه لاتین (Slug)<input name="slug" dir="ltr" required pattern="[a-z0-9][a-z0-9-]{1,78}"></label><label>کارمزد (واحد پایه؛ ۱۰۰ = یک درصد)<input name="commission" type="number" min="0" max="10000" value="0" required></label><button>ثبت پذیرنده</button></form>`:''}
    `);
  }
  const merchants = await db.all('SELECT id,name,status FROM merchants WHERE company_id=? ORDER BY name',[cid]);
  if (path === '/products') {
    const q = rq.query.get('q')?.trim() ?? '';
    const rows = await db.all('SELECT p.*,m.name merchant_name FROM products p JOIN merchants m ON m.id=p.merchant_id WHERE p.company_id=? AND (?="" OR p.name LIKE CONCAT("%",?,"%") OR p.sku LIKE CONCAT("%",?,"%")) ORDER BY p.id DESC LIMIT 300',[cid,q,q,q]);
    return c.render('کالا و خدمات',html`
      <form method="get" class="panel form"><label>جست‌وجوی نام یا SKU<input name="q" value="${q}" placeholder="نام کالا یا کد کالا"></label><button>جست‌وجو</button></form>
      <div class="panel"><h2>کاتالوگ کالاها</h2><table><tr><th>کالا</th><th>SKU</th><th>پذیرنده</th><th>دسته</th><th>قیمت (ریال)</th><th>موجودی</th><th>وضعیت</th></tr>${rows.map(r=>html`<tr><td>${r.name}</td><td dir="ltr">${r.sku}</td><td>${r.merchant_name}</td><td>${r.category??'—'}</td><td dir="ltr">${money(r.price)}</td><td>${fa(String(r.stock))}</td><td>${r.status==='active'?'فعال':r.status}</td></tr>`)}</table><p class="muted">تعداد نتایج: ${fa(String(rows.length))}</p></div>
      ${canCatalog?html`<form method="post" action="/products" class="panel form">${c.csrf}${co.hidden}<h2>افزودن کالا</h2><label>پذیرنده<select name="merchant_id" required><option value="">انتخاب کنید</option>${merchants.filter(m=>m.status==='active').map(m=>html`<option value="${m.id}">${m.name}</option>`)}</select></label><label>نام کالا<input name="name" required maxlength="200"></label><label>کد SKU<input name="sku" dir="ltr" required maxlength="60"></label><label>دسته‌بندی<input name="category" maxlength="80"></label><label>قیمت به ریال<input name="price" inputmode="numeric" required></label><label>موجودی اولیه<input name="stock" type="number" min="0" value="0" required></label><button>ثبت کالا</button></form>`:''}
    `);
  }
  const rows = await db.all('SELECT p.id,p.name,p.sku,p.stock,m.name merchant_name FROM products p JOIN merchants m ON m.id=p.merchant_id WHERE p.company_id=? ORDER BY p.stock ASC,p.name LIMIT 300',[cid]);
  return c.render('انبار و موجودی',html`
    <div class="kpis"><div class="kpi"><b>${fa(String(rows.length))}</b><span>اقلام کاتالوگ</span></div><div class="kpi"><b>${fa(String(rows.filter(x=>Number(x.stock)<=5).length))}</b><span>اقلام با موجودی کم (۵ یا کمتر)</span></div></div>
    <div class="panel"><h2>وضعیت موجودی</h2><table><tr><th>کالا</th><th>SKU</th><th>پذیرنده</th><th>موجودی</th><th>هشدار</th></tr>${rows.map(r=>html`<tr><td>${r.name}</td><td dir="ltr">${r.sku}</td><td>${r.merchant_name}</td><td>${fa(String(r.stock))}</td><td>${Number(r.stock)<=5?'نیازمند تأمین':'عادی'}</td></tr>`)}</table></div>
    ${canCatalog?html`<form method="post" action="/inventory" class="panel form">${c.csrf}${co.hidden}<h2>اصلاح موجودی با ثبت علت</h2><label>کالا<select name="product_id" required><option value="">انتخاب کنید</option>${rows.map(r=>html`<option value="${r.id}">${r.name} — موجودی ${r.stock}</option>`)}</select></label><label>تغییر موجودی (مثبت برای ورود، منفی برای خروج)<input name="delta" type="number" required></label><label>علت اصلاح<input name="reason" required minlength="5" maxlength="250"></label><button>ثبت اصلاح موجودی</button></form>`:''}
  `);
}
