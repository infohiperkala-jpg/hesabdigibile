import { Db } from '../core/db.js';
import * as audit from '../core/audit.js';
import { Actor } from '../core/audit.js';
import * as gate from '../core/gate.js';
import { HttpError, Invalid } from '../core/errors.js';
import { hashPassword } from '../core/crypto.js';
import * as V from '../core/validator.js';

async function company(db: Db, a: Actor, cid: number) {
  gate.assertCompany(a, cid);
  if (!(await db.val('SELECT 1 FROM companies WHERE id = ?', [cid]))) throw new HttpError('مورد درخواستی یافت نشد.', 404);
}

export async function createCompany(db: Db, a: Actor, name: string, legal: string | null = null, parentId: number | null = null): Promise<number> {
  await gate.require_(db, a, 'company.manage');
  if (!gate.isGroup(a)) throw new HttpError('ایجاد شرکت فقط برای مدیریت کل مجموعه مجاز است.', 403);
  name = name.trim(); legal = legal?.trim() || null;
  if ([...name].length < 2 || [...name].length > 120) throw new Invalid('نام شرکت باید بین ۲ تا ۱۲۰ کاراکتر باشد.');
  if (parentId !== null && !(await db.val('SELECT 1 FROM companies WHERE id = ?', [parentId]))) throw new Invalid('شرکت مادر نامعتبر است.');
  return db.tx(async t => {
    const now = t.now(), id = await t.insert('INSERT INTO companies (parent_id,name,legal_name,created_at,updated_at) VALUES (?,?,?,?,?)', [parentId, name, legal, now, now]);
    await audit.log(t, a, 'company.create', 'company', id, { name }, id); return id;
  });
}

export async function createBrand(db: Db, a: Actor, companyId: number, name: string, slug: string, host: string | null = null): Promise<number> {
  await gate.require_(db, a, 'brand.manage'); await company(db, a, companyId);
  name = name.trim(); slug = slug.trim().toLowerCase(); host = host ? host.trim().toLowerCase() : null;
  if ([...name].length < 2 || [...name].length > 120) throw new Invalid('نام برند باید بین ۲ تا ۱۲۰ کاراکتر باشد.');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) || slug.length > 60) throw new Invalid('شناسه برند فقط حروف کوچک انگلیسی، عدد و خط تیره (حداکثر ۶۰ کاراکتر).');
  if (host !== null && !/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) throw new Invalid('نام دامنه معتبر نیست.');
  if (await db.val('SELECT 1 FROM brands WHERE slug = ?', [slug])) throw new Invalid('این شناسه برند قبلاً ثبت شده است.');
  if (host && (await db.val('SELECT 1 FROM domains WHERE host = ?', [host]))) throw new Invalid('این دامنه قبلاً ثبت شده است.');
  return db.tx(async t => {
    const now = t.now(), id = await t.insert('INSERT INTO brands (company_id,name,slug,created_at) VALUES (?,?,?,?)', [companyId, name, slug, now]);
    if (host) await t.exec('INSERT INTO domains (brand_id,host,created_at) VALUES (?,?,?)', [id, host, now]);
    await audit.log(t, a, 'brand.create', 'brand', id, { slug, domain: host }, companyId); return id;
  });
}

