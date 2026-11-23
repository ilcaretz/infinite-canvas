import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { S3Storage } from '../src/s3storage.js';
import { MiB } from '../src/uploadPlan.js';
import { FFMPEG, FFPROBE } from './samples.js';
import { fakeS3 } from './fakeS3.js';

let ctx: App;
let tmp = '';
let fake: ReturnType<typeof fakeS3>;
let n = 0;

async function png() {
  n++;
  return sharp({ create: { width: 40 + n, height: 30, channels: 3, background: { r: n * 9, g: 80, b: 120 } } }).png().toBuffer();
}
const post = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload: payload as object });

type Media = { id: string; status: string; kind: string; urls: { original: string; preview: string | null; thumb: string | null; poster: string | null } | null };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-s3api-'));
  fake = fakeS3();
  const cfg = loadConfig({ dataDir: path.join(tmp, 'data'), ffmpeg: FFMPEG, ffprobe: FFPROBE, webDist: path.join(tmp, 'none'), storageDriver: 's3' });
  const storage = new S3Storage({ bucket: 'bkt', tmpRoot: cfg.dataDir, client: fake.client });
  ctx = await buildApp(cfg, { storage });
});
afterAll(async () => {
  await ctx.app.close();
  ctx.repo.db.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('s3 mode: config and guards', () => {
  it('reports storage=s3, no reveal; direct upload is refused; reveal is 403', async () => {
    const c = (await ctx.app.inject({ url: '/api/config' })).json() as Record<string, unknown>;
    expect(c).toMatchObject({ storage: 's3', canReveal: false, authRequired: false });
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/media', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(put.statusCode).toBe(409);
    expect((await post('/api/items/nope/reveal', {})).statusCode).toBe(403);
  });
  it('configuration without bucket credentials is rejected at startup', async () => {
    const cfg = loadConfig({ dataDir: path.join(tmp, 'd2'), storageDriver: 's3' });
    await expect(buildApp(cfg)).rejects.toThrow(/S3_BUCKET/);
  });
});

describe('s3 mode: init / PUT / complete', () => {
  it('init (small) returns a presigned PUT for originals/<id>.<ext>; the media id is a uuid', async () => {
    const r = await post('/api/uploads/init', { filename: 'pic.PNG', size: 1234, type: 'image/png' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { mediaId: string; mode: string; url: string };
    expect(b.mode).toBe('single');
    expect(b.mediaId).toMatch(/^[0-9a-f-]{36}$/);
    const u = new URL(b.url);
    expect(u.pathname).toBe(`/bkt/originals/${b.mediaId.slice(0, 2)}/${b.mediaId}.png`);
    expect(u.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('init validates size and enforces the limit', async () => {
    expect((await post('/api/uploads/init', { filename: 'a.png' })).statusCode).toBe(400);
    expect((await post('/api/uploads/init', { filename: 'a.png', size: 0 })).statusCode).toBe(400);
    expect((await post('/api/uploads/init', { filename: 'a.png', size: 6 * 1024 ** 3 })).statusCode).toBe(413);
  });

  it('init (large) creates a multipart upload with one 64 MiB part URL per part', async () => {
    const size = 200 * MiB;
    const b = (await post('/api/uploads/init', { filename: 'big.mov', size })).json() as { mode: string; uploadId: string; partSize: number; partCount: number; partUrls: string[]; mediaId: string };
    expect(b).toMatchObject({ mode: 'multipart', partSize: 64 * MiB, partCount: 4 });
    expect(b.partUrls).toHaveLength(4);
    const u = new URL(b.partUrls[2]);
    expect(u.searchParams.get('partNumber')).toBe('3');
    expect(u.searchParams.get('uploadId')).toBe(b.uploadId);
    expect(fake.uploads.has(b.uploadId)).toBe(true);
  });

  it('single flow: browser PUT (simulated in the bucket) -> complete hashes, processes, and answers with presigned URLs', async () => {
    const bytes = await png();
    const init = (await post('/api/uploads/init', { filename: 'a.png', size: bytes.length })).json() as { mediaId: string };
    fake.objects.set(`originals/${init.mediaId.slice(0, 2)}/${init.mediaId}.png`, bytes); // what the browser's PUT does
    const r = await post(`/api/uploads/${init.mediaId}/complete`, { filename: 'a.png' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { media: Media; deduped: boolean };
    expect(body.deduped).toBe(false);
    expect(body.media.id).toBe(init.mediaId);
    const row = ctx.repo.getMedia(init.mediaId)!;
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(row.originalKey).toBe(`originals/${init.mediaId.slice(0, 2)}/${init.mediaId}.png`);
    await ctx.processor.idle();
    const ready = ctx.repo.getMedia(init.mediaId)!;
    expect(ready.status).toBe('ready');
    expect(ready.kind).toBe('image');
    // thumbnail went back to the bucket; nothing is left in tmp
    expect(fake.objects.has(ready.thumbKey!)).toBe(true);
    expect(fs.readdirSync(path.join(tmp, 'data', 'tmp', 's3'))).toEqual([]);
    // status poll now has presigned URLs, never /api/media paths
    const m = ((await ctx.app.inject({ url: `/api/media?ids=${init.mediaId}` })).json() as { media: Media[] }).media[0];
    for (const u of [m.urls!.original, m.urls!.preview!, m.urls!.thumb!]) {
      expect(u).toMatch(/^https:\/\/acct\.r2\.cloudflarestorage\.com\/bkt\//);
      expect(u).not.toContain('/api/');
      expect(u).toContain('X-Amz-Signature=');
    }
    expect(new URL(m.urls!.thumb!).pathname).toBe(`/bkt/${ready.thumbKey}`);
    expect(new URL(m.urls!.preview!).searchParams.get('response-content-type')).toBe('image/png');
  });

  it('complete is idempotent and a second upload of the same bytes is de-duplicated (extra object deleted)', async () => {
    const bytes = await png();
    const a = (await post('/api/uploads/init', { filename: 'd.png', size: bytes.length })).json() as { mediaId: string };
    const keyA = `originals/${a.mediaId.slice(0, 2)}/${a.mediaId}.png`;
    fake.objects.set(keyA, bytes);
    const [r1, r2] = await Promise.all([post(`/api/uploads/${a.mediaId}/complete`, { filename: 'd.png' }), post(`/api/uploads/${a.mediaId}/complete`, { filename: 'd.png' })]);
    expect((r1.json() as { media: Media }).media.id).toBe(a.mediaId);
    expect((r2.json() as { media: Media }).media.id).toBe(a.mediaId);
    await ctx.processor.idle();

    const b = (await post('/api/uploads/init', { filename: 'd-copy.png', size: bytes.length })).json() as { mediaId: string };
    const keyB = `originals/${b.mediaId.slice(0, 2)}/${b.mediaId}.png`;
    fake.objects.set(keyB, bytes);
    const r = (await post(`/api/uploads/${b.mediaId}/complete`, { filename: 'd-copy.png' })).json() as { media: Media; deduped: boolean };
    expect(r.deduped).toBe(true);
    expect(r.media.id).toBe(a.mediaId);
    expect(fake.objects.has(keyB)).toBe(false);
    expect(fake.objects.has(keyA)).toBe(true);
  });

  it('complete without an uploaded object, an empty object, a bad id: 400s and nothing is stored', async () => {
    const id = (await post('/api/uploads/init', { filename: 'q.png', size: 10 })).json() as { mediaId: string };
    const miss = await post(`/api/uploads/${id.mediaId}/complete`, { filename: 'q.png' });
    expect(miss.statusCode).toBe(400);
    fake.objects.set(`originals/${id.mediaId.slice(0, 2)}/${id.mediaId}.png`, Buffer.alloc(0));
    expect((await post(`/api/uploads/${id.mediaId}/complete`, { filename: 'q.png' })).statusCode).toBe(400);
    expect(ctx.repo.getMedia(id.mediaId)).toBeUndefined();
    expect((await post('/api/uploads/not-a-uuid/complete', { filename: 'q.png' })).statusCode).toBe(400);
  });

  it('multipart flow: parts land in the bucket, resume lists them, complete (with and without client ETags) assembles the object', async () => {
    const bytes = await png();
    const size = 130 * MiB; // declared size decides the plan (3 parts); the stored bytes are tiny
    const init = (await post('/api/uploads/init', { filename: 'mp.png', size })).json() as { mediaId: string; uploadId: string; partUrls: string[] };
    const key = `originals/${init.mediaId.slice(0, 2)}/${init.mediaId}.png`;
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    const third = Math.floor(bytes.length / 3);
    const pieces = [bytes.subarray(0, third), bytes.subarray(third, 2 * third), bytes.subarray(2 * third)];
    const etags: Record<number, string> = {};
    for (const i of [0, 2]) {
      const res = await fake.client.send(new UploadPartCommand({ Bucket: 'bkt', Key: key, UploadId: init.uploadId, PartNumber: i + 1, Body: pieces[i] }));
      etags[i + 1] = res.ETag!;
    }
    // resume: parts 1 and 3 are known, fresh URLs for all 3
    const resume = (await post(`/api/uploads/${init.mediaId}/resume`, { filename: 'mp.png', uploadId: init.uploadId, size })).json() as { parts: Array<{ partNumber: number; size: number; etag: string }>; partUrls: string[]; partSize: number };
    expect(resume.parts.map((p) => p.partNumber)).toEqual([1, 3]);
    expect(resume.parts[0].size).toBe(pieces[0].length);
    expect(resume.partUrls).toHaveLength(3);
    expect(resume.partSize).toBe(64 * MiB);
    const res2 = await fake.client.send(new UploadPartCommand({ Bucket: 'bkt', Key: key, UploadId: init.uploadId, PartNumber: 2, Body: pieces[1] }));
    etags[2] = res2.ETag!;

    // client without exposed ETags: the server lists the parts itself
    const r = await post(`/api/uploads/${init.mediaId}/complete`, { filename: 'mp.png', uploadId: init.uploadId, size, parts: [] });
    expect(r.statusCode).toBe(200);
    expect(fake.calls.complete.at(-1)!.parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(fake.objects.get(key)!.equals(bytes)).toBe(true);
    await ctx.processor.idle();
    expect(ctx.repo.getMedia(init.mediaId)!.status).toBe('ready');
    // a retried complete after success (upload session gone) just returns the stored media
    const again = await post(`/api/uploads/${init.mediaId}/complete`, { filename: 'mp.png', uploadId: init.uploadId, size, parts: Object.entries(etags).map(([k, v]) => ({ partNumber: Number(k), etag: v })) });
    expect(again.statusCode).toBe(200);
  });

  it('complete with too few parts answers 409 and the upload stays resumable; abort removes it', async () => {
    const size = 130 * MiB;
    const init = (await post('/api/uploads/init', { filename: 'part.bin', size })).json() as { mediaId: string; uploadId: string };
    const key = `originals/${init.mediaId.slice(0, 2)}/${init.mediaId}.bin`;
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    await fake.client.send(new UploadPartCommand({ Bucket: 'bkt', Key: key, UploadId: init.uploadId, PartNumber: 1, Body: Buffer.from('a') }));
    const r = await post(`/api/uploads/${init.mediaId}/complete`, { filename: 'part.bin', uploadId: init.uploadId, size });
    expect(r.statusCode).toBe(409);
    expect(fake.uploads.has(init.uploadId)).toBe(true);
    expect((await post(`/api/uploads/${init.mediaId}/abort`, { filename: 'part.bin', uploadId: init.uploadId })).statusCode).toBe(200);
    expect(fake.uploads.has(init.uploadId)).toBe(false);
    expect((await post(`/api/uploads/${init.mediaId}/resume`, { filename: 'part.bin', uploadId: init.uploadId, size })).statusCode).toBe(410);
  });
});

describe('s3 mode: redirects, trash purge and URL drops', () => {
  let mediaId = '';
  let itemId = '';
  let boardId = '';
  beforeAll(async () => {
    boardId = ((await post('/api/boards', { name: 'S3' })).json() as { board: { id: string } }).board.id;
    const bytes = await png();
    const init = (await post('/api/uploads/init', { filename: 'r.png', size: bytes.length })).json() as { mediaId: string };
    fake.objects.set(`originals/${init.mediaId.slice(0, 2)}/${init.mediaId}.png`, bytes);
    await post(`/api/uploads/${init.mediaId}/complete`, { filename: 'r.png' });
    await ctx.processor.idle();
    mediaId = init.mediaId;
    itemId = 'it-1';
    await ctx.app.inject({ method: 'PUT', url: `/api/boards/${boardId}/items`, payload: { upserts: [{ id: itemId, kind: 'image', x: 0, y: 0, w: 10, h: 10, z: 1, mediaId, name: 'r.png', version: 1, updatedAt: 1 }], deletes: [] } });
  });

  it('the board payload carries presigned URLs', async () => {
    const b = (await ctx.app.inject({ url: `/api/boards/${boardId}` })).json() as { items: Array<{ media: Media }> };
    expect(b.items[0].media.urls!.thumb).toContain('X-Amz-Signature=');
    expect(b.items[0].media.urls!.thumb).not.toContain('/api/');
  });

  it('legacy /api paths redirect to the bucket; the download link carries an attachment disposition', async () => {
    const o = await ctx.app.inject({ url: `/api/media/${mediaId}/original` });
    expect(o.statusCode).toBe(302);
    expect(String(o.headers.location)).toContain('/bkt/originals/');
    const d = await ctx.app.inject({ url: `/api/items/${itemId}/original` });
    expect(d.statusCode).toBe(302);
    expect(decodeURIComponent(String(d.headers.location))).toContain('attachment; filename="r.png"');
    const t = await ctx.app.inject({ url: `/api/media/${mediaId}/thumb` });
    expect(t.statusCode).toBe(302);
  });

  it('purging the item deletes the original, thumb from the bucket', async () => {
    await ctx.app.inject({ method: 'PUT', url: `/api/boards/${boardId}/items`, payload: { upserts: [], deletes: [{ id: itemId, updatedAt: 5 }] } });
    const row = ctx.repo.getMedia(mediaId)!;
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/items/${itemId}/trash` })).statusCode).toBe(200);
    expect(fake.objects.has(row.originalKey)).toBe(false);
    expect(fake.objects.has(row.thumbKey!)).toBe(false);
  });

  it('URL drop in s3 mode: ingestStream (what /api/media/from-url calls after downloading) writes the original into the bucket', async () => {
    const bytes = await png();
    const { ingestStream } = await import('../src/ingest.js');
    const { Readable } = await import('node:stream');
    const { media, deduped } = await ingestStream({ repo: ctx.repo, storage: ctx.storage, processor: ctx.processor, maxBytes: 1 << 30 }, Readable.from([bytes]), 'dropped.png');
    expect(deduped).toBe(false);
    expect(fake.objects.get(media.originalKey)!.equals(bytes)).toBe(true);
    await ctx.processor.idle();
    expect(ctx.repo.getMedia(media.id)!.status).toBe('ready');
    expect(fs.readdirSync(path.join(tmp, 'data', 'tmp')).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
  it('the SSRF guard still applies to from-url in s3 mode', async () => {
    expect((await post('/api/media/from-url', { url: 'http://127.0.0.1:1/x.png' })).statusCode).toBe(400);
  });
});
