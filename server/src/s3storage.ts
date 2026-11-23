import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, DeleteObjectCommand, GetObjectCommand,
  HeadObjectCommand, ListPartsCommand, PutObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PART_SIZE, type DonePart } from './uploadPlan.js';
import type { Storage, UrlOpts } from './storage.js';

export interface S3Options {
  bucket: string;
  /** DATA_DIR: tmp\ (work files for ffmpeg / sharp) lives under it. */
  tmpRoot: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Presigned URL lifetime in seconds. */
  presignTtlS?: number;
  /** Tests inject a (mocked) client. */
  client?: S3Client;
  now?: () => number;
}

const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp', mp4: 'video/mp4', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain',
};

export const isNotFound = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x?.name === 'NotFound' || x?.name === 'NoSuchKey' || x?.$metadata?.httpStatusCode === 404;
};

/** Cloudflare R2 (or any S3 API). Media bytes go browser <-> bucket via presigned URLs; this class only signs, lists and does server-side transfers. */
export class S3Storage implements Storage {
  readonly kind = 's3' as const;
  readonly client: S3Client;
  readonly bucket: string;
  readonly ttl: number;
  private urlCache = new Map<string, { url: string; until: number }>();
  private now: () => number;

  constructor(private opts: S3Options) {
    this.bucket = opts.bucket;
    this.ttl = opts.presignTtlS ?? 3600;
    this.now = opts.now ?? Date.now;
    this.client =
      opts.client ??
      new S3Client({
        region: opts.region || 'auto',
        endpoint: opts.endpoint,
        forcePathStyle: true,
        credentials: { accessKeyId: opts.accessKeyId ?? '', secretAccessKey: opts.secretAccessKey ?? '' },
        // R2 rejects the SDK's default CRC checksums on presigned requests
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      });
  }

  async init() {
    await fsp.mkdir(path.join(this.opts.tmpRoot, 'tmp', 's3'), { recursive: true });
  }

  // ---- local work files -----------------------------------------------------------------------

  private workDir(key: string) {
    return path.join(this.opts.tmpRoot, 'tmp', 's3', createHash('sha1').update(key).digest('hex').slice(0, 16));
  }

  /** Deterministic tmp path for an output (keeps the key's file name so ffmpeg sees the extension). */
  localPath(key: string): string {
    const dir = this.workDir(key);
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, path.posix.basename(key));
  }

  tmpPath(name: string): string {
    return path.join(this.opts.tmpRoot, 'tmp', name);
  }

  async publish(key: string): Promise<void> {
    const p = this.localPath(key);
    await this.put(key, { path: p });
    await fsp.rm(this.workDir(key), { recursive: true, force: true });
  }

  async withLocal<T>(key: string, fn: (absPath: string) => Promise<T>): Promise<T> {
    const dir = path.join(this.opts.tmpRoot, 'tmp', 's3', `dl-${randomUUID()}`);
    await fsp.mkdir(dir, { recursive: true });
    const dest = path.join(dir, path.posix.basename(key));
    try {
      await pipeline(this.stream(key), fs.createWriteStream(dest));
      return await fn(dest);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  // ---- Storage ------------------------------------------------------------------------------

  async put(key: string, data: Buffer | Readable | { path: string }): Promise<void> {
    const ContentType = MIME_BY_EXT[key.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream';
    if (Buffer.isBuffer(data)) {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType }));
      return;
    }
    const file = !(data instanceof Readable) && 'path' in data ? data.path : null;
    const body = file ? fs.createReadStream(file) : (data as Readable);
    const up = new Upload({ client: this.client, params: { Bucket: this.bucket, Key: key, Body: body, ContentType }, partSize: PART_SIZE, queueSize: 3, leavePartsOnError: false });
    await up.done();
    if (file) await fsp.rm(file, { force: true });
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  stream(key: string, range?: { start: number; end: number }): Readable {
    const out = new PassThrough();
    this.client
      .send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }))
      .then((r) => {
        const body = r.Body as Readable;
        body.on('error', (e) => out.destroy(e));
        body.pipe(out);
      })
      .catch((e) => out.destroy(e));
    return out;
  }

  async head(key: string): Promise<{ size: number; etag: string | null }> {
    const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return { size: Number(r.ContentLength ?? 0), etag: r.ETag ?? null };
  }

  async size(key: string) {
    return (await this.head(key)).size;
  }

  async exists(key: string) {
    try {
      await this.head(key);
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    await fsp.rm(this.workDir(key), { recursive: true, force: true });
  }

  /** SHA-256 of the stored object, streamed (never held in RAM). */
  async sha256(key: string): Promise<string> {
    const h = createHash('sha256');
    for await (const chunk of this.stream(key)) h.update(chunk as Buffer);
    return h.digest('hex');
  }

  // ---- presigned URLs -------------------------------------------------------------------------

  /** Presigned GET, cached per key+headers for ~50 min (or 5/6 of the TTL) so the browser's HTTP cache keeps working. */
  async url(key: string, opts: UrlOpts = {}): Promise<string> {
    const ck = `${key}\n${opts.mime ?? ''}\n${opts.disposition ?? ''}\n${opts.cache ?? ''}`;
    const hit = this.urlCache.get(ck);
    const t = this.now();
    if (hit && hit.until > t) return hit.url;
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket, Key: key, ResponseContentType: opts.mime, ResponseContentDisposition: opts.disposition, ResponseCacheControl: opts.cache,
      }),
      { expiresIn: this.ttl },
    );
    this.urlCache.set(ck, { url, until: t + Math.min(50 * 60_000, this.ttl * 1000 * 0.83) });
    if (this.urlCache.size > 5000) for (const [k, v] of this.urlCache) if (v.until <= t) this.urlCache.delete(k);
    return url;
  }

  presignPut(key: string, ttl = this.ttl): Promise<string> {
    return getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: ttl });
  }

  // ---- multipart ------------------------------------------------------------------------------

  async createMultipart(key: string): Promise<string> {
    const r = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: 'application/octet-stream' }));
    if (!r.UploadId) throw new Error('no UploadId returned');
    return r.UploadId;
  }

  presignPart(key: string, uploadId: string, partNumber: number, ttl = this.ttl): Promise<string> {
    return getSignedUrl(this.client, new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: ttl });
  }

  async listParts(key: string, uploadId: string): Promise<Required<DonePart>[]> {
    const out: Required<DonePart>[] = [];
    let marker: string | undefined;
    for (;;) {
      const r = await this.client.send(new ListPartsCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker, MaxParts: 1000 }));
      for (const p of r.Parts ?? []) out.push({ partNumber: p.PartNumber!, size: Number(p.Size ?? 0), etag: p.ETag ?? '' });
      if (!r.IsTruncated) break;
      marker = String(r.NextPartNumberMarker);
    }
    return out;
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.bucket, Key: key, UploadId: uploadId,
      MultipartUpload: { Parts: sorted.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
    }));
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }));
  }
}
