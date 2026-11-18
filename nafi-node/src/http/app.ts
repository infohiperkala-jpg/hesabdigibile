import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db, Row } from '../core/db.js';
import { env } from '../core/env.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as gate from '../core/gate.js';
import * as audit from '../core/audit.js';
import * as totp from '../core/totp.js';
import * as J from '../core/jalali.js';
import { fa, money, digits } from '../core/validator.js';
import * as authSvc from '../services/auth.js';
import * as mfa from '../services/mfa.js';
import * as org from '../services/org.js';
import * as acc from '../services/accounting.js';
import * as S from './session.js';
import { esc, html, raw, Raw, layout, menuFor, csrfField } from './view.js';
import { Req, Out, Ctx } from './types.js';
import { handleAccounting, handleCredit } from './finance.js';
import { handleEditPages } from './edit-pages.js';
import { handleRegistration } from './registration-pages.js';
import { handleMarketplace } from './marketplace.js';
import { handleOrders } from './orders.js';
import { handleTreasury } from './treasury.js';
import { handlePurchases } from './purchases.js';
import { handleCrm } from './crm.js';
import { handleContracts } from './contracts.js';
import { handleDocuments } from './documents.js';
import { parseMultipart } from './multipart.js';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'app.css'));
const redirect = (to: string, cookie?: string): Out => ({ status: 303, body: '', headers: { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
const page = (b: string, status = 200): Out => ({ status, body: b });
const cookieOf = (name: string, h?: string) => h?.split(';').map(c => c.trim().split('=')).find(([k]) => k === name)?.[1];
const setCookie = (token: string, secure: boolean) => `nafi_sid=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
const bare = (title: string, inner: string) => `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} – پلتفرم نگار آذین فدک</title><link rel="stylesheet" href="/assets/app.css"></head><body class="login">${inner}</body></html>`;
const st = (s: string) => ({ active: 'فعال', disabled: 'غیرفعال' } as Record<string, string>)[s] ?? s;

export function makeHandler(db: Db) {
  return async function handle(rq: Req, token: string | undefined): Promise<Out & { cookie?: string }> {
    let sess = await S.load(db, token); let setTok: string | null = sess.token !== token ? sess.token : null;
    const out = async (): Promise<Out> => {
      const { path, method } = rq;
      if (path === '/login/mfa') {
        if (!S.mfaPendingValid(sess)) return redirect('/login');
        if (method === 'POST') {
          if (!S.csrfOk(sess, rq.form.get('_csrf'))) throw new HttpError('نشست منقضی شده است. صفحه را دوباره بارگذاری کنید.', 419);
          const uid = sess.mfa_user_id!;
          if (!(await mfa.verifyLogin(db, uid, rq.form.get('code') ?? '', undefined, rq.ip))) { await S.setFlash(db, sess, 'کد نادرست است (یا حساب موقتاً قفل شده است).', 'err'); return redirect('/login/mfa'); }
          const u = await db.one("SELECT * FROM users WHERE id = ? AND status = 'active'", [uid]); if (!u) return redirect('/login');
          await audit.log(db, u as any, 'auth.login_mfa', 'user', uid, {}, undefined, rq.ip);
          sess = await S.rotate(db, sess, { user_id: uid }); setTok = sess.token; return redirect('/');
        }
        const fl = await S.popFlash(db, sess);
        return page(bare('تأیید دومرحله‌ای', html`<form method="post" action="/login/mfa" class="box" autocomplete="off"><h1>تأیید دومرحله‌ای</h1><p class="muted">کد ۶ رقمی برنامه احراز هویت یا یکی از کدهای بازیابی را وارد کنید.</p>${fl ? raw(`<div class="flash err">${esc(fl[0])}</div>`) : ''}${csrfField(sess.csrf)}<label>کد<input name="code" dir="ltr" inputmode="numeric" autocomplete="one-time-code" required autofocus></label><button>ورود</button><a href="/login">بازگشت</a></form>`.s));
      }
      if (path === '/login') {
        if (method === 'POST') {
          if (!S.csrfOk(sess, rq.form.get('_csrf'))) throw new HttpError('نشست منقضی شده است. صفحه را دوباره بارگذاری کنید.', 419);
          const u = await authSvc.attempt(db, rq.form.get('email') ?? '', rq.form.get('password') ?? '', rq.ip);
          if (!u) { await S.setFlash(db, sess, 'ایمیل یا گذرواژه نادرست است (یا حساب موقتاً قفل شده است).', 'err'); return redirect('/login'); }
          sess = await S.rotate(db, sess, u.mfa_enabled ? { mfa_user_id: Number(u.id) } : { user_id: Number(u.id) }); setTok = sess.token;
          return redirect(u.mfa_enabled ? '/login/mfa' : '/');
        }
        const fl = await S.popFlash(db, sess);
        return page(bare('ورود', html`<form method="post" action="/login" class="box"><h1>پلتفرم نگار آذین فدک</h1><p class="muted">ورود به مرکز مدیریت مجموعه</p>${fl ? raw(`<div class="flash err">${esc(fl[0])}</div>`) : ''}${csrfField(sess.csrf)}<label>ایمیل<input type="email" name="email" required autocomplete="username" autofocus></label><label>گذرواژه<input type="password" name="password" required autocomplete="current-password"></label><button>ورود</button></form>`.s));
      }
      const u = await S.user(db, sess); if (!u) return redirect('/login');
      const ACCOUNT = ['/account', '/account/mfa', '/account/password', '/logout'];
      if (env('MFA_REQUIRED', '1') === '1' && !u.mfa_enabled && !ACCOUNT.includes(path)) { await S.setFlash(db, sess, 'برای ادامه، احراز هویت دومرحله‌ای (MFA) را فعال کنید.', 'err'); return redirect('/account'); }
      if (method === 'POST' && !S.csrfOk(sess, rq.form.get('_csrf'))) throw new HttpError('نشست منقضی شده است. صفحه را دوباره بارگذاری کنید.', 419);
      const f = (k: string) => rq.form.get(k) ?? '';
      const done = async (to: string, fn: () => Promise<unknown>, okMsg: string): Promise<Out> => { try { await fn(); await S.setFlash(db, sess, okMsg); } catch (e) { if (e instanceof Invalid) await S.setFlash(db, sess, e.message, 'err'); else throw e; } return redirect(to); };
      const render = async (title: string, body: Raw, extra: Partial<{ flashOverride: [string, string] | null }> = {}): Promise<Out> => {
        const fl = extra.flashOverride !== undefined ? extra.flashOverride : await S.popFlash(db, sess);
        return page(layout({ u, title, csrf: sess.csrf, flash: fl, menu: await menuFor(db, u as any), path }, body));
      };
      const A = u as any as audit.Actor; const csrf = csrfField(sess.csrf);
      if (method === 'POST' && path === '/logout') { await audit.log(db, A, 'auth.logout', 'user', u.id); await S.destroy(db, sess); return redirect('/login', 'nafi_sid=; Path=/; Max-Age=0'); }

      if (method === 'GET' && path === '/') {
        await gate.require_(db, A, 'dashboard.view');
        const [wc, pc] = gate.scope(A, 'id'), [w, p] = gate.scope(A);
        const kpi = { 'شرکت‌ها': await db.val(`SELECT COUNT(*) FROM companies WHERE ${wc}`, pc), 'برندها': await db.val(`SELECT COUNT(*) FROM brands WHERE ${w}`, p), 'دامنه‌ها': await db.val(`SELECT COUNT(*) FROM domains d JOIN brands b ON b.id = d.brand_id WHERE ${gate.scope(A, 'b.company_id')[0]}`, p), 'کاربران': await db.val(`SELECT COUNT(*) FROM users WHERE ${w}`, p) };
        const recent = (await gate.can(db, A, 'audit.view')) ? await db.all(`SELECT a.*, x.name AS uname FROM audit_logs a LEFT JOIN users x ON x.id = a.user_id WHERE ${gate.scope(A, 'a.company_id')[0]} ORDER BY a.id DESC LIMIT 8`, p) : [];
        const chain = gate.isGroup(A) && (await gate.can(db, A, 'audit.view')) ? await audit.verify(db) : false;
        return render('داشبورد مدیریت کل', html`<div class="kpis">${Object.entries(kpi).map(([l, v]) => html`<div class="kpi"><b>${fa(String(v))}</b><span>${l}</span></div>`)}</div><p class="muted">فقط شاخص‌هایی که ماژول و داده واقعی دارند نمایش داده می‌شوند.</p>${chain === false ? '' : html`<div class="flash ${chain === null ? 'ok' : 'err'}">${chain === null ? 'زنجیره لاگ حسابرسی سالم است.' : 'هشدار: دست‌کاری در لاگ حسابرسی شناسایی شد (ردیف ' + chain + ').'}</div>`}${recent.length ? html`<div class="panel"><h2>فعالیت‌های اخیر</h2><table><tr><th>زمان</th><th>کاربر</th><th>عملیات</th><th>مورد</th></tr>${recent.map(r => html`<tr><td>${J.format(r.created_at)}</td><td>${r.uname ?? 'سیستم'}</td><td dir="ltr">${r.action}</td><td>${(r.entity ?? '') + (r.entity_id ? ' #' + r.entity_id : '')}</td></tr>`)}</table></div>` : ''}`);
      }
      if (path === '/companies') {
        await gate.require_(db, A, 'company.view');
        if (method === 'POST') return done('/companies', () => org.createCompany(db, A, f('name'), f('legal_name') || null, f('parent_id') ? Number(f('parent_id')) : null), 'شرکت ایجاد شد.');
        const [w, p] = gate.scope(A, 'c.id'), rows = await db.all(`SELECT c.*, pp.name AS parent_name, (SELECT COUNT(*) FROM brands b WHERE b.company_id = c.id) AS brand_count FROM companies c LEFT JOIN companies pp ON pp.id = c.parent_id WHERE ${w} ORDER BY c.id`, p);
        const all = gate.isGroup(A) ? await db.all('SELECT id, name FROM companies ORDER BY id') : [];
        return render('شرکت‌ها و زیرمجموعه‌ها', html`<div class="panel"><table><tr><th>#</th><th>نام</th><th>شرکت مادر</th><th>برندها</th><th>وضعیت</th><th>ایجاد</th></tr>${rows.map(r => html`<tr><td>${r.id}</td><td><a href="/companies/${r.id}">${r.name}</a></td><td>${r.parent_name ?? '—'}</td><td>${r.brand_count}</td><td>${st(r.status)}</td><td>${J.format(r.created_at, false)}</td></tr>`)}</table></div>${gate.isGroup(A) && await gate.can(db, A, 'company.manage') ? html`<form method="post" class="panel form"><h2>شرکت جدید</h2>${csrf}<label>نام شرکت<input name="name" required maxlength="120"></label><label>نام حقوقی<input name="legal_name" maxlength="190"></label><label>شرکت مادر<select name="parent_id"><option value="">— بدون مادر —</option>${all.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></label><button>ایجاد شرکت</button></form>` : ''}`);
      }
      if (path === '/brands') {
        await gate.require_(db, A, 'brand.view');
        if (method === 'POST') return done('/brands', () => org.createBrand(db, A, Number(f('company_id')), f('name'), f('slug'), f('host') || null), 'برند ایجاد شد.');
        const [w, p] = gate.scope(A, 'b.company_id'), rows = await db.all(`SELECT b.*, c.name AS company_name FROM brands b JOIN companies c ON c.id = b.company_id WHERE ${w} ORDER BY b.id`, p);
        const hosts = new Map<number, string[]>(); for (const d of await db.all('SELECT brand_id, host FROM domains ORDER BY id')) hosts.set(Number(d.brand_id), [...(hosts.get(Number(d.brand_id)) ?? []), d.host]);
        const [wc, pc] = gate.scope(A, 'id'), cos = await db.all(`SELECT id, name FROM companies WHERE ${wc} ORDER BY id`, pc);
        return render('برندها و دامنه‌ها', html`<div class="panel"><table><tr><th>#</th><th>برند</th><th>شناسه</th><th>شرکت</th><th>دامنه‌ها</th><th>وضعیت</th></tr>${rows.map(r => html`<tr><td>${r.id}</td><td><a href="/brands/${r.id}">${r.name}</a></td><td dir="ltr">${r.slug}</td><td>${r.company_name}</td><td dir="ltr">${(hosts.get(Number(r.id)) ?? []).join('، ') || '—'}</td><td>${st(r.status)}</td></tr>`)}</table></div>${await gate.can(db, A, 'brand.manage') ? html`<form method="post" class="panel form"><h2>برند جدید</h2>${csrf}<label>شرکت<select name="company_id" required>${cos.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></label><label>نام برند<input name="name" required maxlength="120"></label><label>شناسه (انگلیسی)<input name="slug" dir="ltr" required pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="60"></label><label>دامنه (اختیاری)<input name="host" dir="ltr" placeholder="shop.example.ir"></label><button>ایجاد برند</button></form>` : ''}`);
      }
      if (path === '/users') {
        await gate.require_(db, A, 'user.view');
        if (method === 'POST') return done('/users', () => org.createUser(db, A, f('name'), f('email'), f('password'), f('company_id') ? Number(f('company_id')) : null, Number(f('role_id'))), 'کاربر ایجاد شد.');
        const [w, p] = gate.scope(A, 'x.company_id'), rows = await db.all(`SELECT x.id, x.name, x.email, x.status, x.is_owner, x.mfa_enabled, x.last_login_at, c.name AS company_name FROM users x LEFT JOIN companies c ON c.id = x.company_id WHERE ${w} ORDER BY x.id`, p);
        const rt = new Map<number, string[]>(); for (const x of await db.all('SELECT ur.user_id, r.title FROM user_roles ur JOIN roles r ON r.id = ur.role_id')) rt.set(Number(x.user_id), [...(rt.get(Number(x.user_id)) ?? []), x.title]);
        const [wc, pc] = gate.scope(A, 'id'), cos = await db.all(`SELECT id, name FROM companies WHERE ${wc} ORDER BY id`, pc), roles = await db.all('SELECT id, title FROM roles WHERE company_id IS NULL ORDER BY id');
        const manage = await gate.can(db, A, 'user.manage');
        return render('کاربران و دسترسی‌ها', html`<div class="panel"><table><tr><th>نام</th><th>ایمیل</th><th>شرکت</th><th>نقش</th><th>MFA</th><th>آخرین ورود</th><th>وضعیت</th><th></th></tr>${rows.map(r => html`<tr><td><a href="/users/${r.id}">${r.name}</a></td><td dir="ltr">${r.email}</td><td>${r.company_name ?? 'مدیریت کل'}</td><td>${r.is_owner ? 'مالک' : (rt.get(Number(r.id)) ?? []).join('، ') || '—'}</td><td>${r.mfa_enabled ? 'فعال' : '—'}</td><td>${J.format(r.last_login_at)}</td><td>${st(r.status)}</td><td>${manage && Number(r.id) !== Number(u.id) ? html`<a href="/users/${r.id}">مدیریت</a>` : ''}</td></tr>`)}</table></div><p><a href="/roles">مشاهده نقش‌ها و مجوزها</a></p>${manage ? html`<form method="post" class="panel form" autocomplete="off"><h2>کاربر جدید</h2>${csrf}<label>نام و نام خانوادگی<input name="name" required maxlength="120"></label><label>ایمیل<input type="email" name="email" dir="ltr" required></label><label>گذرواژه (حداقل ۱۰ کاراکتر، حرف و عدد)<input type="password" name="password" required minlength="10" autocomplete="new-password"></label>${gate.isGroup(A) ? html`<label>شرکت<select name="company_id" required>${cos.map(c => html`<option value="${c.id}">${c.name}</option>`)}</select></label>` : ''}<label>نقش<select name="role_id" required>${roles.map(r => html`<option value="${r.id}">${r.title}</option>`)}</select></label><button>ایجاد کاربر</button></form>` : ''}`);
      }
      if (path === '/roles') {
        await gate.require_(db, A, 'role.view'); const roles = await db.all('SELECT id, title, code FROM roles WHERE company_id IS NULL ORDER BY id');
        const perms = await Promise.all(roles.map(r => db.all('SELECT p.code, p.title FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id WHERE rp.role_id = ? ORDER BY p.id', [r.id])));
        return render('نقش‌ها و مجوزها', html`${roles.map((r, i) => html`<div class="panel"><h2>${r.title} <small dir="ltr">(${r.code})</small></h2><ul class="chips">${perms[i].map(p => html`<li title="${p.code}">${p.title}</li>`)}</ul></div>`)}<p class="muted">مالک مجموعه به همه بخش‌ها دسترسی دارد.</p>`);
      }
      if (path === '/audit') {
        await gate.require_(db, A, 'audit.view'); const [w, p] = gate.scope(A, 'a.company_id');
        const rows = await db.all(`SELECT a.*, x.name AS uname FROM audit_logs a LEFT JOIN users x ON x.id = a.user_id WHERE ${w} ORDER BY a.id DESC LIMIT 200`, p), chain = gate.isGroup(A) ? await audit.verify(db) : false;
        return render('امنیت و حسابرسی', html`${chain === false ? '' : html`<div class="flash ${chain === null ? 'ok' : 'err'}">${chain === null ? 'زنجیره هش لاگ سالم است؛ هیچ ردیفی تغییر یا حذف نشده است.' : 'دست‌کاری در لاگ شناسایی شد؛ اولین ردیف مشکوک: ' + chain}</div>`}<div class="panel"><table><tr><th>#</th><th>زمان</th><th>کاربر</th><th>عملیات</th><th>مورد</th><th>جزئیات</th><th>IP</th></tr>${rows.map(r => html`<tr><td>${r.id}</td><td>${J.format(r.created_at)}</td><td>${r.uname ?? 'سیستم'}</td><td dir="ltr">${r.action}</td><td>${(r.entity ?? '') + (r.entity_id ? ' #' + r.entity_id : '')}</td><td dir="ltr">${r.detail ?? ''}</td><td dir="ltr">${r.ip ?? ''}</td></tr>`)}</table></div>`);
      }
      if (path === '/account' || path === '/account/mfa' || path === '/account/password') {
        if (method === 'POST' && path === '/account/password') return done('/account', () => mfa.changePassword(db, A, f('current'), f('new')), 'گذرواژه تغییر کرد.');
        let codes: string[] | null = null;
        if (method === 'POST' && path === '/account/mfa') {
          try {
            if (f('action') === 'begin') { await mfa.begin(db, A); await S.setFlash(db, sess, 'کلید را در برنامه احراز هویت وارد کنید و کد ۶ رقمی را برای تأیید بزنید.'); return redirect('/account'); }
            if (f('action') === 'confirm') { codes = await mfa.confirm(db, A, f('code')); u.mfa_enabled = 1; }
            else if (f('action') === 'disable') { await mfa.disable(db, A, f('password'), f('code')); await S.setFlash(db, sess, 'احراز هویت دومرحله‌ای غیرفعال شد.'); return redirect('/account'); }
            else throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
          } catch (e) { if (e instanceof Invalid) { await S.setFlash(db, sess, e.message, 'err'); return redirect('/account'); } throw e; }
        }
        const secret = await mfa.pendingSecret(db, A), left = u.mfa_enabled ? await mfa.remainingRecoveryCodes(db, Number(u.id)) : 0;
        const mfaBox = codes ? html`<div class="flash ok">کدهای بازیابی (فقط همین یک‌بار نمایش داده می‌شود؛ هر کد یک‌بار مصرف است):</div><pre>${codes.join('\n')}</pre>`
          : u.mfa_enabled ? html`<p>وضعیت: <b>فعال</b> – کدهای بازیابی باقی‌مانده: ${fa(String(left))}</p><form method="post" action="/account/mfa" class="form">${csrf}<input type="hidden" name="action" value="disable"><label>گذرواژه<input type="password" name="password" required></label><label>کد دومرحله‌ای یا کد بازیابی<input name="code" dir="ltr" required></label><button class="ghost">غیرفعال‌سازی</button></form>`
          : secret ? html`<p>۱) در برنامه احراز هویت «ورود دستی کلید» (زمان‌محور) را بزنید و این کلید را وارد کنید:</p><pre>${secret}</pre><p class="muted">آدرس otpauth: <span dir="ltr" style="word-break:break-all">${totp.uri(u.email, secret)}</span></p><form method="post" action="/account/mfa" class="form">${csrf}<input type="hidden" name="action" value="confirm"><label>۲) کد ۶ رقمی نمایش‌داده‌شده<input name="code" dir="ltr" inputmode="numeric" required></label><button>تأیید و فعال‌سازی</button></form>`
          : html`<p>وضعیت: <b>غیرفعال</b>. در تنظیمات پیش‌فرض فعال‌سازی اجباری است.</p><form method="post" action="/account/mfa">${csrf}<input type="hidden" name="action" value="begin"><button>شروع فعال‌سازی</button></form>`;
        return render('حساب من', html`<div class="panel"><h2>احراز هویت دومرحله‌ای (MFA)</h2>${mfaBox}</div><form method="post" action="/account/password" class="panel form" autocomplete="off"><h2>تغییر گذرواژه</h2>${csrf}<label>گذرواژه فعلی<input type="password" name="current" required autocomplete="current-password"></label><label>گذرواژه جدید (حداقل ۱۰ کاراکتر، حرف و عدد)<input type="password" name="new" required minlength="10" autocomplete="new-password"></label><button>تغییر گذرواژه</button></form>`);
      }
      const ctx: Ctx = { db, A, u, rq, csrf, f, render, done, redirect: (to) => redirect(to), flashErr: (m) => S.setFlash(db, sess, m, 'err') as Promise<any>, flashOk: (m) => S.setFlash(db, sess, m) as Promise<any> };
      for (const h of [handleRegistration, handleEditPages, handleAccounting, handleCredit, handleMarketplace, handleOrders, handleTreasury, handlePurchases, handleCrm, handleContracts, handleDocuments]) { const r = await h(ctx); if (r) return r; }
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    };
    try { const r = await out(); return { ...r, cookie: setTok ? setCookie(setTok, rq.secure) : undefined }; }
    catch (e: any) {
      if (e instanceof HttpError) return { status: e.status, body: bare('خطا', `<div class="box"><h1>خطا ${e.status}</h1><p>${esc(e.message)}</p><a href="/">بازگشت</a></div>`) };
      console.error(new Date().toISOString(), e?.name, e?.message); return { status: 500, body: bare('خطا', '<div class="box"><h1>خطای داخلی سرور</h1><p>موضوع ثبت شد.</p></div>') };   // never leak internals
    }
  };
}

