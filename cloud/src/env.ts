export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // vars
  S3_BUCKET: string;
  S3_REGION?: string;
  PRESIGN_TTL_S?: string;
  MAX_FILE_GB?: string;
  // secrets
  USERS: string;
  SESSION_SECRET: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  /** Tests only: replaces global fetch for S3 API calls (multipart) and for from-url downloads. */
  TEST_FETCH?: typeof fetch;
}

export const MiB = 1024 * 1024;
export const MULTIPART_THRESHOLD = 100 * MiB;
export const PART_SIZE = 64 * MiB;
export const MAX_PARTS = 10000;
export const FROM_URL_MAX = 100 * MiB;
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;

export const maxFileBytes = (env: Env) => {
  const gb = Number(env.MAX_FILE_GB ?? 5);
  return Math.floor((Number.isFinite(gb) && gb > 0 ? gb : 5) * 1024 ** 3);
};
export const presignTtl = (env: Env) => Math.max(60, Math.min(604800, Number(env.PRESIGN_TTL_S) || 3600));

export function partSizeFor(size: number): number {
  return Math.max(PART_SIZE, Math.ceil(size / MAX_PARTS));
}
export function planParts(size: number, partSize = partSizeFor(size)) {
  const out: Array<{ partNumber: number; start: number; end: number; size: number }> = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    const end = Math.min(size, start + partSize);
    out.push({ partNumber: n, start, end, size: end - start });
  }
  return out;
}
