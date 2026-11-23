// Pure math for the board. No DOM, no React: unit-tested in geometry.test.ts.

export interface Vec { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
/** World -> screen: screen = world * z + (x, y). */
export interface Camera { x: number; y: number; z: number }
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;
export const WHEEL_SENSITIVITY = 0.0015;
/** Pixels per "line" when a browser reports wheel deltas in lines (Firefox): ~100px per 3-line notch. */
export const WHEEL_LINE_PX = 33;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function screenToWorld(p: Vec, cam: Camera): Vec {
  return { x: (p.x - cam.x) / cam.z, y: (p.y - cam.y) / cam.z };
}

export function worldToScreen(p: Vec, cam: Camera): Vec {
  return { x: p.x * cam.z + cam.x, y: p.y * cam.z + cam.y };
}

/** Set the zoom to `newZoom` (clamped) keeping the world point under `screen` fixed. */
export function zoomAt(cam: Camera, screen: Vec, newZoom: number): Camera {
  const z = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
  const w = screenToWorld(screen, cam);
  return { x: screen.x - w.x * z, y: screen.y - w.y * z, z };
}

/** deltaMode 0 = pixels, 1 = lines, 2 = pages. */
export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * pageHeight;
  return deltaY;
}

export const wheelZoomFactor = (deltaPx: number) => Math.exp(-deltaPx * WHEEL_SENSITIVITY);

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function rectFromPoints(a: Vec, b: Vec): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Camera that shows `b` centered in the viewport with `padding` px margin; zoom never above `maxZoom`. */
export function fitBounds(
  b: Rect,
  viewport: { w: number; h: number },
  padding = 80,
  maxZoom = 1,
): Camera {
  const availW = Math.max(1, viewport.w - 2 * padding);
  const availH = Math.max(1, viewport.h - 2 * padding);
  const z = clamp(Math.min(availW / Math.max(b.w, 1e-6), availH / Math.max(b.h, 1e-6), maxZoom), MIN_ZOOM, MAX_ZOOM);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { x: viewport.w / 2 - cx * z, y: viewport.h / 2 - cy * z, z };
}

/**
 * Tidy grid of `count` square cells starting at `origin` (top-left of the first cell).
 * Row-major; columns = ceil(sqrt(count)) unless given.
 */
export function gridLayout(count: number, origin: Vec, cell = 480, gap = 24, cols?: number): Rect[] {
  if (count <= 0) return [];
  const c = Math.max(1, cols ?? Math.ceil(Math.sqrt(count)));
  const out: Rect[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: origin.x + (i % c) * (cell + gap), y: origin.y + Math.floor(i / c) * (cell + gap), w: cell, h: cell });
  }
  return out;
}

/** Rect with aspect ratio `aspect` (w/h), long side = cell's side, centered in `cell`. */
export function fitInCell(cell: Rect, aspect: number): Rect {
  const a = aspect > 0 && isFinite(aspect) ? aspect : 1;
  const long = Math.max(cell.w, cell.h);
  const w = a >= 1 ? long : long * a;
  const h = a >= 1 ? long / a : long;
  return { x: cell.x + (cell.w - w) / 2, y: cell.y + (cell.h - h) / 2, w, h };
}

/**
 * New box when dragging `handle` by (dx, dy) world px. keepAspect locks the ratio
 * (corners anchor the opposite corner; edges anchor the opposite edge and center the other axis).
 */
export function resizeBox(box: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean, min = 8): Rect {
  const { x, y, w, h } = box;
  const hasW = handle.includes('w');
  const hasE = handle.includes('e');
  const hasN = handle.includes('n');
  const hasS = handle.includes('s');
  const horiz = hasW || hasE;
  const vert = hasN || hasS;
  let nw = w;
  let nh = h;
  if (hasE) nw = w + dx;
  else if (hasW) nw = w - dx;
  if (hasS) nh = h + dy;
  else if (hasN) nh = h - dy;
  if (keepAspect && w > 0 && h > 0) {
    let s: number;
    if (horiz && vert) s = Math.max(nw / w, nh / h);
    else if (horiz) s = nw / w;
    else s = nh / h;
    s = Math.max(s, min / w, min / h);
    nw = w * s;
    nh = h * s;
  } else {
    nw = Math.max(nw, min);
    nh = Math.max(nh, min);
  }
  const nx = hasW ? x + w - nw : hasE ? x : x + (w - nw) / 2;
  const ny = hasN ? y + h - nh : hasS ? y : y + (h - nh) / 2;
  return { x: nx, y: ny, w: nw, h: nh };
}

/** Map `r` (inside `from`) to the same relative place inside `to`. */
export function scaleRectInBox(r: Rect, from: Rect, to: Rect): Rect {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (r.x - from.x) * sx, y: to.y + (r.y - from.y) * sy, w: r.w * sx, h: r.h * sy };
}
