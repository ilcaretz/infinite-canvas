import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/app';
import { hashPassword } from '../src/auth';
import type { Env } from '../src/env';

const SCHEMA = readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8');

/** D1 look-alike over a real SQLite (node:sqlite): the actual schema.sql and real SQL semantics. */
class FakeStmt {
  constructor(private db: DatabaseSync, readonly sql: string, private args: unknown[] = []) {}
  bind(...a: unknown[]) {
    if (a.some((v) => v === undefined)) throw new Error('D1_TYPE_ERROR: undefined bind');
    if (a.length > 100) throw new Error('D1_ERROR: too many bound parameters');
    return new FakeStmt(this.db, this.sql, a);
  }
  async first() {
    return ((this.db.prepare(this.sql).get(...(this.args as never[])) as unknown) ?? null) as never;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as unknown[], success: true, meta: {} };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...(this.args as never[]));
    return { success: true, results: [], meta: { changes: Number(r.changes) } };
  }
  isRead() {
    return /^\s*select/i.test(this.sql);
  }
}

export function fakeD1(): { d1: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec(SCHEMA);
  const d1 = {
    prepare: (sql: string) => new FakeStmt(raw, sql),
    async batch(stmts: FakeStmt[]) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) out.push(s.isRead() ? await s.all() : await s.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { d1: d1 as unknown as D1Database, raw };
}

export function fakeR2() {
  const store = new Map<string, Uint8Array>();
  const toBytes = async (v: unknown): Promise<Uint8Array> => {
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof ReadableStream) return new Uint8Array(await new Response(v).arrayBuffer());
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v as Uint8Array;
  };
  const bucket = {
    async head(key: string) {
      const b = store.get(key);
      return b ? { key, size: b.length } : null;
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const b = store.get(key);
      if (!b) return null;
      const s = opts?.range ? b.slice(opts.range.offset, opts.range.offset + opts.range.length) : b;
      return { size: s.length, arrayBuffer: async () => s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength) };
    },
    async put(key: string, v: unknown) {
      store.set(key, await toBytes(v));
      return { key };
    },
    async delete(k: string | string[]) {
      for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
    },
  };
  return { bucket: bucket as unknown as R2Bucket, store };
}

export const S3_HOST = 'acct.r2.cloudflarestorage.com';

export interface World {
  env: Env;
  raw: DatabaseSync;
  r2: Map<string, Uint8Array>;
  /** answers for hosts other than the S3 endpoint (from-url tests) */
  external: Map<string, (req: Request) => Response | Promise<Response>>;
  s3Calls: string[];
  /** parts the fake S3 reports for ListParts */
  s3Parts: Array<{ n: number; size: number; etag: string }>;
}

export async function makeWorld(): Promise<World> {
  const { d1, raw } = fakeD1();
  const { bucket, store } = fakeR2();
  const world = { external: new Map(), s3Calls: [], s3Parts: [] } as unknown as World;
  const testFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const u = new URL(req.url);
    if (u.host === S3_HOST) {
      world.s3Calls.push(`${req.method} ${u.search}`);
      if (req.method === 'POST' && u.searchParams.has('uploads')) return new Response('<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>');
      if (req.method === 'GET' && u.searchParams.has('uploadId')) {
        const parts = world.s3Parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag><Size>${p.size}</Size></Part>`).join('');
        return new Response(`<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
      }
      if (req.method === 'POST' && u.searchParams.has('uploadId')) return new Response('<CompleteMultipartUploadResult><ETag>"x"</ETag></CompleteMultipartUploadResult>');
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response('?', { status: 400 });
    }
    const h = world.external.get(u.host);
    if (!h) throw new Error(`unexpected network call to ${u.host}`);
    return h(req);
  };
  const users = [await hashPassword('alice', 'pw-alice', 1000), await hashPassword('bob', 'pw-bob', 1000)].join(',');
  world.env = {
    DB: d1, BUCKET: bucket, USERS: users, SESSION_SECRET: 'test-session-secret-value', S3_BUCKET: 'bkt', S3_REGION: 'auto',
    S3_ENDPOINT: `https://${S3_HOST}`, S3_ACCESS_KEY_ID: 'AKIATESTKEY', S3_SECRET_ACCESS_KEY: 'test-secret-key', PRESIGN_TTL_S: '3600', MAX_FILE_GB: '5',
    ASSETS: { fetch: async (r: Request) => new Response(`asset:${new URL(r.url).pathname}`) } as unknown as Fetcher,
    TEST_FETCH: testFetch as typeof fetch,
  };
  world.raw = raw;
  world.r2 = store;
  return world;
}

export interface CallOpts { body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: string }

export async function call(w: World, method: string, path: string, o: CallOpts = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie) headers.cookie = o.cookie;
  let body: string | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['content-type'] = 'application/json';
  }
  return handle(new Request('https://board.test' + path, { method, headers, body, redirect: 'manual' }), w.env);
}

/** Cookie header value for a logged-in user. */
export async function loginAs(w: World, user = 'alice', pw = `pw-${user}`): Promise<string> {
  const res = await call(w, 'POST', '/login', { body: { username: user, password: pw } });
  if (res.status !== 200) throw new Error(`login failed ${res.status}`);
  return res.headers.get('set-cookie')!.split(';')[0];
}
