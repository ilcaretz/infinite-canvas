import type { BoardInfo, Item, MediaDto, ServerItem } from './types';

export interface MediaInfo {
  id: string; filename: string; kind: string; status: string; width: number | null; height: number | null;
  durationMs: number | null; fps: number | null; sizeBytes: number; createdAt: number; container: string | null;
  compression: { codec: string | null; codecName: string | null; codecLong: string | null; profile: string | null; pixFmt: string | null; bitDepth: number | null; bitRate: number | null };
  source: string; sourceEvidence: string;
  sampleRate?: number | null; channels?: number | null; pages?: number | null; lines?: number | null; words?: number | null; format?: string | null;
}

export interface ScreenplayEl { type: string; text: string; depth?: number }
export interface DocVersion { id: string; createdAt: number }
export interface DocPayload {
  id: string; format: 'txt' | 'md' | 'fountain' | 'fdx'; text: string; elements: ScreenplayEl[] | null; editable: boolean;
  current: string; versions: DocVersion[]; lines: number | null; words: number | null; textPreview: string | null;
}

/** Session expired (or never logged in): go to the login page and come back afterwards. */
export function goToLogin() {
  if (typeof location === 'undefined' || location.pathname === '/login') return;
  location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
}

async function j<T>(res: Response): Promise<T> {
  if (res.status === 401) goToLogin();
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

const json = (method: string, body: unknown, keepalive = false): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  keepalive,
});

export interface BoardPayload {
  board: BoardInfo;
  items: ServerItem[];
  deleted: Array<{ id: string; deletedAt: number }>;
  serverTime: number;
}

export interface TrashItem {
  id: string; kind: string; name: string; deletedAt: number; media: MediaDto | null;
}
export type UploadInit =
  | { mediaId: string; mode: 'single'; url: string; headers: Record<string, string> }
  | { mediaId: string; mode: 'multipart'; uploadId: string; partSize: number; partCount: number; partUrls: string[] };
export interface UploadResume { partSize: number; parts: Array<{ partNumber: number; size: number; etag: string }>; partUrls: string[] }
export interface AppConfig {
  comfyUrl: string; canReveal: boolean; storage?: 'local' | 's3'; authRequired?: boolean;
  /** cloud Worker backend (see cloud/mode.ts): the browser hashes, probes and makes the previews itself */
  cloud?: boolean; mode?: string;
}
/** What the browser reports in cloud mode when it completes an upload (see cloud/cloudUpload.ts). */
export interface CloudMeta {
  sha256: string; mime: string; kind: string; width: number | null; height: number | null; durationMs: number | null; fps: number | null;
  codec: string | null; comfyMetadataJson: string | null; sourceJson: string | null;
  hasThumb: boolean; hasPreview: boolean; hasPoster: boolean; pages?: number | null;
  /** text documents <= 20 MB only (same values as server documents.ts textStats) */
  textPreview?: string | null; lines?: number | null; words?: number | null;
}
export interface CloudAssetUrls { thumb?: string | null; preview?: string | null; poster?: string | null }
export type CloudInit = (UploadInit & { deduped?: false; assetUrls?: CloudAssetUrls }) | { deduped: true; media: MediaDto };
export type OpenInComfyResult = { saved: true; path: string } | { saved: false; reason: string };

