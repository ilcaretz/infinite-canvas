import type { Repo } from './db.js';
import type { Storage } from './storage.js';

export const TRASH_DAYS = 30;
export const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

/** Hard-delete items (and their comments); a media file goes only when no remaining item references it. */
export async function purgeItems(repo: Repo, storage: Storage, ids: string[]): Promise<{ items: number; media: number }> {
  const mediaIds = repo.hardDeleteItems(ids);
  let media = 0;
  for (const mid of mediaIds) {
    const m = repo.getMedia(mid);
    if (!m || m.status === 'processing' || repo.mediaRefCount(mid) > 0) continue;
    for (const key of repo.hardDeleteMedia(mid)) {
      try { await storage.delete(key); } catch { /* already gone */ }
    }
    media++;
  }
  return { items: ids.length, media };
}

/** Items deleted more than TRASH_DAYS ago are gone for good. */
export async function purgeExpired(repo: Repo, storage: Storage, now = Date.now()) {
  const old = repo.expiredItems(now - TRASH_DAYS * 24 * 3600 * 1000);
  return old.length ? purgeItems(repo, storage, old.map((i) => i.id)) : { items: 0, media: 0 };
}