export async function createUser(db: Db, a: Actor, name: string, email: string, password: string, companyId: number | null, roleId: number): Promise<number> {
  await gate.require_(db, a, 'user.manage');
  if (!gate.isGroup(a)) companyId = a.company_id;                       // company admins can only create inside their own company
  if (companyId === null) throw new Invalid('شرکت کاربر را انتخاب کنید.');
  gate.assertCompany(a, companyId); await company(db, a, companyId);
  name = name.trim(); email = email.trim().toLowerCase();
  if ([...name].length < 2 || [...name].length > 120) throw new Invalid('نام کاربر باید بین ۲ تا ۱۲۰ کاراکتر باشد.');
  if (!V.email(email)) throw new Invalid('ایمیل معتبر نیست.');
  V.password(password, email);
  if (await db.val('SELECT 1 FROM users WHERE email = ?', [email])) throw new Invalid('این ایمیل قبلاً ثبت شده است.');
  if (!(await db.val('SELECT 1 FROM roles WHERE id = ? AND company_id IS NULL', [roleId]))) throw new Invalid('نقش نامعتبر است.');
  const hash = await hashPassword(password);
  return db.tx(async t => {
    const id = await t.insert('INSERT INTO users (company_id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)', [companyId, name, email, hash, t.now()]);
    await t.exec('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [id, roleId]);
    await audit.log(t, a, 'user.create', 'user', id, { role_id: roleId }, companyId); return id;
  });
}

export async function setUserStatus(db: Db, a: Actor, userId: number, status: string): Promise<void> {
  await gate.require_(db, a, 'user.manage');
  if (!['active', 'disabled'].includes(status)) throw new Invalid('وضعیت نامعتبر است.');
  const u = await db.one('SELECT id, company_id, is_owner FROM users WHERE id = ?', [userId]);
  if (!u) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  const cid = u.company_id === null ? null : Number(u.company_id);
  gate.assertCompany(a, cid);
  if (Number(u.id) === Number(a.id)) throw new Invalid('غیرفعال‌کردن حساب خودتان مجاز نیست.');
  if (u.is_owner && !gate.isGroup(a)) throw new HttpError('مورد درخواستی یافت نشد.', 404);
  await db.exec('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
  await audit.log(db, a, 'user.status', 'user', userId, { status }, cid);
}

// ───────────────────────── editing, status changes and sensitive account actions ─────────────────────────
import * as ch from '../core/changes.js';
import { verifyPassword } from '../core/crypto.js';

const len_ = (s: string) => [...s].length;
export const COMPANY_STATUS: Record<string, string> = { active: 'فعال', suspended: 'معلق', archived: 'بایگانی‌شده' };
const revokeSessions = (db: Db, userId: number) => db.exec('DELETE FROM sessions WHERE user_id = ?', [userId]).catch(() => 0);   // access changes take effect immediately

export async function getCompany(db: Db, a: Actor, id: number) {
  await gate.require_(db, a, 'company.view'); const c = await db.one('SELECT * FROM companies WHERE id = ?', [id]);
  if (!c) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, id); return c;
}
export async function editCompany(db: Db, a: Actor, id: number, input: { name: string; legal_name: string | null }, version?: string): Promise<void> {
  await gate.require_(db, a, 'company.manage'); const c = await getCompany(db, a, id); ch.assertVersion(c, version);
  const name = input.name.trim(), legal = input.legal_name?.trim() || null;
  if (len_(name) < 2 || len_(name) > 120) throw new Invalid('نام شرکت باید بین ۲ تا ۱۲۰ کاراکتر باشد.');
  const changes = ch.diff(c, { name, legal_name: legal }); if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => { await t.exec('UPDATE companies SET name = ?, legal_name = ?, updated_at = ? WHERE id = ?', [name, legal, t.now(), id]); await ch.record(t, a, id, 'company', id, changes); });
}
/** Suspending/archiving a company immediately blocks its users (their sessions are revoked and logins refused). The mother company cannot be changed. */
export async function setCompanyStatus(db: Db, a: Actor, id: number, status: string, note: string): Promise<void> {
  await gate.require_(db, a, 'company.manage'); const c = await getCompany(db, a, id);
  if (!COMPANY_STATUS[status]) throw new Invalid('وضعیت نامعتبر است.'); if (id === Number(await db.val('SELECT MIN(id) FROM companies WHERE parent_id IS NULL'))) throw new Invalid('وضعیت شرکت مادر قابل تغییر نیست.');
  if (c.status === status) throw new Invalid('شرکت از قبل در این وضعیت است.'); note = ch.requireNote(note);
  if (status === 'archived' && (Number(await db.val("SELECT COUNT(*) FROM companies WHERE parent_id = ? AND status <> 'archived'", [id])) > 0)) throw new Invalid('ابتدا زیرمجموعه‌های این شرکت را بایگانی کنید.');
  await db.tx(async t => {
    await t.exec('UPDATE companies SET status = ?, updated_at = ? WHERE id = ?', [status, t.now(), id]); await ch.record(t, a, id, 'company', id, { status: [c.status, status] }, note);
    if (status !== 'active') for (const u of await t.all('SELECT id FROM users WHERE company_id = ?', [id])) await revokeSessions(t, Number(u.id));
  });
}

