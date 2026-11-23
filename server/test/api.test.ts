import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FFMPEG, FFPROBE, makeSamples } from './samples.js';

let ctx: App;
let dataDir = '';
let sampleDir = '';
let files: Record<string, string> = {};

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board data '));
  ({ dir: sampleDir, files } = await makeSamples());
  ctx = await buildApp(loadConfig({ dataDir, ffmpeg: FFMPEG, ffprobe: FFPROBE, maxFileBytes: 5 * 1024 * 1024, webDist: path.join(dataDir, 'none') }));
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(sampleDir, { recursive: true, force: true });
});

const upload = async (file: string, name = path.basename(file)) => {
  const res = await ctx.app.inject({
    method: 'PUT', url: '/api/media',
    headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) },
    payload: fs.readFileSync(file),
  });
  return { res, body: res.json() as { media: { id: string; status: string }; deduped: boolean } };
};

describe('uploads', () => {
  it('stores the original byte-for-byte and de-duplicates identical files by sha256', async () => {
    const a = await upload(files['a.png'], 'one.png');
    const b = await upload(files['a.png'], 'two.png');
    expect(a.res.statusCode).toBe(200);
    expect(a.body.deduped).toBe(false);
    expect(b.body.deduped).toBe(true);
    expect(b.body.media.id).toBe(a.body.media.id);
    const row = ctx.repo.getMedia(a.body.media.id)!;
    expect(fs.readFileSync(ctx.storage.localPath(row.originalKey)).equals(fs.readFileSync(files['a.png']))).toBe(true);
    expect(row.originalKey).not.toMatch(/[A-Za-z]:|\\/); // relative keys only
    const count = ctx.repo.db.prepare('SELECT COUNT(*) c FROM media WHERE sha256=?').get(row.sha256) as { c: number };
    expect(count.c).toBe(1);
    await ctx.processor.idle();
  });

  it('enforces the size limit (413) and leaves nothing in tmp', async () => {
    const big = path.join(sampleDir, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 7));
    const r = await upload(big);
    expect(r.res.statusCode).toBe(413);
    expect(fs.readdirSync(path.join(dataDir, 'tmp'))).toHaveLength(0);
  });

  it('rejects empty files', async () => {
    const empty = path.join(sampleDir, 'empty.bin');
    fs.writeFileSync(empty, '');
    expect((await upload(empty)).res.statusCode).toBe(400);
  });

  it('refuses URL downloads of private addresses', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/media/from-url', payload: { url: 'http://127.0.0.1:5180/api/boards' } });
    expect(res.statusCode).toBe(400);
    const res2 = await ctx.app.inject({ method: 'POST', url: '/api/media/from-url', payload: { url: 'file:///C:/Windows/win.ini' } });
    expect(res2.statusCode).toBe(400);
  });
});

