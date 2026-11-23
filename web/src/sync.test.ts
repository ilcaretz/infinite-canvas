import { describe, expect, it } from 'vitest';
import { BoardStore } from './store';
import { computeMerge, fromServer } from './sync';
import type { Item, MediaDto, ServerItem } from './types';
import { applyMedia } from './uploads';

const mk = (id: string, patch: Partial<Item> = {}): Item => ({
  id, kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 0, version: 1, updatedAt: 1000,
  name: id, ext: 'png', mime: 'image/png', sizeBytes: 1, src: null, durationMs: null, mediaId: 'm-' + id, status: 'ready', ...patch,
});

const srv = (id: string, patch: Partial<ServerItem> = {}): ServerItem => ({
  id, kind: 'image', x: 0, y: 0, w: 100, h: 100, z: 0, mediaId: 'm-' + id, name: id, version: 1, updatedAt: 1000,
  media: {
    id: 'm-' + id, kind: 'image', status: 'ready', mime: 'image/png', codec: null, width: 100, height: 100, durationMs: null, fps: null,
    sizeBytes: 1, originalName: id, error: null, progress: 1,
    urls: { original: '/o', preview: '/p', thumb: '/t', poster: null },
  },
  ...patch,
});

describe('merge of changes from another tab', () => {
  const none = () => false;

  it('swaps in re-signed (s3) media URLs even when the item itself did not change', () => {
    const local = { a: mk('a', { thumbUrl: '/t', previewUrl: '/p', posterUrl: null }) };
    const same = computeMerge(local, {}, [srv('a')], [], none);
    expect(same.upserts).toEqual([]);
    const fresh = srv('a');
    fresh.media!.urls = { original: '/o2', preview: '/p2', thumb: '/t2', poster: null };
    const r = computeMerge(local, {}, [fresh], [], none);
    expect(r.upserts.map((u) => [u.id, u.thumbUrl, u.previewUrl])).toEqual([['a', '/t2', '/p2']]);
    expect(computeMerge(local, {}, [fresh], [], (id) => id === 'a').upserts).toEqual([]); // protected items are never touched
  });

  it('takes newer server items, ignores older ones (last write wins per item)', () => {
    const local = { a: mk('a', { updatedAt: 1000 }), b: mk('b', { updatedAt: 5000 }) };
    const r = computeMerge(local, {}, [srv('a', { x: 50, updatedAt: 2000, version: 2 }), srv('b', { x: 50, updatedAt: 2000 })], [], none);
    expect(r.upserts.map((u) => u.id)).toEqual(['a']);
    expect(r.upserts[0].x).toBe(50);
  });

  it('adds items that only exist on the server', () => {
    const r = computeMerge({}, {}, [srv('n')], [], none);
    expect(r.upserts.map((u) => u.id)).toEqual(['n']);
    expect(r.upserts[0].thumbUrl).toBe('/t');
  });

  it('never touches an item that is protected (being dragged / unsaved edits)', () => {
    const local = { a: mk('a'), b: mk('b') };
    const r = computeMerge(local, {}, [srv('a', { x: 9, updatedAt: 9000 }), srv('b', { x: 9, updatedAt: 9000 })], [{ id: 'a', deletedAt: 9500 }], (id) => id === 'a');
    expect(r.upserts.map((u) => u.id)).toEqual(['b']);
    expect(r.removes).toEqual([]);
  });

  it('removes items deleted elsewhere unless edited locally after the delete', () => {
    const local = { a: mk('a', { updatedAt: 1000 }), b: mk('b', { updatedAt: 9000 }) };
    const r = computeMerge(local, {}, [], [{ id: 'a', deletedAt: 2000 }, { id: 'b', deletedAt: 2000 }], none);
    expect(r.removes).toEqual(['a']);
  });
});

describe('store sync seams', () => {
  it('undo/redo restore values with a NEW version so they are saved and win merges', () => {
    const s = new BoardStore();
    s.loadBoard('b1', 'B', [mk('a')]);
    const before = s.snapshot(['a']);
    s.transientPatch({ a: { x: 40 } });
    expect(s.isTransient('a')).toBe(true);
    s.commit('move', before);
    expect(s.isTransient('a')).toBe(false);
    const v2 = s.getState().items.a.version;
    s.undo();
    const back = s.getState().items.a;
    expect(back.x).toBe(0);
    expect(back.version).toBeGreaterThan(v2);
  });

  it('applyRemote keeps the local object URL and skips history', () => {
    const s = new BoardStore();
    s.loadBoard('b1', 'B', [mk('a', { src: 'blob:x' })]);
    s.applyRemote([mk('a', { x: 7, updatedAt: 3000 })], []);
    expect(s.getState().items.a.x).toBe(7);
    expect(s.getState().items.a.src).toBe('blob:x');
    expect(s.getState().canUndo).toBe(false);
    s.applyRemote([], ['a']);
    expect(s.getState().items.a).toBeUndefined();
  });
});

describe('applying a processed media row to an item', () => {
  const media = (patch: Partial<MediaDto>): MediaDto => ({ ...srv('x').media!, ...patch });

  it('keeps the size when the kind is unchanged (no visible jump)', () => {
    const it = mk('a', { w: 480, h: 270, src: 'blob:x', status: 'processing' });
    const out = applyMedia(it, media({ width: 1920, height: 1080 }), 5000);
    expect([out.w, out.h, out.x, out.y]).toEqual([480, 270, 0, 0]);
    expect(out.status).toBe('ready');
    expect(out.previewUrl).toBe('/p');
    expect(out.version).toBe(it.version + 1);
  });

  it('turns a file card into a real video at the same center', () => {
    const card = mk('a', { kind: 'file', x: 100, y: 100, w: 260, h: 160, mediaId: null });
    const out = applyMedia(card, media({ kind: 'video', width: 1920, height: 1080 }));
    expect(out.kind).toBe('video');
    expect(out.w / out.h).toBeCloseTo(16 / 9, 3);
    expect(out.x + out.w / 2).toBeCloseTo(230, 3);
    expect(out.y + out.h / 2).toBeCloseTo(180, 3);
  });

  it('a failed media row becomes a grey file card that keeps the original', () => {
    const out = applyMedia(mk('a', { w: 480, h: 300 }), media({ status: 'failed', urls: null }));
    expect(out.kind).toBe('file');
    expect(out.status).toBe('failed');
    expect(out.mediaId).toBe('m-x');
  });

  it('fromServer maps urls and ids', () => {
    const it = fromServer(srv('z'));
    expect(it).toMatchObject({ id: 'z', mediaId: 'm-z', thumbUrl: '/t', previewUrl: '/p', status: 'ready', originalUrl: '/api/items/z/original' });
  });
});
