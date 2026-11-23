// Item kinds. image/video render media; audio/document/file render as cards (audio + documents get real
// previews in step 4).
// `text` and `group` have no media: their style lives in `props` (TextProps / GroupProps).
export type ItemKind = 'image' | 'video' | 'audio' | 'document' | 'file' | 'text' | 'group';
export type MediaStatus = 'processing' | 'ready' | 'failed';

export interface Item {
  id: string;
  kind: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  version: number;
  updatedAt: number;
  name: string;
  ext: string;
  mime: string;
  sizeBytes: number;
  /** Local object URL while the file is still on its way to the server. Dropped once the server copy is shown. */
  src: string | null;
  durationMs: number | null;
  // ---- server side (set once the upload reached the server) ----
  mediaId?: string | null;
  status?: MediaStatus;
  thumbUrl?: string | null;
  previewUrl?: string | null;
  posterUrl?: string | null;
  originalUrl?: string | null;
  /** Pixel size of the media (for information; layout uses w/h). */
  pxW?: number | null;
  pxH?: number | null;
  /** Frame rate of a video (from server media metadata). */
  fps?: number | null;
  /** Where the file came from (ComfyUI / Higgsfield / ChatGPT / Unknown / "<tool> (C2PA)"); null until detected. Shows the "C" badge for ComfyUI. */
  source?: string | null;
  /** PDF page count (documents). */
  pages?: number | null;
  /** First ~20 lines of a text / script document (card preview); null for everything else. */
  textPreview?: string | null;
  /** Style of a `text` / `group` item (see textLogic / groupLogic); undefined for media items. */
  props?: unknown;
}

/** Transient per-item state shown on the item (never saved, never part of undo). */
export interface UploadInfo {
  state: 'queued' | 'uploading' | 'processing' | 'failed' | 'downloading' | 'dlfailed';
  /** 0..1 */
  progress: number;
  error?: string;
}

export interface MediaDto {
  id: string;
  kind: ItemKind;
  status: MediaStatus;
  mime: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  sizeBytes: number;
  originalName: string;
  error: string | null;
  source?: string | null;
  pages?: number | null;
  textPreview?: string | null;
  progress: number;
  urls: { original: string; preview: string | null; thumb: string | null; poster: string | null } | null;
}

export interface ServerItem {
  id: string;
  kind: ItemKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  mediaId: string | null;
  name: string;
  props?: unknown;
  version: number;
  updatedAt: number;
  media: MediaDto | null;
}

export interface BoardInfo { id: string; name: string; createdAt: number; updatedAt: number }