describe('boards and items round trip', () => {
  it('creates, renames, saves items (LWW), reloads and deletes', async () => {
    const created = (await ctx.app.inject({ method: 'POST', url: '/api/boards', payload: { name: 'Doc 1' } })).json().board;
    expect(created.name).toBe('Doc 1');
    const up = await upload(files['a.png'], 'pic.png');
    const item = { id: 'item-1', kind: 'image', x: 10.5, y: -20, w: 480, h: 360, z: 3, mediaId: up.body.media.id, name: 'pic.png', version: 1, updatedAt: 1000 };
    let r = await ctx.app.inject({ method: 'PUT', url: `/api/boards/${created.id}/items`, payload: { upserts: [item], deletes: [] } });
    expect(r.json().rejected).toEqual([]);

    let board = (await ctx.app.inject({ method: 'GET', url: `/api/boards/${created.id}` })).json();
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ id: 'item-1', x: 10.5, y: -20, w: 480, h: 360, z: 3, name: 'pic.png', version: 1 });
    expect(board.items[0].media.id).toBe(up.body.media.id);

    // newer write wins, stale write is rejected
    await ctx.app.inject({ method: 'PUT', url: `/api/boards/${created.id}/items`, payload: { upserts: [{ ...item, x: 99, version: 2, updatedAt: 2000 }], deletes: [] } });
    r = await ctx.app.inject({ method: 'PUT', url: `/api/boards/${created.id}/items`, payload: { upserts: [{ ...item, x: 5, version: 1, updatedAt: 1500 }], deletes: [] } });
    expect(r.json().rejected).toEqual(['item-1']);
    board = (await ctx.app.inject({ method: 'GET', url: `/api/boards/${created.id}` })).json();
    expect(board.items[0].x).toBe(99);

    // delete -> listed as deleted; undo (newer upsert) resurrects it
    await ctx.app.inject({ method: 'PUT', url: `/api/boards/${created.id}/items`, payload: { upserts: [], deletes: [{ id: 'item-1', updatedAt: 3000 }] } });
    board = (await ctx.app.inject({ method: 'GET', url: `/api/boards/${created.id}` })).json();
    expect(board.items).toHaveLength(0);
    expect(board.deleted.map((d: { id: string }) => d.id)).toEqual(['item-1']);
    await ctx.app.inject({ method: 'PUT', url: `/api/boards/${created.id}/items`, payload: { upserts: [{ ...item, version: 4, updatedAt: 4000 }], deletes: [] } });
    board = (await ctx.app.inject({ method: 'GET', url: `/api/boards/${created.id}` })).json();
    expect(board.items).toHaveLength(1);

    await ctx.app.inject({ method: 'PATCH', url: `/api/boards/${created.id}`, payload: { name: 'Renamed' } });
    const list = (await ctx.app.inject({ method: 'GET', url: '/api/boards' })).json().boards;
    expect(list[0].name).toBe('Renamed'); // most recently touched first
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/boards/${created.id}` })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/boards/${created.id}` })).statusCode).toBe(404);
    await ctx.processor.idle();
  });
});

