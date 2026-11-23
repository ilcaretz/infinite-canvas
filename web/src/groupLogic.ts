// Pure helpers for `group` items (ComfyUI-style frames). Unit-tested in textGroup.test.ts.
import { boundsOf, type Handle, type Rect, type Vec } from './geometry';

export interface GroupProps { title: string; color: string }

export const GROUP_COLORS = [
  { name: 'Grey', value: '#6b6b75' }, { name: 'Red', value: '#c0504d' }, { name: 'Green', value: '#4f9a5a' },
  { name: 'Blue', value: '#4c7fd6' }, { name: 'Yellow', value: '#d4b23a' },
] as const;
export const GROUP_DEFAULT: GroupProps = { title: 'Group', color: GROUP_COLORS[3].value };
export const GROUP_TITLE_H = 56; // world px, the top strip of the group's own rect
export const GROUP_PAD = 24;
export const GROUP_DEFAULT_W = 600;
export const GROUP_DEFAULT_H = 400;
const EPS = 0.01;

export function groupProps(p: unknown): GroupProps {
  const r = (p && typeof p === 'object' ? p : {}) as Partial<GroupProps>;
  return {
    title: typeof r.title === 'string' ? r.title : GROUP_DEFAULT.title,
    color: typeof r.color === 'string' && r.color ? r.color : GROUP_DEFAULT.color,
  };
}

/** "#rrggbb" + alpha -> rgba(). Unparseable colours come back unchanged. */
export function hexA(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Rect of a new group around `selection`: their bounding box + padding on every side + room for the title bar. */
export function groupRectFromSelection(selection: Rect[]): Rect | null {
  const b = boundsOf(selection);
  if (!b) return null;
  return { x: b.x - GROUP_PAD, y: b.y - GROUP_PAD - GROUP_TITLE_H, w: b.w + 2 * GROUP_PAD, h: b.h + 2 * GROUP_PAD + GROUP_TITLE_H };
}

/** Default group with its top-left at the click point. */
export function defaultGroupRect(at: Vec): Rect {
  return { x: at.x, y: at.y, w: GROUP_DEFAULT_W, h: GROUP_DEFAULT_H };
}

export const titleRect = (g: Rect): Rect => ({ x: g.x, y: g.y, w: g.w, h: Math.min(GROUP_TITLE_H, g.h) });

/** `inner` lies completely inside `outer` (touching edges counts). */
export function isFullyInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x - EPS && inner.y >= outer.y - EPS
    && inner.x + inner.w <= outer.x + outer.w + EPS && inner.y + inner.h <= outer.y + outer.h + EPS;
}

interface Boxed extends Rect { id: string; kind: string }

/** Ids of every other item (groups included, so nested groups and their contents) fully inside `group`. */
export function groupContents(group: Boxed, items: Iterable<Boxed>): string[] {
  const out: string[] = [];
  for (const it of items) if (it.id !== group.id && isFullyInside(it, group)) out.push(it.id);
  return out;
}

/** Everything that moves when the selection is dragged: the selection plus the contents of each selected group (frozen at drag start). */
export function moveSet(selection: Iterable<string>, items: Record<string, Boxed>): string[] {
  const out = new Set<string>();
  const all = Object.values(items);
  for (const id of selection) {
    const it = items[id];
    if (!it) continue;
    out.add(id);
    if (it.kind === 'group') for (const c of groupContents(it, all)) out.add(c);
  }
  return [...out];
}

/** Number of other groups that fully contain `g` (identical rects: the lower id counts as the outer one). */
const depthOf = (g: Boxed, groups: Boxed[]) =>
  groups.filter((o) => o.id !== g.id && isFullyInside(g, o) && !(isFullyInside(o, g) && o.id > g.id)).length;

/** Groups back to front: a group never renders above a group it lies inside; otherwise by their own z. */
export function groupRenderOrder<T extends Boxed & { z: number }>(groups: T[]): T[] {
  const d = new Map(groups.map((g) => [g.id, depthOf(g, groups)]));
  return [...groups].sort((a, b) => d.get(a.id)! - d.get(b.id)! || a.z - b.z || (a.id < b.id ? -1 : 1));
}

export const GROUP_MIN_W = 160;
export const GROUP_MIN_H = 100;

/**
 * Freeform group resize: side handles move only their own edge on one axis, corners follow the pointer with the
 * opposite corner fixed. No aspect lock. Min size enforced; the moving edge stops at min distance from the fixed one.
 */
export function resizeGroup(box: Rect, handle: Handle, dx: number, dy: number, minW = GROUP_MIN_W, minH = GROUP_MIN_H): Rect {
  let l = box.x, t = box.y, r = box.x + box.w, b = box.y + box.h;
  if (handle.includes('w')) l = Math.min(l + dx, r - minW);
  else if (handle.includes('e')) r = Math.max(r + dx, l + minW);
  if (handle.includes('n')) t = Math.min(t + dy, b - minH);
  else if (handle.includes('s')) b = Math.max(b + dy, t + minH);
  return { x: l, y: t, w: r - l, h: b - t };
}
