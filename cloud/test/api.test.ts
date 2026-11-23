import { beforeEach, describe, expect, it } from 'vitest';
import { purgeExpired } from '../src/app';
import { call, loginAs, makeWorld, S3_HOST, type World } from './helpers';

const SHA = (c: string) => c.repeat(64).slice(0, 64);
let w: World;
let cookie: string;
beforeEach(async () => {
  w = await makeWorld();
  cookie = await loginAs(w);
});
const api = async (method: string, path: string, body?: unknown) => {
  const r = await call(w, method, path, { body, cookie });
  const isJson = (r.headers.get('content-type') ?? '').includes('json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = isJson ? await r.json() : await r.text();
  return { status: r.status, body: parsed, headers: r.headers };
};
const bytes = (n: number) => new Uint8Array(n).fill(7);

/** init -> put objects into the fake bucket -> complete */
async function upload(o: { name?: string; size?: number; sha?: string; meta?: Record<string, unknown>; assets?: Array<'thumb' | 'preview' | 'poster'>; user?: string } = {}) {
  const size = o.size ?? 1000;
  const init = await api('POST', '/api/uploads/init', { filename: o.name ?? 'a.png', size, mime: 'image/png', sha256: o.sha ?? SHA('a') });
  expect(init.status).toBe(200);
  const id = init.body.mediaId as string;
  const row = w.raw.prepare('SELECT originalKey FROM uploads WHERE id=?').get(id) as { originalKey: string };
  w.r2.set(row.originalKey, bytes(size));
  const keys = { thumb: `thumbs/${id}.webp`, preview: `previews/${id}.webp`, poster: `previews/${id}.poster.webp` };
  for (const a of o.assets ?? []) w.r2.set(keys[a], bytes(5));
  const done = await api('POST', `/api/uploads/${id}/complete`, {
    filename: o.name ?? 'a.png', size,
    meta: { sha256: o.sha ?? SHA('a'), mime: 'image/png', kind: 'image', width: 640, height: 480, hasThumb: true, hasPreview: true, hasPoster: true, ...o.meta },
  });
  return { id, init, done, key: row.originalKey, keys };
}

describe('boards', () => {
  it('create / list / rename / delete', async () => {
    const a = (await api('POST', '/api/boards', { name: '  First  ' })).body.board;
    expect(a.name).toBe('First');
    expect((await api('POST', '/api/boards', {})).body.board.name).toBe('Untitled board');
    expect((await api('GET', '/api/boards')).body.boards).toHaveLength(2);
    expect((await api('PATCH', `/api/boards/${a.id}`, { name: 'Renamed' })).body.board.name).toBe('Renamed');
    expect((await api('PATCH', `/api/boards/${a.id}`, { name: ' ' })).status).toBe(400);
    expect((await api('PATCH', '/api/boards/nope', { name: 'x' })).status).toBe(404);
    expect((await api('DELETE', `/api/boards/${a.id}`)).body).toEqual({ ok: true });
    expect((await api('DELETE', `/api/boards/${a.id}`)).status).toBe(404);
    expect((await api('GET', `/api/boards/${a.id}`)).status).toBe(404);
  });

  it('deleting a board cascades to its items and comments', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('i1')] });
    await api('POST', `/api/boards/${b.id}/comments`, { author: 'a', text: 't', x: 1, y: 2 });
    await api('DELETE', `/api/boards/${b.id}`);
    expect((w.raw.prepare('SELECT COUNT(*) c FROM items').get() as { c: number }).c).toBe(0);
    expect((w.raw.prepare('SELECT COUNT(*) c FROM comment_messages').get() as { c: number }).c).toBe(0);
  });
});

const item = (id: string, over: Record<string, unknown> = {}) => ({ id, kind: 'text', x: 1, y: 2, w: 100, h: 50, z: 1, name: 'n', props: { text: 'hello', bold: true }, version: 1, updatedAt: 1000, ...over });

