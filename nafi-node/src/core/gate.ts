import { Db } from './db.js';
import { Actor } from './audit.js';
import { HttpError } from './errors.js';

export async function can(db: Db, u: Actor, perm: string): Promise<boolean> {
  if (u.is_owner) return true;
  return (await db.val(`SELECT 1 FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id JOIN user_roles ur ON ur.role_id = rp.role_id WHERE ur.user_id = ? AND p.code = ? LIMIT 1`, [u.id, perm])) === 1;
}
export async function require_(db: Db, u: Actor, perm: string): Promise<void> {
  if (!(await can(db, u, perm))) throw new HttpError('دسترسی شما برای این عملیات مجاز نیست.', 403);
}

/** Company isolation. Group-level owners (company_id NULL + is_owner) see everything; everyone else only their company. */
export const isGroup = (u: Actor): boolean => !!u.is_owner && u.company_id === null;
export const scope = (u: Actor, col = 'company_id'): [string, any[]] => (isGroup(u) ? ['1=1', []] : [`${col} = ?`, [u.company_id]]);
export const canAccess = (u: Actor, companyId: number | null): boolean => isGroup(u) || (companyId !== null && u.company_id !== null && Number(u.company_id) === Number(companyId));
/** 404 (not 403) so the existence of other companies' records is not revealed. */
export function assertCompany(u: Actor, companyId: number | null): void { if (!canAccess(u, companyId)) throw new HttpError('مورد درخواستی یافت نشد.', 404); }
