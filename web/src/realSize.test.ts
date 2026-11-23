import { describe, expect, it } from 'vitest';
import { realSizeRect, toggleRealSize } from './realSize';

describe('realSizeRect', () => {
  it('is native/z and keeps the centre', () => {
    const cur = { x: 100, y: 50, w: 200, h: 100 }; // centre (200, 100)
    for (const z of [0.25, 1, 2.5]) {
      const r = realSizeRect(cur, 1920, 1080, z);
      expect(r.w).toBeCloseTo(1920 / z);
      expect(r.h).toBeCloseTo(1080 / z);
      expect(r.x + r.w / 2).toBeCloseTo(200);
      expect(r.y + r.h / 2).toBeCloseTo(100);
    }
  });
});

describe('toggleRealSize', () => {
  const cur = { x: 0, y: 0, w: 400, h: 300 };
  it('goes to real size when nothing is remembered', () => {
    const t = toggleRealSize(cur, undefined, 800, 600, 2);
    expect(t.action).toBe('real');
    expect(t.rect).toEqual(realSizeRect(cur, 800, 600, 2));
  });
  it('restores when at real size and a previous rect exists', () => {
    const prev = { x: 5, y: 6, w: 10, h: 20 };
    const real = realSizeRect(cur, 1000, 500, 1);
    const t = toggleRealSize({ ...real, w: real.w + 0.5 }, prev, 1000, 500, 1);
    expect(t).toEqual({ action: 'restore', rect: prev });
  });
  it('re-snaps when the size differs (zoom changed or resized)', () => {
    const prev = { x: 5, y: 6, w: 10, h: 20 };
    const real = realSizeRect(cur, 1000, 500, 1);
    expect(toggleRealSize(real, prev, 1000, 500, 2).action).toBe('real');
    expect(toggleRealSize({ ...real, w: real.w + 2 }, prev, 1000, 500, 1).action).toBe('real');
  });
});
