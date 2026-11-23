import type { Env } from './env';

export const COOKIE = 'board_session';
export const SESSION_DAYS = 90;
export const REFRESH_AFTER_MS = 24 * 3600 * 1000;
export const MAX_FAILS = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_ITERATIONS = 50000;

const enc = new TextEncoder();

// ---- base64 ---------------------------------------------------------------------------------
export function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64u = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Constant-time byte compare. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  let d = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return d === 0;
}

/** Constant-time string compare (hashes first so the length does not leak). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  return bytesEqual(new Uint8Array(ha), new Uint8Array(hb));
}

// ---- users (secret USERS = name:pbkdf2$iterations$saltB64$hashB64,...) --------------------------
export interface UserEntry { name: string; iterations: number; salt: Uint8Array; hash: Uint8Array }

export function parseUsers(raw: string | undefined): Map<string, UserEntry> {
  const out = new Map<string, UserEntry>();
  for (const part of (raw ?? '').split(',')) {
    const p = part.trim();
    const i = p.indexOf(':');
    if (i < 1) continue;
    const name = p.slice(0, i).trim().toLowerCase();
    const f = p.slice(i + 1).split('$');
    if (f.length !== 4 || f[0] !== 'pbkdf2') continue;
    const iterations = Number(f[1]);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100000) continue;
    try {
      out.set(name, { name, iterations, salt: unb64(f[2]), hash: unb64(f[3]) });
    } catch {
      /* skip a malformed entry */
    }
  }
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** Entry text for the USERS secret (same format scripts/hash-password.mjs prints). */
export async function hashPassword(name: string, password: string, iterations = DEFAULT_ITERATIONS, salt = crypto.getRandomValues(new Uint8Array(16))): Promise<string> {
  return `${name}:pbkdf2$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

const DUMMY: UserEntry = { name: '', iterations: DEFAULT_ITERATIONS, salt: new Uint8Array(16), hash: new Uint8Array(32) };

/** True only for a known user with the right password. An unknown user still pays one PBKDF2 (no user enumeration by timing). */
export async function verifyLogin(users: Map<string, UserEntry>, name: string, password: string): Promise<boolean> {
  const u = users.get(name);
  const got = await pbkdf2(password, (u ?? DUMMY).salt, (u ?? DUMMY).iterations);
  return !!u && bytesEqual(got, u.hash);
}

// ---- session cookie: v2.<b64url(user)>.<expMs>.<hmac> ---------------------------------------
const keyCache = new Map<string, CryptoKey>();
async function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(secret, k);
  }
  return k;
}
async function mac(secret: string, payload: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`board-session-v2|${payload}`))));
}

export async function signSession(secret: string, user: string, now = Date.now(), days = SESSION_DAYS): Promise<string> {
  const payload = `v2.${b64u(enc.encode(user))}.${now + days * 24 * 3600 * 1000}`;
  return `${payload}.${await mac(secret, payload)}`;
}

/** Returns the user name when the token is genuine, unexpired and the user still exists in USERS; `issuedAt` drives the sliding refresh. */
export async function verifySession(
  secret: string, users: Map<string, UserEntry>, token: string | undefined, now = Date.now(),
): Promise<{ user: string; issuedAt: number } | null> {
  if (!token || !secret) return null;
  const m = /^v2\.([A-Za-z0-9_-]{1,100})\.(\d{1,15})\.([A-Za-z0-9_-]{20,64})$/.exec(token);
  if (!m) return null;
  const exp = Number(m[2]);
  if (exp <= now) return null;
  if (!(await safeEqual(await mac(secret, `v2.${m[1]}.${m[2]}`), m[3]))) return null;
  let user: string;
  try {
    user = new TextDecoder().decode(unb64(m[1]));
  } catch {
    return null;
  }
  if (!users.has(user)) return null;
  return { user, issuedAt: exp - SESSION_DAYS * 24 * 3600 * 1000 };
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
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

export function cookieHeader(token: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

// ---- login rate limit (D1 table login_attempts, per IP + username) ----------------------------
export const attemptKey = (ip: string, user: string) => `${ip}|${user.slice(0, 64)}`;

/** Seconds until another attempt is allowed (0 = allowed now). */
export async function retryAfter(env: Env, key: string, now = Date.now()): Promise<number> {
  const rows = (await env.DB.prepare('SELECT at FROM login_attempts WHERE key=? AND at>? ORDER BY at').bind(key, now - WINDOW_MS).all<{ at: number }>()).results;
  return rows.length >= MAX_FAILS ? Math.max(1, Math.ceil((rows[0].at + WINDOW_MS - now) / 1000)) : 0;
}
export async function recordFail(env: Env, key: string, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO login_attempts (key,at) VALUES (?,?)').bind(key, now),
    env.DB.prepare('DELETE FROM login_attempts WHERE at<?').bind(now - WINDOW_MS),
  ]);
}
export async function clearFails(env: Env, key: string) {
  await env.DB.prepare('DELETE FROM login_attempts WHERE key=?').bind(key).run();
}

// ---- pages ----------------------------------------------------------------------------------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loginPage(opts: { error?: string; next?: string; user?: string } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board - sign in</title>
<style>
html,body{height:100%;margin:0;background:#0f1013;color:#e6e6e6;font:18px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
body{display:flex;align-items:center;justify-content:center}
form{width:min(380px,90vw);display:flex;flex-direction:column;gap:14px}
h1{font-size:24px;font-weight:600;margin:0 0 6px}
input,button{font:inherit;font-size:18px;border-radius:12px;border:1px solid #2c2f36;padding:16px 16px;background:#17181d;color:inherit;outline:none;width:100%;box-sizing:border-box}
input:focus{border-color:#5b8cff}
button{background:#5b8cff;border-color:#5b8cff;color:#fff;font-weight:600;cursor:pointer}
.err{color:#ff8a8a;min-height:1.3em;font-size:15px}
</style></head><body>
<form method="post" action="/login">
<h1>Board</h1>
<input type="text" name="username" placeholder="Name" value="${esc(opts.user ?? '')}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" ${opts.user ? '' : 'autofocus'} required>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" ${opts.user ? 'autofocus' : ''} required>
<input type="hidden" name="next" value="${esc(opts.next ?? '/')}">
<div class="err">${esc(opts.error ?? '')}</div>
<button type="submit">Sign in</button>
</form></body></html>`;
}

/** Same-origin path only (no open redirect). */
export function safeNext(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\') && !/[\r\n]/.test(s) && !s.startsWith('/login') ? s : '/';
}
