import { appendFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb } from '../core/db.js';
import { migrate } from '../core/migrate.js';
import { generateKey, hashPassword } from '../core/crypto.js';
import { seed } from '../services/seeder.js';
import * as audit from '../core/audit.js';

// Usage: npm run install-app -- --email=owner@example.com [--name="نام مالک"]
const arg = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
if (!process.env.APP_KEY) {
  const k = generateKey(); appendFileSync('.env', `${existsSync('.env') ? '\n' : ''}APP_KEY=${k}\n`); process.env.APP_KEY = k;
  console.log('APP_KEY generated and saved to .env - BACK IT UP: without it encrypted documents cannot be read.');
}
const db = openDb();
const ran = await migrate(db); console.log(ran.length ? `Migrations: ${ran.join(', ')}` : 'Migrations: up to date');
await seed(db);
if (Number(await db.val('SELECT COUNT(*) FROM users WHERE is_owner = 1')) === 0) {
  const email = (arg('email') ?? 'owner@nafi.local').toLowerCase(), pass = randomBytes(12).toString('base64').replace(/[+/=]/g, 'A') + '9x';   // random, shown once
  const id = await db.insert('INSERT INTO users (company_id,name,email,password_hash,is_owner,created_at) VALUES (NULL,?,?,?,1,?)', [arg('name') ?? 'مالک مجموعه', email, await hashPassword(pass), db.now()]);
  await audit.log(db, null, 'user.create', 'user', id, { owner: true }, null, 'cli');
  console.log(`Owner created.\n  email:    ${email}\n  password: ${pass}\n  (shown once - change it and store it safely)`);
} else console.log('Owner already exists.');
await db.close();
