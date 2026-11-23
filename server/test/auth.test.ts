import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { parseCookies, RateLimiter, safeEqual, safeNext, signSession, verifySession } from '../src/auth.js';
import { loadConfig, parseTrustProxy } from '../src/config.js';
import { FFMPEG, FFPROBE } from './samples.js';

let ctx: App;
let tmp = '';
const PW = 'correct horse battery';

const login = (password: string, ip = '10.0.0.1', extra: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/login', remoteAddress: ip, headers: { 'content-type': 'application/json', ...extra }, payload: { password } });
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers['set-cookie']).split(';')[0];

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-auth-'));
  const cfg = loadConfig({ dataDir: path.join(tmp, 'data'), ffmpeg: FFMPEG, ffprobe: FFPROBE, webDist: path.join(tmp, 'none'), appPassword: PW, trustProxy: true });
  ctx = await buildApp(cfg);
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('auth (APP_PASSWORD set)', () => {
  it('health and the login page are open; the rest is behind the login', async () => {
    expect((await ctx.app.inject({ url: '/api/health' })).statusCode).toBe(200);
    const page = await ctx.app.inject({ url: '/login' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('type="password"');
  });

  it('protected API routes answer 401 JSON; pages redirect to /login', async () => {
    for (const [method, url] of [['GET', '/api/boards'], ['GET', '/api/config'], ['POST', '/api/boards'], ['PUT', '/api/media'], ['POST', '/api/uploads/init'], ['GET', '/api/media/x/original']] as const) {
      const r = await ctx.app.inject({ method, url });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    const p = await ctx.app.inject({ url: '/board/abc?x=1' });
    expect(p.statusCode).toBe(302);
    expect(String(p.headers.location)).toBe('/login?next=' + encodeURIComponent('/board/abc?x=1'));
    expect(String((await ctx.app.inject({ url: '/' })).headers.location)).toBe('/login');
  });

  it('wrong password: 401, no cookie', async () => {
    const r = await login('nope');
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('right password: signed httpOnly SameSite=Lax cookie (30 days); it opens the API; Secure only behind https', async () => {
    const r = await login(PW);
    expect(r.statusCode).toBe(200);
    const raw = String(r.headers['set-cookie']);
    expect(raw).toMatch(/^board_session=v1\./);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');
    expect(raw).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(raw).not.toContain('Secure');
    const ok = await ctx.app.inject({ url: '/api/boards', headers: { cookie: cookieOf(r) } });
    expect(ok.statusCode).toBe(200);
    const https = await login(PW, '10.0.0.2', { 'x-forwarded-proto': 'https' });
    expect(String(https.headers['set-cookie'])).toContain('; Secure');
  });

  it('form post redirects (303) to a same-origin next; an external next is ignored', async () => {
    const f = (next: string) =>
      ctx.app.inject({ method: 'POST', url: '/login', remoteAddress: '10.0.0.3', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: `password=${encodeURIComponent(PW)}&next=${encodeURIComponent(next)}` });
    const a = await f('/board/1');
    expect(a.statusCode).toBe(303);
    expect(a.headers.location).toBe('/board/1');
    expect((await f('https://evil.example/')).headers.location).toBe('/');
    expect((await f('//evil.example/')).headers.location).toBe('/');
    const bad = await ctx.app.inject({ method: 'POST', url: '/login', remoteAddress: '10.0.0.3', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=x' });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain('Wrong password');
  });

  it('a tampered, expired or foreign-password token is rejected', async () => {
    const good = cookieOf(await login(PW, '10.0.0.4'));
    const tampered = good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await ctx.app.inject({ url: '/api/boards', headers: { cookie: tampered } })).statusCode).toBe(401);
    const expired = 'board_session=' + signSession(PW, Date.now() - 31 * 24 * 3600 * 1000);
    expect((await ctx.app.inject({ url: '/api/boards', headers: { cookie: expired } })).statusCode).toBe(401);
    const foreign = 'board_session=' + signSession('another password');
    expect((await ctx.app.inject({ url: '/api/boards', headers: { cookie: foreign } })).statusCode).toBe(401);
  });

  it('rate limit: 10 failed attempts per IP, then 429 with Retry-After even for the right password; other IPs unaffected', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 10; i++) expect((await login('bad' + i, ip)).statusCode).toBe(401);
    const blocked = await login(PW, ip);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await login(PW, '10.9.9.10')).statusCode).toBe(200);
  });

  it('the client IP comes from X-Forwarded-For when TRUST_PROXY is on', async () => {
    for (let i = 0; i < 10; i++) await login('bad', '10.7.7.7', { 'x-forwarded-for': '203.0.113.5' });
    expect((await login(PW, '10.7.7.7', { 'x-forwarded-for': '203.0.113.5' })).statusCode).toBe(429);
    expect((await login(PW, '10.7.7.7', { 'x-forwarded-for': '203.0.113.6' })).statusCode).toBe(200);
  });

  it('logout clears the cookie', async () => {
    const r = await ctx.app.inject({ method: 'POST', url: '/logout' });
    expect(r.statusCode).toBe(303);
    expect(String(r.headers['set-cookie'])).toContain('Max-Age=0');
  });
});

describe('auth off (default)', () => {
  it('no password configured: everything is open and /login does not exist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-noauth-'));
    const open = await buildApp(loadConfig({ dataDir: path.join(dir, 'data'), ffmpeg: FFMPEG, ffprobe: FFPROBE, webDist: path.join(dir, 'none'), appPassword: '' }));
    try {
      expect((await open.app.inject({ url: '/api/boards' })).statusCode).toBe(200);
      expect((await open.app.inject({ url: '/login' })).statusCode).toBe(404);
      expect(((await open.app.inject({ url: '/api/config' })).json() as { authRequired: boolean }).authRequired).toBe(false);
    } finally {
      await open.app.close();
      open.repo.db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe('auth helpers', () => {
  it('safeEqual', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
  it('session token round trip and expiry', () => {
    const t = signSession('p', 1000);
    expect(verifySession('p', t, 2000)).toBe(true);
    expect(verifySession('q', t, 2000)).toBe(false);
    expect(verifySession('p', t, 1000 + 31 * 24 * 3600 * 1000)).toBe(false);
    expect(verifySession('p', undefined)).toBe(false);
    expect(verifySession('p', 'v1.9999999999999.xxxx')).toBe(false);
  });
  it('RateLimiter window slides', () => {
    const rl = new RateLimiter(3, 1000);
    for (let i = 0; i < 3; i++) rl.fail('a', 0);
    expect(rl.retryAfter('a', 500)).toBe(1);
    expect(rl.retryAfter('a', 1001)).toBe(0);
    expect(rl.retryAfter('b', 0)).toBe(0);
  });
  it('parseCookies / safeNext / parseTrustProxy', () => {
    expect(parseCookies('a=1; board_session=v1.2.3; x=%20y')).toEqual({ a: '1', board_session: 'v1.2.3', x: ' y' });
    expect(safeNext('/a?b=1')).toBe('/a?b=1');
    expect(safeNext('http://x')).toBe('/');
    expect(safeNext('/\\evil')).toBe('/');
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});