describe('processing + serving', () => {
  const cases: Array<[string, { kind: string; preview: boolean; converted: boolean }]> = [
    ['a.png', { kind: 'image', preview: false, converted: false }],
    ['a.tif', { kind: 'image', preview: true, converted: true }],
    ['a.bmp', { kind: 'image', preview: false, converted: false }],
    ['a.exr', { kind: 'image', preview: true, converted: true }],
    ['a.psd', { kind: 'image', preview: true, converted: true }],
    ['evil.svg', { kind: 'image', preview: true, converted: false }],
    ['h264.mp4', { kind: 'video', preview: false, converted: false }],
    ['hevc.mp4', { kind: 'video', preview: true, converted: true }],
    ['prores.mov', { kind: 'video', preview: true, converted: true }],
    ['vp9.webm', { kind: 'video', preview: false, converted: false }],
  ];
  for (const [name, exp] of cases) {
    it(`${name} becomes ready (${exp.kind}${exp.converted ? ', converted preview' : ''})`, async () => {
      const { body } = await upload(files[name]);
      await ctx.processor.idle();
      const row = ctx.repo.getMedia(body.media.id)!;
      expect(row.error).toBeNull();
      expect(row.status).toBe('ready');
      expect(row.kind).toBe(exp.kind);
      expect(!!row.previewKey).toBe(exp.preview);
      expect(row.width).toBeGreaterThan(0);
      expect(fs.existsSync(ctx.storage.localPath(row.thumbKey!))).toBe(true);
      if (exp.kind === 'video') {
        expect(fs.existsSync(ctx.storage.localPath(row.posterKey!))).toBe(true);
        expect(row.durationMs).toBeGreaterThan(1000);
        expect(row.fps).toBeGreaterThan(10);
      }
      const prev = await ctx.app.inject({ method: 'GET', url: `/api/media/${row.id}/preview`, headers: { range: 'bytes=0-9' } });
      expect(prev.statusCode).toBe(206);
      expect(prev.headers['content-range']).toMatch(/^bytes 0-9\//);
    });
  }

  it('transcoded video is H.264 yuv420p with even dimensions', async () => {
    const { body } = await upload(files['odd444.mp4']);
    await ctx.processor.idle();
    const row = ctx.repo.getMedia(body.media.id)!;
    expect(row.previewKey).toBeTruthy();
    expect((row.width ?? 1) % 2).toBe(0);
    expect((row.height ?? 1) % 2).toBe(0);
  });

  it('download serves the exact bytes with a UTF-8 file name', async () => {
    const { body } = await upload(files['a.png'], 'Café – 画像.png');
    const board = (await ctx.app.inject({ method: 'POST', url: '/api/boards', payload: { name: 'B' } })).json().board;
    await ctx.app.inject({
      method: 'PUT', url: `/api/boards/${board.id}/items`,
      payload: { upserts: [{ id: 'dl-1', kind: 'image', x: 0, y: 0, w: 10, h: 10, z: 1, mediaId: body.media.id, name: 'Café – 画像.png', version: 1, updatedAt: 1 }], deletes: [] },
    });
    const r = await ctx.app.inject({ method: 'GET', url: '/api/items/dl-1/original' });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(fs.readFileSync(files['a.png']))).toBe(true);
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''Caf%C3%A9%20%E2%80%93%20%E7%94%BB%E5%83%8F.png");
  });

  it('SVG preview is sanitized and sandboxed', async () => {
    const { body } = await upload(files['evil.svg']);
    await ctx.processor.idle();
    const r = await ctx.app.inject({ method: 'GET', url: `/api/media/${body.media.id}/preview` });
    expect(r.headers['content-type']).toContain('image/svg+xml');
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect(r.body).not.toMatch(/script|onload|evil\.test/);
  });

  it('unreadable image-looking files end as failed with a message, original kept', async () => {
    const bad = path.join(sampleDir, 'broken.png');
    const png = fs.readFileSync(files['a.png']);
    fs.writeFileSync(bad, Buffer.concat([png.subarray(0, 40), Buffer.alloc(50, 1)]));
    const { body } = await upload(bad);
    await ctx.processor.idle();
    const row = ctx.repo.getMedia(body.media.id)!;
    expect(row.status).toBe('failed');
    expect(row.error).toBeTruthy();
    expect(fs.existsSync(ctx.storage.localPath(row.originalKey))).toBe(true);
  });

  it('a text file renamed .png is failed (grey card), a plain .txt is just a file card', async () => {
    const fake = path.join(sampleDir, 'fake.png');
    fs.writeFileSync(fake, 'this is not a picture');
    const a = await upload(fake);
    const b = await upload(files['notes.txt']);
    await ctx.processor.idle();
    expect(ctx.repo.getMedia(a.body.media.id)!.status).toBe('failed');
    const t = ctx.repo.getMedia(b.body.media.id)!;
    expect([t.status, t.kind, t.mime]).toEqual(['ready', 'document', 'text/plain']);
  });
});

describe('GET /api/media/:id/info', () => {
  it('returns codec details + source, and backfills older rows lazily', async () => {
    const copy = path.join(sampleDir, 'info-copy.mp4'); // unique bytes: not de-duplicated against earlier uploads
    fs.writeFileSync(copy, Buffer.concat([fs.readFileSync(files['h264.mp4']), Buffer.from('infotest')]));
    const { body } = await upload(copy, 'higgsfield_clip.mp4');
    await ctx.processor.idle();
    const id = body.media.id;
    let info = (await ctx.app.inject({ method: 'GET', url: `/api/media/${id}/info` })).json() as Record<string, any>;
    expect(info.filename).toBe('higgsfield_clip.mp4');
    expect(info.compression.codec).toBe('H.264');
    expect(info.compression.pixFmt).toBe('yuv420p');
    expect(info.container).toBe('MP4');
    expect(info.source).toBe('Higgsfield');
    expect(info.sourceEvidence).toBe('filename');
    // an "old" row: source columns empty -> filled on first info request
    ctx.repo.updateMedia(id, { source: null, sourceEvidence: null, container: null });
    info = (await ctx.app.inject({ method: 'GET', url: `/api/media/${id}/info` })).json();
    expect(info.source).toBe('Higgsfield');
    expect(info.container).toBe('MP4');
    expect((await ctx.app.inject({ method: 'GET', url: '/api/media/nope/info' })).statusCode).toBe(404);
  });
});
