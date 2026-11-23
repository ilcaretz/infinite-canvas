import { describe, expect, it } from 'vitest';
import {
  GROUP_PAD, GROUP_TITLE_H, defaultGroupRect, groupContents, groupRectFromSelection, groupRenderOrder, hexA, isFullyInside, moveSet, resizeGroup, titleRect,
} from './groupLogic';
import { BoardStore } from './store';
import {
  TEXT_DEFAULT, estimateTextHeight, resizeText, scaleFont, sizeLabel, textName, textProps,
} from './textLogic';
import type { Item } from './types';

const box = (id: string, kind: string, x: number, y: number, w: number, h: number, z = 0) => ({ id, kind, x, y, w, h, z });
const mkItem = (id: string, kind: Item['kind'], x: number, y: number, w: number, h: number): Item => ({
  id, kind, x, y, w, h, z: 0, version: 0, updatedAt: 0, name: id, ext: '', mime: '', sizeBytes: 0, src: null, durationMs: null,
});

describe('group containment at drag start', () => {
  const g = box('g', 'group', 0, 0, 500, 400);
  const inside = box('in', 'image', 20, 60, 100, 100);
  const touching = box('edge', 'image', 400, 300, 100, 100); // flush with the group's bottom-right corner
  const sticksOut = box('out', 'image', 450, 100, 100, 100); // 50 px past the right edge
  const outside = box('far', 'image', 900, 900, 50, 50);

  it('fully-inside rule: partial overlap is not contained, touching edges are', () => {
    expect(isFullyInside(inside, g)).toBe(true);
    expect(isFullyInside(touching, g)).toBe(true);
    expect(isFullyInside(sticksOut, g)).toBe(false);
    expect(groupContents(g, [g, inside, touching, sticksOut, outside]).sort()).toEqual(['edge', 'in']);
  });

  it('nested groups move with their contents; a group never contains itself', () => {
    const inner = box('g2', 'group', 10, 50, 300, 200);
    const deep = box('deep', 'image', 20, 100, 50, 50);
    const peer = box('g3', 'group', 450, 50, 200, 100); // half outside
    const all = [g, inner, deep, inside, peer, outside];
    expect(groupContents(g, all).sort()).toEqual(['deep', 'g2', 'in']);
    const items = Object.fromEntries(all.map((i) => [i.id, i]));
    expect(moveSet(['g'], items).sort()).toEqual(['deep', 'g', 'g2', 'in']);
    expect(moveSet(['g2'], items).sort()).toEqual(['deep', 'g2', 'in']);
    expect(moveSet(['in', 'far'], items).sort()).toEqual(['far', 'in']);
  });

  it('render order: larger-behind-smaller, otherwise own z', () => {
    const big = box('big', 'group', 0, 0, 1000, 1000, 9);
    const small = box('small', 'group', 100, 100, 200, 200, 1); // lower z, but inside big: must stay in front of it
    const other = box('other', 'group', 2000, 0, 100, 100, 5);
    const lowZ = box('low', 'group', 3000, 0, 100, 100, 2);
    expect(groupRenderOrder([small, big]).map((x) => x.id)).toEqual(['big', 'small']);
    expect(groupRenderOrder([other, lowZ, small, big]).map((x) => x.id)).toEqual(['low', 'other', 'big', 'small']);
  });

  it('dragging a group in the store moves contents as one undo step', () => {
    const s = new BoardStore();
    s.addItems([mkItem('g', 'group', 0, 0, 500, 400), mkItem('a', 'image', 20, 60, 100, 100), mkItem('z', 'image', 900, 0, 50, 50)]);
    const ids = moveSet(['g'], s.getState().items);
    const before = s.snapshot(ids);
    const patches: Record<string, Partial<Item>> = {};
    for (const id of ids) patches[id] = { x: before[id].x + 100 };
    s.transientPatch(patches);
    s.commit('move', before);
    expect(s.getState().items.a.x).toBe(120);
    expect(s.getState().items.z.x).toBe(900);
    s.undo();
    expect(s.getState().items.g.x).toBe(0);
    expect(s.getState().items.a.x).toBe(20);
  });
});

describe('group rect', () => {
  it('bbox of the selection + 24 px padding + title bar', () => {
    const r = groupRectFromSelection([{ x: 100, y: 200, w: 50, h: 40 }, { x: 300, y: 260, w: 100, h: 100 }])!;
    expect(r).toEqual({ x: 100 - GROUP_PAD, y: 200 - GROUP_PAD - GROUP_TITLE_H, w: 300 + 2 * GROUP_PAD, h: 160 + 2 * GROUP_PAD + GROUP_TITLE_H });
    // the new group contains what it was built from
    expect(isFullyInside({ x: 100, y: 200, w: 50, h: 40 }, r)).toBe(true);
    expect(isFullyInside({ x: 300, y: 260, w: 100, h: 100 }, r)).toBe(true);
    expect(groupRectFromSelection([])).toBeNull();
  });
  it('default group is 600x400 at the click point; title strip is the top of it', () => {
    expect(defaultGroupRect({ x: 5, y: 7 })).toEqual({ x: 5, y: 7, w: 600, h: 400 });
    expect(titleRect({ x: 0, y: 0, w: 600, h: 400 })).toEqual({ x: 0, y: 0, w: 600, h: GROUP_TITLE_H });
    expect(titleRect({ x: 0, y: 0, w: 600, h: 10 }).h).toBe(10);
  });
  it('hexA builds rgba', () => {
    expect(hexA('#4c7fd6', 0.18)).toBe('rgba(76, 127, 214, 0.18)');
    expect(hexA('red', 0.5)).toBe('red');
  });
});

