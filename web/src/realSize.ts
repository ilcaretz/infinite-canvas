import type { Rect } from './geometry';

/** Tolerance (world px) when deciding whether an item is still at the real-size rect we set. */
export const REAL_SIZE_EPS = 1;

/** Rect where 1 media pixel = 1 screen pixel at zoom z, keeping the rect's centre fixed. */
export function realSizeRect(cur: Rect, nativeW: number, nativeH: number, z: number): Rect {
  const w = nativeW / z;
  const h = nativeH / z;
  return { x: cur.x + cur.w / 2 - w / 2, y: cur.y + cur.h / 2 - h / 2, w, h };
}

/** True when `cur` has the same size as `real` (within eps world px). */
export function sizeMatches(cur: Rect, real: Rect, eps = REAL_SIZE_EPS): boolean {
  return Math.abs(cur.w - real.w) <= eps && Math.abs(cur.h - real.h) <= eps;
}

/**
 * Double-click toggle. `prev` = remembered previous rect (if any).
 * Restore when a previous rect exists and the item's size still equals its real-size rect at the current zoom;
 * otherwise go to real size (and the caller remembers `cur`).
 */
export function toggleRealSize(
  cur: Rect, prev: Rect | undefined, nativeW: number, nativeH: number, z: number,
): { action: 'restore'; rect: Rect } | { action: 'real'; rect: Rect } {
  const real = realSizeRect(cur, nativeW, nativeH, z);
  if (prev && sizeMatches(cur, real)) return { action: 'restore', rect: prev };
  return { action: 'real', rect: real };
}
