import { describe, expect, it } from 'vitest';
import { BoardStore } from './store';
import type { Item } from './types';

const mk = (id: string, x = 0): Item => ({
  id, kind: 'image', x, y: 0, w: 100, h: 100, z: 0, version: 0, updatedAt: 0,
  name: id, ext: 'png', mime: 'image/png', sizeBytes: 1, src: null, durationMs: null,
});

describe('BoardStore undo/redo', () => {
  it('add, move, delete, z-order are undoable and redoable', () => {
    const s = new BoardStore();
    s.addItems([mk('a'), mk('b', 200)]);
    expect(Object.keys(s.getState().items)).toHaveLength(2);

    const before = s.snapshot(['a']);
    s.transientPatch({ a: { x: 50 } });
    s.commit('move', before);
    expect(s.getState().items.a.x).toBe(50);
    s.undo();
    expect(s.getState().items.a.x).toBe(0);
    s.redo();
    expect(s.getState().items.a.x).toBe(50);

    s.reorder(['a'], true);
    expect(s.getState().items.a.z).toBeGreaterThan(s.getState().items.b.z);
    s.undo();
    expect(s.getState().items.a.z).toBeLessThan(s.getState().items.b.z);

    s.deleteItems(['b']);
    expect(s.getState().items.b).toBeUndefined();
    s.undo();
    expect(s.getState().items.b).toBeDefined();
    s.undo();
    expect(s.getState().items.a.x).toBe(0);
    s.undo();
    expect(Object.keys(s.getState().items)).toHaveLength(0);
    expect(s.getState().canUndo).toBe(false);
    expect(s.getState().canRedo).toBe(true);
  });

  it('a new action clears the redo stack', () => {
    const s = new BoardStore();
    s.addItems([mk('a')]);
    s.undo();
    s.addItems([mk('b')]);
    expect(s.getState().canRedo).toBe(false);
  });

  it('patchEverywhere survives undo/redo of the add', () => {
    const s = new BoardStore();
    s.addItems([mk('a')]);
    s.patchEverywhere('a', (it) => ({ ...it, w: 300, h: 100 }));
    s.undo();
    s.redo();
    expect(s.getState().items.a.w).toBe(300);
  });

  it('no-op commit adds no history', () => {
    const s = new BoardStore();
    s.addItems([mk('a')]);
    const before = s.snapshot(['a']);
    s.transientPatch({ a: { x: 0 } });
    s.commit('move', before);
    s.undo();
    expect(s.getState().items.a).toBeUndefined();
  });
});
