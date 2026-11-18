import { Db, Row } from '../core/db.js';
import { Actor } from '../core/audit.js';
import { Raw } from './view.js';
export interface UploadedFile { field: string; filename: string; type: string; data: Buffer }
export interface Req { method: string; path: string; query: URLSearchParams; form: URLSearchParams; ip: string; secure: boolean; files?: UploadedFile[] }
export interface Out { status: number; body: string; binary?: Buffer; headers?: Record<string, string> }
export interface Ctx {
  db: Db; A: Actor; u: Row; rq: Req; csrf: Raw;
  f: (k: string) => string;
  render: (title: string, body: Raw) => Promise<Out>;
  done: (to: string, fn: () => Promise<unknown>, okMsg: string) => Promise<Out>;
  redirect: (to: string) => Out;
  flashErr: (msg: string) => Promise<void>;
  flashOk: (msg: string) => Promise<void>;
}