export function startServer(db: Db, port: number, host = '127.0.0.1') {
  const handle = makeHandler(db);
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x'); const sec = { 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Cache-Control': 'no-store' };
    if (url.pathname === '/assets/app.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); return void res.end(css); }
    const chunks: Buffer[] = []; let size = 0; const ct = String(req.headers['content-type'] ?? '');
    if (req.method === 'POST') { for await (const c of req) { size += c.length; if (size > (ct.startsWith('multipart/') ? 9_500_000 : 200_000)) { res.writeHead(413); return void res.end(); } chunks.push(c); } }
    const raw = Buffer.concat(chunks); let form: URLSearchParams, files: any[] | undefined;
    try { if (ct.startsWith('multipart/form-data')) { const mp = parseMultipart(raw, ct); form = mp.fields; files = mp.files; } else form = new URLSearchParams(raw.toString('utf8')); } catch { res.writeHead(400); return void res.end(); }
    const proto = String(req.headers['x-forwarded-proto'] ?? '');
    const r = await handle({ method: req.method ?? 'GET', path: url.pathname.replace(/\/+$/, '') || '/', query: url.searchParams, form, files, ip: String(req.socket.remoteAddress ?? ''), secure: proto === 'https' }, cookieOf('nafi_sid', req.headers.cookie));
    const h: Record<string, string | string[]> = { 'Content-Type': 'text/html; charset=utf-8', ...sec, ...(r.headers ?? {}) }; if (r.cookie) h['Set-Cookie'] = r.cookie; else if (r.headers?.['Set-Cookie']) h['Set-Cookie'] = r.headers['Set-Cookie'];
    res.writeHead(r.status, h); res.end((r as any).binary ?? r.body);
  }).listen(port, host);
}
