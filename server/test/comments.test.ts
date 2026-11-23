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

const inj = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  ctx.app.inject({ method, url, payload: payload as never });
const getBoard = async (id = boardId) => (await inj('GET', `/api/boards/${id}`)).json();
const item = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'file', x: 0, y: 0, w: 200, h: 100, z: 1, mediaId: null, name: `${id}.bin`, version: 1, updatedAt: 1000, ...over });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board comments '));
  ctx = await buildApp(loadConfig({ dataDir, ffmpeg: FFMPEG, ffprobe: FFPROBE, maxFileBytes: 1024 * 1024, webDist: path.join(dataDir, 'none') }));
  boardId = (await inj('POST', '/api/boards', { name: 'C' })).json().board.id;
  await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [item('it1')], deletes: [] });
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('comments API', () => {
  it('creates numbered comments with a first message, on the board and on an item', async () => {
    const a = await inj('POST', `/api/boards/${boardId}/comments`, { id: 'c-a', x: 5, y: 6, author: 'Ann', text: 'on the canvas' });
    expect(a.statusCode).toBe(200);
    expect(a.json().comment).toMatchObject({ id: 'c-a', number: 1, itemId: null, x: 5, y: 6, resolved: false });
    expect(a.json().comment.messages).toHaveLength(1);

    const b = await inj('POST', `/api/boards/${boardId}/comments`, {
      id: 'c-b', itemId: 'it1', itemX: 0.25, itemY: 1.7, x: 0, y: 0, videoTimeMs: 1234.4, author: 'Bob', text: 'on the item\nline 2',
    });
    expect(b.json().comment).toMatchObject({ number: 2, itemId: 'it1', itemX: 0.25, itemY: 1, videoTimeMs: 1234 }); // fraction clamped to 0..1
    expect(b.json().comment.messages[0].text).toBe('on the item\nline 2');

    // idempotent on id (retry after a lost response must not duplicate or renumber)
    const again = await inj('POST', `/api/boards/${boardId}/comments`, { id: 'c-b', itemId: 'it1', itemX: 0.5, itemY: 0.5, author: 'Bob', text: 'dup' });
    expect(again.json().comment.number).toBe(2);
    expect(again.json().comment.messages).toHaveLength(1);

    const list = (await getBoard()).comments;
    expect(list.map((c: { number: number }) => c.number)).toEqual([1, 2]);
  });

  it('validates input and numbers per board', async () => {
    expect((await inj('POST', `/api/boards/${boardId}/comments`, { x: 1, y: 1, author: 'A', text: '  ' })).statusCode).toBe(400);
    expect((await inj('POST', `/api/boards/${boardId}/comments`, { x: 1, y: 1, text: 'hi' })).statusCode).toBe(400);
    expect((await inj('POST', `/api/boards/${boardId}/comments`, { itemId: 'nope', itemX: 0, itemY: 0, author: 'A', text: 'hi' })).statusCode).toBe(400);
    expect((await inj('POST', `/api/boards/${boardId}/comments`, { author: 'A', text: 'hi' })).statusCode).toBe(400);
    expect((await inj('POST', '/api/boards/missing/comments', { x: 1, y: 1, author: 'A', text: 'hi' })).statusCode).toBe(404);
    const other = (await inj('POST', '/api/boards', { name: 'Other' })).json().board.id;
    const c = await inj('POST', `/api/boards/${other}/comments`, { x: 1, y: 1, author: 'A', text: 'first here' });
    expect(c.json().comment.number).toBe(1);
  });

  it('replies, resolves and reopens', async () => {
    const r = await inj('POST', '/api/comments/c-a/messages', { author: 'Bob', text: 'see https://example.com/x' });
    expect(r.json().comment.messages.map((m: { author: string }) => m.author)).toEqual(['Ann', 'Bob']);
    expect((await inj('POST', '/api/comments/c-a/messages', { author: 'Bob', text: '' })).statusCode).toBe(400);
    expect((await inj('POST', '/api/comments/zzz/messages', { author: 'Bob', text: 'x' })).statusCode).toBe(404);

    expect((await inj('PATCH', '/api/comments/c-a', { resolved: true })).json().comment.resolved).toBe(true);
    expect((await getBoard()).comments.find((c: { id: string }) => c.id === 'c-a').resolved).toBe(true); // still listed; the client hides it
    expect((await inj('PATCH', '/api/comments/c-a', { resolved: false })).json().comment.resolved).toBe(false);
    expect((await inj('PATCH', '/api/comments/c-a', { resolved: 'yes' })).statusCode).toBe(400);
  });

  it('hides comments of a deleted item and brings them back when the item is restored', async () => {
    await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [], deletes: [{ id: 'it1', updatedAt: 5000 }] });
    let ids = (await getBoard()).comments.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['c-a']);
    await inj('PUT', `/api/boards/${boardId}/items`, { upserts: [item('it1', { version: 3, updatedAt: 6000 })], deletes: [] });
    ids = (await getBoard()).comments.map((c: { id: string }) => c.id);
    expect(ids).toEqual(['c-a', 'c-b']);
  });

  it('deletes a comment (soft) and survives a reopen of the database', async () => {
    expect((await inj('DELETE', '/api/comments/c-a')).statusCode).toBe(200);
    expect((await inj('DELETE', '/api/comments/c-a')).statusCode).toBe(404);
    expect((await getBoard()).comments.map((c: { id: string }) => c.id)).toEqual(['c-b']);
    // numbering never reuses a deleted number
    const n = await inj('POST', `/api/boards/${boardId}/comments`, { x: 0, y: 0, author: 'A', text: 'later' });
    expect(n.json().comment.number).toBe(3);
  });
});

describe('comments migration', () => {
  it('adds the new columns to an old comments table and numbers existing rows per board', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE media (id TEXT PRIMARY KEY);
      CREATE TABLE comments (id TEXT PRIMARY KEY, boardId TEXT NOT NULL, itemId TEXT, x REAL NOT NULL, y REAL NOT NULL,
        videoTimeMs INTEGER, resolved INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
      INSERT INTO comments (id,boardId,x,y,createdAt) VALUES ('a','b1',0,0,10),('b','b1',0,0,20),('c','b2',0,0,5);`);
    migrate(db);
    const rows = db.prepare('SELECT id, number, updatedAt FROM comments ORDER BY id').all();
    expect(rows).toEqual([{ id: 'a', number: 1, updatedAt: 10 }, { id: 'b', number: 2, updatedAt: 20 }, { id: 'c', number: 1, updatedAt: 5 }]);
    const cols = (db.prepare('PRAGMA table_info(comments)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['number', 'itemX', 'itemY', 'updatedAt', 'deletedAt']));
    db.close();
  });
});
