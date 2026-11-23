import { api } from './api';
import { extOf } from './files';
import { boardStore, type BoardStore } from './store';
import type { Item, ServerItem } from './types';
import { watchProcessing } from './uploads';

const SAVE_DEBOUNCE_MS = 300;
const POLL_MS = 5000;
const RETRY_MS = 2000;

/** Media items wait for their upload; text (once it has content) and group items have no media and are saved right away. */
export const isSaveable = (it: Item) =>
  !!it.mediaId || it.kind === 'group' || (it.kind === 'text' && !!(it.props as { text?: string } | undefined)?.text);

/** Server row -> client item. */
export function fromServer(s: ServerItem): Item {
  const m = s.media;
  return {
    id: s.id, kind: s.kind, x: s.x, y: s.y, w: s.w, h: s.h, z: s.z, version: s.version, updatedAt: s.updatedAt,
    name: s.name, ext: extOf(s.name), mime: m?.mime ?? '', sizeBytes: m?.sizeBytes ?? 0, src: null,
    durationMs: m?.durationMs ?? null, mediaId: s.mediaId, status: m?.status,
    thumbUrl: m?.urls?.thumb ?? null, previewUrl: m?.urls?.preview ?? null, posterUrl: m?.urls?.poster ?? null,
    originalUrl: s.mediaId ? `/api/items/${s.id}/original` : null, pxW: m?.width ?? null, pxH: m?.height ?? null, fps: m?.fps ?? null, source: m?.source ?? null,
    pages: m?.pages ?? null, textPreview: m?.textPreview ?? null, props: s.props ?? undefined,
  };
}

/** Pure merge decision (unit-tested): last write wins per item, protected items are never touched. */
export function computeMerge(
  local: Record<string, Item>,
  uploads: Record<string, unknown>,
  serverItems: ServerItem[],
  serverDeleted: Array<{ id: string; deletedAt: number }>,
  isProtected: (id: string) => boolean,
): { upserts: Item[]; removes: string[] } {
  const upserts: Item[] = [];
  const removes: string[] = [];
  for (const s of serverItems) {
    const l = local[s.id];
    if (!l) {
      upserts.push(fromServer(s));
      continue;
    }
    if (isProtected(s.id)) continue;
    const statusChanged = !uploads[s.id] && !!s.media && l.status !== s.media.status;
    // s3 mode: presigned URLs are re-signed about every 50 min; swap them in before the old ones expire
    const diff = (mine: string | null | undefined, theirs: string | null | undefined) => !!mine && !!theirs && mine !== theirs;
    const urlsChanged = !!s.media?.urls && (diff(l.thumbUrl, s.media.urls.thumb) || diff(l.previewUrl, s.media.urls.preview) || diff(l.posterUrl, s.media.urls.poster));
    if (s.updatedAt > l.updatedAt || statusChanged || urlsChanged) upserts.push(fromServer(s));
  }
  for (const d of serverDeleted) {
    const l = local[d.id];
    if (l && !isProtected(d.id) && d.deletedAt >= l.updatedAt) removes.push(d.id);
  }
  return { upserts, removes };
}

/**
 * Mirrors the store to the server: debounced autosave of every change (items without a server media id yet are
 * not saved: their upload is still running) and a 5 s poll that merges changes from another tab (last write
 * wins per item; never touches an item that is being dragged or has unsaved local edits).
 */
export class BoardSync {
  private boardId = '';
  private saved = new Map<string, { version: number; mediaId: string | null }>();
  private dirty = new Set<string>();
  private pendingDeletes = new Map<string, number>();
  private saveTimer = 0;
  private pollTimer = 0;
  private inflight = false;
  private unsub: (() => void) | null = null;
  private onHide = () => {
    if (document.visibilityState === 'hidden') void this.flush(true);
  };

  constructor(private store: BoardStore = boardStore) {}

