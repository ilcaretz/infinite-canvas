import { describe, expect, it } from 'vitest';
import {
  boardOrder, clampScale, fitScale, formatTimecode, frameIndex, frameMidTime, neighbour, safeFps, stepFrame,
  toggleFit100, totalFrames, zoomAt, zoomLabel,
} from './viewerLogic';

const mk = (id: string, x: number, y: number, h = 100) => ({ id, x, y, h });

describe('boardOrder', () => {
  it('sorts rows top-to-bottom then left-to-right', () => {
    const o = boardOrder([mk('d', 0, 300), mk('b', 500, 10), mk('a', 0, 0), mk('c', 250, 30), mk('e', 400, 310)]);
    expect(o.map((i) => i.id)).toEqual(['a', 'c', 'b', 'd', 'e']);
  });
  it('treats slightly offset items as one row', () => {
    const o = boardOrder([mk('r', 300, 0), mk('l', 0, 40)]);
    expect(o.map((i) => i.id)).toEqual(['l', 'r']);
  });
  it('handles empty input', () => expect(boardOrder([])).toEqual([]));
});

describe('neighbour', () => {
  const ord = ['a', 'b', 'c'];
  it('moves and does not wrap', () => {
    expect(neighbour(ord, 'b', 1)).toBe('c');
    expect(neighbour(ord, 'b', -1)).toBe('a');
    expect(neighbour(ord, 'c', 1)).toBeNull();
    expect(neighbour(ord, 'a', -1)).toBeNull();
    expect(neighbour(ord, 'zz', 1)).toBeNull();
  });
});

describe('frame/time math', () => {
  it('falls back to 24 fps', () => {
    expect(safeFps(null)).toBe(24);
    expect(safeFps(0)).toBe(24);
    expect(safeFps(30)).toBe(30);
  });
  it('totalFrames', () => {
    expect(totalFrames(2, 24)).toBe(48);
    expect(totalFrames(NaN, 24)).toBe(0);
  });
  it('frameIndex is stable at frame boundaries and mid-frame', () => {
    expect(frameIndex(0, 24)).toBe(0);
    expect(frameIndex(5 / 24, 24)).toBe(5);
    expect(frameIndex(frameMidTime(7, 24), 24)).toBe(7);
    expect(frameIndex(100, 24, 48)).toBe(47);
  });
  it('stepFrame is exactly one frame and clamps', () => {
    const t = frameMidTime(10, 30);
    expect(stepFrame(t, 30, 100, 1)).toBe(11);
    expect(stepFrame(t, 30, 100, -1)).toBe(9);
    expect(stepFrame(0.001, 30, 100, -1)).toBe(0);
    expect(stepFrame(frameMidTime(99, 30), 30, 100, 1)).toBe(99);
  });
  it('formatTimecode mm:ss.ff', () => {
    expect(formatTimecode(0, 24)).toBe('00:00.00');
    expect(formatTimecode(61 + 5 / 24, 24)).toBe('01:01.05');
    expect(formatTimecode(0.99, 24)).toBe('00:00.23');
    expect(formatTimecode(NaN, 24)).toBe('00:00.00');
  });
});

describe('zoom', () => {
  it('fitScale', () => {
    expect(fitScale(1000, 500, 2000, 500)).toBeCloseTo(0.5);
    expect(fitScale(0, 0, 10, 10)).toBe(1);
  });
  it('clamps between fit/4 and 64x', () => {
    expect(clampScale(0.001, 0.5)).toBeCloseTo(0.125);
    expect(clampScale(1000, 0.5)).toBe(64);
  });
  it('keeps the point under the cursor fixed', () => {
    const v = { s: 0.5, tx: 10, ty: -20 };
    const px = 120, py = 80;
    const n = zoomAt(v, 3, px, py, 0.5);
    const img = { x: (px - v.tx) / v.s, y: (py - v.ty) / v.s };
    expect(n.tx + img.x * n.s).toBeCloseTo(px);
    expect(n.ty + img.y * n.s).toBeCloseTo(py);
  });
  it('double-click toggles fit <-> 100 %', () => {
    const fit = 0.4;
    const a = toggleFit100({ s: fit, tx: 0, ty: 0 }, fit, 50, 50);
    expect(a.s).toBeCloseTo(1);
    const b = toggleFit100(a, fit, 50, 50);
    expect(b).toEqual({ s: fit, tx: 0, ty: 0 });
  });
  it('zoomLabel', () => {
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.5)).toBe('50%');
    expect(zoomLabel(0.333)).toBe('33.3%');
    expect(zoomLabel(8)).toBe('800%');
  });
});
