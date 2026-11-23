import type { Item } from './types';

/** Pure helpers for the viewer (unit-tested in viewerLogic.test.ts). */

export const DEFAULT_FPS = 24;
export const MAX_SCALE = 64;
export const PIXELATE_ABOVE = 4; // 400 %
const EPS = 1e-4;

type Pos = Pick<Item, 'id' | 'x' | 'y' | 'h'>;

/**
 * Board order: top-to-bottom in row bands, left-to-right inside a band.
 * Items are sorted by y; a new band starts when an item's vertical centre falls outside the first
 * item's [y, y+h] range of the current band. Inside a band: by x (then y, then id for stability).
 */
export function boardOrder<T extends Pos>(items: T[]): T[] {
  const byY = [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const bands: T[][] = [];
  let top = 0;
  let bottom = 0;
  for (const it of byY) {
    const cy = it.y + it.h / 2;
    if (bands.length && cy >= top && cy <= bottom) bands[bands.length - 1].push(it);
    else {
      bands.push([it]);
      top = it.y;
      bottom = it.y + it.h;
    }
  }
  return bands.flatMap((b) => b.sort((a, c) => a.x - c.x || a.y - c.y || (a.id < c.id ? -1 : 1)));
}

/** Previous/next id in `order`, no wrap-around. Returns null at the ends (or if `id` is unknown). */
export function neighbour(order: string[], id: string, dir: 1 | -1): string | null {
  const i = order.indexOf(id);
  if (i < 0) return null;
  return order[i + dir] ?? null;
}

/** What the viewer can open: pictures, videos, audio, PDFs (and converted office files) and text / script documents. */
export const isViewable = (it: Pick<Item, 'kind'> & Partial<Pick<Item, 'previewUrl' | 'textPreview' | 'status' | 'mediaId'>> | undefined): boolean => {
  if (!it) return false;
  if (it.kind === 'image' || it.kind === 'video') return true;
  if (it.status !== 'ready' || !it.mediaId) return false;
  if (it.kind === 'audio') return true;
  return it.kind === 'document' && (!!it.previewUrl || it.textPreview != null);
};

export type DocViewKind = 'pdf' | 'text';
export const docViewKind = (it: Pick<Item, 'previewUrl' | 'textPreview'>): DocViewKind => (it.textPreview != null ? 'text' : 'pdf');

// ---- frame / time math ---------------------------------------------------------------------

export const safeFps = (fps: number | null | undefined) => (fps && isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS);

export const totalFrames = (durationSec: number, fps: number) =>
  !isFinite(durationSec) || durationSec <= 0 ? 0 : Math.max(1, Math.round(durationSec * fps));

/** 0-based index of the frame shown at time t. */
export function frameIndex(t: number, fps: number, total = Infinity): number {
  const n = Math.floor(t * fps + EPS);
  return Math.min(Math.max(0, n), Math.max(0, total - 1));
}

/** Time in the middle of frame n: safe to seek to (no boundary rounding ambiguity). */
export const frameMidTime = (n: number, fps: number) => (n + 0.5) / fps;

/** Frame index after stepping `delta` frames from time t, clamped to the clip. */
export function stepFrame(t: number, fps: number, total: number, delta: number): number {
  return Math.min(Math.max(0, frameIndex(t, fps, total) + delta), Math.max(0, total - 1));
}

/** mm:ss.ff, ff is the frame within the current second. */
export function formatTimecode(t: number, fps: number): string {
  const tt = Math.max(0, isFinite(t) ? t : 0);
  const whole = Math.floor(tt + EPS);
  const perSec = Math.ceil(fps - EPS);
  const ff = Math.min(perSec - 1, Math.max(0, Math.floor((tt - whole) * fps + EPS)));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ff).padStart(2, '0')}`;
}

// ---- zoom / pan -----------------------------------------------------------------------------

export interface View { s: number; tx: number; ty: number }

export function fitScale(stageW: number, stageH: number, natW: number, natH: number): number {
  if (!(natW > 0) || !(natH > 0) || !(stageW > 0) || !(stageH > 0)) return 1;
  return Math.min(stageW / natW, stageH / natH);
}

export const clampScale = (s: number, fit: number) => Math.min(MAX_SCALE, Math.max(fit / 4, s));

/**
 * Zoom by `factor` keeping the point under the cursor fixed. (px, py) is the cursor relative to the
 * stage centre; the media is centred there and drawn with translate(tx,ty) scale(s).
 */
export function zoomAt(v: View, factor: number, px: number, py: number, fit: number): View {
  const s = clampScale(v.s * factor, fit);
  const k = s / v.s;
  return { s, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

/** Double-click: fit -> 100 % (around the cursor point), anything else -> fit. */
export function toggleFit100(v: View, fit: number, px: number, py: number): View {
  const atFit = Math.abs(v.s - fit) < 1e-6 && v.tx === 0 && v.ty === 0;
  if (atFit) return zoomAt(v, 1 / v.s, px, py, fit);
  return { s: fit, tx: 0, ty: 0 };
}

export const zoomLabel = (s: number) => `${s >= 10 ? Math.round(s * 100) : Math.round(s * 1000) / 10}%`;

/**
 * Where to seek for a frame step: frame index, total frames and the mid-frame time to seek to.
 * `fps` may be missing (falls back to 24).
 */
export function stepTarget(t: number, duration: number, fps: number | null | undefined, delta: number) {
  const r = safeFps(fps);
  const total = totalFrames(duration, r);
  const frame = stepFrame(t, r, total, delta);
  return { frame, total, time: frameMidTime(frame, r), fps: r };
}
