/** Pure display formatters (unit-tested in format.test.ts). */

/** Duration as `m:ss.ff` (`h:mm:ss.ff` from one hour up). Hundredths, rounded, carry-safe: 59.999 s -> `1:00.00`. */
export function fmtDur(ms: number): string {
  const cs = Math.max(0, Math.round((isFinite(ms) ? ms : 0) / 10));
  const f = cs % 100;
  const total = Math.floor(cs / 100);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = `${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Whole-second clock for a board card: `m:ss` (`h:mm:ss` from one hour up). */
export function fmtClock(sec: number): string {
  const t = Math.max(0, Math.floor(isFinite(sec) ? sec : 0));
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** New time after a seek of `delta` seconds, clamped to the clip. */
export function seekBy(t: number, delta: number, duration: number): number {
  const max = isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(max, Math.max(0, t + delta));
}

/** "just now" / "5 min ago" / "3 h ago" / "2 days ago" for the trash list. */
export function timeAgo(then: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