export const api = {
  config: () => fetch('/api/config').then((r) => j<AppConfig>(r)),
  workflowText: (mediaId: string) => fetch(`/api/media/${mediaId}/workflow`, { cache: 'no-store' }).then(async (r) => {
    if (!r.ok) throw new Error(r.status === 404 ? 'No ComfyUI workflow found in this file' : `HTTP ${r.status}`);
    return r.text();
  }),
  openInComfy: (mediaId: string) => fetch(`/api/media/${mediaId}/open-in-comfy`, { method: 'POST' }).then((r) => j<OpenInComfyResult>(r)),
  reveal: (itemId: string) => fetch(`/api/items/${itemId}/reveal`, { method: 'POST' }).then((r) => j<{ ok: true }>(r)),
  trash: (boardId: string) => fetch(`/api/boards/${boardId}/trash`, { cache: 'no-store' }).then((r) => j<{ items: TrashItem[] }>(r)).then((r) => r.items),
  restoreItem: (id: string) => fetch(`/api/items/${id}/restore`, { method: 'POST' }).then((r) => j<{ ok: true }>(r)),
  purgeItem: (id: string) => fetch(`/api/items/${id}/trash`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  listBoards: () => fetch('/api/boards').then((r) => j<{ boards: BoardInfo[] }>(r)).then((r) => r.boards),
  createBoard: (name: string) => fetch('/api/boards', json('POST', { name })).then((r) => j<{ board: BoardInfo }>(r)).then((r) => r.board),
  renameBoard: (id: string, name: string) => fetch(`/api/boards/${id}`, json('PATCH', { name })).then((r) => j<{ board: BoardInfo }>(r)).then((r) => r.board),
  deleteBoard: (id: string) => fetch(`/api/boards/${id}`, { method: 'DELETE' }).then((r) => j<{ ok: true }>(r)),
  getBoard: (id: string) => fetch(`/api/boards/${id}`, { cache: 'no-store' }).then((r) => j<BoardPayload>(r)),
  saveItems: (boardId: string, upserts: Item[], deletes: Array<{ id: string; updatedAt: number }>, keepalive = false) =>
    fetch(`/api/boards/${boardId}/items`, json('PUT', {
      upserts: upserts.map((i) => ({
        id: i.id, kind: i.kind, x: i.x, y: i.y, w: i.w, h: i.h, z: i.z, mediaId: i.mediaId ?? null, name: i.name, props: i.props ?? null,
        version: i.version, updatedAt: i.updatedAt,
      })),
      deletes,
    }, keepalive)).then((r) => j<{ ok: true; rejected: string[] }>(r)),
  mediaStatus: (ids: string[]) => fetch(`/api/media?ids=${ids.join(',')}`, { cache: 'no-store' }).then((r) => j<{ media: MediaDto[] }>(r)).then((r) => r.media),
  mediaInfo: (id: string) => fetch(`/api/media/${id}/info`, { cache: 'no-store' }).then((r) => j<MediaInfo>(r)),
  document: (id: string, version?: string) =>
    fetch(`/api/media/${id}/document${version ? `?version=${encodeURIComponent(version)}` : ''}`, { cache: 'no-store' }).then((r) => j<DocPayload>(r)),
  saveDocument: (id: string, text: string) => fetch(`/api/media/${id}/document`, json('PUT', { text })).then((r) => j<DocPayload>(r)),
  restoreDocument: (id: string, versionId: string) => fetch(`/api/media/${id}/document/restore`, json('POST', { versionId })).then((r) => j<DocPayload>(r)),
  uploadsInit: (filename: string, size: number, type: string) =>
    fetch('/api/uploads/init', json('POST', { filename, size, type })).then((r) => j<UploadInit>(r)),
  uploadsInitCloud: (body: { filename: string; size: number; mime: string; sha256: string }) =>
    fetch('/api/uploads/init', json('POST', body)).then((r) => j<CloudInit>(r)),
  uploadsResume: (mediaId: string, filename: string, uploadId: string, size: number) =>
    fetch(`/api/uploads/${mediaId}/resume`, json('POST', { filename, uploadId, size })).then((r) => j<UploadResume>(r)),
  uploadsComplete: (mediaId: string, body: { filename: string; size: number; uploadId?: string; parts?: Array<{ partNumber: number; etag: string }>; meta?: CloudMeta }) =>
    fetch(`/api/uploads/${mediaId}/complete`, json('POST', body)).then((r) => j<{ media: MediaDto; deduped: boolean }>(r)),
  uploadsAbort: (mediaId: string, filename: string, uploadId?: string) =>
    fetch(`/api/uploads/${mediaId}/abort`, json('POST', { filename, uploadId })).then((r) => j<{ ok: true }>(r)),
  fromUrl: (url: string) => fetch('/api/media/from-url', json('POST', { url })).then((r) => j<{ media: MediaDto; name: string }>(r)),
};

/** Upload one file with XHR (fetch has no upload progress). Raw streamed body; the name travels in a header. */
export function uploadFile(
  file: File, onProgress: (frac: number) => void,
): { promise: Promise<MediaDto>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<MediaDto>((resolve, reject) => {
    xhr.open('PUT', '/api/media');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'file'));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { media?: MediaDto; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300 && body.media) resolve(body.media);
      else reject(new Error(body.error ?? `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
