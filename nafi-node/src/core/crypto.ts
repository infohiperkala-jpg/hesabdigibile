import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { env } from './env.js';

/** AES-256-GCM authenticated encryption. APP_KEY loss = encrypted data is unrecoverable: back it up. */
export const generateKey = (): string => randomBytes(32).toString('base64');
function key(): Buffer {
  const k = Buffer.from(env('APP_KEY') ?? '', 'base64');
  if (k.length !== 32) throw new Error('APP_KEY is missing or invalid (run the install script).');
  return k;
}
export function seal(plain: Buffer | string): Buffer {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}
export function open(sealed: Buffer): Buffer {
  try {
    const d = createDecipheriv('aes-256-gcm', key(), sealed.subarray(0, 12)); d.setAuthTag(sealed.subarray(12, 28));
    return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
  } catch { throw new Error('Decryption failed (wrong key or tampered data).'); }
}
export const sealText = (s: string): string => seal(s).toString('base64');
export const openText = (s: string): string => open(Buffer.from(s, 'base64')).toString('utf8');
/** Deterministic keyed hash for exact-match lookup of encrypted fields. */
export const blind = (v: string): string => createHmac('sha256', createHash('sha256').update('blind-index|').update(key()).digest()).update(v).digest('hex');
export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
export const safeEqual = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const hashPassword = (p: string): Promise<string> => argonHash(p);
export const verifyPassword = async (hash: string, p: string): Promise<boolean> => { try { return await argonVerify(hash, p); } catch { return false; } };
