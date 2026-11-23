import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, safeWorkflowName, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { FFMPEG, FFPROBE, ffmpegAvailable } from './samples.js';

let ctx: App;
let cfg: Config;
let dataDir = '';
let tmp = '';
let boardId = '';
const revealed: string[] = [];
const hits: Array<{ method: string; url: string; body: string; type: string }> = [];
let fake: http.Server;
let fakePort = 0;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
const tEXt = (k: string, v: string) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')]));
const withChunks = (png: Buffer, ...extra: Buffer[]) => Buffer.concat([png.subarray(0, png.length - 12), ...extra, png.subarray(png.length - 12)]);

const UI_WF = { last_node_id: 2, nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveImage' }], links: [], version: 0.4 };
const API_WF = { '3': { class_type: 'KSampler', inputs: { seed: 1 } }, '4': { class_type: 'SaveImage', inputs: {} } };

let n = 0;
async function png(...extra: Buffer[]) {
  n++; // unique pixels: no sha dedupe between files
  const base = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: n * 7, g: 40, b: 90 } } }).png().toBuffer();
  return withChunks(base, ...extra);
}
async function addItem(name: string, bytes: Buffer, id: string, kind = 'image') {
  const up = await ctx.app.inject({
    method: 'PUT', url: '/api/media',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, payload: bytes,
  });
  const mediaId = (up.json() as { media: { id: string } }).media.id;
  await ctx.processor.idle();
  const r = await ctx.app.inject({
    method: 'PUT', url: `/api/boards/${boardId}/items`,
    payload: { upserts: [{ id, kind, x: 0, y: 0, w: 100, h: 100, z: 1, mediaId, name, version: 1, updatedAt: 1000 }], deletes: [] },
  });
  expect(r.statusCode).toBe(200);
  return mediaId;
}
const mediaOf = (itemId: string) => ctx.repo.getItem(itemId)!.mediaId!;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-step6-'));
  dataDir = path.join(tmp, 'data');
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body, type: String(req.headers['content-type']) });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakePort = (fake.address() as { port: number }).port;
  cfg = loadConfig({ dataDir, ffmpeg: FFMPEG, ffprobe: FFPROBE, webDist: path.join(tmp, 'none'), comfyUrl: `http://127.0.0.1:${fakePort}` });
  ctx = await buildApp(cfg, { reveal: (p) => revealed.push(p) });
  boardId = ((await ctx.app.inject({ method: 'POST', url: '/api/boards', payload: { name: 'S6' } })).json() as { board: { id: string } }).board.id;
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  await new Promise((r) => fake.close(r));
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('workflow extraction', () => {
  it('PNG tEXt "workflow" is returned as-is (UI format preferred over the API prompt)', async () => {
    await addItem('both.png', await png(tEXt('prompt', JSON.stringify(API_WF)), tEXt('workflow', JSON.stringify(UI_WF))), 'w-both');
    const r = await ctx.app.inject({ method: 'GET', url: `/api/media/${mediaOf('w-both')}/workflow` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-workflow-format']).toBe('workflow');
    expect(r.json()).toEqual(UI_WF);
  });
  it('falls back to the API prompt when that is all there is; 404 when nothing', async () => {
    const m1 = await addItem('api.png', await png(tEXt('prompt', JSON.stringify(API_WF))), 'w-api');
    const r = await ctx.app.inject({ method: 'GET', url: `/api/media/${m1}/workflow` });
    expect(r.headers['x-workflow-format']).toBe('prompt');
    expect(r.json()).toEqual(API_WF);
    const m2 = await addItem('plain.png', await png(), 'w-plain');
    expect((await ctx.app.inject({ method: 'GET', url: `/api/media/${m2}/workflow` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/media/nope/workflow' })).statusCode).toBe(404);
  });
  it.runIf(ffmpegAvailable)('mp4 with -metadata comment (VHS style {workflow,prompt})', async () => {
    const out = path.join(tmp, 'v.mp4');
    const comment = JSON.stringify({ workflow: UI_WF, prompt: API_WF });
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=64x48:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata', `comment=${comment}`, out]);
    expect(r.status).toBe(0);
    const mid = await addItem('shot.mp4', fs.readFileSync(out), 'w-mp4', 'video');
    const res = await ctx.app.inject({ method: 'GET', url: `/api/media/${mid}/workflow` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(UI_WF);
  });
});

describe('open-in-comfy', () => {
  it('saves the workflow through ComfyUI userdata API (path, query, body)', async () => {
    const mid = await addItem('my shot v2.png', await png(tEXt('workflow', JSON.stringify(UI_WF))), 'o-1');
    hits.length = 0;
    const r = await ctx.app.inject({ method: 'POST', url: `/api/media/${mid}/open-in-comfy` });
    expect(r.json()).toMatchObject({ saved: true, path: 'Board/my shot v2.json' });
    expect(hits).toHaveLength(1);
    expect(hits[0].method).toBe('POST');
    expect(hits[0].url).toBe('/api/userdata/workflows%2FBoard%2Fmy%20shot%20v2.json?overwrite=true');
    expect(hits[0].type).toContain('application/json');
    expect(JSON.parse(hits[0].body)).toEqual(UI_WF);
  });
  it('reports ComfyUI not running (and never starts it)', async () => {
    const dead = await new Promise<number>((res) => {
      const s = http.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => res(p));
      });
    });
    const keep = cfg.comfyUrl;
    cfg.comfyUrl = `http://127.0.0.1:${dead}`;
    try {
      const r = await ctx.app.inject({ method: 'POST', url: `/api/media/${mediaOf('o-1')}/open-in-comfy` });
      expect(r.statusCode).toBe(200);
      const b = r.json() as { saved: boolean; reason: string };
      expect(b.saved).toBe(false);
      expect(b.reason).toBe(`ComfyUI not running at http://127.0.0.1:${dead}`);
    } finally {
      cfg.comfyUrl = keep;
    }
  });
  it('404 when the file carries no workflow; /api/config exposes the URL', async () => {
    expect((await ctx.app.inject({ method: 'POST', url: `/api/media/${mediaOf('w-plain')}/open-in-comfy` })).statusCode).toBe(404);
    const c = (await ctx.app.inject({ method: 'GET', url: '/api/config' })).json() as { comfyUrl: string; canReveal: boolean };
    expect(c.comfyUrl).toBe(cfg.comfyUrl);
    expect(c.canReveal).toBe(process.platform === 'win32');
  });
  it('sanitizes file names', () => {
    expect(safeWorkflowName('a/b:c*?.png')).toBe('a_b_c__');
    expect(safeWorkflowName('..  .png')).toBe('workflow');
    expect(safeWorkflowName('ComfyUI_00012_.webp')).toBe('ComfyUI_00012_');
    expect(safeWorkflowName('100%.mp4')).toBe('100_');
  });
});

describe('reveal', () => {
  it.runIf(process.platform === 'win32')('selects the stored original, only for loopback callers', async () => {
    revealed.length = 0;
    const r = await ctx.app.inject({ method: 'POST', url: '/api/items/o-1/reveal' });
    expect(r.statusCode).toBe(200);
    expect(revealed).toHaveLength(1);
    expect(path.relative(dataDir, revealed[0]).startsWith('..')).toBe(false);
    expect(fs.existsSync(revealed[0])).toBe(true);
    const far = await ctx.app.inject({ method: 'POST', url: '/api/items/o-1/reveal', remoteAddress: '10.1.2.3' });
    expect(far.statusCode).toBe(403);
    expect(revealed).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/items/zzz/reveal' })).statusCode).toBe(404);
  });
});

describe('trash', () => {
  const del = (id: string, at: number) =>
    ctx.app.inject({ method: 'PUT', url: `/api/boards/${boardId}/items`, payload: { upserts: [], deletes: [{ id, updatedAt: at }] } });
  const board = async () => (await ctx.app.inject({ method: 'GET', url: `/api/boards/${boardId}` })).json() as { items: Array<{ id: string }>; comments: unknown[] };

  it('lists trashed items, restores them (comments return), deletes forever', async () => {
    const mid = await addItem('t1.png', await png(), 't-1');
    const cm = await ctx.app.inject({ method: 'POST', url: `/api/boards/${boardId}/comments`, payload: { itemId: 't-1', itemX: 0.5, itemY: 0.5, author: 'A', text: 'hi' } });
    expect(cm.statusCode).toBe(200);
    await del('t-1', 2000);
    const list = (await ctx.app.inject({ method: 'GET', url: `/api/boards/${boardId}/trash` })).json() as {
      items: Array<{ id: string; name: string; deletedAt: number; media: { urls: { thumb: string } } }>;
    };
    expect(list.items.map((i) => i.id)).toEqual(['t-1']);
    expect(list.items[0].name).toBe('t1.png');
    expect(list.items[0].media.urls.thumb).toContain('/api/media/');
    expect((await board()).items.some((i) => i.id === 't-1')).toBe(false);
    expect((await board()).comments).toHaveLength(0);

    expect((await ctx.app.inject({ method: 'POST', url: '/api/items/t-1/restore' })).statusCode).toBe(200);
    expect((await board()).items.some((i) => i.id === 't-1')).toBe(true);
    expect((await board()).comments).toHaveLength(1);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/items/t-1/restore' })).statusCode).toBe(404); // not trashed any more
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/items/t-1/trash' })).statusCode).toBe(404); // live items cannot be purged

    await del('t-1', Date.now() + 1000);
    const key = ctx.repo.getMedia(mid)!.originalKey;
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/items/t-1/trash' })).statusCode).toBe(200);
    expect(ctx.repo.getItem('t-1')).toBeUndefined();
    expect(ctx.repo.getMedia(mid)).toBeUndefined();
    expect(await ctx.storage.exists(key)).toBe(false);
    expect(ctx.repo.db.prepare('SELECT COUNT(*) c FROM comments WHERE itemId=?').get('t-1')).toEqual({ c: 0 });
  });

  it('30-day purge: old items go, media files stay while another item uses them', async () => {
    const bytes = await png();
    const mid = await addItem('shared.png', bytes, 'p-1');
    await addItem('shared.png', bytes, 'p-2'); // same bytes -> same media row
    const mid2 = await addItem('lonely.png', await png(), 'p-3');
    await addItem('recent.png', await png(), 'p-4');
    const DAY = 24 * 3600 * 1000;
    const now = Date.now();
    await del('p-1', now - 31 * DAY);
    await del('p-3', now - 31 * DAY);
    await del('p-4', now - 5 * DAY);
    const k1 = ctx.repo.getMedia(mid)!.originalKey;
    const k3 = ctx.repo.getMedia(mid2)!.originalKey;
    const r = await ctx.purgeTrash(now);
    expect(r.items).toBe(2);
    expect(ctx.repo.getItem('p-1')).toBeUndefined();
    expect(ctx.repo.getItem('p-3')).toBeUndefined();
    expect(ctx.repo.getItem('p-4')).toBeDefined(); // only 5 days old
    expect(ctx.repo.getItem('p-2')).toBeDefined();
    expect(ctx.repo.getMedia(mid)).toBeDefined(); // p-2 still uses it
    expect(await ctx.storage.exists(k1)).toBe(true);
    expect(ctx.repo.getMedia(mid2)).toBeUndefined();
    expect(await ctx.storage.exists(k3)).toBe(false);
  });
});
