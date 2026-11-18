import { createHmac, randomBytes } from 'node:crypto';
import { digits } from './validator.js';

/** RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits): compatible with Google/Microsoft Authenticator, Aegis. */
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(b: Buffer): string {
  let bits = ''; for (const x of b) bits += x.toString(2).padStart(8, '0');
  let o = ''; for (let i = 0; i < bits.length; i += 5) o += ALPHA[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return o;
}
export function base32Decode(s: string): Buffer {
  let bits = ''; for (const c of s.toUpperCase().replace(/[\s=-]/g, '')) { const p = ALPHA.indexOf(c); if (p < 0) return Buffer.alloc(0); bits += p.toString(2).padStart(5, '0'); }
  const out: number[] = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export const newSecret = (): string => base32Encode(randomBytes(20));
export function code(secret: Buffer, step: number): string {
  const ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(ctr).digest(), o = h[19] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
/** @returns matched time step (must be > lastStep: replay protection), tolerating +-1 step of clock drift */
export function verify(secretB32: string, c: string, nowSec: number, lastStep = 0): number | null {
  c = digits(c.trim()); if (!/^\d{6}$/.test(c)) return null;
  const bin = base32Decode(secretB32); if (!bin.length) return null;
  const base = Math.floor(nowSec / 30); let hit: number | null = null;
  for (let o = -1; o <= 1; o++) { const st = base + o; if (code(bin, st) === c && st > lastStep) hit = st; }
  return hit;
}
export const uri = (account: string, secret: string, issuer = 'NegarAzinFadak'): string =>
  `otpauth://totp/${encodeURIComponent(issuer + ':' + account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
