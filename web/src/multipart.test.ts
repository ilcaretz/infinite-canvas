import { describe, expect, it } from 'vitest';
import { missingParts, planParts, runMultipart, UploadCancelled, type DonePart, type MultipartTransport } from './multipart';

const MiB = 1024 * 1024;
const blob = (n: number) => ({ size: n, slice: (a: number, b: number) => ({ size: b - a, a, b }) }) as unknown as Blob;

describe('part planning and resume math', () => {
  it('64 MiB parts cover the file exactly, the last is the remainder', () => {
    const plan = planParts(200 * MiB + 5, 64 * MiB);
    expect(plan.map((p) => p.size)).toEqual([64 * MiB, 64 * MiB, 64 * MiB, 8 * MiB + 5]);
    expect(plan[3].end).toBe(200 * MiB + 5);
    expect(planParts(128 * MiB, 64 * MiB)).toHaveLength(2);
  });
  it('missingParts skips done parts and redoes wrongly sized ones', () => {
    const plan = planParts(200 * MiB, 64 * MiB);
    const done: DonePart[] = [{ partNumber: 1, size: 64 * MiB }, { partNumber: 2, size: 5 }, { partNumber: 4, size: 8 * MiB }];
    expect(missingParts(plan, done).map((p) => p.partNumber)).toEqual([2, 3]);
  });
});

function transport(over: Partial<MultipartTransport> & { fail?: (url: string, call: number) => boolean } = {}) {
  const sent: string[] = [];
  let active = 0;
  let maxActive = 0;
  const calls = new Map<string, number>();
  const t: MultipartTransport = {
    async putPart(url, b, onProgress) {
      active++;
      maxActive = Math.max(maxActive, active);
      const c = (calls.get(url) ?? 0) + 1;
      calls.set(url, c);
      await Promise.resolve();
      onProgress(b.size / 2);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      if (over.fail?.(url, c)) throw new Error('boom');
      sent.push(url);
      return `"e-${url}"`;
    },
    resume: over.resume ?? (async () => ({ partSize: 10, parts: [], partUrls: [] })),
    sleep: async () => {},
    cancelled: over.cancelled,
  };
  return { t, sent, calls, maxActive: () => maxActive };
}

describe('runMultipart', () => {
  const urls = (n: number, tag = 'u') => Array.from({ length: n }, (_, i) => `${tag}${i + 1}`);

  it('sends every part once, 3 in parallel at most, and returns ordered ETags', async () => {
    const x = transport();
    const progress: number[] = [];
    const parts = await runMultipart(blob(100), x.t, { partSize: 10, partUrls: urls(10), onProgress: (b) => progress.push(b) });
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(parts[2].etag).toBe('"e-u3"');
    expect(x.sent).toHaveLength(10);
    expect(x.maxActive()).toBeLessThanOrEqual(3);
    expect(x.maxActive()).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(100);
    expect(Math.max(...progress)).toBeLessThanOrEqual(100);
  });

  it('a part that fails is retried (same URL) without touching the others', async () => {
    const x = transport({ fail: (url, c) => url === 'u2' && c < 3 });
    await runMultipart(blob(30), x.t, { partSize: 10, partUrls: urls(3), partRetries: 2 });
    expect(x.calls.get('u2')).toBe(3);
    expect(x.calls.get('u1')).toBe(1);
  });

  it('when a part keeps failing the upload resumes from the bucket: finished parts are not sent again, fresh URLs are used', async () => {
    let resumed = 0;
    const x = transport({
      fail: (url) => url === 'old2', // the stale URL of part 2 never works
      resume: async () => {
        resumed++;
        // the bucket already has part 1 (confirmed) and part 3 (finished while we were retrying)
        return { partSize: 10, parts: [{ partNumber: 1, size: 10, etag: '"b1"' }, { partNumber: 3, size: 10, etag: '"b3"' }], partUrls: urls(3, 'new') };
      },
    });
    const parts = await runMultipart(blob(30), x.t, { partSize: 10, partUrls: urls(3, 'old'), partRetries: 1 });
    expect(resumed).toBe(1);
    expect(x.calls.get('new2')).toBe(1);
    expect(x.calls.has('new1')).toBe(false);
    expect(x.calls.has('new3')).toBe(false);
    expect(parts.map((p) => p.etag)).toEqual(['"b1"', '"e-new2"', '"b3"']);
  });

  it('resume reporting a part with the wrong size sends that part again', async () => {
    let first = true;
    const x = transport({
      fail: (url, c) => url === 'a2' && c <= 2,
      resume: async () => {
        first = false;
        return { partSize: 10, parts: [{ partNumber: 1, size: 10 }, { partNumber: 2, size: 3 }], partUrls: urls(3, 'b') };
      },
    });
    const parts = await runMultipart(blob(30), x.t, { partSize: 10, partUrls: urls(3, 'a'), partRetries: 1 });
    expect(first).toBe(false);
    expect(x.calls.get('b2')).toBe(1);
    expect(x.calls.get('b3')).toBe(1);
    expect(parts).toHaveLength(3);
  });

  it('gives up after the resume rounds are used up', async () => {
    const x = transport({ fail: () => true });
    await expect(runMultipart(blob(20), x.t, { partSize: 10, partUrls: urls(2), partRetries: 0, maxResumeRounds: 2 })).rejects.toThrow(/could not be sent/);
  });

  it('survives the resume call itself failing once', async () => {
    let n = 0;
    const x = transport({
      fail: (url, c) => url === 'u1' && c < 2,
      resume: async () => {
        if (++n === 1) throw new Error('server down');
        return { partSize: 10, parts: [], partUrls: urls(1) };
      },
    });
    const parts = await runMultipart(blob(10), x.t, { partSize: 10, partUrls: urls(1), partRetries: 0 });
    expect(parts).toHaveLength(1);
  });

  it('cancel stops with UploadCancelled and sends nothing more', async () => {
    let cancel = false;
    const x = transport({ cancelled: () => cancel });
    cancel = true;
    await expect(runMultipart(blob(30), x.t, { partSize: 10, partUrls: urls(3) })).rejects.toBeInstanceOf(UploadCancelled);
    expect(x.sent).toHaveLength(0);
  });
});
