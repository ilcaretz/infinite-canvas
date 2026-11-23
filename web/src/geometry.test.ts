import { describe, expect, it } from 'vitest';
import {
  boundsOf, fitBounds, fitInCell, gridLayout, MAX_ZOOM, MIN_ZOOM, normalizeWheelDelta,
  resizeBox, screenToWorld, wheelZoomFactor, worldToScreen, zoomAt,
} from './geometry';

describe('screen <-> world', () => {
  it('round-trips at many zooms', () => {
    for (const z of [0.02, 0.1, 0.5, 1, 3.7, 32]) {
      const cam = { x: -123.4, y: 987.6, z };
      const p = { x: 412.5, y: 77.25 };
      const back = worldToScreen(screenToWorld(p, cam), cam);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });
  it('identity camera maps 1:1', () => {
    expect(screenToWorld({ x: 10, y: 20 }, { x: 0, y: 0, z: 1 })).toEqual({ x: 10, y: 20 });
  });
  it('applies translate then scale', () => {
    expect(screenToWorld({ x: 150, y: 250 }, { x: 50, y: 50, z: 2 })).toEqual({ x: 50, y: 100 });
  });
});

describe('zoomAt', () => {
  it('keeps the cursor world point fixed', () => {
    const cam = { x: 30, y: -40, z: 0.8 };
    const cursor = { x: 640, y: 360 };
    const before = screenToWorld(cursor, cam);
    for (const f of [0.5, 1.3, 7, 0.01]) {
      const next = zoomAt(cam, cursor, cam.z * f);
      const after = screenToWorld(cursor, next);
      expect(after.x).toBeCloseTo(before.x, 8);
      expect(after.y).toBeCloseTo(before.y, 8);
    }
  });
  it('clamps zoom to 0.02..32 and still keeps the point fixed', () => {
    const cam = { x: 0, y: 0, z: 1 };
    const cursor = { x: 300, y: 200 };
    const hi = zoomAt(cam, cursor, 1000);
    const lo = zoomAt(cam, cursor, 0.0001);
    expect(hi.z).toBe(MAX_ZOOM);
    expect(lo.z).toBe(MIN_ZOOM);
    expect(screenToWorld(cursor, hi).x).toBeCloseTo(300, 8);
    expect(screenToWorld(cursor, lo).y).toBeCloseTo(200, 8);
  });
  it('wheel factor is exp(-dy*0.0015); lines/pages normalised', () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-0.15), 12);
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(normalizeWheelDelta(3, 1, 800)).toBe(99);
    expect(normalizeWheelDelta(1, 2, 800)).toBe(800);
    expect(normalizeWheelDelta(120, 0, 800)).toBe(120);
  });
});

describe('fit all', () => {
  it('boundsOf unions rects; empty -> null', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([{ x: 0, y: 0, w: 10, h: 10 }, { x: 50, y: -20, w: 5, h: 5 }])).toEqual({ x: 0, y: -20, w: 55, h: 30 });
  });
  it('centers the bounds and fits inside the padded viewport', () => {
    const b = { x: 100, y: 100, w: 4000, h: 2000 };
    const vp = { w: 1000, h: 800 };
    const cam = fitBounds(b, vp, 50, 1);
    expect(cam.z).toBeCloseTo(900 / 4000, 9);
    const c = worldToScreen({ x: 2100, y: 1100 }, cam);
    expect(c.x).toBeCloseTo(500, 9);
    expect(c.y).toBeCloseTo(400, 9);
    const tl = worldToScreen({ x: b.x, y: b.y }, cam);
    expect(tl.x).toBeGreaterThanOrEqual(50 - 1e-9);
  });
  it('never zooms in past maxZoom for tiny content', () => {
    expect(fitBounds({ x: 0, y: 0, w: 10, h: 10 }, { w: 1000, h: 800 }, 80, 1).z).toBe(1);
  });
});

describe('gridLayout', () => {
  it('single cell at origin', () => {
    expect(gridLayout(1, { x: 5, y: 7 }, 480, 24)).toEqual([{ x: 5, y: 7, w: 480, h: 480 }]);
  });
  it('uses ceil(sqrt(n)) columns, row-major, with gaps', () => {
    const g = gridLayout(5, { x: 0, y: 0 }, 100, 10);
    expect(g).toHaveLength(5);
    expect(g[0]).toMatchObject({ x: 0, y: 0 });
    expect(g[2]).toMatchObject({ x: 220, y: 0 });
    expect(g[3]).toMatchObject({ x: 0, y: 110 });
    expect(g[4]).toMatchObject({ x: 110, y: 110 });
  });
  it('zero count -> empty; explicit columns honoured', () => {
    expect(gridLayout(0, { x: 0, y: 0 })).toEqual([]);
    expect(gridLayout(4, { x: 0, y: 0 }, 10, 0, 4).every((r) => r.y === 0)).toBe(true);
  });
  it('fitInCell keeps the slot center and a 480 long side', () => {
    const cell = { x: 100, y: 100, w: 480, h: 480 };
    expect(fitInCell(cell, 2)).toEqual({ x: 100, y: 220, w: 480, h: 240 });
    expect(fitInCell(cell, 0.5)).toEqual({ x: 220, y: 100, w: 240, h: 480 });
  });
});

describe('resizeBox', () => {
  const box = { x: 0, y: 0, w: 200, h: 100 };
  it('se corner locked keeps ratio and anchors nw', () => {
    const r = resizeBox(box, 'se', 100, 0, true);
    expect(r.w / r.h).toBeCloseTo(2, 9);
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
  it('nw corner anchors the se corner', () => {
    const r = resizeBox(box, 'nw', -100, -50, true);
    expect(r.x + r.w).toBeCloseTo(200, 9);
    expect(r.y + r.h).toBeCloseTo(100, 9);
  });
  it('free edge changes one dimension only', () => {
    expect(resizeBox(box, 'e', 50, 999, false)).toEqual({ x: 0, y: 0, w: 250, h: 100 });
  });
  it('locked edge centers the other axis', () => {
    const r = resizeBox(box, 'e', 200, 0, true);
    expect(r.w).toBe(400);
    expect(r.h).toBe(200);
    expect(r.y).toBe(-50);
  });
  it('never collapses below the minimum', () => {
    expect(resizeBox(box, 'e', -5000, 0, false).w).toBe(8);
  });
});
