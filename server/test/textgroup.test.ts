import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrate } from '../src/db.js';
import { FFMPEG, FFPROBE } from './samples.js';

let ctx: App;
let dataDir = '';
let boardId = '';

const inj = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, payload: payload as never });
const base = { x: 10, y: 20, w: 300, h: 40, z: 1, mediaId: null, version: 1, updatedAt: 1000 };

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board textgroup '));
  ctx = await buildApp(loadConfig({ dataDir, ffmpeg: FFMPEG, ffprobe: FFPROBE, maxFileBytes: 1024 * 1024, webDist: path.join(dataDir, 'none') }));
  boardId = (await inj('POST', '/api/boards', { name: 'TG' })).json().board.id;
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('text and group items', () => {
  it('round-trips text + style and group title + colour, and updates them', async () => {
    const text = { id: 't1', kind: 'text', ...base, name: 'Hello', props: { text: 'Hello\nwörld ✓ <b>', size: 56, color: '#4c8dff', bold: true, align: 'center', junk: 1 } };
    const group = { id: 'g1', kind: 'group', ...base, w: 600, h: 400, name: 'Act 1', props: { title: 'Act 1', color: '#4f9a5a' } };
    const put = await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [text, group], deletes: [] });
    expect(put.json().rejected).toEqual([]);
    const got = (await inj('GET', `/api/boards/${boardId}`)).json();
    const byId = Object.fromEntries(got.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.t1.kind).toBe('text');
    expect(byId.t1.props).toEqual({ text: 'Hello\nwörld ✓ <b>', size: 56, color: '#4c8dff', bold: true, align: 'center' });
    expect(byId.g1.props).toEqual({ title: 'Act 1', color: '#4f9a5a' });

    await inj('PUT', `/api/boards/${boardId}/items`, {
      upserts: [{ ...group, version: 2, updatedAt: 2000, props: { title: 'Act 2', color: '#d4b23a' } }], deletes: [],
    });
    const again = (await inj('GET', `/api/boards/${boardId}`)).json();
    expect(again.items.find((i: { id: string }) => i.id === 'g1').props).toEqual({ title: 'Act 2', color: '#d4b23a' });
  });

  it('trash lists them and restore brings the props back; media items carry no props', async () => {
    await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [], deletes: [{ id: 't1', updatedAt: 3000 }] });
    const trash = (await inj('GET', `/api/boards/${boardId}/trash`)).json();
    expect(trash.items.map((i: { id: string }) => i.id)).toContain('t1');
    expect((await inj('POST', '/api/items/t1/restore')).statusCode).toBe(200);
    const f = { id: 'f1', kind: 'file', ...base, name: 'a.bin', props: { text: 'x' } };
    await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [f], deletes: [] });
    const got = (await inj('GET', `/api/boards/${boardId}`)).json();
    expect(got.items.find((i: { id: string }) => i.id === 't1').props.text).toContain('Hello');
    expect(got.items.find((i: { id: string }) => i.id === 'f1').props).toBeNull();
  });

  it('migrate() adds the props column to an older items table', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT)');
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(items)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('props');
    db.close();
  });
});
