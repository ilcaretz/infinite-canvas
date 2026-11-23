import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaRow, Repo } from './db.js';
import { extOf } from './detect.js';
import type { Processor } from './process.js';
import type { Storage } from './storage.js';
import type { S3Storage } from './s3storage.js';

export class TooLargeError extends Error {}
export class EmptyFileError extends Error {}

export interface IngestContext {
  repo: Repo;
  storage: Storage;
  processor: Processor;
  maxBytes: number;
}

export function originalKeyFor(sha256: string, name: string): string {
  const ext = extOf(name);
  return `originals/${sha256.slice(0, 2)}/${sha256}${ext ? '.' + ext : ''}`;
}

/**
 * Stream `source` to tmp\ while hashing (never buffers the file in RAM), enforce the size limit,
 * de-duplicate by sha256, store the original byte-for-byte and queue processing.
 */
export async function ingestStream(ctx: IngestContext, source: Readable, originalName: string): Promise<{ media: MediaRow; deduped: boolean }> {
  const tmp = ctx.storage.tmpPath(`${randomUUID()}.part`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > ctx.maxBytes) return cb(new TooLargeError(`file is larger than ${(ctx.maxBytes / 1024 ** 3).toFixed(1)} GB`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(source, meter, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  if (size === 0) {
    await fsp.rm(tmp, { force: true });
    throw new EmptyFileError('file is empty');
  }
  const sha = hash.digest('hex');
  const existing = ctx.repo.getMediaBySha(sha);
  if (existing) {
    await fsp.rm(tmp, { force: true });
    if (existing.status === 'failed') {
      ctx.repo.updateMedia(existing.id, { status: 'processing', error: null });
      ctx.processor.enqueue(existing.id);
      return { media: ctx.repo.getMedia(existing.id)!, deduped: true };
    }
    return { media: existing, deduped: true };
  }
  const key = originalKeyFor(sha, originalName);
  const media = ctx.repo.insertMedia({
    id: randomUUID(), originalKey: key, mime: 'application/octet-stream', sizeBytes: size, sha256: sha, originalName: originalName.slice(0, 255),
  });
  try {
    await ctx.storage.put(key, { path: tmp });
  } catch (e) {
    ctx.repo.db.prepare('DELETE FROM media WHERE id=?').run(media.id);
    await fsp.rm(tmp, { force: true });
    throw e;
  }
  ctx.processor.enqueue(media.id);
  return { media, deduped: false };
}

/** Key of a browser-uploaded original in s3 mode: derived from the media id (the sha is only known after the upload). */
export function remoteOriginalKey(mediaId: string, name: string): string {
  const ext = extOf(name);
  return `originals/${mediaId.slice(0, 2)}/${mediaId}${ext ? '.' + ext : ''}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An original the browser PUT straight into the bucket under `key`: hash it by streaming it back from the bucket (server side),
 * enforce the limits, de-duplicate by sha256 and queue processing. Idempotent: calling it again for the same media id returns the same row.
 */
export async function ingestRemote(
  ctx: IngestContext, storage: S3Storage, mediaId: string, key: string, originalName: string,
): Promise<{ media: MediaRow; deduped: boolean }> {
  const done = ctx.repo.getMedia(mediaId);
  if (done) return { media: done, deduped: false };
  let size: number;
  try {
    size = (await storage.head(key)).size;
  } catch {
    throw new MissingUploadError('upload not found in storage');
  }
  if (size > ctx.maxBytes) {
    await storage.delete(key);
    throw new TooLargeError(`file is larger than ${(ctx.maxBytes / 1024 ** 3).toFixed(1)} GB`);
  }
  if (size === 0) {
    await storage.delete(key);
    throw new EmptyFileError('file is empty');
  }
  const sha = await storage.sha256(key);
  const existing = ctx.repo.getMediaBySha(sha);
  if (existing) {
    if (existing.originalKey !== key) await storage.delete(key);
    if (existing.status === 'failed') {
      ctx.repo.updateMedia(existing.id, { status: 'processing', error: null });
      ctx.processor.enqueue(existing.id);
      return { media: ctx.repo.getMedia(existing.id)!, deduped: true };
    }
    return { media: existing, deduped: true };
  }
  const media = ctx.repo.insertMedia({
    id: mediaId, originalKey: key, mime: 'application/octet-stream', sizeBytes: size, sha256: sha, originalName: originalName.slice(0, 255),
  });
  ctx.processor.enqueue(media.id);
  return { media, deduped: false };
}

export class MissingUploadError extends Error {}
