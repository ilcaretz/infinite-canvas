import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export const COOKIE = 'board_session';
export const SESSION_DAYS = 30;
export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000;

/** Constant-time string compare (hashes first so the length does not leak). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

const keyFor = (password: string) => createHmac('sha256', password).update('board-session-v1').digest();

/** Signed session token `v1.<expiryMs>.<hmac>`; changing APP_PASSWORD invalidates every session. */
export function signSession(password: string, now = Date.now(), days = SESSION_DAYS): string {
  const exp = now + days * 24 * 3600 * 1000;
  const mac = createHmac('sha256', keyFor(password)).update(`v1.${exp}`).digest('base64url');
  return `v1.${exp}.${mac}`;
}

export function verifySession(password: string, token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const m = /^v1\.(\d{1,15})\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  if (!m) return false;
  if (Number(m[1]) <= now) return false;
  const mac = createHmac('sha256', keyFor(password)).update(`v1.${m[1]}`).digest('base64url');
  return safeEqual(mac, m[2]);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) {
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* skip a malformed value */
      }
    }
  }
  return out;
}

/** 10 failed attempts per 15 min per key (IP). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = MAX_ATTEMPTS, private windowMs = WINDOW_MS) {}

  private live(key: string, now: number) {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }

  /** Seconds until another attempt is allowed (0 = allowed now). */
  retryAfter(key: string, now = Date.now()): number {
    const arr = this.live(key, now);
    return arr.length >= this.max ? Math.ceil((arr[0] + this.windowMs - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()) {
    const arr = this.live(key, now);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 10000) for (const k of this.hits.keys()) this.live(k, now);
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loginPage(opts: { error?: string; next?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board - sign in</title>
<style>
html,body{height:100%;margin:0;background:#0f1013;color:#e6e6e6;font:15px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
body{display:flex;align-items:center;justify-content:center}
form{width:min(320px,86vw);display:flex;flex-direction:column;gap:12px}
h1{font-size:18px;font-weight:600;margin:0 0 4px;letter-spacing:.2px}
input,button{font:inherit;border-radius:8px;border:1px solid #2c2f36;padding:10px 12px;background:#17181d;color:inherit;outline:none}
input:focus{border-color:#5b8cff}
button{background:#5b8cff;border-color:#5b8cff;color:#fff;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.1)}
.err{color:#ff8a8a;min-height:1.2em;font-size:13px}
</style></head><body>
<form method="post" action="/login">
<h1>Board</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${esc(opts.next ?? '/')}">
<div class="err">${esc(opts.error ?? '')}</div>
<button type="submit">Sign in</button>
</form></body></html>`;
}

/** Same-origin path only (no open redirect). */
export function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && !/[\r\n]/.test(s) ? s : '/';
}

/** Registers the login routes + the guard hook. Returns false (and adds nothing) when `password` is empty. */
export function registerAuth(app: FastifyInstance, password: string, limiter = new RateLimiter()): boolean {
  if (!password) return false;
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const isHttps = (req: FastifyRequest) => req.protocol === 'https';
  const setCookie = (req: FastifyRequest, reply: FastifyReply, token: string, maxAgeS: number) => {
    reply.header('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${isHttps(req) ? '; Secure' : ''}`);
  };
  const authed = (req: FastifyRequest) => verifySession(password, parseCookies(req.headers.cookie)[COOKIE]);

  app.addHook('onRequest', async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p === '/login' || p === '/logout' || p === '/api/health') return;
    if (authed(req)) return;
    if (p.startsWith('/api/')) return reply.code(401).send({ error: 'login required' });
    return reply.code(302).header('cache-control', 'no-store').header('location', '/login' + (p !== '/' ? `?next=${encodeURIComponent(req.url)}` : '')).send();
  });

  app.get('/login', async (req, reply) => {
    if (authed(req)) return reply.redirect(safeNext((req.query as { next?: string }).next));
    return reply.type('text/html').header('cache-control', 'no-store').send(loginPage({ next: safeNext((req.query as { next?: string }).next) }));
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown; next?: unknown };
    const wantsJson = String(req.headers.accept ?? '').includes('application/json') || String(req.headers['content-type'] ?? '').includes('json');
    const fail = (code: number, error: string, retry?: number) => {
      if (retry) reply.header('retry-after', retry);
      return wantsJson ? reply.code(code).send({ error }) : reply.code(code).type('text/html').header('cache-control', 'no-store').send(loginPage({ error, next: safeNext(body.next) }));
    };
    const wait = limiter.retryAfter(req.ip);
    if (wait) return fail(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`, wait);
    if (typeof body.password !== 'string' || !safeEqual(body.password, password)) {
      limiter.fail(req.ip);
      return fail(401, 'Wrong password.');
    }
    limiter.clear(req.ip);
    setCookie(req, reply, signSession(password), SESSION_DAYS * 24 * 3600);
    return wantsJson ? reply.send({ ok: true }) : reply.code(303).header('location', safeNext(body.next)).send();
  });

  const logout = async (req: FastifyRequest, reply: FastifyReply) => {
    setCookie(req, reply, '', 0);
    return reply.code(303).header('location', '/login').send();
  };
  app.post('/logout', logout);
  app.get('/logout', logout);
  return true;
}
