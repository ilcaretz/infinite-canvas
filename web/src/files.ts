import { fitInCell, gridLayout, type Rect, type Vec } from './geometry';
import { boardStore } from './store';
import type { Item } from './types';
import { startUploads, startUrlDownload } from './uploads';

/** Long side of a dropped media item, in world px. */
export const DROP_CELL = 480;
export const DROP_GAP = 24;
export const CARD_W = 260;
export const CARD_H = 160;

/** Original File objects by item id, kept until the server has them (retry after a failed upload). */
export const sourceFiles = new Map<string, File>();

const IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml', 'image/bmp', 'image/x-ms-bmp',
]);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'avif', 'svg', 'bmp']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function classifyFile(file: File): 'image' | 'video' | 'file' {
  const mime = file.type.toLowerCase();
  const ext = extOf(file.name);
  if (IMAGE_MIME.has(mime) || (mime === '' && IMAGE_EXT.has(ext))) return 'image';
  // Any video/* is attempted; a media `error` event turns it into a card (see ItemView / probeVideo).
  if (mime.startsWith('video/') || (mime === '' && VIDEO_EXT.has(ext))) return 'video';
  return 'file';
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---- silent item corrections (patch live item + history snapshots) ---------

/** Re-shape to `aspect` (w/h), keeping the item's center and long side. */
export function correctAspect(aspect: number) {
  return (it: Item): Item => {
    if (!(aspect > 0) || !isFinite(aspect) || (it.kind !== 'image' && it.kind !== 'video')) return it;
    const r = fitInCell({ x: it.x, y: it.y, w: Math.max(it.w, it.h), h: Math.max(it.w, it.h) }, aspect);
    // fitInCell centers inside a square of the long side; re-center on the item's real center.
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    return { ...it, x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h };
  };
}

/** Turn a media item into a dark file card (unplayable video / undecodable image). Idempotent. */
export function toCard(it: Item): Item {
  if (it.kind !== 'image' && it.kind !== 'video') return it;
  const cx = it.x + it.w / 2;
  const cy = it.y + it.h / 2;
  return { ...it, kind: 'file', src: null, durationMs: null, x: cx - CARD_W / 2, y: cy - CARD_H / 2, w: CARD_W, h: CARD_H };
}

export function probeImage(id: string, url: string) {
  const img = new Image();
  img.onload = () => {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      boardStore.patchEverywhere(id, correctAspect(img.naturalWidth / img.naturalHeight));
    }
  };
  img.onerror = () => boardStore.patchEverywhere(id, toCard);
  img.src = url;
}

export function probeVideo(id: string, url: string) {
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  const done = () => {
    v.onloadedmetadata = null;
    v.onerror = null;
    v.removeAttribute('src');
    v.load();
  };
  v.onloadedmetadata = () => {
    const dur = isFinite(v.duration) ? Math.round(v.duration * 1000) : null;
    const aspect = v.videoWidth > 0 && v.videoHeight > 0 ? v.videoWidth / v.videoHeight : 1;
    boardStore.patchEverywhere(id, (it) => ({ ...correctAspect(aspect)(it), durationMs: dur }));
    done();
  };
  v.onerror = () => {
    boardStore.patchEverywhere(id, toCard);
    done();
  };
  v.src = url;
}

/**
 * Create items for `files` synchronously (same frame as the drop). Grid cells are centered so that the
 * first cell's center sits on `at` (world coords). Returns the created items.
 */
export function createItemsFromFiles(files: File[], at: Vec): Item[] {
  if (!files.length) return [];
  const origin = { x: at.x - DROP_CELL / 2, y: at.y - DROP_CELL / 2 };
  const slots = gridLayout(files.length, origin, DROP_CELL, DROP_GAP);
  const items: Item[] = [];
  files.forEach((file, i) => {
    const kind = classifyFile(file);
    const slot: Rect = slots[i];
    const cell = kind === 'file'
      ? { x: slot.x + (slot.w - CARD_W) / 2, y: slot.y + (slot.h - CARD_H) / 2, w: CARD_W, h: CARD_H }
      : slot; // provisional square, corrected when natural size is known
    const src = kind === 'file' ? null : URL.createObjectURL(file);
    const id = newId();
    sourceFiles.set(id, file);
    items.push({
      id, kind, x: cell.x, y: cell.y, w: cell.w, h: cell.h, z: 0, version: 1, updatedAt: Date.now(),
      name: file.name, ext: extOf(file.name), mime: file.type, sizeBytes: file.size, src, durationMs: null,
    });
  });
  boardStore.addItems(items);
  for (const it of items) {
    if (!it.src) continue;
    if (it.kind === 'image') probeImage(it.id, it.src);
    else if (it.kind === 'video') probeVideo(it.id, it.src);
  }
  startUploads(items.map((i) => i.id)); // background upload; the items are already on the board
  return items;
}

// ---- drops from another browser tab (images / videos / links) ------------------------------------

/** URLs the server may download: img/video/source sources first, then text/uri-list. http(s) and data: only. */
export function extractDroppedUrls(dt: DataTransfer): string[] {
  const out: string[] = [];
  const add = (u: string | null | undefined) => {
    const t = (u ?? '').trim();
    if (/^(https?:|data:image\/)/i.test(t) && !out.includes(t)) out.push(t);
  };
  const html = dt.getData('text/html');
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('img[src], video[src], source[src]').forEach((el) => add(el.getAttribute('src')));
    if (!out.length) doc.querySelectorAll('a[href]').forEach((el) => add(el.getAttribute('href')));
  }
  if (!out.length) {
    for (const line of dt.getData('text/uri-list').split(/\r?\n/)) if (!line.startsWith('#')) add(line);
  }
  return out;
}

function nameFromUrl(u: string): string {
  try {
    const url = new URL(u);
    const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
    return last || url.hostname;
  } catch {
    return 'download';
  }
}

/** Placeholder cards at the drop point; the server downloads each URL and the card becomes the real item. */
export function createItemsFromUrls(urls: string[], at: Vec): Item[] {
  const real: string[] = [];
  const items: Item[] = [];
  const web = urls.filter((u) => {
    if (u.startsWith('data:')) {
      real.push(u);
      return false;
    }
    return true;
  });
  // data: images are decoded locally and handled exactly like a dropped file
  for (const u of real) {
    void fetch(u).then((r) => r.blob()).then((b) => {
      const ext = (b.type.split('/')[1] ?? 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg');
      createItemsFromFiles([new File([b], `dropped.${ext}`, { type: b.type })], at);
    }).catch(() => {});
  }
  if (!web.length) return items;
  const origin = { x: at.x - DROP_CELL / 2, y: at.y - DROP_CELL / 2 };
  const slots = gridLayout(web.length, origin, DROP_CELL, DROP_GAP);
  web.forEach((url, i) => {
    const slot = slots[i];
    const name = nameFromUrl(url);
    items.push({
      id: newId(), kind: 'file', x: slot.x + (slot.w - CARD_W) / 2, y: slot.y + (slot.h - CARD_H) / 2, w: CARD_W, h: CARD_H, z: 0,
      version: 1, updatedAt: Date.now(), name, ext: extOf(name), mime: '', sizeBytes: 0, src: null, durationMs: null,
    });
  });
  boardStore.addItems(items);
  items.forEach((it, i) => {
    urlOf.set(it.id, web[i]);
    startUrlDownload(it.id, web[i]);
  });
  return items;
}

/** Source URL of a placeholder (for "retry"). */
export const urlOf = new Map<string, string>();
