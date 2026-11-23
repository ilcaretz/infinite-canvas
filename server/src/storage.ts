import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Options for a media URL: response headers a remote backend bakes into a presigned GET. */
export interface UrlOpts {
  mime?: string;
  /** Content-Disposition value (e.g. `attachment; filename=...`). */
  disposition?: string;
  cache?: string;
}

/** All file access goes through this interface: LocalDiskStorage (default) or S3Storage (R2). */
export interface Storage {
  readonly kind: 'local' | 's3';
  /** Write `data` (Buffer, stream, or {path} of a local file that is moved in) under `key`. */
  put(key: string, data: Buffer | Readable | { path: string }): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string, range?: { start: number; end: number }): Readable;
  size(key: string): Promise<number>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  /** URL the browser uses for a key: `/api/files/...` (local, previews/thumbs only) or a cached presigned GET (s3). */
  url(key: string, opts?: UrlOpts): Promise<string>;
  /** Absolute path of a local file for tools like ffmpeg. Local: the stored file. S3: a tmp work path for an OUTPUT, see publish(). */
  localPath(key: string): string;
  /** Absolute path for a not-yet-stored temp file. */
  tmpPath(name: string): string;
  /** Run `fn` with a readable local copy of `key` (local: the file itself; s3: downloaded to tmp\ and removed afterwards). */
  withLocal<T>(key: string, fn: (absPath: string) => Promise<T>): Promise<T>;
  /** After writing to localPath(key): make it the stored object (local: no-op; s3: upload, then delete the tmp file). */
  publish(key: string): Promise<void>;
}

export class LocalDiskStorage implements Storage {
  readonly kind = 'local' as const;
  constructor(readonly root: string) {}

  async init() {
    for (const d of ['originals', 'previews', 'thumbs', 'tmp']) await fsp.mkdir(path.join(this.root, d), { recursive: true });
  }

  localPath(key: string): string {
    const norm = path.posix.normalize(key.replaceAll('\\', '/'));
    if (norm.startsWith('..') || path.posix.isAbsolute(norm)) throw new Error(`bad storage key: ${key}`);
    return path.join(this.root, ...norm.split('/'));
  }

  tmpPath(name: string): string {
    return path.join(this.root, 'tmp', name);
  }

  async put(key: string, data: Buffer | Readable | { path: string }): Promise<void> {
    const dest = this.localPath(key);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (Buffer.isBuffer(data)) await fsp.writeFile(dest, data);
    else if ('path' in data && !(data instanceof Readable)) {
      try {
        await fsp.rename(data.path, dest);
      } catch {
        await fsp.copyFile(data.path, dest);
        await fsp.rm(data.path, { force: true });
      }
    } else await pipeline(data as Readable, fs.createWriteStream(dest));
  }

  get(key: string) {
    return fsp.readFile(this.localPath(key));
  }

  stream(key: string, range?: { start: number; end: number }) {
    return fs.createReadStream(this.localPath(key), range);
  }

  async size(key: string) {
    return (await fsp.stat(this.localPath(key))).size;
  }

  async exists(key: string) {
    try {
      await fsp.access(this.localPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string) {
    await fsp.rm(this.localPath(key), { force: true });
  }

  async url(key: string) {
    return '/api/files/' + key.split('/').map(encodeURIComponent).join('/');
  }

  withLocal<T>(key: string, fn: (absPath: string) => Promise<T>): Promise<T> {
    return fn(this.localPath(key));
  }

  async publish() {
    /* already in place */
  }
}
