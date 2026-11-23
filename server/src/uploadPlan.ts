/** Multipart planning shared by the init / resume / complete routes (the web app has its own copy of the same math). */
export const MiB = 1024 * 1024;
/** Files larger than this are uploaded in parts. */
export const MULTIPART_THRESHOLD = 100 * MiB;
export const PART_SIZE = 64 * MiB;
/** S3 / R2 limit. */
export const MAX_PARTS = 10000;

export interface PartPlan {
  partNumber: number;
  /** byte offset, inclusive */
  start: number;
  /** byte offset, exclusive */
  end: number;
  size: number;
}

/** Part size for a file: 64 MiB, grown only when 64 MiB parts would exceed 10 000 parts. */
export function partSizeFor(size: number, base = PART_SIZE): number {
  return Math.max(base, Math.ceil(size / MAX_PARTS));
}

export function planParts(size: number, partSize = partSizeFor(size)): PartPlan[] {
  const out: PartPlan[] = [];
  for (let start = 0, n = 1; start < size; start += partSize, n++) {
    const end = Math.min(size, start + partSize);
    out.push({ partNumber: n, start, end, size: end - start });
  }
  return out;
}

export interface DonePart {
  partNumber: number;
  size: number;
  etag?: string;
}

/** Parts still to upload: never uploaded, or uploaded with a size that does not match the plan. */
export function missingParts(plan: PartPlan[], done: DonePart[]): PartPlan[] {
  const bySize = new Map(done.map((d) => [d.partNumber, d.size]));
  return plan.filter((p) => bySize.get(p.partNumber) !== p.size);
}