describe('items', () => {
  it('PUT then GET round trip, last write wins, deletes go to the trash list', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    const put = await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('i1'), item('i2', { x: 5 }), { id: 'bad', kind: 'nope' }] });
    expect(put.body).toEqual({ ok: true, rejected: [] });
    let g = (await api('GET', `/api/boards/${b.id}`)).body;
    expect(g.items).toHaveLength(2);
    const i1 = g.items.find((i: { id: string }) => i.id === 'i1');
    expect(i1).toMatchObject({ kind: 'text', x: 1, w: 100, props: { text: 'hello', bold: true }, media: null, mediaId: null });
    expect(typeof g.serverTime).toBe('number');
    // stale write rejected, newer accepted
    const r = await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('i1', { x: 99, updatedAt: 500 }), item('i2', { x: 77, updatedAt: 2000, version: 2 })] });
    expect(r.body.rejected).toEqual(['i1']);
    g = (await api('GET', `/api/boards/${b.id}`)).body;
    expect(g.items.find((i: { id: string }) => i.id === 'i1').x).toBe(1);
    expect(g.items.find((i: { id: string }) => i.id === 'i2').x).toBe(77);
    // foreign board item is rejected
    const b2 = (await api('POST', '/api/boards', { name: 'y' })).body.board;
    expect((await api('PUT', `/api/boards/${b2.id}/items`, { upserts: [item('i1', { updatedAt: 9999 })] })).body.rejected).toEqual(['i1']);
    // delete -> trash -> restore
    await api('PUT', `/api/boards/${b.id}/items`, { deletes: [{ id: 'i1', updatedAt: 3000 }] });
    g = (await api('GET', `/api/boards/${b.id}`)).body;
    expect(g.items.map((i: { id: string }) => i.id)).toEqual(['i2']);
    expect(g.deleted).toEqual([{ id: 'i1', deletedAt: 3000 }]);
    expect((await api('GET', `/api/boards/${b.id}/trash`)).body.items[0]).toMatchObject({ id: 'i1', kind: 'text' });
    expect((await api('POST', '/api/items/i1/restore')).body).toEqual({ ok: true });
    expect((await api('GET', `/api/boards/${b.id}`)).body.items).toHaveLength(2);
    expect((await api('PUT', '/api/boards/nope/items', {})).status).toBe(404);
  });

  it('handles more than 100 items in one PUT (D1 100-parameter limit)', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    const many = Array.from({ length: 250 }, (_, i) => item(`m${i}`));
    expect((await api('PUT', `/api/boards/${b.id}/items`, { upserts: many })).body).toEqual({ ok: true, rejected: [] });
    expect((await api('GET', `/api/boards/${b.id}`)).body.items).toHaveLength(250);
  });

  it('an item pointing at unknown media is saved with mediaId null', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('i1', { kind: 'image', mediaId: 'ghost' })] });
    expect((await api('GET', `/api/boards/${b.id}`)).body.items[0].mediaId).toBeNull();
  });
});

describe('comments', () => {
  it('create, reply, resolve, delete', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    const c1 = (await api('POST', `/api/boards/${b.id}/comments`, { id: 'c1', author: 'alice', text: 'hi', x: 1, y: 2 })).body.comment;
    expect(c1).toMatchObject({ number: 1, resolved: false, messages: [{ author: 'alice', text: 'hi' }] });
    const c2 = (await api('POST', `/api/boards/${b.id}/comments`, { author: 'bob', text: 'yo', x: 1, y: 2 })).body.comment;
    expect(c2.number).toBe(2);
    expect((await api('POST', `/api/boards/${b.id}/comments`, { id: 'c1', author: 'alice', text: 'hi', x: 1, y: 2 })).body.comment.messages).toHaveLength(1); // idempotent
    expect((await api('POST', '/api/comments/c1/messages', { author: 'bob', text: 'reply' })).body.comment.messages).toHaveLength(2);
    expect((await api('PATCH', '/api/comments/c1', { resolved: true })).body.comment.resolved).toBe(true);
    expect((await api('GET', `/api/boards/${b.id}`)).body.comments).toHaveLength(2);
    expect((await api('DELETE', '/api/comments/c1')).body).toEqual({ ok: true });
    expect((await api('GET', `/api/boards/${b.id}`)).body.comments).toHaveLength(1);
    expect((await api('POST', `/api/boards/${b.id}/comments`, { author: 'a', text: '' , x: 1, y: 2 })).status).toBe(400);
  });
});

