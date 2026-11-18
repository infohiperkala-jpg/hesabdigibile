import * as gate from '../core/gate.js';
import * as ch from '../core/changes.js';
import * as J from '../core/jalali.js';
import { HttpError } from '../core/errors.js';
import { fa, money, parseAmount } from '../core/validator.js';
import * as org from '../services/org.js';
import * as acc from '../services/accounting.js';
import * as credit from '../services/credit.js';
import { html, raw, Raw } from './view.js';
import { Ctx, Out } from './types.js';
import { Row } from '../core/db.js';

const LABELS: Record<string, string> = { name: 'نام', legal_name: 'نام حقوقی', status: 'وضعیت', email: 'ایمیل', role: 'نقش', password: 'گذرواژه', mfa: 'MFA', lock: 'قفل', domain_added: 'دامنه افزوده‌شد', domain_removed: 'دامنه حذف شد', voucher_date: 'تاریخ سند', description: 'شرح', total: 'جمع سند', lines: 'تعداد ردیف', edited: 'ویرایش', min_amount: 'حداقل مبلغ', max_amount: 'حداکثر مبلغ', min_down_bp: 'حداقل پیش‌پرداخت (bp)', max_down_bp: 'حداکثر پیش‌پرداخت (bp)', quote_ttl_min: 'اعتبار پیش‌فاکتور (دقیقه)', grace_days: 'مهلت اولین قسط', late_fee_bp_day: 'جریمه روزانه (bp)', settlement_work_days: 'تسویه (روز کاری)', terms: 'گزینه‌های اقساط' };
const STATUS_FA: Record<string, string> = { active: 'فعال', suspended: 'معلق', archived: 'بایگانی‌شده', disabled: 'غیرفعال', inactive: 'غیرفعال', open: 'باز', closed: 'بسته' };
const show = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : STATUS_FA[String(v)] ?? String(v));
/** The history panel every editable entity shows: who, when, what changed (before -> after) and why. */
export async function historyPanel(c: Ctx, entity: string, id: number): Promise<Raw> {
  const rows = await ch.history(c.db, entity, id);
  return html`<div class="panel"><h2>تاریخچه تغییرات</h2>${rows.length ? html`<table><tr><th>زمان</th><th>کاربر</th><th>تغییر</th><th>دلیل</th></tr>${rows.map(r => html`<tr><td>${J.format(r.created_at)}</td><td>${r.uname ?? 'سیستم'}</td><td>${Object.entries(JSON.parse(r.changes) as Record<string, [unknown, unknown]>).map(([k, [a, b]]) => html`<div><b>${LABELS[k] ?? k}:</b> <span style="text-decoration:line-through;opacity:.7">${show(a)}</span> ← ${show(b)}</div>`)}</td><td>${r.note ?? ''}</td></tr>`)}</table>` : html`<p class="muted">هنوز تغییری ثبت نشده است.</p>`}</div>`;
}
const statusForm = (c: Ctx, action: string, options: [string, string][], label = 'تغییر وضعیت'): Raw =>
  html`<form method="post" action="${action}" class="panel form"><h2>${label}</h2>${c.csrf}<label>وضعیت جدید<select name="status">${options.map(([v, l]) => html`<option value="${v}">${l}</option>`)}</select></label><label>دلیل (الزامی)<input name="note" required minlength="5"></label><button>ثبت تغییر وضعیت</button></form>`;
const back = (to: string) => html`<p><a href="${to}">← بازگشت</a></p>`;

