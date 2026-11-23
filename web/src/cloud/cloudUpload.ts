/**
 * Cloud-mode upload: the Worker cannot hash / resize / probe (10 ms CPU), so this browser does it.
 *   sha256 (streamed) -> init (dedupe or presigned URLs) -> original PUT (reused s3upload / multipart code)
 *   -> thumb / preview / poster PUT to the presigned assetUrls -> complete with `meta`.
 */
import { api, type CloudAssetUrls, type CloudInit, type CloudMeta } from '../api';
import { uploadToBucket } from '../s3upload';
import type { MediaDto } from '../types';
import { buildAssets, type BuiltAssets } from './assets';
import { analyzeMetadata, type FileMetadata } from './comfyMeta';
import { sha256Blob } from './hash';
import { detectKind } from './sniff';

const HEAD_BYTES = 65536; // server readHead()
const HASH_SHARE = 0.1; // progress bar: 0-10 % hashing, 10-95 % original upload, last 5 % assets + complete

/** PUT one generated asset to its presigned URL (3 tries), content-type = the blob's real type (Safari canvas yields image/png). False when it could not be stored: the item simply has no such preview. */
export async function putAsset(url: string, blob: Blob, fetchFn: typeof fetch = fetch): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetchFn(url, { method: 'PUT', headers: { 'content-type': blob.type || 'image/webp' }, body: blob });
      if (r.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
  }
  return false;
}

export interface Derived { sha256: string; assets: BuiltAssets; metadata: FileMetadata }

/** The `meta` object of the complete call (pure; exported for tests). */
export function completeMeta(d: Derived, stored: { thumb: boolean; preview: boolean; poster: boolean }): CloudMeta {
  const a = d.assets;
  return {
    sha256: d.sha256, mime: a.mime, kind: a.kind, width: a.width, height: a.height, durationMs: a.durationMs, fps: a.fps, codec: a.codec,
    comfyMetadataJson: d.metadata.comfyMetadataJson, sourceJson: d.metadata.sourceJson,
    hasThumb: stored.thumb, hasPreview: stored.preview, hasPoster: stored.poster, pages: a.pages,
    textPreview: a.text?.textPreview ?? null, lines: a.text?.lines ?? null, words: a.text?.words ?? null,
  };
}

/** Browser-side derivation of everything the server used to compute from the stored original. Never throws. */
export async function deriveAssets(file: File): Promise<{ assets: BuiltAssets; metadata: FileMetadata }> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  const assets = await buildAssets(file, head);
  const det = detectKind(head, file.name, file.type);
  // the server scans image / video / audio containers; documents and plain files only get the filename check
  const scan = det.kind === 'image' || det.kind === 'video' || det.kind === 'audio';
  const metadata = await analyzeMetadata(file, file.name, scan).catch((): FileMetadata => ({ comfyMetadataJson: null, sourceJson: null }));
  return { assets, metadata };
}

/** Same shape as api.uploadFile / uploadToBucket. */
export function uploadToCloud(file: File, onProgress: (frac: number) => void): { promise: Promise<MediaDto>; abort: () => void } {
  let cancelled = false;
  let sha256 = '';
  let urls: CloudAssetUrls = {};
  let derived: Promise<{ assets: BuiltAssets; metadata: FileMetadata }> | null = null;

  const inner = uploadToBucket(file, (f) => onProgress(HASH_SHARE + (0.95 - HASH_SHARE) * f), {
    init: async (filename, size, mime): Promise<CloudInit> => {
      sha256 ||= await sha256Blob(file, (f) => onProgress(HASH_SHARE * f), undefined, () => cancelled);
      const init = await api.uploadsInitCloud({ filename, size, mime, sha256 });
      if (!init.deduped) {
        urls = init.assetUrls ?? {};
        derived ??= deriveAssets(file); // runs while the original travels
      }
      return init;
    },
    beforeComplete: async () => {
      const d = await derived!;
      const { assets } = d;
      const put = (url: string | null | undefined, blob: Blob | null) => (url && blob ? putAsset(url, blob) : Promise.resolve(false));
      const [thumb, preview, poster] = await Promise.all([put(urls.thumb, assets.thumb), put(urls.preview, assets.preview), put(urls.poster, assets.poster)]);
      onProgress(0.98);
      return completeMeta({ sha256, ...d }, { thumb, preview, poster });
    },
  });
  return {
    promise: inner.promise.then((m) => {
      onProgress(1);
      return m;
    }),
    abort: () => {
      cancelled = true;
      inner.abort();
    },
  };
}
