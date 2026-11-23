import { describe, expect, it } from 'vitest';
import { fmtClock, fmtDur, seekBy, timeAgo } from './format';

describe('fmtDur', () => {
  it('pads the seconds (0:03.00, not 0:3.00)', () => {
    expect(fmtDur(3000)).toBe('0:03.00');
    expect(fmtDur(0)).toBe('0:00.00');
    expect(fmtDur(3456)).toBe('0:03.46');
    expect(fmtDur(65500)).toBe('1:05.50');
  });
  it('uses h:mm:ss.ff over an hour', () => {
    expect(fmtDur(3600_000)).toBe('1:00:00.00');
    expect(fmtDur(3723_450)).toBe('1:02:03.45');
  });
  it('carries on rounding and tolerates junk', () => {
    expect(fmtDur(59_999)).toBe('1:00.00');
    expect(fmtDur(-5)).toBe('0:00.00');
    expect(fmtDur(NaN)).toBe('0:00.00');
  });
});

describe('fmtClock / seekBy', () => {
  it('formats whole seconds', () => {
    expect(fmtClock(5.9)).toBe('0:05');
    expect(fmtClock(125)).toBe('2:05');
    expect(fmtClock(3661)).toBe('1:01:01');
  });
  it('seeks and clamps', () => {
    expect(seekBy(10, 1, 100)).toBe(11);
    expect(seekBy(10, -5, 100)).toBe(5);
    expect(seekBy(2, -5, 100)).toBe(0);
    expect(seekBy(98, 5, 100)).toBe(100);
    expect(seekBy(3, 5, NaN)).toBe(8);
  });
});

describe('timeAgo', () => {
  const now = 1_000_000_000_000;
  it('reads naturally', () => {
    expect(timeAgo(now - 5_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(timeAgo(now - 24 * 3600_000, now)).toBe('1 day ago');
    expect(timeAgo(now - 4 * 24 * 3600_000, now)).toBe('4 days ago');
    expect(timeAgo(now + 5000, now)).toBe('just now');
  });
});