export async function handleEditPages(c: Ctx): Promise<Out | null> {
  const { rq, db, A, f } = c; const path = rq.path; let m: RegExpMatchArray | null;
  // ───────── companies ─────────
  if ((m = path.match(/^\/companies\/(\d+)(\/(edit|status))?$/))) {
    const id = Number(m[1]), page = `/companies/${id}`;
    if (rq.method === 'POST') {
      if (m[3] === 'edit') return c.done(page, () => org.editCompany(db, A, id, { name: f('name'), legal_name: f('legal_name') || null }, f('version')), 'اطلاعات شرکت ذخیره شد.');
      if (m[3] === 'status') return c.done(page, () => org.setCompanyStatus(db, A, id, f('status'), f('note')), 'وضعیت شرکت تغییر کرد.');
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    }
    const co = await org.getCompany(db, A, id), mg = await gate.can(db, A, 'company.manage');
    return c.render('شرکت: ' + co.name, html`${back('/companies')}<div class="panel"><h2>${co.name} <span class="st">${org.COMPANY_STATUS[co.status]}</span></h2><p class="muted">ایجاد: ${J.format(co.created_at)}</p></div>
${mg ? html`<form method="post" action="${page}/edit" class="panel form"><h2>ویرایش اطلاعات</h2>${c.csrf}<input type="hidden" name="version" value="${ch.versionOf(co)}"><label>نام شرکت<input name="name" value="${co.name}" required maxlength="120"></label><label>نام حقوقی<input name="legal_name" value="${co.legal_name ?? ''}" maxlength="190"></label><button>ذخیره تغییرات</button></form>${co.parent_id === null ? html`<p class="muted">وضعیت شرکت مادر قابل تغییر نیست.</p>` : statusForm(c, page + '/status', Object.entries(org.COMPANY_STATUS).filter(([k]) => k !== co.status) as [string, string][])}<p class="muted">تعلیق یا بایگانی شرکت، ورود همه کاربران آن را فوراً مسدود و نشست‌هایشان را باطل می‌کند.</p>` : ''}
${await historyPanel(c, 'company', id)}`);
  }
  // ───────── brands + domains ─────────
  if ((m = path.match(/^\/brands\/(\d+)(\/(edit|status|domains|domains\/remove))?$/))) {
    const id = Number(m[1]), page = `/brands/${id}`;
    if (rq.method === 'POST') {
      if (m[3] === 'edit') return c.done(page, () => org.editBrand(db, A, id, f('name'), f('version')), 'برند ذخیره شد.');
      if (m[3] === 'status') return c.done(page, () => org.setBrandStatus(db, A, id, f('status'), f('note')), 'وضعیت برند تغییر کرد.');
      if (m[3] === 'domains') return c.done(page, () => org.addDomain(db, A, id, f('host')), 'دامنه افزوده شد.');
      if (m[3] === 'domains/remove') return c.done(page, () => org.removeDomain(db, A, id, Number(f('domain_id')), f('note')), 'دامنه حذف شد.');
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    }
    const b = await org.getBrand(db, A, id), domains = await db.all('SELECT * FROM domains WHERE brand_id = ? ORDER BY id', [id]), mg = await gate.can(db, A, 'brand.manage');
    return c.render('برند: ' + b.name, html`${back('/brands')}<div class="panel"><h2>${b.name} <span class="st">${STATUS_FA[b.status]}</span></h2><p class="muted">شرکت: ${b.company_name} | شناسه: <span dir="ltr">${b.slug}</span></p></div>
<div class="panel"><h2>دامنه‌ها</h2><table><tr><th>دامنه</th><th></th></tr>${domains.map(d => html`<tr><td dir="ltr">${d.host}</td><td>${mg ? html`<form method="post" action="${page}/domains/remove" style="display:flex;gap:6px">${c.csrf}<input type="hidden" name="domain_id" value="${d.id}"><input name="note" placeholder="دلیل حذف (الزامی)" required minlength="5"><button class="ghost">حذف</button></form>` : ''}</td></tr>`)}${domains.length ? '' : html`<tr><td colspan="2" class="muted">دامنه‌ای ثبت نشده است.</td></tr>`}</table>${mg ? html`<form method="post" action="${page}/domains" class="form" style="margin-top:10px">${c.csrf}<label>دامنه جدید<input name="host" dir="ltr" placeholder="shop.example.ir" required></label><button>افزودن</button></form>` : ''}</div>
${mg ? html`<form method="post" action="${page}/edit" class="panel form"><h2>ویرایش</h2>${c.csrf}<input type="hidden" name="version" value="${ch.versionOf(b)}"><label>نام برند<input name="name" value="${b.name}" required maxlength="120"></label><button>ذخیره تغییرات</button></form>${statusForm(c, page + '/status', [['active', 'فعال'], ['suspended', 'معلق'], ['archived', 'بایگانی‌شده']].filter(([k]) => k !== b.status) as [string, string][])}` : ''}
${await historyPanel(c, 'brand', id)}`);
  }
  // ───────── users ─────────
  if ((m = path.match(/^\/users\/(\d+)(\/(edit|role|status|password|unlock|mfa-reset))?$/)) ) {
    const id = Number(m[1]), page = `/users/${id}`;
    if (rq.method === 'POST') {
      if (m[3] === 'edit') return c.done(page, () => org.editUser(db, A, id, f('name'), f('email'), f('version')), 'اطلاعات کاربر ذخیره شد.');
      if (m[3] === 'role') return c.done(page, () => org.changeUserRole(db, A, id, Number(f('role_id')), f('note')), 'نقش کاربر تغییر کرد و نشست‌های او باطل شد.');
      if (m[3] === 'status') return c.done(page, () => org.setUserStatusWithReason(db, A, id, f('status'), f('note')), 'وضعیت کاربر تغییر کرد.');
      if (m[3] === 'password') return c.done(page, () => org.adminResetPassword(db, A, id, f('password'), f('note')), 'گذرواژه بازنشانی شد و نشست‌های کاربر باطل شد.');
      if (m[3] === 'unlock') return c.done(page, () => org.unlockUser(db, A, id), 'قفل حساب برداشته شد.');
      if (m[3] === 'mfa-reset') return c.done(page, () => org.resetMfa(db, A, id, f('note')), 'MFA بازنشانی شد؛ کاربر باید دوباره فعالش کند.');
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    }
    const u = await org.getUser(db, A, id), mg = await gate.can(db, A, 'user.manage'), self = Number(u.id) === Number(A.id);
    const roles = await db.all('SELECT id, title FROM roles WHERE company_id IS NULL ORDER BY id'), cur = await db.all('SELECT r.title FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [id]);
    const locked = !!u.locked_until && u.locked_until > db.now();
    return c.render('کاربر: ' + u.name, html`${back('/users')}<div class="panel"><h2>${u.name} <span class="st">${STATUS_FA[u.status]}</span> ${locked ? raw('<span class="st st-needs_fix">قفل‌شده</span>') : ''}</h2><p class="muted">${u.company_name ?? 'مدیریت کل'} | نقش: ${u.is_owner ? 'مالک' : cur.map(r => r.title).join('، ') || '—'} | MFA: ${u.mfa_enabled ? 'فعال' : 'غیرفعال'} | آخرین ورود: ${J.format(u.last_login_at)}</p></div>
${mg && !self ? html`<form method="post" action="${page}/edit" class="panel form"><h2>ویرایش مشخصات</h2>${c.csrf}<input type="hidden" name="version" value="${ch.versionOf(u)}"><label>نام<input name="name" value="${u.name}" required></label><label>ایمیل<input type="email" name="email" dir="ltr" value="${u.email}" required></label><button>ذخیره (تغییر ایمیل، نشست‌ها را باطل می‌کند)</button></form>
${u.is_owner ? '' : html`<form method="post" action="${page}/role" class="panel form"><h2>تغییر نقش</h2>${c.csrf}<label>نقش جدید<select name="role_id">${roles.map(r => html`<option value="${r.id}">${r.title}</option>`)}</select></label><label>دلیل (الزامی)<input name="note" required minlength="5"></label><button>تغییر نقش</button></form>`}
${statusForm(c, page + '/status', [[u.status === 'active' ? 'disabled' : 'active', u.status === 'active' ? 'غیرفعال' : 'فعال']], u.status === 'active' ? 'غیرفعال‌سازی حساب' : 'فعال‌سازی حساب')}
<form method="post" action="${page}/password" class="panel form" autocomplete="off"><h2>بازنشانی گذرواژه توسط مدیر</h2>${c.csrf}<label>گذرواژه جدید (حداقل ۱۰ کاراکتر، حرف و عدد)<input type="password" name="password" required minlength="10" autocomplete="new-password"></label><label>دلیل (الزامی)<input name="note" required minlength="5"></label><button>بازنشانی و باطل‌کردن نشست‌ها</button></form>
<div class="panel" style="display:flex;gap:12px;flex-wrap:wrap">${locked || Number(u.failed_logins) ? html`<form method="post" action="${page}/unlock">${c.csrf}<button class="ghost">رفع قفل حساب</button></form>` : ''}${u.mfa_enabled && gate.isGroup(A) ? html`<form method="post" action="${page}/mfa-reset" class="form">${c.csrf}<label>دلیل بازنشانی MFA (فقط مدیریت کل)<input name="note" required minlength="5"></label><button class="ghost">بازنشانی MFA</button></form>` : ''}</div>` : html`<p class="muted">${self ? 'برای تغییر مشخصات خودتان از «حساب من» استفاده کنید.' : ''}</p>`}
${await historyPanel(c, 'user', id)}`);
  }
  // ───────── ledger accounts, period reopen, draft voucher edit ─────────
  if ((m = path.match(/^\/accounting\/accounts\/(\d+)(\/(edit|status))?$/))) {
    const id = Number(m[1]), page = `/accounting/accounts/${id}`;
    if (rq.method === 'POST') {
      if (m[3] === 'edit') return c.done(page, () => acc.editAccount(db, A, id, f('name'), f('version')), 'حساب ذخیره شد.');
      if (m[3] === 'status') return c.done(page, () => acc.setAccountStatus(db, A, id, f('status'), f('note')), 'وضعیت حساب تغییر کرد.');
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    }
    const a = await acc.getAccount(db, A, id), mg = await gate.can(db, A, 'accounting.manage');
    return c.render('حساب ' + a.code, html`${back('/accounting')}<div class="panel"><h2><span dir="ltr">${a.code}</span> ${a.name} <span class="st">${acc.ACCOUNT_STATUS[a.status]}</span></h2><p class="muted">ماهیت: ${a.nature === 'debit' ? 'بدهکار' : 'بستانکار'} | ${a.is_postable ? 'قابل‌ثبت در سند' : 'حساب کل/گروه'} | کد حساب پس از ایجاد تغییر نمی‌کند.</p></div>
${mg ? html`<form method="post" action="${page}/edit" class="panel form"><h2>ویرایش نام</h2>${c.csrf}<input type="hidden" name="version" value="${ch.versionOf(a)}"><label>نام حساب<input name="name" value="${a.name}" required></label><button>ذخیره</button></form>${statusForm(c, page + '/status', [[a.status === 'active' ? 'inactive' : 'active', a.status === 'active' ? 'غیرفعال' : 'فعال']], a.status === 'active' ? 'غیرفعال‌سازی حساب' : 'فعال‌سازی حساب')}<p class="muted">غیرفعال‌سازی فقط وقتی ممکن است که حساب مانده، سند پیش‌نویس و زیرحساب فعال نداشته باشد.</p>` : ''}
${await historyPanel(c, 'account', id)}`);
  }
  if (rq.method === 'POST' && (m = path.match(/^\/accounting\/periods\/(\d+)\/reopen$/))) return c.done('/accounting', () => acc.reopenPeriod(db, A, Number(m![1]), f('note')), 'دوره مالی دوباره باز شد.');
  if ((m = path.match(/^\/accounting\/vouchers\/(\d+)\/edit$/))) {
    const id = Number(m[1]), page = `/accounting/vouchers/${id}`;
    if (rq.method === 'POST') {
      const accs = rq.form.getAll('acc[]'), ds = rq.form.getAll('debit[]'), cs = rq.form.getAll('credit[]'), dd = rq.form.getAll('ldesc[]'), lines: acc.Line[] = [];
      accs.forEach((a, i) => { const d = (ds[i] ?? '').trim(), cr = (cs[i] ?? '').trim(); if (!a && !d && !cr) return; lines.push({ account_id: Number(a), debit: d ? parseAmount(d) : null, credit: cr ? parseAmount(cr) : null, description: dd[i] ?? '' }); });
      return c.done(page + '/edit', () => acc.updateDraft(db, A, id, f('date'), f('description'), lines, f('version')), 'سند ذخیره شد.');
    }
    const v = await acc.find(db, A, id); if (v.status !== 'draft') return c.render('سند قطعی', html`${back(page)}<div class="panel"><p>سند قطعی قابل ویرایش نیست؛ برای اصلاح، سند برگشتی صادر کنید.</p></div>`);
    const its = await acc.items(db, id), accounts = await db.all("SELECT id, code, name FROM accounts WHERE company_id = ? AND is_postable = 1 AND status = 'active' ORDER BY code", [v.company_id]), ver = await acc.voucherVersion(db, id);
    const [gy, gm, gd] = String(v.voucher_date).split('-').map(Number), [jy, jm, jd] = J.fromGregorian(gy, gm, gd), jdate = `${jy}/${String(jm).padStart(2, '0')}/${String(jd).padStart(2, '0')}`;
    const rows = [...its, ...Array(Math.max(0, 8 - its.length)).fill(null)];
    return c.render('ویرایش سند پیش‌نویس', html`${back(page)}<form method="post" action="${page}/edit" class="panel" autocomplete="off"><h2>ویرایش سند پیش‌نویس #${v.id}</h2>${c.csrf}<input type="hidden" name="version" value="${ver}"><div class="form"><label>تاریخ (شمسی)<input name="date" dir="ltr" value="${jdate}" required></label><label style="grid-column:span 2">شرح سند<input name="description" value="${v.description}" required maxlength="400"></label></div><table style="margin-top:10px"><tr><th>حساب (معین)</th><th>بدهکار (ریال)</th><th>بستانکار (ریال)</th><th>شرح ردیف</th></tr>${rows.map((r: Row | null) => html`<tr><td><select name="acc[]"><option value="">—</option>${accounts.map(a => html`<option value="${a.id}"${r && Number(r.account_id) === Number(a.id) ? raw(' selected') : ''}>${a.code + ' ' + a.name}</option>`)}</select></td><td><input name="debit[]" dir="ltr" value="${r && Number(r.debit) ? Number(r.debit) : ''}"></td><td><input name="credit[]" dir="ltr" value="${r && Number(r.credit) ? Number(r.credit) : ''}"></td><td><input name="ldesc[]" value="${r?.description ?? ''}"></td></tr>`)}</table><p class="muted">اگر کس دیگری همزمان سند را تغییر دهد، ذخیره رد می‌شود تا تغییرات او از بین نرود. همه ردیف‌ها جایگزین می‌شوند و تغییر جمع و تعداد ردیف در تاریخچه ثبت می‌شود.</p><button>ذخیره تغییرات</button></form>${await historyPanel(c, 'voucher', id)}`);
  }
  // ───────── credit plans ─────────
  if ((m = path.match(/^\/credit\/plans\/(\d+)(\/(edit|status))?$/))) {
    const id = Number(m[1]), page = `/credit/plans/${id}`;
    if (rq.method === 'POST') {
      const n = (k: string) => Number(f(k) || 0), cnt = rq.form.getAll('t_count[]'), terms = cnt.map((x, i) => ({ installments: Number(x), monthly_fee_bp: Number(rq.form.getAll('t_monthly[]')[i] || 0), upfront_fee_bp: Number(rq.form.getAll('t_upfront[]')[i] || 0), has: x.trim() !== '' })).filter(t => t.has).map(({ has, ...t }) => t);
      if (m[3] === 'edit') return c.done(page, () => credit.editPlan(db, A, id, { name: f('name'), min_amount: n('min_amount'), max_amount: n('max_amount'), min_down_bp: n('min_down_bp'), max_down_bp: n('max_down_bp') || 10000, quote_ttl_min: n('quote_ttl_min'), grace_days: n('grace_days'), late_fee_bp_day: n('late_fee_bp_day'), settlement_work_days: n('settlement_work_days') }, terms, f('version')), 'طرح ذخیره شد.');
      if (m[3] === 'status') return c.done(page, () => credit.setPlanStatus(db, A, id, f('status'), f('note')), 'وضعیت طرح تغییر کرد.');
      throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
    }
    const p = await credit.getPlan(db, A, id), terms = await db.all('SELECT * FROM credit_plan_terms WHERE plan_id = ? ORDER BY installments', [id]), mg = await gate.can(db, A, 'credit.manage');
    const used = !!(await db.val('SELECT 1 FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id WHERE q.plan_id = ? LIMIT 1', [id])), rows = [...terms, ...Array(Math.max(0, 4 - terms.length)).fill(null)];
    return c.render('طرح: ' + p.name, html`${back('/credit')}<div class="panel"><h2>${p.name} <span class="st">${credit.PLAN_STATUS[p.status]}</span></h2><p class="muted">مبلغ ${money(p.min_amount)} تا ${money(p.max_amount)} ریال | ${used ? 'برای این طرح درخواست ثبت شده است؛ شرایط قابل ویرایش نیست.' : 'تا قبل از اولین درخواست قابل ویرایش است.'}</p></div>
${mg && !used ? html`<form method="post" action="${page}/edit" class="panel form"><h2>ویرایش شرایط</h2>${c.csrf}<input type="hidden" name="version" value="${ch.versionOf(p)}"><label>نام<input name="name" value="${p.name}" required></label><label>حداقل مبلغ (ریال)<input name="min_amount" dir="ltr" value="${p.min_amount}"></label><label>حداکثر مبلغ (ریال)<input name="max_amount" dir="ltr" value="${p.max_amount}"></label><label>حداقل پیش‌پرداخت (bp)<input name="min_down_bp" dir="ltr" value="${p.min_down_bp}"></label><label>حداکثر پیش‌پرداخت (bp)<input name="max_down_bp" dir="ltr" value="${p.max_down_bp}"></label><label>اعتبار پیش‌فاکتور (دقیقه)<input name="quote_ttl_min" dir="ltr" value="${p.quote_ttl_min}"></label><label>مهلت اولین قسط (روز)<input name="grace_days" dir="ltr" value="${p.grace_days}"></label><label>جریمه دیرکرد روزانه (bp)<input name="late_fee_bp_day" dir="ltr" value="${p.late_fee_bp_day}"></label><label>تسویه با پذیرنده (روز کاری)<input name="settlement_work_days" dir="ltr" value="${p.settlement_work_days}"></label>${rows.map((t: Row | null, i: number) => html`<label>گزینه ${fa(i + 1)}: تعداد اقساط<input name="t_count[]" dir="ltr" value="${t?.installments ?? ''}"></label><label>کارمزد ماهانه (bp)<input name="t_monthly[]" dir="ltr" value="${t?.monthly_fee_bp ?? 0}"></label><label>کارمزد ابتدایی (bp)<input name="t_upfront[]" dir="ltr" value="${t?.upfront_fee_bp ?? 0}"></label>`)}<button>ذخیره تغییرات</button></form>` : html`<div class="panel"><table><tr><th>تعداد اقساط</th><th>کارمزد ماهانه</th><th>کارمزد ابتدایی</th></tr>${terms.map(t => html`<tr><td>${fa(t.installments)}</td><td>${fa(Number(t.monthly_fee_bp) / 100)}٪</td><td>${fa(Number(t.upfront_fee_bp) / 100)}٪</td></tr>`)}</table></div>`}
${mg ? statusForm(c, page + '/status', [[p.status === 'active' ? 'archived' : 'active', p.status === 'active' ? 'بایگانی (عدم امکان پیش‌فاکتور جدید)' : 'فعال‌سازی']], 'وضعیت طرح') : ''}
${await historyPanel(c, 'plan', id)}`);
  }
  return null;
}