describe('uploads', () => {
  it('init (single) returns presigned PUTs + asset URLs; no `type` field needed', async () => {
    const init = await api('POST', '/api/uploads/init', { filename: 'pic.png', size: 5000, mime: 'image/png', sha256: SHA('b') });
    expect(init.body).toMatchObject({ mode: 'single', deduped: false, headers: { 'content-type': 'application/octet-stream' } });
    expect(init.body.url).toContain(`${S3_HOST}/bkt/originals/`);
    expect(init.body.url).toContain('X-Amz-Signature=');
    for (const k of ['thumb', 'preview', 'poster']) expect(init.body.assetUrls[k]).toContain('X-Amz-Signature=');
    expect(init.body.assetUrls.thumb).toContain(`thumbs/${init.body.mediaId}.webp`);
    expect(init.body.assetUrls.poster).toContain(`previews/${init.body.mediaId}.poster.webp`);
    expect((await api('POST', '/api/uploads/init', { filename: 'x', size: 0 })).status).toBe(400);
    expect((await api('POST', '/api/uploads/init', { filename: 'x', size: 6 * 1024 ** 3 })).status).toBe(413);
  });

  it('init (multipart) creates the S3 upload and one presigned URL per part', async () => {
    const size = 200 * 1024 * 1024;
    const init = await api('POST', '/api/uploads/init', { filename: 'big.mp4', size, mime: 'video/mp4', sha256: SHA('c') });
    expect(init.body).toMatchObject({ mode: 'multipart', uploadId: 'up-1', partSize: 64 * 1024 * 1024, partCount: 4 });
    expect(init.body.partUrls).toHaveLength(4);
    expect(init.body.partUrls[2]).toContain('partNumber=3');
    expect(init.body.partUrls[2]).toContain('uploadId=up-1');
  });

  it('init dedupes on a known sha256', async () => {
    const first = await upload({ sha: SHA('d') });
    expect(first.done.status).toBe(200);
    const again = await api('POST', '/api/uploads/init', { filename: 'copy.png', size: 1000, mime: 'image/png', sha256: SHA('d') });
    expect(again.body).toMatchObject({ deduped: true, media: { id: first.id } });
    expect(again.body.mediaId).toBeUndefined();
  });

  it('complete writes keys ONLY for assets that exist in the bucket', async () => {
    const r = await upload({ assets: ['thumb'], meta: { hasThumb: true, hasPreview: true, hasPoster: true } });
    expect(r.done.status).toBe(200);
    const m = w.raw.prepare('SELECT * FROM media WHERE id=?').get(r.id) as Record<string, unknown>;
    expect(m.thumbKey).toBe(`thumbs/${r.id}.webp`);
    expect(m.previewKey).toBeNull();
    expect(m.posterKey).toBeNull();
    expect(m).toMatchObject({ status: 'ready', sizeBytes: 1000, width: 640, height: 480, kind: 'image', uploadedBy: 'alice' });
    expect(r.done.body.media.urls).toEqual({
      original: `/api/media/${r.id}/original`, preview: `/api/media/${r.id}/preview`, thumb: `/api/media/${r.id}/thumb`, poster: null,
    });
    expect(r.done.body.media.uploadedBy).toBe('alice');
  });

  it('a flag without the object is ignored; an object without the flag is ignored too', async () => {
    const r = await upload({ assets: ['preview'], meta: { hasThumb: true, hasPreview: false, hasPoster: false } });
    const m = w.raw.prepare('SELECT thumbKey, previewKey, posterKey FROM media WHERE id=?').get(r.id) as Record<string, unknown>;
    expect(m).toEqual({ thumbKey: null, previewKey: null, posterKey: null });
  });

  it('complete is idempotent and records the uploader', async () => {
    const r = await upload({ meta: { hasThumb: false, hasPreview: false, hasPoster: false } });
    const again = await api('POST', `/api/uploads/${r.id}/complete`, { filename: 'a.png', size: 1000, meta: { sha256: SHA('a') } });
    expect(again.body).toMatchObject({ deduped: false, media: { id: r.id } });
    expect((w.raw.prepare('SELECT COUNT(*) c FROM media').get() as { c: number }).c).toBe(1);
    expect((w.raw.prepare('SELECT COUNT(*) c FROM uploads').get() as { c: number }).c).toBe(0);
  });

  it('complete: missing object 400, size mismatch 409, bad sha 400, empty 400', async () => {
    const init = await api('POST', '/api/uploads/init', { filename: 'a.png', size: 1000, mime: 'image/png', sha256: SHA('e') });
    const id = init.body.mediaId;
    expect((await api('POST', `/api/uploads/${id}/complete`, { filename: 'a.png', size: 1000, meta: { sha256: SHA('e') } })).status).toBe(400);
    const key = (w.raw.prepare('SELECT originalKey k FROM uploads WHERE id=?').get(id) as { k: string }).k;
    w.r2.set(key, bytes(999));
    expect((await api('POST', `/api/uploads/${id}/complete`, { filename: 'a.png', size: 1000, meta: { sha256: SHA('e') } })).status).toBe(409);
    w.r2.set(key, bytes(1000));
    expect((await api('POST', `/api/uploads/${id}/complete`, { filename: 'a.png', size: 1000, meta: { sha256: 'zz' } })).status).toBe(400);
    expect((await api('POST', '/api/uploads/not-a-uuid/complete', {})).status).toBe(400);
  });

  it('complete with a sha that already exists dedupes and deletes the new objects', async () => {
    const first = await upload({ sha: SHA('f') });
    // the client did not know the hash at init (sha256 omitted), so a second upload goes through and is deduped at complete
    const init = await api('POST', '/api/uploads/init', { filename: 'b.png', size: 1000, mime: 'image/png' });
    const id = init.body.mediaId;
    const key = (w.raw.prepare('SELECT originalKey k FROM uploads WHERE id=?').get(id) as { k: string }).k;
    w.r2.set(key, bytes(1000));
    w.r2.set(`thumbs/${id}.webp`, bytes(3));
    const done = await api('POST', `/api/uploads/${id}/complete`, { filename: 'b.png', size: 1000, meta: { sha256: SHA('f'), hasThumb: true } });
    expect(done.body).toMatchObject({ deduped: true, media: { id: first.id } });
    expect(w.r2.has(key)).toBe(false);
    expect(w.r2.has(`thumbs/${id}.webp`)).toBe(false);
    expect(w.r2.has(first.key)).toBe(true);
  });

  it('multipart complete: lists parts from S3, completes, stores the row', async () => {
    const size = 100 * 1024 * 1024 + 1;
    const init = await api('POST', '/api/uploads/init', { filename: 'big.mp4', size, mime: 'video/mp4', sha256: SHA('1') });
    const id = init.body.mediaId;
    const key = (w.raw.prepare('SELECT originalKey k FROM uploads WHERE id=?').get(id) as { k: string }).k;
    w.r2.set(key, { length: size } as unknown as Uint8Array); // size is all HEAD needs
    w.s3Parts = [{ n: 1, size: 64 * 1024 * 1024, etag: 'e1' }, { n: 2, size: size - 64 * 1024 * 1024, etag: 'e2' }];
    const done = await api('POST', `/api/uploads/${id}/complete`, { filename: 'big.mp4', size, uploadId: 'up-1', parts: [], meta: { sha256: SHA('1'), kind: 'video', mime: 'video/mp4', durationMs: 4000, fps: 24 } });
    expect(done.status).toBe(200);
    expect(w.s3Calls).toContain('GET ?uploadId=up-1&max-parts=1000');
    expect(w.s3Calls.some((c) => c.startsWith('POST ?uploadId=up-1'))).toBe(true);
    expect(done.body.media).toMatchObject({ kind: 'video', durationMs: 4000, fps: 24, sizeBytes: size });
  });

  it('multipart complete with too few parts is 409', async () => {
    const size = 200 * 1024 * 1024;
    const init = await api('POST', '/api/uploads/init', { filename: 'big.mp4', size, mime: 'video/mp4', sha256: SHA('2') });
    w.s3Parts = [{ n: 1, size: 1, etag: 'e1' }];
    const done = await api('POST', `/api/uploads/${init.body.mediaId}/complete`, { filename: 'big.mp4', size, uploadId: 'up-1', meta: { sha256: SHA('2') } });
    expect(done.status).toBe(409);
  });

  it('resume reports the parts the bucket holds and fresh part URLs; abort cleans up', async () => {
    const size = 200 * 1024 * 1024;
    const init = await api('POST', '/api/uploads/init', { filename: 'big.mp4', size, mime: 'video/mp4', sha256: SHA('3') });
    w.s3Parts = [{ n: 1, size: 64 * 1024 * 1024, etag: 'e1' }];
    const res = await api('POST', `/api/uploads/${init.body.mediaId}/resume`, { filename: 'big.mp4', uploadId: 'up-1', size });
    expect(res.body.parts).toEqual([{ partNumber: 1, size: 64 * 1024 * 1024, etag: '"e1"' }]);
    expect(res.body.partUrls).toHaveLength(4);
    const ab = await api('POST', `/api/uploads/${init.body.mediaId}/abort`, { filename: 'big.mp4', uploadId: 'up-1' });
    expect(ab.body).toEqual({ ok: true });
    expect(w.s3Calls).toContain('DELETE ?uploadId=up-1');
    expect((w.raw.prepare('SELECT COUNT(*) c FROM uploads').get() as { c: number }).c).toBe(0);
  });

  it('stores browser-extracted metadata in the Node-server columns', async () => {
    const r = await upload({
      name: 'script.md',
      meta: {
        kind: 'document', mime: 'text/markdown', hasThumb: false, hasPreview: false, hasPoster: false, pages: null, lines: 12, words: 99, textPreview: 'hello\nworld',
        sourceJson: JSON.stringify({ source: 'ChatGPT', evidence: 'C2PA claim' }), comfyMetadataJson: '{"nodes":[]}',
      },
    });
    const m = w.raw.prepare('SELECT * FROM media WHERE id=?').get(r.id) as Record<string, unknown>;
    expect(m).toMatchObject({ kind: 'document', codec: 'md', lines: 12, words: 99, textPreview: 'hello\nworld', source: 'ChatGPT', sourceEvidence: 'C2PA claim', comfyMetadataJson: '{"nodes":[]}' });
    expect(r.done.body.media.textPreview).toBe('hello\nworld');
  });

  it('undecodable images arrive as kind file and stay a file; a PSD keeps its webp preview', async () => {
    const f = await upload({ name: 'x.heic', sha: SHA('4'), meta: { kind: 'file', hasThumb: false, hasPreview: false, hasPoster: false } });
    expect(f.done.body.media).toMatchObject({ kind: 'file', urls: { preview: null, thumb: null } });
    const psd = await upload({ name: 'x.psd', sha: SHA('5'), assets: ['preview', 'thumb'], meta: { hasPreview: true, hasThumb: true, hasPoster: false } });
    const row = w.raw.prepare('SELECT previewKey FROM media WHERE id=?').get(psd.id) as { previewKey: string };
    expect(row.previewKey).toBe(`previews/${psd.id}.webp`);
  });

  it('PUT /api/media tells the client to use /api/uploads', async () => {
    const r = await api('PUT', '/api/media');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('/api/uploads');
  });
});

