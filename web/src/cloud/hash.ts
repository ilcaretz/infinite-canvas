import { createSHA256 } from 'hash-wasm';

export const HASH_CHUNK = 8 * 1024 * 1024;

/** sha256 (lowercase hex) of a Blob/File, read in chunks: a multi-GB file is never held in memory. */
export async function sha256Blob(blob: Blob, onProgress?: (frac: number) => void, chunk = HASH_CHUNK, cancelled?: () => boolean): Promise<string> {
  const h = await createSHA256();
  h.init();
  for (let pos = 0; pos < blob.size; pos += chunk) {
    if (cancelled?.()) throw new Error('aborted');
    h.update(new Uint8Array(await blob.slice(pos, Math.min(blob.size, pos + chunk)).arrayBuffer()));
    onProgress?.(Math.min(1, (pos + chunk) / blob.size));
  }
  const hex = h.digest('hex');
  onProgress?.(1);
  return hex;
}
