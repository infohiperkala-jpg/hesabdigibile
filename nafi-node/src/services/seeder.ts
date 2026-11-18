import { Db } from '../core/db.js';
import * as audit from '../core/audit.js';

export const PERMS: Record<string, string> = {
  'dashboard.view': 'مشاهده داشبورد', 'company.view': 'مشاهده شرکت‌ها', 'company.manage': 'مدیریت شرکت‌ها', 'brand.view': 'مشاهده برندها و دامنه‌ها', 'brand.manage': 'مدیریت برندها و دامنه‌ها',
  'user.view': 'مشاهده کاربران', 'user.manage': 'مدیریت کاربران', 'role.view': 'مشاهده نقش‌ها', 'audit.view': 'مشاهده گزارش حسابرسی',
  'registration.view': 'مشاهده پرونده‌های ثبت‌نام', 'registration.manage': 'ثبت‌نام و بارگذاری مدارک', 'registration.review': 'بررسی و تأیید مدارک', 'document.view': 'مشاهده زونکن دیجیتال', 'document.download': 'دانلود مدارک',
  'accounting.view': 'مشاهده حسابداری و گزارش‌ها', 'accounting.manage': 'مدیریت سرفصل‌ها و دوره مالی', 'accounting.entry': 'ثبت و برگشت سند حسابداری', 'accounting.finalize': 'قطعی‌کردن سند حسابداری',
  'credit.view': 'مشاهده اعتبار و اقساط', 'credit.manage': 'تعریف طرح‌های اعتباری', 'credit.entry': 'ثبت پیش‌فاکتور و درخواست اعتبار', 'credit.review': 'تصمیم‌گیری درخواست اعتبار', 'credit.payment': 'ثبت پرداخت اقساط',
  'market.view': 'مشاهده بازارگاه', 'market.manage': 'مدیریت پذیرندگان', 'market.catalog': 'مدیریت کاتالوگ کالا', 'market.sell': 'ثبت سفارش', 'market.settle': 'تسویه با پذیرندگان', 'purchase.view': 'مشاهده خرید و تأمین‌کنندگان', 'purchase.manage': 'مدیریت تأمین‌کنندگان و سفارش خرید', 'purchase.receive': 'ثبت رسید خرید', 'crm.view': 'مشاهده CRM و مشتریان', 'crm.manage': 'مدیریت مشتریان و پیگیری‌ها',
  'contract.view': 'مشاهده قراردادها', 'contract.manage': 'مدیریت قالب‌های قرارداد', 'contract.draft': 'تنظیم و امضای قرارداد', 'contract.approve': 'تأیید و فسخ قرارداد',
};
const ALL = Object.keys(PERMS);
export const ROLES: Record<string, [string, string[]]> = {
  company_admin: ['مدیر شرکت', ALL.filter(p => p !== 'company.manage')],
  viewer: ['مشاهده‌گر', ['dashboard.view', 'company.view', 'brand.view']],
  registrar: ['کارمند ثبت‌نام', ['dashboard.view', 'registration.view', 'registration.manage', 'document.view']],
  doc_expert: ['کارشناس مدارک', ['dashboard.view', 'registration.view', 'registration.review', 'document.view', 'document.download']],
  accountant: ['کارشناس حسابداری', ['dashboard.view', 'accounting.view', 'accounting.entry']],
  fin_manager: ['مدیر مالی', ['dashboard.view', 'accounting.view', 'accounting.manage', 'accounting.finalize']],
  credit_officer: ['کارشناس اعتبار', ['dashboard.view', 'registration.view', 'credit.view', 'credit.entry', 'credit.payment']],
  credit_manager: ['مدیر اعتبار', ['dashboard.view', 'registration.view', 'credit.view', 'credit.manage', 'credit.review']],
  market_manager: ['مدیر بازارگاه', ['dashboard.view', 'market.view', 'market.manage', 'market.catalog', 'market.settle']],
  sales_agent: ['کارشناس فروش', ['dashboard.view', 'registration.view', 'credit.view', 'credit.entry', 'market.view', 'market.sell', 'crm.view', 'crm.manage']],
  contract_officer: ['کارشناس قراردادها', ['dashboard.view', 'registration.view', 'contract.view', 'contract.draft']],
  legal_manager: ['مدیر حقوقی', ['dashboard.view', 'registration.view', 'document.download', 'contract.view', 'contract.manage', 'contract.approve']],
};

/** Idempotent: permissions, global roles and the group (mother) company. Returns the mother company id. */
export async function seed(db: Db): Promise<number> {
  for (const [code, title] of Object.entries(PERMS)) if (!(await db.val('SELECT 1 FROM permissions WHERE code = ?', [code]))) await db.exec('INSERT INTO permissions (code,title) VALUES (?,?)', [code, title]);
  for (const [code, [title, perms]] of Object.entries(ROLES)) {
    let rid = await db.val('SELECT id FROM roles WHERE code = ? AND company_id IS NULL', [code]);
    if (!rid) rid = await db.insert('INSERT INTO roles (company_id,code,title) VALUES (NULL,?,?)', [code, title]);
    for (const p of perms) {
      const pid = await db.val('SELECT id FROM permissions WHERE code = ?', [p]);
      if (!(await db.val('SELECT 1 FROM role_permissions WHERE role_id = ? AND permission_id = ?', [rid, pid]))) await db.exec('INSERT INTO role_permissions (role_id,permission_id) VALUES (?,?)', [rid, pid]);
    }
  }
  let cid = await db.val('SELECT id FROM companies WHERE parent_id IS NULL ORDER BY id LIMIT 1');
  if (!cid) {
    const now = db.now();
    cid = await db.insert('INSERT INTO companies (parent_id,name,legal_name,created_at,updated_at) VALUES (NULL,?,?,?,?)', ['نگار آذین فدک ایران', 'مجموعه نگار آذین فدک ایران', now, now]);
    await audit.log(db, null, 'company.create', 'company', Number(cid), { name: 'شرکت مادر' }, Number(cid));
  }
  return Number(cid);
}
