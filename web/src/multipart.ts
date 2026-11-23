/** Pure multipart-upload logic (planning, resume, retry, parallelism). No network here: the caller injects the transport. */

export interface PartPlan {
  partNumber: number;
  /** inclusive */
  start: number;
  /** exclusive */
  end: number;
  size: number;
}

export interface DonePart {
  partNumber: number;
  size: number;
  etag?: string;
}

/** Same math as the server (uploadPlan.ts): contiguous parts, last one is the remainder. */
export function planParts(size: number, partSize: number): PartPlan[] {
  const out: PartPlan[] = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    const end = Math.min(size, start + partSize);
    out.push({ partNumber: n, start, end, size: end - start });
  }
  return out;
}

/** Parts the bucket does not hold yet (or holds with a wrong size). */
export function missingParts(plan: PartPlan[], done: DonePart[]): PartPlan[] {
  const bySize = new Map(done.map((d) => [d.partNumber, d.size]));
  return plan.filter((p) => bySize.get(p.partNumber) !== p.size);
}

export interface MultipartTransport {
  /** PUT one part; resolves with the ETag header ('' when the browser cannot read it). */
  putPart(url: string, blob: Blob, onProgress: (loaded: number) => void): Promise<string>;
  /** Ask the server what the bucket holds + fresh part URLs. */
  resume(): Promise<{ partSize: number; parts: DonePart[]; partUrls: string[] }>;
  sleep(ms: number): Promise<void>;
  /** True once the user cancelled: stop without error rounds. */
  cancelled?(): boolean;
}

export interface MultipartOptions {
  partSize: number;
  partUrls: string[];
  parallel?: number;
  /** extra tries of ONE part before the whole round is declared failed and the upload is resumed from the bucket */
  partRetries?: number;
  /** resume rounds that may pass without finishing before giving up */
  maxResumeRounds?: number;
  /** total bytes confirmed or in flight (monotone enough for a progress bar) */
  onProgress?: (bytes: number) => void;
}

export class UploadCancelled extends Error {
  constructor() {
    super('aborted');
  }
}

/** Upload every missing part, `parallel` at a time; a failed round resumes from the parts the bucket already has. */
export async function runMultipart(file: Blob, t: MultipartTransport, o: MultipartOptions): Promise<Array<{ partNumber: number; etag: string }>> {
  const parallel = o.parallel ?? 3;
  const retries = o.partRetries ?? 2;
  const maxRounds = o.maxResumeRounds ?? 5;
  let partSize = o.partSize;
  let urls = o.partUrls;
  const plan = () => planParts(file.size, partSize);
  const done = new Map<number, { size: number; etag: string }>();
  const inflight = new Map<number, number>();
  const report = () => {
    let b = 0;
    for (const d of done.values()) b += d.size;
    for (const v of inflight.values()) b += v;
    o.onProgress?.(Math.min(b, file.size));
  };

  let rounds = 0;
  for (;;) {
    if (t.cancelled?.()) throw new UploadCancelled();
    const todo = missingParts(plan(), [...done].map(([partNumber, d]) => ({ partNumber, size: d.size })));
    if (!todo.length) break;
    let failed = 0;
    const queue = [...todo];
    const worker = async () => {
      for (let part = queue.shift(); part; part = queue.shift()) {
        let ok = false;
        for (let attempt = 0; attempt <= retries && !ok; attempt++) {
          if (t.cancelled?.()) throw new UploadCancelled();
          try {
            const etag = await t.putPart(urls[part.partNumber - 1], file.slice(part.start, part.end), (loaded) => {
              inflight.set(part!.partNumber, Math.min(loaded, part!.size));
              report();
            });
            done.set(part.partNumber, { size: part.size, etag });
            ok = true;
          } catch (e) {
            if (e instanceof UploadCancelled || t.cancelled?.()) throw new UploadCancelled();
            await t.sleep(400 * 2 ** attempt);
          } finally {
            inflight.delete(part.partNumber);
            report();
          }
        }
        if (!ok) failed++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
    if (!failed) continue;
    // some parts kept failing (dead link, expired URLs...): learn what the bucket really has and carry on from there
    if (++rounds > maxRounds) throw new Error(`upload failed: ${failed} part(s) could not be sent`);
    await t.sleep(Math.min(8000, 1000 * rounds));
    try {
      const r = await t.resume();
      if (r.partSize !== partSize) partSize = r.partSize;
      urls = r.partUrls;
      done.clear();
      for (const p of r.parts) done.set(p.partNumber, { size: p.size, etag: p.etag ?? '' });
      report();
    } catch {
      /* server unreachable too: the next round tries again with the old URLs */
    }
  }
  return [...done].map(([partNumber, d]) => ({ partNumber, etag: d.etag })).sort((a, b) => a.partNumber - b.partNumber);
}