describe('text style and size math', () => {
  it('defaults and size labels', () => {
    expect(textProps(undefined)).toEqual(TEXT_DEFAULT);
    expect(textProps({ text: 'a', size: 56, bold: true, align: 'right' })).toMatchObject({ text: 'a', size: 56, bold: true, align: 'right', color: '#f2f2f2' });
    expect(textProps({ size: -3, align: 'weird' })).toMatchObject({ size: 32, align: 'left' });
    expect([20, 32, 56, 96].map(sizeLabel)).toEqual(['S', 'M', 'L', 'XL']);
    expect(sizeLabel(33)).toBeNull();
  });
  it('font scaling rounds and clamps', () => {
    expect(scaleFont(32, 1.5)).toBe(48);
    expect(scaleFont(32, 0.001)).toBe(6);
    expect(scaleFont(500, 10)).toBe(600);
    expect(scaleFont(32, NaN)).toBe(32);
  });
  it('height estimate and trash name', () => {
    expect(estimateTextHeight('a\nb\nc', 20)).toBeCloseTo(72);
    expect(estimateTextHeight('', 32)).toBeCloseTo(38.4);
    expect(textName('  hello \n  world  ')).toBe('hello world');
    expect(textName('x'.repeat(100))).toHaveLength(60);
  });
  it('side / plain-corner resize changes the width only; Shift-corner scales the font', () => {
    const b = { x: 100, y: 100, w: 200, h: 40 };
    const e = resizeText(b, 32, 'e', 100, 50, false);
    expect(e.rect).toEqual({ x: 100, y: 100, w: 300, h: 40 });
    expect(e.size).toBe(32);
    const w = resizeText(b, 32, 'w', 50, 0, false);
    expect(w.rect).toEqual({ x: 150, y: 100, w: 150, h: 40 });
    expect(resizeText(b, 32, 'se', 100, 100, false)).toEqual({ rect: { x: 100, y: 100, w: 300, h: 40 }, size: 32 });
    expect(resizeText(b, 32, 'n', 0, -50, false)).toEqual({ rect: b, size: 32 });
    const s = resizeText(b, 32, 'se', 200, 0, true);
    expect(s.rect.w).toBe(400);
    expect(s.rect.h).toBe(80);
    expect(s.size).toBe(64);
    expect(resizeText(b, 32, 'e', -500, 0, false).rect.w).toBe(24); // min width
  });
});

describe('resizeGroup', () => {
  const b = { x: 100, y: 100, w: 400, h: 300 };
  it('side handles change one edge on one axis only', () => {
    expect(resizeGroup(b, 'e', 50, 999)).toEqual({ x: 100, y: 100, w: 450, h: 300 });
    expect(resizeGroup(b, 'w', 50, 999)).toEqual({ x: 150, y: 100, w: 350, h: 300 });
    expect(resizeGroup(b, 's', 999, 40)).toEqual({ x: 100, y: 100, w: 400, h: 340 });
    expect(resizeGroup(b, 'n', 999, -40)).toEqual({ x: 100, y: 60, w: 400, h: 340 });
  });
  it('corners are freeform, opposite corner fixed', () => {
    expect(resizeGroup(b, 'se', 30, -20)).toEqual({ x: 100, y: 100, w: 430, h: 280 });
    expect(resizeGroup(b, 'nw', -30, 20)).toEqual({ x: 70, y: 120, w: 430, h: 280 });
    expect(resizeGroup(b, 'ne', 30, 20)).toEqual({ x: 100, y: 120, w: 430, h: 280 });
    expect(resizeGroup(b, 'sw', -30, -20)).toEqual({ x: 70, y: 100, w: 430, h: 280 });
  });
  it('enforces min size and never flips', () => {
    expect(resizeGroup(b, 'e', -9999, 0)).toEqual({ x: 100, y: 100, w: 160, h: 300 });
    expect(resizeGroup(b, 'w', 9999, 0)).toEqual({ x: 340, y: 100, w: 160, h: 300 });
    expect(resizeGroup(b, 's', 0, -9999)).toEqual({ x: 100, y: 100, w: 400, h: 100 });
    expect(resizeGroup(b, 'n', 0, 9999)).toEqual({ x: 100, y: 300, w: 400, h: 100 });
    expect(resizeGroup(b, 'se', -9999, -9999)).toEqual({ x: 100, y: 100, w: 160, h: 100 });
    expect(resizeGroup(b, 'nw', 9999, 9999)).toEqual({ x: 340, y: 300, w: 160, h: 100 });
  });
});