describe('media URLs', () => {
  it('variants answer 302 to a presigned R2 GET', async () => {
    const r = await upload({ assets: ['thumb', 'poster'], name: 'v.mp4', meta: { kind: 'video', mime: 'video/mp4', hasThumb: true, hasPoster: true, hasPreview: false } });
    for (const [path, needle] of [
      [`/api/media/${r.id}/original`, `originals/`], [`/api/media/${r.id}/thumb`, `thumbs/${r.id}.webp`], [`/api/media/${r.id}/poster`, `.poster.webp`],
      [`/api/media/${r.id}/preview`, `originals/`], [`/api/media/${r.id}/download`, `originals/`], [`/api/items/none/original`, ''],
    ]) {
      const res = await call(w, 'GET', path, { cookie });
      if (!needle) { expect(res.status).toBe(404); continue; }
      expect(res.status).toBe(302);
      const loc = res.headers.get('location')!;
      expect(loc).toContain(S3_HOST);
      expect(loc).toContain(needle);
      expect(loc).toContain('X-Amz-Signature=');
      expect(loc).toContain('X-Amz-Expires=3600');
    }
    const dl = new URL((await call(w, 'GET', `/api/media/${r.id}/download`, { cookie })).headers.get('location')!);
    expect(dl.searchParams.get('response-content-disposition')).toContain('attachment');
    const orig = await call(w, 'GET', `/api/media/${r.id}/original`, { cookie });
    expect(orig.headers.get('cache-control')).toContain('max-age=300');
  });

  it('a direct image (hasPreview false) serves the ORIGINAL as preview', async () => {
    const r = await upload({ meta: { hasThumb: false, hasPreview: false, hasPoster: false } });
    const loc = new URL((await call(w, 'GET', `/api/media/${r.id}/preview`, { cookie })).headers.get('location')!);
    expect(loc.pathname).toContain(r.key);
    expect(new URL((await call(w, 'GET', `/api/media/${r.id}/thumb`, { cookie })).headers.get('location')!).pathname).toContain(r.key);
  });

  it('SVG is never served inline-executable: always attachment disposition', async () => {
    const r = await upload({ name: 'logo.svg', sha: SHA('6'), meta: { mime: 'image/svg+xml', hasThumb: false, hasPreview: false, hasPoster: false } });
    for (const v of ['preview', 'original', 'thumb']) {
      const loc = new URL((await call(w, 'GET', `/api/media/${r.id}/${v}`, { cookie })).headers.get('location')!);
      expect(loc.searchParams.get('response-content-disposition')).toBe('attachment');
      expect(loc.searchParams.get('response-content-type')).toBe('image/svg+xml');
    }
  });

  it('a converted original (webp preview exists) is download-only octet-stream', async () => {
    const r = await upload({ name: 'x.psd', sha: SHA('7'), assets: ['preview'], meta: { hasPreview: true, hasThumb: false, hasPoster: false } });
    const loc = new URL((await call(w, 'GET', `/api/media/${r.id}/original`, { cookie })).headers.get('location')!);
    expect(loc.searchParams.get('response-content-type')).toBe('application/octet-stream');
    const prev = new URL((await call(w, 'GET', `/api/media/${r.id}/preview`, { cookie })).headers.get('location')!);
    expect(prev.searchParams.get('response-content-type')).toBe('image/webp');
  });

  it('/api/files/* only hands out previews and thumbs', async () => {
    expect((await call(w, 'GET', '/api/files/thumbs/abc.webp', { cookie })).status).toBe(302);
    expect((await call(w, 'GET', '/api/files/originals/ab/abc.png', { cookie })).status).toBe(404);
    expect((await call(w, 'GET', '/api/files/thumbs%2F..%2Foriginals%2Fx', { cookie })).status).toBe(404);
  });

  it('GET /api/media?ids= lists rows; unknown media is 404', async () => {
    const r = await upload();
    expect((await api('GET', `/api/media?ids=${r.id},nope`)).body.media).toHaveLength(1);
    expect((await api('GET', '/api/media/nope/thumb')).status).toBe(404);
    expect((await api('GET', `/api/media/${r.id}/info`)).body).toMatchObject({ id: r.id, filename: 'a.png', width: 640, uploadedBy: 'alice' });
  });

  it('config says cloud / s3 so the web hides Show in folder; reveal is disabled', async () => {
    const c = (await api('GET', '/api/config')).body;
    expect(c).toMatchObject({ storage: 's3', canReveal: false, cloud: true, authRequired: true });
    expect((await api('POST', '/api/items/x/reveal')).status).toBe(404);
  });
});

