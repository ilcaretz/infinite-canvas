// Pure helpers for `text` items (style presets, font scaling, resize). Unit-tested in textGroup.test.ts.
import { resizeBox, type Handle, type Rect } from './geometry';

export type TextAlign = 'left' | 'center' | 'right';
export interface TextProps { text: string; size: number; color: string; bold: boolean; align: TextAlign }

export const TEXT_SIZES = [
  { label: 'S', size: 20 }, { label: 'M', size: 32 }, { label: 'L', size: 56 }, { label: 'XL', size: 96 },
] as const;
export const TEXT_COLORS = [
  { name: 'White', value: '#f2f2f2' }, { name: 'Light grey', value: '#b4b4bc' }, { name: 'Black', value: '#000000' },
  { name: 'Blue', value: '#4c8dff' }, { name: 'Yellow', value: '#f2ff59' },
] as const;
export const TEXT_DEFAULT: TextProps = { text: '', size: 32, color: '#f2f2f2', bold: false, align: 'left' };
export const TEXT_LINE_HEIGHT = 1.2;
export const TEXT_DEFAULT_W = 360;
export const TEXT_MIN_W = 24;
export const TEXT_MIN_SIZE = 6;
export const TEXT_MAX_SIZE = 600;

/** Fill in defaults for whatever a stored / remote props object lacks. */
export function textProps(p: unknown): TextProps {
  const r = (p && typeof p === 'object' ? p : {}) as Partial<TextProps>;
  return {
    text: typeof r.text === 'string' ? r.text : '',
    size: typeof r.size === 'number' && isFinite(r.size) && r.size > 0 ? r.size : TEXT_DEFAULT.size,
    color: typeof r.color === 'string' && r.color ? r.color : TEXT_DEFAULT.color,
    bold: r.bold === true,
    align: r.align === 'center' || r.align === 'right' ? r.align : 'left',
  };
}

/** Preset label (S/M/L/XL) when the size matches one exactly, else null (custom, e.g. after Shift-scaling). */
export function sizeLabel(size: number): string | null {
  return TEXT_SIZES.find((s) => s.size === size)?.label ?? null;
}

/** Font size after scaling by `k`, rounded and kept in a sane range. */
export function scaleFont(size: number, k: number): number {
  if (!(k > 0) || !isFinite(k)) return size;
  return Math.min(TEXT_MAX_SIZE, Math.max(TEXT_MIN_SIZE, Math.round(size * k)));
}

/** Height of `text` at `size` before the browser measured it (one line per newline; wrapping is measured later). */
export function estimateTextHeight(text: string, size: number): number {
  return Math.max(1, text.split('\n').length) * size * TEXT_LINE_HEIGHT;
}

/** Name stored in the items table (also what the trash list shows). */
export function textName(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Resize a text item by dragging `handle` (dx, dy world px). Side handles and plain corners only change the width
 * (text wraps, height follows the content); a corner with Shift scales the font proportionally.
 */
export function resizeText(box: Rect, size: number, handle: Handle, dx: number, dy: number, shift: boolean): { rect: Rect; size: number } {
  const west = handle.includes('w');
  const east = handle.includes('e');
  if (!west && !east) return { rect: box, size }; // n / s: height is the content's
  const corner = handle.length === 2;
  if (corner && shift) {
    const nb = resizeBox(box, handle, dx, dy, true, TEXT_MIN_W);
    return { rect: nb, size: scaleFont(size, nb.w / box.w) };
  }
  const nb = resizeBox(box, west ? 'w' : 'e', dx, 0, false, TEXT_MIN_W);
  return { rect: { x: nb.x, y: box.y, w: nb.w, h: box.h }, size };
}
