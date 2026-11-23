import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand,
  HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { createHash } from 'node:crypto';

const notFound = () => Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
const noUpload = () => Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload', $metadata: { httpStatusCode: 404 } });

async function bodyToBuffer(b: unknown): Promise<Buffer> {
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b instanceof Uint8Array) return Buffer.from(b);
  const chunks: Buffer[] = [];
  for await (const c of b as Readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

/** An in-memory bucket behind a mocked S3Client (no network). */
export function fakeS3() {
  const client = new S3Client({ region: 'auto', endpoint: 'https://acct.r2.cloudflarestorage.com', forcePathStyle: true, credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' } });
  const mock = mockClient(client);
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  const calls = { put: [] as string[], get: [] as string[], delete: [] as string[], abort: [] as string[], complete: [] as Array<{ key: string; parts: Array<{ PartNumber?: number; ETag?: string }> }> };
  let n = 0;

  mock.on(PutObjectCommand).callsFake(async (i) => {
    const buf = await bodyToBuffer(i.Body);
    objects.set(i.Key, buf);
    calls.put.push(i.Key);
    return { ETag: etagOf(buf) };
  });
  mock.on(GetObjectCommand).callsFake(async (i) => {
    const o = objects.get(i.Key);
    if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
    calls.get.push(i.Key);
    let data = o;
    if (i.Range) {
      const m = /bytes=(\d+)-(\d+)/.exec(i.Range)!;
      data = o.subarray(Number(m[1]), Number(m[2]) + 1);
    }
    return { Body: Object.assign(Readable.from([data]), { transformToByteArray: async () => new Uint8Array(data) }) as never, ContentLength: data.length };
  });
  mock.on(HeadObjectCommand).callsFake(async (i) => {
    const o = objects.get(i.Key);
    if (!o) throw notFound();
    return { ContentLength: o.length, ETag: etagOf(o) };
  });
  mock.on(DeleteObjectCommand).callsFake(async (i) => {
    objects.delete(i.Key);
    calls.delete.push(i.Key);
    return {};
  });
  mock.on(CreateMultipartUploadCommand).callsFake(async (i) => {
    const id = `up-${++n}`;
    uploads.set(id, { key: i.Key, parts: new Map() });
    return { UploadId: id };
  });
  mock.on(UploadPartCommand).callsFake(async (i) => {
    const u = uploads.get(i.UploadId);
    if (!u) throw noUpload();
    const buf = await bodyToBuffer(i.Body);
    u.parts.set(i.PartNumber, buf);
    return { ETag: etagOf(buf) };
  });
  mock.on(ListPartsCommand).callsFake(async (i) => {
    const u = uploads.get(i.UploadId);
    if (!u) throw noUpload();
    const all = [...u.parts.entries()].sort((a, b) => a[0] - b[0]).filter(([k]) => k > Number(i.PartNumberMarker ?? 0));
    const page = all.slice(0, i.MaxParts ?? 1000);
    const truncated = all.length > page.length;
    return {
      Parts: page.map(([k, b]) => ({ PartNumber: k, Size: b.length, ETag: etagOf(b) })),
      IsTruncated: truncated, NextPartNumberMarker: truncated ? String(page[page.length - 1][0]) : undefined,
    };
  });
  mock.on(CompleteMultipartUploadCommand).callsFake(async (i) => {
    const u = uploads.get(i.UploadId);
    if (!u) throw noUpload();
    const parts = i.MultipartUpload?.Parts ?? [];
    calls.complete.push({ key: i.Key, parts });
    const bufs = parts.map((p) => {
      const b = u.parts.get(p.PartNumber!);
      if (!b || etagOf(b) !== p.ETag) throw Object.assign(new Error('InvalidPart'), { name: 'InvalidPart' });
      return b;
    });
    objects.set(u.key, Buffer.concat(bufs));
    uploads.delete(i.UploadId);
    return {};
  });
  mock.on(AbortMultipartUploadCommand).callsFake(async (i) => {
    calls.abort.push(i.UploadId);
    uploads.delete(i.UploadId);
    return {};
  });

  return { client, mock, objects, uploads, calls };
}
