import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Database-level guarantees (defence in depth): finalised vouchers and saved contract versions cannot be edited even with raw SQL. */
const TRIGGERS: string[] = [
  ['items_u', 'BEFORE UPDATE ON voucher_items', "(SELECT status FROM vouchers WHERE id = OLD.voucher_id) = 'final'", 'final voucher is immutable'],
  ['items_d', 'BEFORE DELETE ON voucher_items', "(SELECT status FROM vouchers WHERE id = OLD.voucher_id) = 'final'", 'final voucher is immutable'],
  ['items_i', 'BEFORE INSERT ON voucher_items', "(SELECT status FROM vouchers WHERE id = NEW.voucher_id) = 'final'", 'final voucher is immutable'],
  ['vouch_u', 'BEFORE UPDATE ON vouchers', "OLD.status = 'final'", 'final voucher is immutable'],
  ['vouch_d', 'BEFORE DELETE ON vouchers', "OLD.status = 'final'", 'final voucher is immutable'],
  ['cv_u', 'BEFORE UPDATE ON contract_versions', '1 = 1', 'contract version is immutable'],
  ['cv_d', 'BEFORE DELETE ON contract_versions', '1 = 1', 'contract version is immutable'],
].map(([n, on, when, msg]) => `CREATE TRIGGER trg_${n} ${on} FOR EACH ROW BEGIN IF ${when} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '${msg}'; END IF; END`);

/** Single-row head of the audit hash chain: its row lock serialises writers until their transaction commits. */
const EXTRA_DDL = [
  'CREATE TABLE audit_head (id TINYINT NOT NULL PRIMARY KEY, last_hash CHAR(64) NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
  `INSERT INTO audit_head (id, last_hash) VALUES (1, '${'0'.repeat(64)}')`,
];

export async function migrate(db: Db): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS node_migrations (name VARCHAR(190) NOT NULL PRIMARY KEY, ran_at DATETIME NOT NULL) ENGINE=InnoDB');
  const done = new Set((await db.all<{ name: string }>('SELECT name FROM node_migrations')).map(r => r.name));
  const ran: string[] = [];
  const steps: [string, () => Promise<void>][] = [
    ['001_baseline', async () => {
      const sql = readFileSync(join(dir, '001_baseline.sql'), 'utf8');
      // mysqldump orders tables alphabetically, so load with FK checks off (on ONE connection: it is a session setting)
      const c = await db.pool.getConnection();
      try { await c.query('SET FOREIGN_KEY_CHECKS = 0'); for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await c.query(stmt); await c.query('SET FOREIGN_KEY_CHECKS = 1'); }
      finally { c.release(); }
    }],
    ['002_guards', async () => { for (const s of EXTRA_DDL) await db.exec(s); for (const t of TRIGGERS) await db.exec(t); }],
    ['003_sessions', async () => {   // server-side sessions: the cookie holds a random token, the table holds only its SHA-256
      await db.exec(`CREATE TABLE sessions (id CHAR(64) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NULL, mfa_user_id BIGINT UNSIGNED NULL, csrf CHAR(64) NOT NULL, flash TEXT NULL,
        created_at DATETIME NOT NULL, seen_at DATETIME NOT NULL, KEY ix_sessions_user (user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }],
    ['004_editing', async () => {   // optimistic-concurrency timestamps + field-level change history for every editable entity
      for (const t of ['brands', 'users', 'accounts', 'credit_plans']) await db.exec(`ALTER TABLE ${t} ADD COLUMN updated_at DATETIME NULL`);
      await db.exec(`CREATE TABLE change_log (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id BIGINT UNSIGNED NULL, entity VARCHAR(40) NOT NULL, entity_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NULL, changes TEXT NOT NULL, note VARCHAR(500) NULL, created_at DATETIME NOT NULL, KEY ix_change_entity (entity, entity_id), KEY ix_change_company (company_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }],
    ['005_treasury', async () => {
      await db.exec(`CREATE TABLE bank_accounts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id BIGINT UNSIGNED NOT NULL,
        title VARCHAR(120) NOT NULL,
        bank_name VARCHAR(120) NOT NULL,
        account_number VARCHAR(40) NOT NULL,
        iban VARCHAR(34) NULL,
        opening_balance BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(10) NOT NULL DEFAULT 'active',
        created_by BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY ux_bank_account_no (company_id, account_number),
        KEY ix_bank_accounts_company (company_id),
        CONSTRAINT fk_bank_accounts_company FOREIGN KEY (company_id) REFERENCES companies(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await db.exec(`CREATE TABLE treasury_transactions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        company_id BIGINT UNSIGNED NOT NULL,
        kind VARCHAR(12) NOT NULL,
        from_account_id BIGINT UNSIGNED NULL,
        to_account_id BIGINT UNSIGNED NULL,
        amount BIGINT NOT NULL,
        reference VARCHAR(80) NULL,
        description VARCHAR(300) NOT NULL,
        transacted_on DATE NOT NULL,
        created_by BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY ux_treasury_reference (company_id, reference),
        KEY ix_treasury_company_date (company_id, transacted_on),
        KEY ix_treasury_from (from_account_id),
        KEY ix_treasury_to (to_account_id),
        CONSTRAINT fk_treasury_company FOREIGN KEY (company_id) REFERENCES companies(id),
        CONSTRAINT fk_treasury_from FOREIGN KEY (from_account_id) REFERENCES bank_accounts(id),
        CONSTRAINT fk_treasury_to FOREIGN KEY (to_account_id) REFERENCES bank_accounts(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    }],
  ];
  for (const [name, run] of steps) {
    if (done.has(name)) continue;
    await run(); await db.exec('INSERT INTO node_migrations (name, ran_at) VALUES (?, ?)', [name, db.now()]); ran.push(name);
  }
  return ran;
}
