import mysql, { Pool, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { env } from './env.js';

export type Row = Record<string, any>;

export function createPool(database?: string): Pool {
  return mysql.createPool({
    host: env('DB_HOST', '127.0.0.1'), port: Number(env('DB_PORT', '3306')), user: env('DB_USER', 'nafi'), password: env('DB_PASS', ''),
    database: database ?? env('DB_NAME', 'nafi'), charset: 'utf8mb4', connectionLimit: 10, dateStrings: true, supportBigNumbers: true, bigNumberStrings: false, multipleStatements: false,
  });
}

/** Thin query helper. A Db bound to a connection is a transaction scope: nested tx() calls join it (like the PHP version). */
export class Db {
  constructor(public readonly pool: Pool, private readonly conn?: PoolConnection) {}
  private get ex() { return (this.conn ?? this.pool) as Pool; }
  get inTx() { return !!this.conn; }
  now(): string { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
  async all<T = Row>(sql: string, p: any[] = []): Promise<T[]> { const [r] = await this.ex.query(sql, p); return r as T[]; }
  async one<T = Row>(sql: string, p: any[] = []): Promise<T | null> { const r = await this.all<T>(sql, p); return r[0] ?? null; }
  async val(sql: string, p: any[] = []): Promise<any> { const r = await this.one(sql, p); return r ? Object.values(r)[0] : null; }
  async exec(sql: string, p: any[] = []): Promise<number> { const [r] = await this.ex.query(sql, p); return (r as ResultSetHeader).affectedRows ?? 0; }
  async insert(sql: string, p: any[] = []): Promise<number> { const [r] = await this.ex.query(sql, p); return Number((r as ResultSetHeader).insertId); }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    if (this.conn) return fn(this);
    const c = await this.pool.getConnection();
    try { await c.beginTransaction(); const r = await fn(new Db(this.pool, c)); await c.commit(); return r; }
    catch (e) { await c.rollback(); throw e; }
    finally { c.release(); }
  }
  async close() { await this.pool.end(); }
}

export const openDb = (database?: string) => new Db(createPool(database));
