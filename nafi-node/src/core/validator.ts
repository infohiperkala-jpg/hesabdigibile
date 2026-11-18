import { Invalid } from './errors.js';

const MAP: Record<string, string> = {};
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((c, i) => { MAP[c] = String(i); }); '٠١٢٣٤٥٦٧٨٩'.split('').forEach((c, i) => { MAP[c] = String(i); });
/** Persian/Arabic-Indic digits to ASCII. */
export const digits = (s: string): string => s.replace(/[۰-۹٠-٩]/g, c => MAP[c]);
export const fa = (s: string | number): string => String(s).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
export const money = (n: number | string): string => fa(Number(n).toLocaleString('en-US').replace(/,/g, '٬'));
/** Parse a user-typed amount into integer Rials; null if invalid. */
export const parseAmount = (s: string): number | null => { const t = digits(s).replace(/[\s,٬،]/g, ''); return /^\d{1,15}$/.test(t) ? Number(t) : null; };

/** Iranian national code structure + check digit (structure only: NOT proof of identity). */
export function nationalId(c: string): boolean {
  if (!/^\d{10}$/.test(c) || /^(\d)\1{9}$/.test(c)) return false;
  let s = 0; for (let i = 0; i < 9; i++) s += Number(c[i]) * (10 - i);
  const r = s % 11; return r < 2 ? Number(c[9]) === r : Number(c[9]) === 11 - r;
}
export const email = (e: string): boolean => e.length <= 190 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const mobile = (m: string): boolean => /^09\d{9}$/.test(m);
export function password(p: string, mail = ''): void {
  if ([...p].length < 10 || !/[A-Za-z]/.test(p) || !/\d/.test(p)) throw new Invalid('گذرواژه باید حداقل ۱۰ کاراکتر و شامل حرف و عدد باشد.');
  if (mail && p.toLowerCase() === mail.toLowerCase()) throw new Invalid('گذرواژه نباید با ایمیل یکسان باشد.');
}
