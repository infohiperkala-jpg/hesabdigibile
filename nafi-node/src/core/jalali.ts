import { digits, fa } from './validator.js';

export function fromGregorian(gy: number, gm: number, gd: number): [number, number, number] {
  const g = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334], gy2 = gm > 2 ? gy + 1 : gy;
  let days = 355666 + 365 * gy + Math.floor((gy2 + 3) / 4) - Math.floor((gy2 + 99) / 100) + Math.floor((gy2 + 399) / 400) + gd + g[gm - 1];
  let jy = -1595 + 33 * Math.floor(days / 12053); days %= 12053;
  jy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { jy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = days < 186 ? 1 + days % 31 : 1 + (days - 186) % 30;
  return [jy, jm, jd];
}
export function toGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097); days %= 146097;
  if (days > 36524) { days--; gy += 100 * Math.floor(days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461); days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const m = [0, 31, (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0; for (; gm < 13 && gd > m[gm]; gm++) gd -= m[gm];
  return [gy, gm, gd];
}
const iso = (y: number, m: number, d: number) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
/** Parse a Jalali date typed as YYYY/MM/DD into Gregorian "Y-m-d"; null if invalid (round-trip rejects 30 Esfand in a non-leap year). */
export function parse(s: string): string | null {
  const m = digits(s.trim()).match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/); if (!m) return null;
  const [jy, jm, jd] = [+m[1], +m[2], +m[3]]; if (jm < 1 || jm > 12 || jd < 1 || jd > 31) return null;
  const [gy, gm, gd] = toGregorian(jy, jm, jd), b = fromGregorian(gy, gm, gd);
  return b[0] === jy && b[1] === jm && b[2] === jd ? iso(gy, gm, gd) : null;
}
/** Format a UTC "Y-m-d[ H:i:s]" string as Persian-digit Jalali date (and HH:MM). */
export function format(utc: string | null | undefined, time = true): string {
  if (!utc) return '—';
  const d = new Date(utc.replace(' ', 'T') + (utc.length > 10 ? '' : 'T00:00:00') + 'Z');
  const [y, m, dd] = fromGregorian(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  return fa(`${String(y).padStart(4, '0')}/${String(m).padStart(2, '0')}/${String(dd).padStart(2, '0')}` + (time ? ` ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` : ''));
}
/** Add Jalali months to a Gregorian "Y-m-d", clamping the day (31 Shahrivar + 1 month = 30 Mehr). */
export function addMonths(isoDate: string, n: number): string {
  const [gy, gm, gd] = isoDate.split('-').map(Number); let [jy, jm, jd] = fromGregorian(gy, gm, gd);
  const idx = jy * 12 + (jm - 1) + n; jy = Math.floor(idx / 12); jm = (idx % 12) + 1;
  while (jd > 29 && parse(`${jy}/${jm}/${jd}`) === null) jd--;
  return parse(`${jy}/${jm}/${jd}`)!;
}
/** Add working days, skipping Thursday and Friday. Official public holidays are NOT included. */
export function addWorkingDays(isoDate: string, n: number): string {
  let t = new Date(isoDate + 'T00:00:00Z').getTime();
  while (n > 0) { t += 86400000; const w = new Date(t).getUTCDay(); if (w !== 4 && w !== 5) n--; }
  return new Date(t).toISOString().slice(0, 10);
}
