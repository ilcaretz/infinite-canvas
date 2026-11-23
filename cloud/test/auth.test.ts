import { describe, expect, it } from 'vitest';
import { COOKIE, signSession } from '../src/auth';
import { call, loginAs, makeWorld } from './helpers';

describe('auth', () => {
  it('health is open; every other /api route is 401 without a cookie', async () => {
    const w = await makeWorld();
    expect((await call(w, 'GET', '/api/health')).status).toBe(200);
    expect((await call(w, 'GET', '/api/boards')).status).toBe(401);
    expect((await call(w, 'GET', '/api/me')).status).toBe(401);
    expect((await call(w, 'PUT', '/api/media')).status).toBe(401);
  });

  it('pages (static assets too) redirect to /login when logged out and are served after login', async () => {
    const w = await makeWorld();
    const r = await call(w, 'GET', '/board/abc');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/login?next=%2Fboard%2Fabc');
    expect((await call(w, 'GET', '/')).headers.get('location')).toBe('/login');
    const cookie = await loginAs(w);
    const page = await call(w, 'GET', '/assets/app.js', { cookie });
    expect(await page.text()).toBe('asset:/assets/app.js');
  });

  it('login page has username + password fields', async () => {
    const w = await makeWorld();
    const html = await (await call(w, 'GET', '/login')).text();
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it('per-user login works and /api/me names the user', async () => {
    const w = await makeWorld();
    for (const u of ['alice', 'bob']) {
      const cookie = await loginAs(w, u);
      expect(await (await call(w, 'GET', '/api/me', { cookie })).json()).toEqual({ user: u });
    }
  });

  it('login cookie is HttpOnly, Secure, SameSite=Lax, 90 days', async () => {
    const w = await makeWorld();
    const res = await call(w, 'POST', '/login', { body: { username: 'alice', password: 'pw-alice' } });
    const c = res.headers.get('set-cookie')!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toContain(`Max-Age=${90 * 24 * 3600}`);
  });

  it('form login redirects (303) to a same-origin next, and ignores an external one', async () => {
    const w = await makeWorld();
    const form = (next: string) => call(w, 'POST', '/login', { raw: new URLSearchParams({ username: 'Alice', password: 'pw-alice', next }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    const ok = await form('/board/1');
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/board/1');
    expect((await form('//evil.example')).headers.get('location')).toBe('/');
  });

  it('wrong password and wrong user are 401', async () => {
    const w = await makeWorld();
    expect((await call(w, 'POST', '/login', { body: { username: 'alice', password: 'nope' } })).status).toBe(401);
    expect((await call(w, 'POST', '/login', { body: { username: 'mallory', password: 'pw-alice' } })).status).toBe(401);
    expect((await call(w, 'POST', '/login', { body: { username: 'bob', password: 'pw-alice' } })).status).toBe(401);
    const r = await call(w, 'POST', '/login', { body: { password: 'pw-alice' } });
    expect(r.status).toBe(401);
    expect(r.headers.get('set-cookie')).toBeNull();
  });

  it('429 on the 6th failure for the same IP+user; a typo never locks the other user out', async () => {
    const w = await makeWorld();
    const bad = (u: string) => call(w, 'POST', '/login', { body: { username: u, password: 'x' }, headers: { 'cf-connecting-ip': '1.2.3.4' } });
    for (let i = 0; i < 5; i++) expect((await bad('alice')).status).toBe(401);
    const sixth = await bad('alice');
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    // even the right password is refused while locked
    expect((await call(w, 'POST', '/login', { body: { username: 'alice', password: 'pw-alice' }, headers: { 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(429);
    // other user, same IP: fine
    expect((await call(w, 'POST', '/login', { body: { username: 'bob', password: 'pw-bob' }, headers: { 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(200);
    // same user from another IP: fine
    expect((await call(w, 'POST', '/login', { body: { username: 'alice', password: 'pw-alice' }, headers: { 'cf-connecting-ip': '9.9.9.9' } })).status).toBe(200);
    const rows = w.raw.prepare('SELECT COUNT(*) c FROM login_attempts').get() as { c: number };
    expect(rows.c).toBe(5);
  });

  it('a successful login clears the failure counter', async () => {
    const w = await makeWorld();
    const h = { 'cf-connecting-ip': '5.5.5.5' };
    for (let i = 0; i < 4; i++) await call(w, 'POST', '/login', { body: { username: 'bob', password: 'x' }, headers: h });
    expect((await call(w, 'POST', '/login', { body: { username: 'bob', password: 'pw-bob' }, headers: h })).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await call(w, 'POST', '/login', { body: { username: 'bob', password: 'x' }, headers: h })).status).toBe(401);
  });

  it('tampered cookies are rejected', async () => {
    const w = await makeWorld();
    const cookie = await loginAs(w, 'bob');
    const token = cookie.slice(COOKIE.length + 1);
    const [v, user, exp, mac] = token.split('.');
    const forgedUser = Buffer.from('alice').toString('base64url');
    const forgedExp = String(Number(exp) + 1000);
    const flipped = mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A');
    for (const t of [`${v}.${forgedUser}.${exp}.${mac}`, `${v}.${user}.${forgedExp}.${mac}`, `${v}.${user}.${exp}.${flipped}`, 'garbage', `${token}x`]) {
      expect((await call(w, 'GET', '/api/me', { cookie: `${COOKIE}=${t}` })).status).toBe(401);
    }
    expect((await call(w, 'GET', '/api/me', { cookie })).status).toBe(200);
  });

  it('a cookie signed with another secret, an expired one, or one of a removed user is rejected', async () => {
    const w = await makeWorld();
    const other = await signSession('another-secret', 'alice');
    expect((await call(w, 'GET', '/api/me', { cookie: `${COOKIE}=${other}` })).status).toBe(401);
    const old = await signSession(w.env.SESSION_SECRET, 'alice', Date.now() - 91 * 24 * 3600 * 1000);
    expect((await call(w, 'GET', '/api/me', { cookie: `${COOKIE}=${old}` })).status).toBe(401);
    const ghost = await signSession(w.env.SESSION_SECRET, 'mallory');
    expect((await call(w, 'GET', '/api/me', { cookie: `${COOKIE}=${ghost}` })).status).toBe(401);
  });

  it('session is sliding: re-issued when older than a day, not before', async () => {
    const w = await makeWorld();
    const fresh = `${COOKIE}=${await signSession(w.env.SESSION_SECRET, 'alice')}`;
    expect((await call(w, 'GET', '/api/me', { cookie: fresh })).headers.get('set-cookie')).toBeNull();
    const aged = `${COOKIE}=${await signSession(w.env.SESSION_SECRET, 'alice', Date.now() - 2 * 24 * 3600 * 1000)}`;
    const res = await call(w, 'GET', '/api/me', { cookie: aged });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie')!;
    expect(set).toContain('Max-Age=' + 90 * 24 * 3600);
    const again = await call(w, 'GET', '/api/me', { cookie: set.split(';')[0] });
    expect(again.headers.get('set-cookie')).toBeNull();
  });

  it('logout clears the cookie', async () => {
    const w = await makeWorld();
    const res = await call(w, 'GET', '/logout');
    expect(res.status).toBe(303);
    expect(res.headers.get('set-cookie')).toMatch(/Max-Age=0/);
  });

  it('refuses to run unconfigured (fail closed)', async () => {
    const w = await makeWorld();
    w.env.USERS = '';
    expect((await call(w, 'GET', '/api/boards')).status).toBe(500);
    expect((await call(w, 'GET', '/api/health')).status).toBe(200);
  });
});