describe('workflow', () => {
  it('returns the stored workflow text as is; open-in-comfy returns the JSON only', async () => {
    const wf = '{"nodes":[{"id":1}],"links":[]}';
    const r = await upload({ meta: { comfyMetadataJson: wf, hasThumb: false, hasPreview: false, hasPoster: false } });
    const res = await call(w, 'GET', `/api/media/${r.id}/workflow`, { cookie });
    expect(await res.text()).toBe(wf);
    expect(res.headers.get('x-workflow-format')).toBe('workflow');
    const o = (await api('POST', `/api/media/${r.id}/open-in-comfy`)).body;
    expect(o).toMatchObject({ saved: false, workflow: wf });
    const none = await upload({ sha: SHA('8'), meta: { hasThumb: false, hasPreview: false, hasPoster: false } });
    expect((await api('GET', `/api/media/${none.id}/workflow`)).status).toBe(404);
  });
});

describe('from-url', () => {
  it.each(['http://127.0.0.1/a.png', 'http://localhost/a.png', 'http://10.1.2.3/a.png', 'http://192.168.0.5/a', 'http://[::1]/a', 'http://169.254.169.254/latest', 'http://[::ffff:127.0.0.1]/a', 'http://2130706433/a', 'http://foo.local/a', 'ftp://example.com/a', 'http://user:pw@example.com/a', 'nonsense'])(
    'SSRF guard rejects %s',
    async (url) => {
      const r = await api('POST', '/api/media/from-url', { url });
      expect(r.status).toBe(400);
      expect(r.body.error).toBeTruthy();
    },
  );

  it('rejects a redirect to a private address', async () => {
    w.external.set('cdn.example.com', () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8188/x' } }));
    const r = await api('POST', '/api/media/from-url', { url: 'https://cdn.example.com/a.png' });
    expect(r.status).toBe(400);
  });

  it('streams a file into R2 (follows a public redirect) and returns the dto', async () => {
    w.external.set('short.example.com', () => new Response(null, { status: 301, headers: { location: 'https://cdn.example.com/pics/cat.png' } }));
    w.external.set('cdn.example.com', () => new Response(bytes(2048), { headers: { 'content-type': 'image/png', 'content-length': '2048' } }));
    const r = await api('POST', '/api/media/from-url', { url: 'https://short.example.com/x' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'cat.png', deduped: false, media: { kind: 'image', sizeBytes: 2048, originalName: 'cat.png', uploadedBy: 'alice' } });
    expect(w.r2.get(`originals/${r.body.media.id.slice(0, 2)}/${r.body.media.id}.png`)).toHaveLength(2048);
  });

  it('refuses unknown size, html pages, and files over 100 MB', async () => {
    w.external.set('a.example.com', () => new Response('x', { headers: { 'content-type': 'image/png', 'transfer-encoding': 'chunked' } }));
    expect((await api('POST', '/api/media/from-url', { url: 'https://a.example.com/x.png' })).status).toBe(400);
    w.external.set('b.example.com', () => new Response('<html>', { headers: { 'content-type': 'text/html', 'content-length': '6' } }));
    expect((await api('POST', '/api/media/from-url', { url: 'https://b.example.com/' })).status).toBe(400);
    w.external.set('c.example.com', () => new Response('x', { headers: { 'content-type': 'video/mp4', 'content-length': String(101 * 1024 * 1024) } }));
    expect((await api('POST', '/api/media/from-url', { url: 'https://c.example.com/v.mp4' })).status).toBe(413);
  });
});

describe('documents', () => {
  it('read, save (new version), list versions, restore', async () => {
    const r = await upload({ name: 'notes.txt', sha: SHA('9'), meta: { kind: 'document', mime: 'text/plain', hasThumb: false, hasPreview: false, hasPoster: false } });
    w.r2.set(r.key, new TextEncoder().encode('line one\nline two'));
    const d0 = (await api('GET', `/api/media/${r.id}/document`)).body;
    expect(d0).toMatchObject({ format: 'txt', text: 'line one\nline two', editable: true, current: 'original' });
    const d1 = (await api('PUT', `/api/media/${r.id}/document`, { text: 'edited text here' })).body;
    expect(d1.text).toBe('edited text here');
    expect(d1.versions).toHaveLength(2);
    expect(d1).toMatchObject({ lines: 1, words: 3 });
    const back = (await api('POST', `/api/media/${r.id}/document/restore`, { versionId: 'original' })).body;
    expect(back.text).toBe('line one\nline two');
    expect(back.versions).toHaveLength(3);
    expect((await api('GET', `/api/media/${r.id}/document?version=nope`)).status).toBe(404);
    expect((await api('PUT', `/api/media/${r.id}/document`, { text: 5 })).status).toBe(400);
  });

  it('fdx is parsed to elements and read-only', async () => {
    const r = await upload({ name: 's.fdx', sha: SHA('0'), meta: { kind: 'document', hasThumb: false, hasPreview: false, hasPoster: false } });
    w.r2.set(r.key, new TextEncoder().encode('<?xml version="1.0"?><FinalDraft><Content><Paragraph Type="Scene Heading"><Text>int. room &amp; hall</Text></Paragraph><Paragraph Type="Dialogue"><Text>Hi.</Text></Paragraph></Content></FinalDraft>'));
    const d = (await api('GET', `/api/media/${r.id}/document`)).body;
    expect(d.elements).toEqual([{ type: 'scene', text: 'INT. ROOM & HALL' }, { type: 'dialogue', text: 'Hi.' }]);
    expect(d.editable).toBe(false);
    expect((await api('PUT', `/api/media/${r.id}/document`, { text: 'x' })).status).toBe(400);
  });
});

describe('trash purge', () => {
  it('purging an item removes its media row and R2 objects when nothing else references it', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    const r = await upload({ assets: ['thumb'] });
    await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('i1', { kind: 'image', mediaId: r.id })] });
    expect((await api('DELETE', '/api/items/i1/trash')).status).toBe(404); // not trashed yet
    await api('PUT', `/api/boards/${b.id}/items`, { deletes: [{ id: 'i1', updatedAt: 5000 }] });
    expect((await api('DELETE', '/api/items/i1/trash')).body).toEqual({ ok: true });
    expect(w.r2.has(r.key)).toBe(false);
    expect(w.r2.has(r.keys.thumb)).toBe(false);
    expect((w.raw.prepare('SELECT COUNT(*) c FROM media').get() as { c: number }).c).toBe(0);
  });

  it('the daily cron purges items trashed more than 30 days ago only', async () => {
    const b = (await api('POST', '/api/boards', { name: 'x' })).body.board;
    await api('PUT', `/api/boards/${b.id}/items`, { upserts: [item('old'), item('recent')] });
    const now = Date.now();
    await api('PUT', `/api/boards/${b.id}/items`, { deletes: [{ id: 'old', updatedAt: now - 31 * 86400000 }, { id: 'recent', updatedAt: now - 86400000 }] });
    expect(await purgeExpired(w.env, now)).toMatchObject({ items: 1 });
    const left = w.raw.prepare('SELECT id FROM items').all() as Array<{ id: string }>;
    expect(left.map((x) => x.id)).toEqual(['recent']);
  });
});