export async function getBrand(db: Db, a: Actor, id: number) {
  await gate.require_(db, a, 'brand.view'); const b = await db.one('SELECT b.*, c.name AS company_name FROM brands b JOIN companies c ON c.id = b.company_id WHERE b.id = ?', [id]);
  if (!b) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, Number(b.company_id)); return b;
}
export async function editBrand(db: Db, a: Actor, id: number, name: string, version?: string): Promise<void> {
  await gate.require_(db, a, 'brand.manage'); const b = await getBrand(db, a, id); ch.assertVersion(b, version); name = name.trim();
  if (len_(name) < 2 || len_(name) > 120) throw new Invalid('نام برند باید بین ۲ تا ۱۲۰ کاراکتر باشد.');
  const changes = ch.diff(b, { name }); if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => { await t.exec('UPDATE brands SET name = ?, updated_at = ? WHERE id = ?', [name, t.now(), id]); await ch.record(t, a, Number(b.company_id), 'brand', id, changes); });
}
export async function setBrandStatus(db: Db, a: Actor, id: number, status: string, note: string): Promise<void> {
  await gate.require_(db, a, 'brand.manage'); const b = await getBrand(db, a, id);
  if (!['active', 'suspended', 'archived'].includes(status)) throw new Invalid('وضعیت نامعتبر است.'); if (b.status === status) throw new Invalid('برند از قبل در این وضعیت است.'); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec('UPDATE brands SET status = ?, updated_at = ? WHERE id = ?', [status, t.now(), id]); await ch.record(t, a, Number(b.company_id), 'brand', id, { status: [b.status, status] }, note); });
}
export async function addDomain(db: Db, a: Actor, brandId: number, host: string): Promise<void> {
  await gate.require_(db, a, 'brand.manage'); const b = await getBrand(db, a, brandId); host = host.trim().toLowerCase();
  if (!/^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(host)) throw new Invalid('نام دامنه معتبر نیست.'); if (await db.val('SELECT 1 FROM domains WHERE host = ?', [host])) throw new Invalid('این دامنه قبلاً ثبت شده است.');
  await db.tx(async t => { await t.exec('INSERT INTO domains (brand_id,host,created_at) VALUES (?,?,?)', [brandId, host, t.now()]); await ch.record(t, a, Number(b.company_id), 'brand', brandId, { domain_added: [null, host] }); });
}
export async function removeDomain(db: Db, a: Actor, brandId: number, domainId: number, note: string): Promise<void> {
  await gate.require_(db, a, 'brand.manage'); const b = await getBrand(db, a, brandId); const d = await db.one('SELECT * FROM domains WHERE id = ? AND brand_id = ?', [domainId, brandId]);
  if (!d) throw new HttpError('مورد درخواستی یافت نشد.', 404); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec('DELETE FROM domains WHERE id = ?', [domainId]); await ch.record(t, a, Number(b.company_id), 'brand', brandId, { domain_removed: [d.host, null] }, note); });
}