  start(boardId: string, serverItems: ServerItem[]) {
    this.stop();
    this.boardId = boardId;
    for (const s of serverItems) this.saved.set(s.id, { version: s.version, mediaId: s.mediaId });
    this.unsub = this.store.subscribe(() => this.onChange());
    this.pollTimer = window.setInterval(() => void this.poll(), POLL_MS);
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onHide);
    for (const s of serverItems) if (s.media?.status === 'processing') watchProcessing(s.id, s.media.id);
  }

  stop() {
    this.unsub?.();
    this.unsub = null;
    window.clearTimeout(this.saveTimer);
    window.clearInterval(this.pollTimer);
    this.saveTimer = 0;
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onHide);
    this.saved.clear();
    this.dirty.clear();
    this.pendingDeletes.clear();
  }

  /** Diff the store against what the server has. Cheap: only compares version + mediaId. */
  private onChange() {
    const items = this.store.getState().items;
    let touched = false;
    for (const id in items) {
      const it = items[id];
      if (!isSaveable(it)) continue;
      const s = this.saved.get(id);
      if (!s || s.version !== it.version || s.mediaId !== (it.mediaId ?? null)) {
        if (!this.dirty.has(id)) touched = true;
        this.dirty.add(id);
      } else this.dirty.delete(id);
      this.pendingDeletes.delete(id);
    }
    for (const id of this.saved.keys()) {
      if (!items[id] && !this.pendingDeletes.has(id)) {
        this.pendingDeletes.set(id, Date.now());
        this.dirty.delete(id);
        touched = true;
      }
    }
    if (touched && !this.saveTimer) this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
  }

  async flush(keepalive = false) {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.inflight) {
      this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
      return;
    }
    const items = this.store.getState().items;
    const ups = [...this.dirty].map((id) => items[id]).filter((it): it is Item => !!it && isSaveable(it));
    const dels = [...this.pendingDeletes].map(([id, updatedAt]) => ({ id, updatedAt }));
    if (!ups.length && !dels.length) return;
    this.inflight = true;
    const boardId = this.boardId;
    try {
      await api.saveItems(boardId, ups, dels, keepalive);
      if (boardId !== this.boardId) return;
      for (const it of ups) {
        this.saved.set(it.id, { version: it.version, mediaId: it.mediaId ?? null });
        const cur = this.store.getState().items[it.id];
        if (cur && cur.version === it.version) this.dirty.delete(it.id);
      }
      for (const d of dels) {
        this.saved.delete(d.id);
        this.pendingDeletes.delete(d.id);
      }
      this.store.setSaveError(false);
    } catch {
      this.store.setSaveError(true);
      this.saveTimer = window.setTimeout(() => void this.flush(), RETRY_MS);
    } finally {
      this.inflight = false;
      if (!this.saveTimer && (this.dirty.size || this.pendingDeletes.size)) {
        this.saveTimer = window.setTimeout(() => void this.flush(), SAVE_DEBOUNCE_MS);
      }
    }
  }

  private isProtected(id: string) {
    return this.dirty.has(id) || this.pendingDeletes.has(id) || this.store.isTransient(id);
  }

  async poll() {
    if (this.inflight) return;
    const boardId = this.boardId;
    let data;
    try {
      data = await api.getBoard(boardId);
    } catch {
      return;
    }
    if (boardId !== this.boardId) return;
    const st = this.store.getState();
    if (data.board.name !== st.boardName) this.store.setBoardName(data.board.name);
    const { upserts, removes } = computeMerge(st.items, st.uploads, data.items, data.deleted, (id) => this.isProtected(id));
    if (!upserts.length && !removes.length) return;
    for (const u of upserts) this.saved.set(u.id, { version: u.version, mediaId: u.mediaId ?? null });
    for (const id of removes) this.saved.delete(id);
    this.store.applyRemote(upserts, removes);
    for (const u of upserts) if (u.status === 'processing' && u.mediaId) watchProcessing(u.id, u.mediaId);
  }
}

export const boardSync = new BoardSync();
