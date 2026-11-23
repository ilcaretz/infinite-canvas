import { api, type CloudInit, type CloudMeta, type UploadInit } from './api';
import type { MediaDto } from './types';
import { runMultipart, UploadCancelled } from './multipart';

/** PUT a Blob to a presigned URL with progress; resolves with the ETag header ('' when CORS hides it). */
function putBlob(url: string, blob: Blob, onProgress: (loaded: number) => void, headers: Record<string, string>, track: Set<XMLHttpRequest>): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    track.add(xhr);
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded);
    };
    xhr.onload = () => {
      track.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) resolve((xhr.getResponseHeader('ETag') ?? '').trim());
      else reject(new Error(`storage answered HTTP ${xhr.status}`));
    };
    xhr.onerror = () => {
      track.delete(xhr);
      reject(new Error('network error while uploading'));
    };
    xhr.onabort = () => {
      track.delete(xhr);
      reject(new UploadCancelled());
    };
    xhr.send(blob);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry a short call (complete / init) on network errors and 5xx; 4xx answers are final. */
async function retrying<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (/^HTTP 4\d\d$/.test((e as Error).message) || (e as Error).message === 'aborted') break;
      await sleep(500 * 2 ** i);
    }
  }
  throw last;
}

/**
 * s3 mode upload: the file goes browser -> bucket (presigned PUT, or 64 MiB parts 3 at a time for big files, resumable);
 * the app server only signs, completes (hashes) and processes. Same shape as api.uploadFile.
 */
export interface BucketHooks {
  /** replaces the plain init call (cloud mode: sends the sha256; may answer `deduped` = nothing to upload) */
  init?: (name: string, size: number, type: string) => Promise<CloudInit>;
  /** runs once the original is stored, before complete: returns the metadata the browser produced (cloud mode) */
  beforeComplete?: (init: UploadInit) => Promise<CloudMeta | undefined>;
}

export function uploadToBucket(file: File, onProgress: (frac: number) => void, hooks?: BucketHooks): { promise: Promise<MediaDto>; abort: () => void } {
  const xhrs = new Set<XMLHttpRequest>();
  let cancelled = false;
  const abort = () => {
    cancelled = true;
    for (const x of [...xhrs]) x.abort();
  };
  const name = file.name || 'file';
  const frac = (bytes: number) => onProgress(file.size ? Math.min(1, bytes / file.size) : 1);

  const promise = (async (): Promise<MediaDto> => {
    const type = file.type || 'application/octet-stream';
    const first = await retrying(() => (hooks?.init ? hooks.init(name, file.size, type) : api.uploadsInit(name, file.size, type)));
    if ('deduped' in first && first.deduped) return first.media;
    const init = first as UploadInit;
    if (init.mode === 'single') {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (cancelled) throw new Error('aborted');
        try {
          await putBlob(init.url, file, frac, init.headers, xhrs);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (e instanceof UploadCancelled) throw new Error('aborted');
          await sleep(800 * 2 ** attempt);
        }
      }
      if (lastErr) throw lastErr;
      const meta = await hooks?.beforeComplete?.(init);
      return (await retrying(() => api.uploadsComplete(init.mediaId, { filename: name, size: file.size, ...(meta ? { meta } : {}) }))).media;
    }
    try {
      const parts = await runMultipart(
        file,
        {
          putPart: (url, blob, p) => putBlob(url, blob, p, {}, xhrs),
          resume: () => api.uploadsResume(init.mediaId, name, init.uploadId, file.size),
          sleep,
          cancelled: () => cancelled,
        },
        { partSize: init.partSize, partUrls: init.partUrls, parallel: 3, onProgress: frac },
      );
      // without a readable ETag header (CORS) send no parts: the server lists them from the bucket itself
      const etags = parts.every((p) => p.etag) ? parts : [];
      const meta = await hooks?.beforeComplete?.(init);
      return (await retrying(() => api.uploadsComplete(init.mediaId, { filename: name, size: file.size, uploadId: init.uploadId, parts: etags, ...(meta ? { meta } : {}) }))).media;
    } catch (e) {
      if (e instanceof UploadCancelled || cancelled) {
        void api.uploadsAbort(init.mediaId, name, init.uploadId).catch(() => {});
        throw new Error('aborted');
      }
      throw e;
    }
  })();
  return { promise, abort };
}
