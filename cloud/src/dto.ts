import type { CommentMessageRow, CommentRow, MediaRow } from './repo';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const MIME_BY_KEY_EXT: Record<string, string> = {
  webp: 'image/webp', mp4: 'video/mp4', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', m4a: 'audio/mp4', pdf: 'application/pdf',
};

export function commentDto(c: CommentRow & { messages: CommentMessageRow[] }) {
  return {
    id: c.id, boardId: c.boardId, itemId: c.itemId, number: c.number, x: c.x, y: c.y, itemX: c.itemX, itemY: c.itemY,
    videoTimeMs: c.videoTimeMs, resolved: !!c.resolved, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messages: c.messages.map((m) => ({ id: m.id, author: m.author, text: m.text, createdAt: m.createdAt })),
  };
}

export const isPdf = (m: MediaRow) => m.kind === 'document' && (!!m.previewKey || m.codec === 'pdf');

/**
 * Media row -> JSON. URLs are stable same-origin paths (`/api/media/<id>/<variant>`) that 302 to a presigned R2 URL on demand,
 * so listing a board never signs anything (the Worker has 10 ms CPU per request).
 */
export function mediaDto(m: MediaRow) {
  const base = `/api/media/${m.id}`;
  const ready = m.status === 'ready';
  const visual = m.kind === 'image' || m.kind === 'video';
  const pdf = isPdf(m);
  return {
    id: m.id, kind: m.kind, status: m.status, mime: m.mime, codec: m.codec, width: m.width, height: m.height,
    durationMs: m.durationMs, fps: m.fps, sizeBytes: m.sizeBytes, originalName: m.originalName, error: m.error,
    source: m.source, pages: m.pages, textPreview: m.kind === 'document' ? m.textPreview : null,
    uploadedBy: m.uploadedBy ?? '',
    progress: 1,
    urls: ready
      ? {
          original: `${base}/original`,
          preview: visual || m.kind === 'audio' || pdf ? `${base}/preview` : null,
          thumb: m.thumbKey ? `${base}/thumb` : visual ? (m.posterKey ? `${base}/poster` : m.kind === 'image' ? `${base}/preview` : null) : null,
          poster: m.posterKey ? `${base}/poster` : null,
        }
      : null,
  };
}

// ---- info card ----
const CODEC_LABELS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC (H.265)', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mjpeg: 'MJPEG',
  dnxhd: 'DNxHD/DNxHR', ffv1: 'FFV1', png: 'PNG', jpeg: 'JPEG', webp: 'WebP', gif: 'GIF', avif: 'AVIF', heic: 'HEIC', bmp: 'BMP',
  tiff: 'TIFF', svg: 'SVG', psd: 'PSD', exr: 'OpenEXR', hdr: 'Radiance HDR',
  aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', alac: 'ALAC',
};
const PRORES: Record<string, string> = {
  proxy: 'ProRes 422 Proxy', lt: 'ProRes 422 LT', standard: 'ProRes 422', hq: 'ProRes 422 HQ', '4444': 'ProRes 4444', '4444 xq': 'ProRes 4444 XQ',
};
export function codecLabel(codec: string | null, profile?: string | null): string | null {
  if (!codec) return null;
  const c = codec.toLowerCase();
  if (c === 'prores') return PRORES[(profile ?? '').toLowerCase()] ?? 'ProRes';
  if (c.startsWith('pcm_')) return `PCM ${/\d+/.exec(c)?.[0] ?? ''}-bit`.replace('PCM -bit', 'PCM');
  return CODEC_LABELS[c] ?? codec.toUpperCase();
}
export function bitDepthOf(pixFmt: string | null): number | null {
  if (!pixFmt) return null;
  const m = /p(\d{2})(?:le|be)$/.exec(pixFmt);
  if (m) return Number(m[1]);
  return /^(yuvj?\d{3}p|rgb24|bgr24|rgba|bgra|nv12|nv21|gray|pal8|argb|abgr|0rgb|rgb0)$/.test(pixFmt) ? 8 : null;
}

export function infoDto(m: MediaRow) {
  return {
    id: m.id, filename: m.originalName, kind: m.kind, status: m.status, width: m.width, height: m.height,
    durationMs: m.durationMs, fps: m.fps, sizeBytes: m.sizeBytes, createdAt: m.createdAt,
    container: m.container ?? (m.kind === 'image' ? m.codec?.toUpperCase() ?? null : null),
    compression: {
      codec: m.kind === 'document' ? null : m.kind === 'image' ? codecLabel(m.codec) : codecLabel(m.codec, m.codecProfile), codecName: m.codec, codecLong: m.codecLong,
      profile: m.codecProfile, pixFmt: m.pixFmt, bitDepth: bitDepthOf(m.pixFmt), bitRate: m.bitRate,
    },
    sampleRate: m.sampleRate, channels: m.channels, pages: m.pages, lines: m.lines, words: m.words,
    format: m.kind === 'document' ? m.codec : null,
    source: m.source ?? 'Unknown', sourceEvidence: m.sourceEvidence ?? '', uploadedBy: m.uploadedBy ?? '',
  };
}

/** Item props: style of a text / group item, sanitised per kind. */
export function cleanProps(kind: string, raw: unknown): string | null {
  if (kind !== 'text' && kind !== 'group') return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const out: Record<string, unknown> = {};
  if (kind === 'text') {
    out.text = str(r.text, 50000) ?? '';
    if (typeof r.size === 'number' && Number.isFinite(r.size)) out.size = Math.min(2000, Math.max(1, r.size));
    const color = str(r.color, 32);
    if (color) out.color = color;
    if (typeof r.bold === 'boolean') out.bold = r.bold;
    if (r.align === 'left' || r.align === 'center' || r.align === 'right') out.align = r.align;
  } else {
    out.title = str(r.title, 200) ?? '';
    const color = str(r.color, 32);
    if (color) out.color = color;
  }
  return JSON.stringify(out);
}
export function parseProps(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
