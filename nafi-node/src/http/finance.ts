import { Row } from '../core/db.js';
import * as gate from '../core/gate.js';
import { HttpError, Invalid } from '../core/errors.js';
import * as J from '../core/jalali.js';
import { fa, money, parseAmount } from '../core/validator.js';
import * as acc from '../services/accounting.js';
import * as credit from '../services/credit.js';
import * as posting from '../services/posting.js';
import { html, raw, Raw } from './view.js';
import { Ctx, Out } from './types.js';

/** Company context: group owners pick one with ?c=; everyone else is fixed to their own company. */
async function company(c: Ctx): Promise<{ cid: number; cq: string; cqh: Raw; q: (path: string, extra?: string) => string }> {
  const group = gate.isGroup(c.A);
  const cid = group ? Number(c.rq.query.get('c') ?? c.rq.form.get('c') ?? (await c.db.val('SELECT id FROM companies ORDER BY id LIMIT 1'))) : Number(c.u.company_id);
  gate.assertCompany(c.A, cid);
  if (!(await c.db.val('SELECT 1 FROM companies WHERE id = ?', [cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  return { cid, cq: group ? `c=${cid}` : '', cqh: group ? raw(`<input type="hidden" name="c" value="${cid}">`) : raw(''), q: (path, extra = '') => { const s = [group ? `c=${cid}` : '', extra].filter(Boolean).join('&'); return path + (s ? '?' + s : ''); } };
}
const statusName = (s: string) => (s === 'final' ? 'قطعی' : 'پیش‌نویس');

export async function handleAccounting(c: Ctx): Promise<Out | null> {
  const { rq, db, A } = c, path = rq.path;
  if (!path.startsWith('/accounting')) return null;
  await gate.require_(db, A, 'accounting.view');
  const k = await company(c), cid = k.cid;
  const periods = await db.all('SELECT * FROM fiscal_periods WHERE company_id = ? ORDER BY starts_on DESC', [cid]);
  const pid = Number(rq.query.get('p') ?? periods[0]?.id ?? 0), P = pid ? `p=${pid}` : '';
  const nav = html`<div class="panel" style="display:flex;flex-wrap:wrap;gap:14px;align-items:end;justify-content:space-between"><nav style="display:flex;gap:14px"><a href="${k.q('/accounting', P)}">سرفصل‌ها و دوره‌ها</a><a href="${k.q('/accounting/vouchers', P)}">اسناد</a><a href="${k.q('/accounting/reports', P)}">تراز و دفتر معین</a><a href="${k.q('/accounting/posting', P)}">اتصال اعتبار</a></nav><form method="get" style="display:flex;gap:8px;align-items:end">${gate.isGroup(A) ? html`<label>شرکت<select name="c" onchange="this.form.submit()">${(await db.all('SELECT id, name FROM companies ORDER BY id')).map(x => html`<option value="${x.id}"${x.id === cid ? raw(' selected') : ''}>${x.name}</option>`)}</select></label>` : ''}<label>دوره مالی<select name="p">${periods.map(p => html`<option value="${p.id}"${Number(p.id) === pid ? raw(' selected') : ''}>${p.title}${p.status === 'closed' ? ' (بسته)' : ''}</option>`)}</select></label><button class="ghost">نمایش</button></form></div>`;
  const hid = html`${c.csrf}${k.cqh}`;
  const back = k.q('/accounting');

  if (rq.method === 'POST') {
    const f = c.f; let m: RegExpMatchArray | null;
    if (path === '/accounting/seed') return c.done(back, () => acc.seedStarterChart(db, A, cid), 'سرفصل‌های پیشنهادی ایجاد شد؛ حسابدار آن را بازبینی کند.');
    if (path === '/accounting/accounts') return c.done(back, () => acc.createAccount(db, A, cid, f('parent_id') ? Number(f('parent_id')) : null, f('code'), f('name'), !!f('postable')), 'حساب ایجاد شد.');
    if (path === '/accounting/periods') return c.done(back, () => acc.createPeriod(db, A, cid, f('title'), f('starts'), f('ends')), 'دوره مالی ایجاد شد.');
    if (path === '/accounting/periods/close') return c.done(back, () => acc.closePeriod(db, A, Number(f('period_id'))), 'دوره مالی بسته شد.');
    if (path === '/accounting/posting/map') return c.done(k.q('/accounting/posting'), () => posting.setAccount(db, A, cid, f('role'), Number(f('account_id'))), 'حساب نقش ذخیره شد.');
    if (path === '/accounting/posting/post') { try { const id = await posting.post(db, A, cid, f('event'), Number(f('ref'))); await c.flashOk('سند پیش‌نویس ایجاد شد؛ فرد دیگری باید آن را قطعی کند.'); return c.redirect(k.q(`/accounting/vouchers/${id}`)); } catch (e) { if (e instanceof Invalid) { await c.flashErr(e.message); return c.redirect(k.q('/accounting/posting')); } throw e; } }
    if (path === '/accounting/vouchers') {
      try {
        const accs = rq.form.getAll('acc[]'), ds = rq.form.getAll('debit[]'), cs = rq.form.getAll('credit[]'), dd = rq.form.getAll('ldesc[]'), lines: acc.Line[] = [];
        accs.forEach((a, i) => {
          const d = (ds[i] ?? '').trim(), cr = (cs[i] ?? '').trim(); if (!a && !d && !cr) return;
          const pd = d ? parseAmount(d) : null, pc = cr ? parseAmount(cr) : null; if ((d && pd === null) || (cr && pc === null)) throw new Invalid('مبلغ باید فقط عدد صحیح (ریال) باشد.');
          lines.push({ account_id: Number(a), debit: pd, credit: pc, description: dd[i] ?? '' });
        });
        const id = await acc.createVoucher(db, A, cid, f('date'), f('description'), lines); await c.flashOk('سند پیش‌نویس ثبت شد؛ برای قطعی‌شدن باید فرد دیگری آن را تأیید کند.'); return c.redirect(k.q(`/accounting/vouchers/${id}`));
      } catch (e) { if (e instanceof Invalid) { await c.flashErr(e.message); return c.redirect(k.q('/accounting/vouchers/new')); } throw e; }
    }
    if ((m = path.match(/^\/accounting\/vouchers\/(\d+)\/(finalize|reverse|delete)$/))) {
      const id = Number(m[1]), vb = k.q(`/accounting/vouchers/${id}`);
      if (m[2] === 'finalize') return c.done(vb, () => acc.finalize(db, A, id), 'سند قطعی شد.');
      if (m[2] === 'delete') return c.done(k.q('/accounting/vouchers'), () => acc.deleteDraft(db, A, id), 'سند پیش‌نویس حذف شد.');
      try { const n = await acc.reverse(db, A, id, f('date')); await c.flashOk('سند برگشتی (پیش‌نویس) ایجاد شد.'); return c.redirect(k.q(`/accounting/vouchers/${n}`)); } catch (e) { if (e instanceof Invalid) { await c.flashErr(e.message); return c.redirect(vb); } throw e; }
    }
    throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
  }

  const mg = await gate.can(db, A, 'accounting.manage'), entry = await gate.can(db, A, 'accounting.entry'), fin = await gate.can(db, A, 'accounting.finalize');
  if (path === '/accounting') {
    const accounts = await db.all('SELECT * FROM accounts WHERE company_id = ? ORDER BY code', [cid]);
    return c.render('مدیریت مالی و حسابداری', html`${nav}<div class="panel"><h2>سرفصل حساب‌ها</h2>${accounts.length ? html`<table><tr><th>کد</th><th>نام حساب</th><th>ماهیت</th><th>قابل‌ثبت در سند</th></tr>${accounts.map(a => html`<tr><td dir="ltr"><a href="/accounting/accounts/${a.id}${k.cq ? '?' + k.cq : ''}">${a.code}</a></td><td style="padding-right:${8 + 14 * (a.code.length > 2 ? 2 : a.code.length > 1 ? 1 : 0)}px">${a.name}</td><td>${a.nature === 'debit' ? 'بدهکار' : 'بستانکار'}</td><td>${a.is_postable ? 'بله' : 'خیر (حساب کل/گروه)'}</td></tr>`)}</table><p class="muted">سرفصل‌های پیشنهادی فقط نقطه شروع‌اند؛ حسابدار شرکت آن را بازبینی کند.</p>` : html`<p class="muted">برای این شرکت هنوز سرفصلی تعریف نشده است.</p>${mg ? html`<form method="post" action="/accounting/seed">${hid}<button>ایجاد سرفصل‌های پیشنهادی (نمونه اولیه)</button></form>` : ''}`}</div>
${mg && accounts.length ? html`<form method="post" action="/accounting/accounts" class="panel form"><h2>حساب جدید</h2>${hid}<label>حساب والد<select name="parent_id"><option value="">— بدون والد —</option>${accounts.filter(a => !a.is_postable).map(a => html`<option value="${a.id}">${a.code + ' ' + a.name}</option>`)}</select></label><label>کد (با کد والد شروع شود)<input name="code" dir="ltr" required></label><label>نام<input name="name" required></label><label class="ck" style="flex-direction:row;gap:8px;align-items:center"><input type="checkbox" name="postable" value="1"> قابل‌ثبت در سند (معین)</label><button>ایجاد حساب</button></form>` : ''}
<div class="panel"><h2>دوره‌های مالی</h2><table><tr><th>عنوان</th><th>از</th><th>تا</th><th>وضعیت</th><th></th></tr>${periods.map(p => html`<tr><td>${p.title}</td><td>${J.format(p.starts_on, false)}</td><td>${J.format(p.ends_on, false)}</td><td>${p.status === 'open' ? 'باز' : 'بسته'}</td><td>${mg && p.status === 'open' ? html`<form method="post" action="/accounting/periods/close">${hid}<input type="hidden" name="period_id" value="${p.id}"><button class="ghost">بستن دوره</button></form>` : mg ? html`<form method="post" action="/accounting/periods/${p.id}/reopen" style="display:flex;gap:6px">${hid}<input name="note" placeholder="دلیل بازگشایی (الزامی)" required minlength="5"><button class="ghost">بازگشایی</button></form>` : ''}</td></tr>`)}</table></div>
${mg ? html`<form method="post" action="/accounting/periods" class="panel form"><h2>دوره مالی جدید</h2>${hid}<label>عنوان<input name="title" required placeholder="سال مالی ۱۴۰۵"></label><label>شروع (شمسی)<input name="starts" dir="ltr" required placeholder="1405/01/01"></label><label>پایان (شمسی)<input name="ends" dir="ltr" required placeholder="1405/12/29"></label><button>ایجاد دوره</button></form>` : ''}`);
  }
  if (path === '/accounting/vouchers') {
    const rows = await db.all('SELECT v.*, (SELECT SUM(debit) FROM voucher_items WHERE voucher_id = v.id) AS total FROM vouchers v WHERE v.company_id = ? AND (? = 0 OR v.period_id = ?) ORDER BY v.id DESC LIMIT 200', [cid, pid, pid]);
    return c.render('اسناد حسابداری', html`${nav}${entry ? html`<p><a href="${k.q('/accounting/vouchers/new')}"><button>+ سند جدید</button></a></p>` : ''}<div class="panel"><table><tr><th>شماره</th><th>تاریخ</th><th>شرح</th><th>نوع</th><th>مبلغ (ریال)</th><th>وضعیت</th></tr>${rows.map(r => html`<tr><td><a href="${k.q('/accounting/vouchers/' + r.id)}">${r.voucher_no ? fa(r.voucher_no) : 'پیش‌نویس #' + r.id}</a></td><td>${J.format(r.voucher_date, false)}</td><td>${r.description}</td><td>${r.kind === 'adjusting' ? 'برگشتی' : 'عادی'}</td><td dir="ltr">${money(r.total ?? 0)}</td><td><span class="st st-${r.status === 'final' ? 'approved_final' : 'awaiting_review'}">${statusName(r.status)}</span></td></tr>`)}${rows.length ? '' : html`<tr><td colspan="6" class="muted">سندی ثبت نشده است.</td></tr>`}</table></div>`);
  }
  if (path === '/accounting/vouchers/new') {
    await gate.require_(db, A, 'accounting.entry'); const accounts = await db.all("SELECT id, code, name FROM accounts WHERE company_id = ? AND is_postable = 1 AND status = 'active' ORDER BY code", [cid]);
    return c.render('سند حسابداری جدید', html`${nav}<form method="post" action="/accounting/vouchers" class="panel" autocomplete="off"><h2>سند حسابداری جدید (پیش‌نویس)</h2>${hid}<div class="form"><label>تاریخ (شمسی)<input name="date" dir="ltr" required placeholder="1405/08/16"></label><label style="grid-column:span 2">شرح سند<input name="description" required maxlength="400"></label></div><table style="margin-top:10px"><tr><th>حساب (معین)</th><th>بدهکار (ریال)</th><th>بستانکار (ریال)</th><th>شرح ردیف</th></tr>${[0, 1, 2, 3, 4, 5].map(() => html`<tr><td><select name="acc[]"><option value="">—</option>${accounts.map(a => html`<option value="${a.id}">${a.code + ' ' + a.name}</option>`)}</select></td><td><input name="debit[]" dir="ltr" inputmode="numeric"></td><td><input name="credit[]" dir="ltr" inputmode="numeric"></td><td><input name="ldesc[]" maxlength="300"></td></tr>`)}</table><p class="muted">هر ردیف فقط یکی از بدهکار/بستانکار. جمع دو ستون باید برابر باشد؛ سند پس از ثبت، پیش‌نویس است و فرد دیگری باید آن را قطعی کند.</p><button>ثبت پیش‌نویس</button></form>`);
  }
  let m = path.match(/^\/accounting\/vouchers\/(\d+)$/);
  if (m) {
    const v = await acc.find(db, A, Number(m[1])); if (Number(v.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    const its = await acc.items(db, Number(v.id)), names = new Map((await db.all('SELECT id, name FROM users WHERE id IN (?, ?)', [v.created_by, v.finalized_by ?? 0])).map(x => [Number(x.id), x.name])), rev = await db.val('SELECT id FROM vouchers WHERE reverses_id = ?', [v.id]);
    const td = its.reduce((s, i) => s + Number(i.debit), 0), tc = its.reduce((s, i) => s + Number(i.credit), 0), act = `/accounting/vouchers/${v.id}`;
    return c.render('سند حسابداری ' + (v.voucher_no ? 'شماره ' + v.voucher_no : '(پیش‌نویس)'), html`${nav}<div class="panel"><h2>${v.voucher_no ? 'سند شماره ' + fa(v.voucher_no) : 'سند پیش‌نویس'} <span class="st st-${v.status === 'final' ? 'approved_final' : 'awaiting_review'}">${statusName(v.status)}</span> ${v.kind === 'adjusting' ? raw('<span class="st st-needs_fix">برگشتی</span>') : ''}</h2><p>${v.description}<br><span class="muted">تاریخ ${J.format(v.voucher_date, false)} | دوره: ${v.period_title} | ثبت‌کننده: ${names.get(Number(v.created_by)) ?? '—'}${v.finalized_by ? ' | قطعی‌کننده: ' + (names.get(Number(v.finalized_by)) ?? '—') : ''}</span></p><table><tr><th>#</th><th>حساب</th><th>بدهکار</th><th>بستانکار</th><th>شرح</th></tr>${its.map(i => html`<tr><td>${i.line_no}</td><td><span dir="ltr">${i.code}</span> ${i.name}</td><td dir="ltr">${Number(i.debit) ? money(i.debit) : ''}</td><td dir="ltr">${Number(i.credit) ? money(i.credit) : ''}</td><td>${i.description ?? ''}</td></tr>`)}<tr><th colspan="2">جمع</th><th dir="ltr">${money(td)}</th><th dir="ltr">${money(tc)}</th><th></th></tr></table></div>
<div class="panel" style="display:flex;gap:10px;flex-wrap:wrap;align-items:end">${v.status === 'draft' ? html`${fin ? html`<form method="post" action="${act}/finalize">${hid}<button>قطعی‌کردن سند</button></form>` : ''}${entry || mg ? html`<a href="${k.q(act + '/edit')}"><button type="button" class="ghost">ویرایش پیش‌نویس</button></a>` : ''}${entry ? html`<form method="post" action="${act}/delete">${hid}<button class="ghost">حذف پیش‌نویس</button></form>` : ''}` : entry && v.kind !== 'adjusting' && !rev ? html`<form method="post" action="${act}/reverse" class="form">${hid}<label>تاریخ سند برگشتی (شمسی)<input name="date" dir="ltr" required placeholder="1405/08/20"></label><button class="ghost">صدور سند برگشتی</button></form><span class="muted">سند قطعی قابل ویرایش یا حذف نیست؛ اصلاح فقط با سند برگشتی انجام می‌شود.</span>` : rev ? html`<a href="${k.q('/accounting/vouchers/' + rev)}">مشاهده سند برگشتی</a>` : ''}</div>`);
  }
  if (path === '/accounting/reports') {
    const tb = pid ? await acc.trialBalance(db, A, cid, pid) : null, aid = Number(rq.query.get('a') ?? 0), lg = pid && aid ? await acc.ledger(db, A, aid, pid) : null;
    if (lg && Number(lg.account.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    const postable = await db.all('SELECT id, code, name FROM accounts WHERE company_id = ? AND is_postable = 1 ORDER BY code', [cid]);
    return c.render('گزارش‌های مالی', html`${nav}${!tb ? html`<div class="panel muted">ابتدا یک دوره مالی تعریف کنید.</div>` : html`<div class="flash ${tb.balanced ? 'ok' : 'err'}">${tb.balanced ? 'تراز آزمایشی متوازن است (فقط اسناد قطعی).' : 'هشدار: تراز آزمایشی متوازن نیست!'}</div><div class="panel" style="overflow-x:auto"><h2>تراز آزمایشی (ریال)</h2><table><tr><th>کد</th><th>حساب</th><th>گردش بدهکار</th><th>گردش بستانکار</th><th>مانده بدهکار</th><th>مانده بستانکار</th></tr>${tb.rows.map(r => html`<tr${raw(r.is_postable ? '' : ' style="font-weight:600"')}><td dir="ltr">${r.code}</td><td>${r.name}</td><td dir="ltr">${money(r.debit)}</td><td dir="ltr">${money(r.credit)}</td><td dir="ltr">${money(r.balance_debit)}</td><td dir="ltr">${money(r.balance_credit)}</td></tr>`)}<tr><th colspan="2">جمع حساب‌های معین</th><th dir="ltr">${money(tb.total_debit)}</th><th dir="ltr">${money(tb.total_credit)}</th><th colspan="2"></th></tr></table></div>
<form method="get" class="panel form"><h2>دفتر معین</h2>${gate.isGroup(A) ? raw(`<input type="hidden" name="c" value="${cid}">`) : ''}<input type="hidden" name="p" value="${pid}"><label>حساب<select name="a">${postable.map(a => html`<option value="${a.id}"${Number(a.id) === aid ? raw(' selected') : ''}>${a.code + ' ' + a.name}</option>`)}</select></label><button>نمایش</button></form>
${lg ? html`<div class="panel"><h2>دفتر معین: ${lg.account.name}</h2><table><tr><th>سند</th><th>تاریخ</th><th>شرح</th><th>بدهکار</th><th>بستانکار</th><th>مانده</th></tr>${lg.rows.map(r => html`<tr><td>${fa(r.voucher_no)}</td><td>${J.format(r.voucher_date, false)}</td><td>${r.description}</td><td dir="ltr">${Number(r.debit) ? money(r.debit) : ''}</td><td dir="ltr">${Number(r.credit) ? money(r.credit) : ''}</td><td dir="ltr">${money(r.balance)}</td></tr>`)}</table></div>` : ''}`}`);
  }
  if (path === '/accounting/posting') {
    const postable = await db.all("SELECT id, code, name FROM accounts WHERE company_id = ? AND is_postable = 1 AND status = 'active' ORDER BY code", [cid]), map = await posting.mapping(db, cid), pend = await posting.pending(db, A, cid), rec = await posting.reconcile(db, A, cid);
    const postBtn = (ev: string, ref: number) => entry ? html`<form method="post" action="/accounting/posting/post">${hid}<input type="hidden" name="event" value="${ev}"><input type="hidden" name="ref" value="${ref}"><button class="ghost">ایجاد سند</button></form>` : '';
    return c.render('اتصال اعتبار به حسابداری', html`${nav}<div class="panel"><h2>مغایرت‌گیری: زیرحساب اقساط با دفتر کل</h2>${rec.ledger === null ? html`<p class="muted">ابتدا حساب نقش «مطالبات اقساط» را تعیین کنید.</p>` : html`<table><tr><th>مانده اقساط (ماژول اعتبار)</th><th>مانده مطالبات در دفتر کل (اسناد قطعی)</th><th>اختلاف</th><th>رویداد بدون سند</th><th>اسناد پیش‌نویس</th></tr><tr><td dir="ltr">${money(rec.subledger)}</td><td dir="ltr">${money(rec.ledger)}</td><td dir="ltr" style="font-weight:600;color:var(--${rec.difference === 0 ? 'pri' : 'red'})">${money(rec.difference ?? 0)}</td><td>${fa(rec.unposted)}</td><td>${fa(rec.draft_vouchers)}</td></tr></table><p class="muted">اختلاف تا زمانی که همه رویدادها سند نشده و همه اسناد قطعی نشده‌اند طبیعی است.</p>`}</div>
${mg ? html`<div class="panel"><h2>تعیین حساب‌ها (توسط حسابدار)</h2><table><tr><th>نقش</th><th>حساب فعلی</th><th></th></tr>${Object.entries(posting.ROLES).map(([role, label]) => html`<tr><td>${label}</td><td>${map[role] ? postable.filter(a => Number(a.id) === map[role]).map(a => a.code + ' ' + a.name).join('') : html`<span class="muted">تعیین نشده</span>`}</td><td><form method="post" action="/accounting/posting/map" style="display:flex;gap:6px">${hid}<input type="hidden" name="role" value="${role}"><select name="account_id">${postable.map(a => html`<option value="${a.id}"${map[role] === Number(a.id) ? raw(' selected') : ''}>${a.code + ' ' + a.name}</option>`)}</select><button class="ghost">ذخیره</button></form></td></tr>`)}</table></div>` : ''}
<div class="panel"><h2>رویدادهای بدون سند</h2><table><tr><th>نوع</th><th>شرح</th><th>مبلغ (ریال)</th><th></th></tr>${pend.activations.map(e => html`<tr><td>فعال‌سازی اعتبار</td><td>درخواست ${fa(e.id)} – ${e.first_name} ${e.last_name}</td><td dir="ltr">${money(e.total_repayment)}</td><td>${postBtn('credit.activate', Number(e.id))}</td></tr>`)}${pend.payments.map(e => html`<tr><td>دریافت قسط</td><td>درخواست ${fa(e.application_id)} – <span dir="ltr">${e.reference}</span></td><td dir="ltr">${money(e.amount)}</td><td>${postBtn('credit.payment', Number(e.id))}</td></tr>`)}${pend.settlements.map(e => html`<tr><td>تسویه با پذیرنده</td><td><span dir="ltr">${e.reference}</span></td><td dir="ltr">${money(e.net)}</td><td>${postBtn('market.settlement', Number(e.id))}</td></tr>`)}${pend.activations.length + pend.payments.length + pend.settlements.length ? '' : html`<tr><td colspan="4" class="muted">همه رویدادها سند شده‌اند.</td></tr>`}</table><p class="muted">سند به‌صورت پیش‌نویس ساخته می‌شود و فرد دیگری باید آن را قطعی کند. سیاست حسابداری (مثلاً درآمد معوق) را حسابدار شرکت تأیید کند.</p></div>`);
  }
  throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
}

export async function handleCredit(c: Ctx): Promise<Out | null> {
  const { rq, db, A } = c, path = rq.path;
  if (!path.startsWith('/credit')) return null;
  await gate.require_(db, A, 'credit.view');
  const k = await company(c), cid = k.cid, hid = html`${c.csrf}${k.cqh}`, home = k.q('/credit'), f = c.f;
  if (rq.method === 'POST') {
    let m: RegExpMatchArray | null;
    if (path === '/credit/plans') {
      const n = (key: string) => Number(f(key) || 0), terms = rq.form.getAll('t_count[]').map((cnt, i) => ({ installments: Number(cnt), monthly_fee_bp: Number(rq.form.getAll('t_monthly[]')[i] || 0), upfront_fee_bp: Number(rq.form.getAll('t_upfront[]')[i] || 0), has: cnt.trim() !== '' })).filter(t => t.has).map(({ has, ...t }) => t);
      return c.done(home, () => credit.createPlan(db, A, cid, { name: f('name'), min_amount: n('min_amount'), max_amount: n('max_amount'), min_down_bp: n('min_down_bp'), max_down_bp: n('max_down_bp') || 10000, quote_ttl_min: n('quote_ttl_min'), grace_days: n('grace_days'), late_fee_bp_day: n('late_fee_bp_day'), settlement_work_days: n('settlement_work_days') }, terms), 'طرح اعتباری ایجاد شد.');
    }
    if (path === '/credit/quote') {
      try {
        const amount = parseAmount(f('amount')), down = f('down') === '' ? 0 : parseAmount(f('down')); if (amount === null || down === null) throw new Invalid('مبلغ باید فقط عدد صحیح (ریال) باشد.');
        const q = await credit.quote(db, A, cid, Number(f('plan_id')), amount, down, Number(f('count')));
        if (f('profile_id')) { const id = await credit.createApplication(db, A, q.quote_id, Number(f('profile_id'))); await c.flashOk('پیش‌فاکتور ثبت و درخواست ایجاد شد.'); return c.redirect(k.q(`/credit/applications/${id}`)); }
        await c.flashOk(`پیش‌فاکتور محاسبه شد: هر قسط ${money(q.installment_amount)} ریال، قسط آخر ${money(q.last_installment_amount)}، کارمزد ${money(q.fee_total)}، کل بازپرداخت ${money(q.total_repayment)} ریال (اعتبار تا ${J.format(q.expires_at)}؛ برای ثبت درخواست، پرونده را انتخاب کنید).`);
      } catch (e) { if (e instanceof Invalid) await c.flashErr(e.message); else throw e; }
      return c.redirect(home);
    }
    if ((m = path.match(/^\/credit\/applications\/(\d+)\/(transition|contract|activate|pay)$/))) {
      const id = Number(m[1]), b = k.q(`/credit/applications/${id}`);
      if (m[2] === 'transition') return c.done(b, () => credit.transition(db, A, id, f('to'), f('note')), 'وضعیت درخواست تغییر کرد.');
      if (m[2] === 'contract') return c.done(b, () => credit.signContract(db, A, id, f('note')), 'قرارداد ثبت شد.');
      if (m[2] === 'activate') return c.done(b, () => credit.activate(db, A, id, f('date')), 'درخواست فعال و جدول اقساط ایجاد شد.');
      return c.done(b, () => credit.recordPayment(db, A, id, parseAmount(f('amount')) ?? 0, f('reference')), 'پرداخت ثبت شد.');
    }
    throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
  }
  const entry = await gate.can(db, A, 'credit.entry'), manage = await gate.can(db, A, 'credit.manage');
  if (path === '/credit') {
    const plans = await db.all('SELECT * FROM credit_plans WHERE company_id = ? ORDER BY id DESC', [cid]), terms = await db.all('SELECT * FROM credit_plan_terms WHERE plan_id IN (SELECT id FROM credit_plans WHERE company_id = ?) ORDER BY installments', [cid]);
    const apps = await db.all('SELECT ap.id, ap.status, q.amount, q.installments, pr.first_name, pr.last_name FROM credit_applications ap JOIN credit_quotes q ON q.id = ap.quote_id JOIN identity_profiles pr ON pr.id = ap.profile_id WHERE ap.company_id = ? ORDER BY ap.id DESC LIMIT 100', [cid]);
    const profiles = await db.all("SELECT p.id, p.first_name, p.last_name, f.folder_no FROM identity_profiles p JOIN digital_folders f ON f.profile_id = p.id WHERE p.company_id = ? AND p.status = 'approved_final' ORDER BY p.id DESC", [cid]);
    return c.render('اعتبار و اقساط', html`${entry && plans.length ? html`<form method="post" action="/credit/quote" class="panel form"><h2>پیش‌فاکتور اقساط / ثبت درخواست</h2>${hid}<label>طرح<select name="plan_id">${plans.filter(p => p.status === 'active').map(p => html`<option value="${p.id}">${p.name}</option>`)}</select></label><label>مبلغ (ریال)<input name="amount" dir="ltr" required inputmode="numeric"></label><label>پیش‌پرداخت (ریال)<input name="down" dir="ltr" inputmode="numeric" placeholder="۰"></label><label>تعداد اقساط<input name="count" dir="ltr" required inputmode="numeric"></label><label>برای ثبت درخواست: پرونده متقاضی (تأیید نهایی)<select name="profile_id"><option value="">— فقط محاسبه —</option>${profiles.map(p => html`<option value="${p.id}">${p.folder_no + ' – ' + p.first_name + ' ' + p.last_name}</option>`)}</select></label><button>محاسبه / ثبت</button></form>` : ''}
<div class="panel"><h2>درخواست‌ها</h2><table><tr><th>#</th><th>متقاضی</th><th>مبلغ</th><th>اقساط</th><th>وضعیت</th></tr>${apps.map(a => html`<tr><td><a href="${k.q('/credit/applications/' + a.id)}">${fa(a.id)}</a></td><td>${a.first_name + ' ' + a.last_name}</td><td dir="ltr">${money(a.amount)}</td><td>${fa(a.installments)}</td><td>${credit.STATUS[a.status]}</td></tr>`)}${apps.length ? '' : html`<tr><td colspan="5" class="muted">درخواستی ثبت نشده است.</td></tr>`}</table></div>
<div class="panel"><h2>طرح‌های اعتباری</h2>${plans.map(p => html`<p><b><a href="${k.q('/credit/plans/' + p.id)}">${p.name}</a></b> – مبلغ ${money(p.min_amount)} تا ${money(p.max_amount)} ریال | پیش‌پرداخت ${fa(Number(p.min_down_bp) / 100)}٪ تا ${fa(Number(p.max_down_bp) / 100)}٪ | مهلت اولین قسط ${fa(p.grace_days)} روز | تسویه با پذیرنده ${fa(p.settlement_work_days)} روز کاری<br><span class="muted">${terms.filter(t => Number(t.plan_id) === Number(p.id)).map(t => `[${fa(t.installments)} قسط: کارمزد ماهانه ${fa(Number(t.monthly_fee_bp) / 100)}٪، کارمزد ابتدایی ${fa(Number(t.upfront_fee_bp) / 100)}٪] `).join('')}</span></p>`)}${plans.length ? '' : html`<p class="muted">هنوز طرحی تعریف نشده است. نرخ‌ها و کارمزدها باید توسط مدیر اعتبار طبق مصوبه رسمی وارد شود؛ سامانه هیچ نرخ پیش‌فرضی ندارد.</p>`}</div>
${manage ? html`<form method="post" action="/credit/plans" class="panel form"><h2>طرح جدید</h2>${hid}<label>نام طرح<input name="name" required></label><label>حداقل مبلغ (ریال)<input name="min_amount" dir="ltr" required></label><label>حداکثر مبلغ (ریال)<input name="max_amount" dir="ltr" required></label><label>حداقل پیش‌پرداخت (bp؛ ۱۰۰=۱٪)<input name="min_down_bp" dir="ltr" value="0"></label><label>حداکثر پیش‌پرداخت (bp)<input name="max_down_bp" dir="ltr" value="10000"></label><label>اعتبار پیش‌فاکتور (دقیقه)<input name="quote_ttl_min" dir="ltr" value="30"></label><label>مهلت اولین قسط (روز)<input name="grace_days" dir="ltr" value="0"></label><label>جریمه دیرکرد روزانه (bp)<input name="late_fee_bp_day" dir="ltr" value="0"></label><label>تسویه با پذیرنده (روز کاری)<input name="settlement_work_days" dir="ltr" value="0"></label>${[0, 1, 2, 3].map(i => html`<label>گزینه ${fa(i + 1)}: تعداد اقساط<input name="t_count[]" dir="ltr"></label><label>کارمزد ماهانه (bp)<input name="t_monthly[]" dir="ltr" value="0"></label><label>کارمزد ابتدایی (bp)<input name="t_upfront[]" dir="ltr" value="0"></label>`)}<button>ایجاد طرح</button></form>` : ''}`);
  }
  const m = path.match(/^\/credit\/applications\/(\d+)$/);
  if (m) {
    const ap = await credit.get(db, A, Number(m[1])); if (Number(ap.company_id) !== cid) throw new HttpError('مورد درخواستی یافت نشد.', 404);
    const plan = (await db.one('SELECT * FROM credit_plans WHERE id = ?', [ap.plan_id]))!, inst = await credit.installments(db, Number(ap.id)), hist = await credit.history(db, Number(ap.id)), allowed = await credit.allowed(db, A, ap);
    const contract = await db.one('SELECT * FROM credit_contracts WHERE application_id = ?', [ap.id]), today = new Date().toISOString().slice(0, 10), b = `/credit/applications/${ap.id}`;
    return c.render('درخواست اعتبار #' + ap.id, html`<p><a href="${home}">← بازگشت</a></p><div class="panel"><h2>درخواست #${fa(ap.id)} – ${ap.first_name + ' ' + ap.last_name} <span class="st">${credit.STATUS[ap.status]}</span></h2><table><tr><th>پرونده</th><td>${ap.folder_no}</td><th>مبلغ</th><td dir="ltr">${money(ap.amount)}</td><th>پیش‌پرداخت</th><td dir="ltr">${money(ap.down_payment)}</td><th>تأمین مالی</th><td dir="ltr">${money(ap.financed)}</td></tr><tr><th>اقساط</th><td>${fa(ap.inst_count)}</td><th>هر قسط</th><td dir="ltr">${money(ap.installment_amount)}</td><th>کل بازپرداخت</th><td dir="ltr">${money(ap.total_repayment)}</td><th>تسویه پذیرنده</th><td>${J.format(ap.settlement_expected_on, false)}</td></tr></table>${contract ? html`<p class="muted">قرارداد ثبت‌شده؛ هش شرایط: <span dir="ltr">${String(contract.terms_hash).slice(0, 16)}…</span> | ${J.format(contract.signed_at)} (ثبت رسید رضایت؛ سرویس امضای الکترونیک رسمی نیست)</p>` : ''}</div>
${inst.length ? html`<div class="panel"><h2>اقساط</h2><table><tr><th>#</th><th>سررسید</th><th>مبلغ</th><th>پرداخت‌شده</th><th>وضعیت</th><th>جریمه دیرکرد (اطلاعی)</th></tr>${inst.map(i => html`<tr><td>${fa(i.seq)}</td><td>${J.format(i.due_date, false)}</td><td dir="ltr">${money(i.amount)}</td><td dir="ltr">${money(i.paid_amount)}</td><td>${i.status !== 'paid' && i.due_date < today ? 'سررسیدگذشته' : ({ pending: 'در انتظار', partial: 'پرداخت جزئی', paid: 'پرداخت‌شده', overdue: 'سررسیدگذشته' } as any)[i.status]}</td><td dir="ltr">${money(credit.lateFee(i, Number(plan.late_fee_bp_day), today))}</td></tr>`)}</table></div>${ap.status === 'active' && await gate.can(db, A, 'credit.payment') ? html`<form method="post" action="${b}/pay" class="panel form"><h2>ثبت پرداخت</h2>${hid}<label>مبلغ (ریال)<input name="amount" dir="ltr" required></label><label>شناسه پیگیری یکتا (تکراری ثبت نمی‌شود)<input name="reference" dir="ltr" required></label><button>ثبت پرداخت</button></form>` : ''}` : ''}
${ap.status === 'approved' && entry ? html`<form method="post" action="${b}/contract" class="panel form"><h2>ثبت قرارداد امضاشده</h2>${hid}<label>نحوه/مستند امضا<input name="note" required></label><button>ثبت قرارداد</button></form>` : ''}
${ap.status === 'contracted' && entry ? html`<form method="post" action="${b}/activate" class="panel form"><h2>فعال‌سازی و تولید جدول اقساط</h2>${hid}<label>تاریخ قرارداد (شمسی)<input name="date" dir="ltr" required placeholder="1405/08/16"></label><button>فعال‌سازی</button></form>` : ''}
${Object.keys(allowed).length ? html`<form method="post" action="${b}/transition" class="panel form"><h2>تغییر وضعیت</h2>${hid}<label>وضعیت جدید<select name="to">${Object.entries(allowed).map(([kk, l]) => html`<option value="${kk}">${l}</option>`)}</select></label><label>توضیح (برای تأیید، رد و نیاز به مدارک الزامی)<input name="note"></label><button>ثبت</button></form>` : ''}
<div class="panel"><h2>تاریخچه</h2><table><tr><th>زمان</th><th>کاربر</th><th>از</th><th>به</th><th>توضیح</th></tr>${hist.map(h => html`<tr><td>${J.format(h.created_at)}</td><td>${h.uname}</td><td>${h.from_status ? credit.STATUS[h.from_status] : '—'}</td><td>${credit.STATUS[h.to_status]}</td><td>${h.note ?? ''}</td></tr>`)}</table></div>`);
  }
  throw new HttpError('صفحه مورد نظر یافت نشد.', 404);
}
