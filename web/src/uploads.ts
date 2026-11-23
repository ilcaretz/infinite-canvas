import { api, uploadFile } from './api';
import { getConfig } from './comfy';
import { uploadToBucket } from './s3upload';
import { uploadToCloud } from './cloud/cloudUpload';
import { isCloudConfig } from './cloud/mode';
import {
  CARD_H, CARD_W, classifyFile, DROP_CELL, extOf, probeImage, probeVideo, sourceFiles, toCard,
} from './files';
import { boardStore } from './store';
import type { Item, MediaDto } from './types';

const MAX_PARALLEL = 3;
const POLL_MS = 1000;
const PROGRESS_THROTTLE_MS = 100;

type Job = () => Promise<void>;
const jobs: Job[] = [];
let active = 0;

function pump() {
  while (active < MAX_PARALLEL && jobs.length) {
    const job = jobs.shift()!;
    active += 1;
    void job().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function enqueue(job: Job) {
  jobs.push(job);
  pump();
}

/** True while something is still travelling to the server (used for the "leave page?" guard). */
export function hasPendingTransfers(): boolean {
  return Object.values(boardStore.getState().uploads).some((u) => u.state === 'queued' || u.state === 'uploading' || u.state === 'downloading');
}

// ---- applying a processed media row to an item ---------------------------------------------

const isVisual = (k: string) => k === 'image' || k === 'video';

export const AUDIO_CARD = { w: 480, h: 140 };
export const TEXT_CARD = { w: 400, h: 420 };

/** Board size of a freshly processed audio / document item (null = keep the generic file card). */
export function cardSizeFor(m: Pick<MediaDto, 'kind' | 'width' | 'height' | 'textPreview' | 'urls'>): { w: number; h: number } | null {
  if (m.kind === 'audio') return AUDIO_CARD;
  if (m.kind !== 'document') return null;
  if (m.urls?.thumb && m.width && m.height) {
    const a = m.width / m.height;
    return a >= 1 ? { w: DROP_CELL, h: DROP_CELL / a } : { w: DROP_CELL * a, h: DROP_CELL };
  }
  return m.textPreview != null ? TEXT_CARD : null;
}

/** Pure: how an item looks once its media row is known (exported for tests). */
export function applyMedia(it: Item, m: MediaDto, now = Date.now()): Item {
  const common = { mediaId: m.id, version: it.version + 1, updatedAt: now, pxW: m.width, pxH: m.height, fps: m.fps, source: m.source ?? null, pages: m.pages ?? null, textPreview: m.textPreview ?? null };
  if (m.status === 'failed' || !m.urls) {
    return { ...toCard(it), ...common, status: m.status, durationMs: null };
  }
  let base: Item = it;
  const kind = m.kind;
  if (isVisual(m.kind)) {
    if (it.kind !== m.kind) {
      // card -> media (e.g. a ProRes file the browser could not show): fit to the real aspect, same center
      const aspect = m.width && m.height ? m.width / m.height : 1;
      const w = aspect >= 1 ? DROP_CELL : DROP_CELL * aspect;
      const h = aspect >= 1 ? DROP_CELL / aspect : DROP_CELL;
      const cx = it.x + it.w / 2;
      const cy = it.y + it.h / 2;
      base = { ...it, x: cx - w / 2, y: cy - h / 2, w, h };
    }
  } else {
    // audio / document / file: audio + documents get their own card size (once, when the kind first changes); the rest stay file cards
    base = isVisual(it.kind) ? toCard(it) : it;
    const size = it.kind !== m.kind ? cardSizeFor(m) : null;
    if (size) {
      const cx = base.x + base.w / 2;
      const cy = base.y + base.h / 2;
      base = { ...base, x: cx - size.w / 2, y: cy - size.h / 2, w: size.w, h: size.h };
    }
  }
  return {
    ...base, ...common, kind, status: 'ready', mime: m.mime, sizeBytes: m.sizeBytes, durationMs: m.durationMs ?? base.durationMs,
    thumbUrl: m.urls.thumb, previewUrl: m.urls.preview, posterUrl: m.urls.poster, originalUrl: m.urls.original,
  };
}

function finalize(itemId: string, m: MediaDto) {
  boardStore.patchEverywhere(itemId, (it) => {
    if (it.src && (m.status === 'failed' || !isVisual(m.kind))) URL.revokeObjectURL(it.src);
    const next = applyMedia(it, m);
    return m.status === 'failed' || !isVisual(m.kind) ? { ...next, src: null } : next;
  });
  boardStore.setUpload(itemId, null);
  sourceFiles.delete(itemId);
}

/** Bind an item to the media row the server returned (the item becomes saveable) and follow its processing. */
function adopt(itemId: string, m: MediaDto) {
  boardStore.patchEverywhere(itemId, (it) => ({ ...it, mediaId: m.id, status: m.status }));
  if (m.status === 'ready' || m.status === 'failed') finalize(itemId, m);
  else watchProcessing(itemId, m.id, m.progress);
}

// ---- processing poll -------------------------------------------------------------------------

const tracking = new Map<string, string>(); // item id -> media id
let pollTimer = 0;

export function watchProcessing(itemId: string, mediaId: string, progress = 0) {
  tracking.set(itemId, mediaId);
  boardStore.setUpload(itemId, { state: 'processing', progress });
  if (!pollTimer) pollTimer = window.setInterval(() => void pollProcessing(), POLL_MS);
}

async function pollProcessing() {
  if (!tracking.size) {
    window.clearInterval(pollTimer);
    pollTimer = 0;
    return;
  }
  const ids = [...new Set(tracking.values())].slice(0, 100);
  let media: MediaDto[];
  try {
    media = await api.mediaStatus(ids);
  } catch {
    return; // server briefly unreachable: keep trying
  }
  const byId = new Map(media.map((m) => [m.id, m]));
  for (const [itemId, mediaId] of [...tracking]) {
    const m = byId.get(mediaId);
    if (!m) {
      tracking.delete(itemId);
      boardStore.setUpload(itemId, null);
    } else if (m.status === 'processing') {
      boardStore.setUpload(itemId, { state: 'processing', progress: m.progress });
    } else {
      tracking.delete(itemId);
      finalize(itemId, m);
    }
  }
}

// ---- file uploads -------------------------------------------------------------------------------

function failUpload(itemId: string, error: string) {
  boardStore.setUpload(itemId, { state: 'failed', progress: 0, error });
}

function uploadJob(itemId: string): Job {
  return async () => {
    const file = sourceFiles.get(itemId);
    if (!file) return failUpload(itemId, 'file no longer available');
    boardStore.setUpload(itemId, { state: 'uploading', progress: 0 });
    let last = 0;
    // s3 mode: browser -> bucket directly (presigned / multipart); local mode: streamed through the app server as before
    // cloud mode: the browser also hashes + makes the previews (the Worker has 10 ms CPU)
    const cfg = await getConfig();
    const send = isCloudConfig(cfg) ? uploadToCloud : cfg.storage === 's3' ? uploadToBucket : uploadFile;
    const up = send(file, (frac) => {
      const now = performance.now();
      if (now - last < PROGRESS_THROTTLE_MS && frac < 1) return;
      last = now;
      boardStore.setUpload(itemId, { state: 'uploading', progress: frac });
    });
    try {
      adopt(itemId, await up.promise);
    } catch (e) {
      failUpload(itemId, (e as Error).message);
    }
  };
}

/** Queue the uploads of items created from local files (max 3 run at once). */
export function startUploads(itemIds: string[]) {
  for (const id of itemIds) {
    boardStore.setUpload(id, { state: 'queued', progress: 0 });
    enqueue(uploadJob(id));
  }
}

export function retryUpload(itemId: string) {
  startUploads([itemId]);
}

// ---- URL drops -----------------------------------------------------------------------------------

export function startUrlDownload(itemId: string, url: string) {
  boardStore.setUpload(itemId, { state: 'downloading', progress: 0 });
  enqueue(async () => {
    try {
      const { media, name } = await api.fromUrl(url);
      boardStore.patchEverywhere(itemId, (it) => ({ ...it, name, ext: extOf(name) }));
      adopt(itemId, media);
    } catch (e) {
      boardStore.setUpload(itemId, { state: 'dlfailed', progress: 0, error: (e as Error).message });
    }
  });
}

export function retryUrlDownload(itemId: string, url: string) {
  startUrlDownload(itemId, url);
}

/** "Upload file instead": turn a failed URL placeholder into a normal local-file item. */
export function replaceWithFile(itemId: string, file: File) {
  const kind = classifyFile(file);
  const src = kind === 'file' ? null : URL.createObjectURL(file);
  sourceFiles.set(itemId, file);
  boardStore.patchEverywhere(itemId, (it) => {
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const w = kind === 'file' ? CARD_W : DROP_CELL;
    const h = kind === 'file' ? CARD_H : DROP_CELL;
    return {
      ...it, kind, x: cx - w / 2, y: cy - h / 2, w, h, name: file.name, ext: extOf(file.name), mime: file.type,
      sizeBytes: file.size, src, durationMs: null, mediaId: null, status: undefined,
    };
  });
  if (src) {
    if (kind === 'image') probeImage(itemId, src);
    else probeVideo(itemId, src);
  }
  startUploads([itemId]);
}
