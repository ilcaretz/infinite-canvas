import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3Storage } from '../src/s3storage.js';
import { MiB, missingParts, MULTIPART_THRESHOLD, partSizeFor, planParts, PART_SIZE } from '../src/uploadPlan.js';
import { fakeS3 } from './fakeS3.js';

let tmp = '';
let fake: ReturnType<typeof fakeS3>;
let st: S3Storage;
let clock = 1_000_000;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-s3-'));
  fake = fakeS3();
  st = new S3Storage({ bucket: 'bkt', tmpRoot: tmp, client: fake.client, presignTtlS: 3600, now: () => clock });
  await st.init();
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('S3Storage basics', () => {
  it('put(Buffer) sends bucket, key and a content type; get returns the bytes', async () => {
    await st.put('previews/a.webp', Buffer.from('hello'));
    const cmd = fake.mock.commandCalls(PutObjectCommand).find((c) => c.args[0].input.Key === 'previews/a.webp')!;
    expect(cmd.args[0].input).toMatchObject({ Bucket: 'bkt', Key: 'previews/a.webp', ContentType: 'image/webp' });
    expect((await st.get('previews/a.webp')).toString()).toBe('hello');
  });

  it('put({path}) uploads the file and removes the tmp file; put(stream) works too', async () => {
    const f = path.join(tmp, 'x.bin');
    fs.writeFileSync(f, Buffer.alloc(1000, 7));
    await st.put('originals/ab/x.bin', { path: f });
    expect(fs.existsSync(f)).toBe(false);
    expect(fake.objects.get('originals/ab/x.bin')!.length).toBe(1000);
    await st.put('versions/s.txt', Readable.from([Buffer.from('ab'), Buffer.from('cd')]));
    expect(fake.objects.get('versions/s.txt')!.toString()).toBe('abcd');
  });

  it('size / exists / delete', async () => {
    expect(await st.size('previews/a.webp')).toBe(5);
    expect(await st.exists('previews/a.webp')).toBe(true);
    expect(await st.exists('nope')).toBe(false);
    await st.delete('previews/a.webp');
    expect(await st.exists('previews/a.webp')).toBe(false);
    expect(fake.calls.delete).toContain('previews/a.webp');
  });

  it('stream supports a byte range; sha256 streams the object', async () => {
    fake.objects.set('k.bin', Buffer.from('0123456789'));
    const chunks: Buffer[] = [];
    for await (const c of st.stream('k.bin', { start: 2, end: 5 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    const { createHash } = await import('node:crypto');
    expect(await st.sha256('k.bin')).toBe(createHash('sha256').update('0123456789').digest('hex'));
    const err = await new Promise<Error>((res) => st.stream('missing').on('error', res));
    expect(err.name).toBe('NoSuchKey');
  });

  it('withLocal downloads to tmp, passes the path, then cleans up', async () => {
    fake.objects.set('originals/zz/doc.txt', Buffer.from('local copy'));
    let seen = '';
    const out = await st.withLocal('originals/zz/doc.txt', async (p) => {
      seen = p;
      expect(path.basename(p)).toBe('doc.txt');
      return fs.readFileSync(p, 'utf8');
    });
    expect(out).toBe('local copy');
    expect(fs.existsSync(seen)).toBe(false);
  });

  it('localPath + publish: the written output goes to the bucket and the tmp copy is removed', async () => {
    const p = st.localPath('thumbs/m1.webp');
    expect(path.basename(p)).toBe('m1.webp');
    fs.writeFileSync(p, 'thumb-bytes');
    await st.publish('thumbs/m1.webp');
    expect(fake.objects.get('thumbs/m1.webp')!.toString()).toBe('thumb-bytes');
    expect(fs.existsSync(p)).toBe(false);
  });
});

describe('presigned URLs', () => {
  it('GET url: endpoint + bucket path style, signature, expiry and response overrides', async () => {
    const u = new URL(await st.url('previews/a b.webp', { mime: 'image/webp', disposition: 'inline; filename="a.webp"', cache: 'public, max-age=1' }));
    expect(u.origin).toBe('https://acct.r2.cloudflarestorage.com');
    expect(u.pathname).toBe('/bkt/previews/a%20b.webp');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get('response-content-type')).toBe('image/webp');
    expect(u.searchParams.get('response-content-disposition')).toContain('inline');
    expect(u.searchParams.get('response-cache-control')).toBe('public, max-age=1');
  });

  it('is cached per key for ~50 min (same string so the browser cache works), then re-signed', async () => {
    const a = await st.url('thumbs/c.webp');
    clock += 10 * 60_000;
    expect(await st.url('thumbs/c.webp')).toBe(a);
    clock += 45 * 60_000; // 55 min since signing
    await new Promise((r) => setTimeout(r, 1100)); // the signature timestamp has 1 s resolution
    const b = await st.url('thumbs/c.webp');
    expect(b).not.toBe(a);
    expect(await st.url('thumbs/d.webp')).not.toBe(b);
  });

  it('PUT and part URLs carry the signature and the multipart query', async () => {
    const put = new URL(await st.presignPut('originals/ab/x.mp4'));
    expect(put.pathname).toBe('/bkt/originals/ab/x.mp4');
    expect(put.searchParams.get('X-Amz-Signature')).toBeTruthy();
    const part = new URL(await st.presignPart('originals/ab/x.mp4', 'UP1', 3));
    expect(part.searchParams.get('partNumber')).toBe('3');
    expect(part.searchParams.get('uploadId')).toBe('UP1');
    expect(part.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });
});

describe('multipart', () => {
  it('create, list (paged) and complete in part order', async () => {
    const id = await st.createMultipart('originals/aa/big.bin');
    const { UploadPartCommand } = await import('@aws-sdk/client-s3');
    for (const n of [3, 1, 2]) await st.client.send(new UploadPartCommand({ Bucket: 'bkt', Key: 'originals/aa/big.bin', UploadId: id, PartNumber: n, Body: Buffer.from(`p${n}`) }));
    const parts = await st.listParts('originals/aa/big.bin', id);
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(parts[0]).toMatchObject({ size: 2 });
    await st.completeMultipart('originals/aa/big.bin', id, [parts[2], parts[0], parts[1]]);
    expect(fake.calls.complete.at(-1)!.parts.map((p) => p.PartNumber)).toEqual([1, 2, 3]);
    expect(fake.objects.get('originals/aa/big.bin')!.toString()).toBe('p1p2p3');
  });
});

describe('multipart planning and resume math', () => {
  it('threshold is 100 MiB, parts are 64 MiB', () => {
    expect(MULTIPART_THRESHOLD).toBe(100 * MiB);
    expect(PART_SIZE).toBe(64 * MiB);
  });
  it('plans contiguous parts that cover the file exactly; last part is the remainder', () => {
    const size = 200 * MiB + 5;
    const plan = planParts(size);
    expect(plan.map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
    expect(plan[0]).toMatchObject({ start: 0, end: 64 * MiB, size: 64 * MiB });
    expect(plan[3]).toMatchObject({ start: 192 * MiB, end: size, size: 8 * MiB + 5 });
    for (let i = 1; i < plan.length; i++) expect(plan[i].start).toBe(plan[i - 1].end);
    expect(plan.reduce((a, p) => a + p.size, 0)).toBe(size);
  });
  it('an exact multiple has no empty trailing part; 5 GiB is 80 parts', () => {
    expect(planParts(128 * MiB)).toHaveLength(2);
    expect(planParts(5 * 1024 * MiB)).toHaveLength(80);
  });
  it('part size grows only when 64 MiB parts would exceed 10 000 parts', () => {
    expect(partSizeFor(5 * 1024 * MiB)).toBe(64 * MiB);
    const huge = 10000 * 64 * MiB + 1;
    expect(partSizeFor(huge)).toBeGreaterThan(64 * MiB);
    expect(planParts(huge).length).toBeLessThanOrEqual(10000);
  });
  it('missingParts: resume skips parts already in the bucket and redoes wrongly sized ones', () => {
    const plan = planParts(200 * MiB);
    expect(missingParts(plan, []).map((p) => p.partNumber)).toEqual([1, 2, 3, 4]);
    const done = [{ partNumber: 1, size: 64 * MiB }, { partNumber: 2, size: 10 }, { partNumber: 4, size: 8 * MiB }];
    expect(missingParts(plan, done).map((p) => p.partNumber)).toEqual([2, 3]);
    expect(missingParts(plan, plan.map((p) => ({ partNumber: p.partNumber, size: p.size })))).toEqual([]);
  });
});