export async function getUser(db: Db, a: Actor, id: number) {
  await gate.require_(db, a, 'user.view'); const u = await db.one('SELECT x.*, c.name AS company_name FROM users x LEFT JOIN companies c ON c.id = x.company_id WHERE x.id = ?', [id]);
  if (!u) throw new HttpError('مورد درخواستی یافت نشد.', 404); gate.assertCompany(a, u.company_id === null ? null : Number(u.company_id));
  if (u.is_owner && !gate.isGroup(a)) throw new HttpError('مورد درخواستی یافت نشد.', 404); return u;
}
export async function editUser(db: Db, a: Actor, id: number, name: string, email: string, version?: string): Promise<void> {
  await gate.require_(db, a, 'user.manage'); const u = await getUser(db, a, id); ch.assertVersion(u, version); name = name.trim(); email = email.trim().toLowerCase();
  if (len_(name) < 2 || len_(name) > 120) throw new Invalid('نام کاربر باید بین ۲ تا ۱۲۰ کاراکتر باشد.'); if (!V.email(email)) throw new Invalid('ایمیل معتبر نیست.');
  if (await db.val('SELECT 1 FROM users WHERE email = ? AND id <> ?', [email, id])) throw new Invalid('این ایمیل قبلاً ثبت شده است.');
  const changes = ch.diff(u, { name, email }); if (!Object.keys(changes).length) throw new Invalid('تغییری برای ذخیره وجود ندارد.');
  await db.tx(async t => { await t.exec('UPDATE users SET name = ?, email = ?, updated_at = ? WHERE id = ?', [name, email, t.now(), id]); await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, changes); if (changes.email) await revokeSessions(t, id); });
}
export async function changeUserRole(db: Db, a: Actor, id: number, roleId: number, note: string): Promise<void> {
  await gate.require_(db, a, 'user.manage'); const u = await getUser(db, a, id); if (u.is_owner) throw new Invalid('نقش مالک قابل تغییر نیست.'); if (Number(u.id) === Number(a.id)) throw new Invalid('تغییر نقش خودتان مجاز نیست.');
  const role = await db.one('SELECT id, title FROM roles WHERE id = ? AND company_id IS NULL', [roleId]); if (!role) throw new Invalid('نقش نامعتبر است.'); note = ch.requireNote(note);
  const cur = await db.all('SELECT r.title FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?', [id]); if (cur.length === 1 && cur[0].title === role.title) throw new Invalid('کاربر از قبل این نقش را دارد.');
  await db.tx(async t => { await t.exec('DELETE FROM user_roles WHERE user_id = ?', [id]); await t.exec('INSERT INTO user_roles (user_id,role_id) VALUES (?,?)', [id, roleId]); await t.exec('UPDATE users SET updated_at = ? WHERE id = ?', [t.now(), id]);
    await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, { role: [cur.map(r => r.title).join('، ') || null, role.title] }, note); await revokeSessions(t, id); });
}
/** Disabling revokes every session of the user at once. */
export async function setUserStatusWithReason(db: Db, a: Actor, id: number, status: string, note: string): Promise<void> {
  await gate.require_(db, a, 'user.manage'); const u = await getUser(db, a, id); if (!['active', 'disabled'].includes(status)) throw new Invalid('وضعیت نامعتبر است.');
  if (Number(u.id) === Number(a.id)) throw new Invalid('غیرفعال‌کردن حساب خودتان مجاز نیست.'); if (u.status === status) throw new Invalid('کاربر از قبل در این وضعیت است.'); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec('UPDATE users SET status = ?, updated_at = ? WHERE id = ?', [status, t.now(), id]); await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, { status: [u.status, status] }, note); if (status === 'disabled') await revokeSessions(t, id); });
}
/** Admin sets a new password for someone else (never reveals the old one); all their sessions are revoked. */
export async function adminResetPassword(db: Db, a: Actor, id: number, newPassword: string, note: string): Promise<void> {
  await gate.require_(db, a, 'user.manage'); const u = await getUser(db, a, id); if (Number(u.id) === Number(a.id)) throw new Invalid('برای تغییر گذرواژه خودتان از «حساب من» استفاده کنید.'); note = ch.requireNote(note); V.password(newPassword, u.email);
  const hash = await hashPassword(newPassword);
  await db.tx(async t => { await t.exec('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', [hash, t.now(), id]); await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, { password: ['***', '*** (بازنشانی شد)'] }, note); await revokeSessions(t, id); });
}
export async function unlockUser(db: Db, a: Actor, id: number): Promise<void> {
  await gate.require_(db, a, 'user.manage'); const u = await getUser(db, a, id);
  if (!u.locked_until && !Number(u.failed_logins)) throw new Invalid('حساب قفل نیست.');
  await db.tx(async t => { await t.exec('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [id]); await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, { lock: ['قفل', 'باز'] }); });
}
/** Removing someone's second factor is a high-risk recovery action: group owner only, with a reason; they must enrol again at next login. */
export async function resetMfa(db: Db, a: Actor, id: number, note: string): Promise<void> {
  await gate.require_(db, a, 'user.manage'); if (!gate.isGroup(a)) throw new HttpError('بازنشانی MFA فقط برای مدیریت کل مجموعه مجاز است.', 403);
  const u = await getUser(db, a, id); if (!u.mfa_enabled) throw new Invalid('MFA برای این کاربر فعال نیست.'); if (Number(u.id) === Number(a.id)) throw new Invalid('برای خودتان از «حساب من» استفاده کنید.'); note = ch.requireNote(note);
  await db.tx(async t => { await t.exec('UPDATE users SET mfa_enabled = 0, totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', [id]); await t.exec('DELETE FROM mfa_recovery_codes WHERE user_id = ?', [id]);
    await ch.record(t, a, u.company_id === null ? null : Number(u.company_id), 'user', id, { mfa: ['فعال', 'بازنشانی‌شده'] }, note); await revokeSessions(t, id); });
}
void verifyPassword;
