import { Db, Row } from '../core/db.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
/** Tagged template: every interpolated value is HTML-escaped unless wrapped with raw(). */
export class Raw { constructor(public s: string) {} }
export const raw = (s: string) => new Raw(s);
export const html = (strs: TemplateStringsArray, ...vals: unknown[]): Raw =>
  new Raw(strs.reduce((o, s, i) => o + s + (i < vals.length ? (vals[i] instanceof Raw ? (vals[i] as Raw).s : Array.isArray(vals[i]) ? (vals[i] as unknown[]).map(v => v instanceof Raw ? v.s : esc(v)).join('') : esc(vals[i])) : ''), ''));

type Item = [number, string, string | null, string | null];   // number, title, permission, route (null = not built)
const TREE: [string, Item[]][] = [
  ['سازمان', [[1, 'داشبورد مدیریت کل', 'dashboard.view', '/'], [2, 'مدیریت سازمان', 'module.2', null], [3, 'شرکت‌ها و زیرمجموعه‌ها', 'company.view', '/companies'], [4, 'برندها و دامنه‌ها', 'brand.view', '/brands'], [5, 'کاربران و دسترسی‌ها', 'user.view', '/users']]],
  ['مالی', [[6, 'مدیریت مالی و حسابداری', 'accounting.view', '/accounting'], [7, 'خزانه‌داری و بانک', 'module.7', null]]],
  ['فروش و بازارگاه', [[8, 'فروش و سفارشات', 'module.8', null], [9, 'بازارگاه و فروشگاه‌ها', 'market.view', null], [10, 'کالا و خدمات', 'module.10', null], [11, 'انبار و موجودی', 'module.11', null], [12, 'خرید و تأمین‌کنندگان', 'module.12', null]]],
  ['اعتبار و لندتک', [[13, 'اعتبار و کیف پول', 'credit.view', '/credit'], [14, 'لندتک و تسهیلات', 'module.14', null], [15, 'اقساط و وصول مطالبات', 'module.15', null], [16, 'پذیرندگان و نمایندگان', 'module.16', null]]],
  ['مشتری و هویت', [[17, 'CRM و مشتریان', 'module.17', null], [18, 'ثبت‌نام و احراز هویت', 'registration.view', '/registrations'], [19, 'مدیریت پرونده‌ها', 'module.19', null]]],
  ['اسناد و قراردادها', [[20, 'زونکن دیجیتال', 'module.20', null], [21, 'OCR و پردازش اسناد', 'module.21', null], [22, 'قراردادها', 'contract.view', null], [23, 'دبیرخانه و اتوماسیون', 'module.23', null]]],
  ['توسعه و امنیت', [[34, 'امنیت و حسابرسی', 'audit.view', '/audit'], [35, 'تنظیمات کلان', 'module.35', null]]],
];
export async function menuFor(db: Db, u: Actor) {
  const out: { group: string; items: { n: number; title: string; url: string | null }[] }[] = [];
  for (const [group, items] of TREE) { const vis = []; for (const [n, title, perm, url] of items) if (await gate.can(db, u, perm!)) vis.push({ n, title, url }); if (vis.length) out.push({ group, items: vis }); }
  return out;
}
export const fmtDate = (s: string | null) => s;
export interface PageCtx { u: Row; title: string; csrf: string; flash: [string, string] | null; menu: Awaited<ReturnType<typeof menuFor>>; path: string }
export function layout(c: PageCtx, body: Raw): string {
  const nav = c.menu.map(g => `<details open><summary>${esc(g.group)}</summary><ul>${g.items.map(i => i.url
    ? `<li><a href="${esc(i.url)}"${c.path === i.url ? ' class="on"' : ''}>${i.n}. ${esc(i.title)}</a></li>`
    : `<li><span class="soon" title="این ماژول هنوز در نسخه Node ساخته نشده است">${i.n}. ${esc(i.title)}<em>در دست ساخت</em></span></li>`).join('')}</ul></details>`).join('');
  return `<!DOCTYPE html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(c.title)} – پلتفرم نگار آذین فدک</title><link rel="stylesheet" href="/assets/app.css"></head><body><div class="app"><aside><div class="brand">پلتفرم نگار آذین فدک<small>مرکز مدیریت مجموعه</small></div><nav>${nav}</nav></aside><main><header><h1>${esc(c.title)}</h1><form method="post" action="/logout" class="who"><input type="hidden" name="_csrf" value="${esc(c.csrf)}"><a href="/account">${esc(c.u.name)}</a><button class="ghost">خروج</button></form></header>${c.flash ? `<div class="flash ${esc(c.flash[1])}">${esc(c.flash[0])}</div>` : ''}${body.s}</main></div></body></html>`;
}
export const csrfField = (t: string) => raw(`<input type="hidden" name="_csrf" value="${esc(t)}">`);
