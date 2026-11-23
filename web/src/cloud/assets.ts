/**
 * Browser-side replacement of server/src/process.ts: decode the original and produce the preview assets (webp thumb / preview / poster)
 * plus width / height / duration. Sizes and qualities mirror the server: thumb 512 q80, poster 1280 q82, preview 8192 q90, PDF page 768 q85.
 */
import { detectKind, extOf, TEXT_EXT, type CloudKind, type Detected } from './sniff';
import { blobReader } from './comfyMeta';
import { probeMp4 } from './mp4probe';
import { textFormatOf, textMetaOf, type TextMeta } from './textDoc';

export const THUMB = 512;
export const POSTER_MAX = 1280;
export const PREVIEW_MAX = 8192;
export const PDF_MAX = 768;
export const Q_THUMB = 0.8;
export const Q_POSTER = 0.82;
export const Q_PREVIEW = 0.9;
export const Q_PDF = 0.85;
export const MAX_PSD_BYTES = 1024 ** 3;
/** a video that shows no frame / an audio that gives no metadata within this long is treated as undecodable */
export const MEDIA_TIMEOUT_MS = 10_000;

export const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', fountain: 'text/plain', fdx: 'application/xml',
  rtf: 'application/rtf', json: 'application/json', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text',
  webm: 'video/webm', ogv: 'video/ogg', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4',
};

/** Largest size that fits `max` x `max`, aspect kept; never enlarges (sharp withoutEnlargement / ffmpeg min()). */
export function fitInside(w: number, h: number, max: number): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

export interface BuiltAssets {
  kind: CloudKind;
  mime: string;
  codec: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  fps: number | null;
  pages: number | null;
  /** text documents (<= 20 MB): card preview + counts, as the server computes them */
  text: TextMeta | null;
  thumb: Blob | null;
  preview: Blob | null;
  poster: Blob | null;
}

const empty = (kind: CloudKind, mime: string, codec: string | null = null): BuiltAssets => ({
  kind, mime, codec, width: null, height: null, durationMs: null, fps: null, pages: null, text: null, thumb: null, preview: null, poster: null,
});

// ---- canvas helpers ----------------------------------------------------------------------------------

type Canvas2D = { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D };

function makeCanvas(w: number, h: number): Canvas2D {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    return { canvas, ctx: canvas.getContext('2d') as OffscreenCanvasRenderingContext2D };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d') as CanvasRenderingContext2D };
}

async function toWebp(c: Canvas2D['canvas'], quality: number): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type: 'image/webp', quality });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('webp encode failed'))), 'image/webp', quality));
}

/** Draw `src` (sw x sh) scaled into a w x h canvas and encode it as WebP. */
export async function encodeWebp(src: CanvasImageSource, w: number, h: number, quality: number, opts: { white?: boolean } = {}): Promise<Blob> {
  const { canvas, ctx } = makeCanvas(w, h);
  if (opts.white) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return toWebp(canvas, quality);
}

/** thumb (512) from a source of size sw x sh. */
const thumbOf = (src: CanvasImageSource, sw: number, sh: number) => {
  const t = fitInside(sw, sh, THUMB);
  return encodeWebp(src, t.w, t.h, Q_THUMB);
};

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

// ---- images -------------------------------------------------------------------------------------------

interface Decoded { src: CanvasImageSource; w: number; h: number; close: () => void }

async function decodeSvg(file: Blob): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  // like the server (density 144 = 2x): rasterise at twice the intrinsic size; 512 when the SVG has none
  const w = img.naturalWidth ? img.naturalWidth * 2 : 512;
  const h = img.naturalHeight ? img.naturalHeight * 2 : 512;
  return { src: img, w, h, close: () => URL.revokeObjectURL(url) };
}

async function decodePsd(file: Blob): Promise<Decoded> {
  if (file.size > MAX_PSD_BYTES) throw new Error('PSD larger than 1 GB is not supported');
  const { readPsd } = await import('ag-psd');
  const psd = readPsd(await file.arrayBuffer(), { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  const img = psd.imageData;
  if (!img) throw new Error('PSD has no flattened composite');
  const { canvas, ctx } = makeCanvas(img.width, img.height);
  ctx.putImageData(img as ImageData, 0, 0);
  return { src: canvas as CanvasImageSource, w: img.width, h: img.height, close: () => {} };
}

async function decodeBitmap(file: Blob): Promise<Decoded> {
  const bmp = await createImageBitmap(file);
  return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
}

/** Thumb (+ preview for formats the browser cannot show as is) for an image. Throws when the image cannot be decoded. */
export async function makeImageAssets(file: Blob, det: Detected): Promise<BuiltAssets> {
  const fmt = det.format;
  const d = fmt === 'svg' ? await decodeSvg(file) : fmt === 'psd' ? await decodePsd(file) : await decodeBitmap(file);
  try {
    const out = empty('image', det.mime, fmt);
    out.width = d.w;
    out.height = d.h;
    if (fmt === 'svg') {
      // shown from the original; width/height = the 2x raster size, as the server reports (sharp density 144)
      out.thumb = await thumbOf(d.src, d.w, d.h);
      return out;
    }
    out.thumb = await thumbOf(d.src, d.w, d.h);
    if (!det.direct) {
      const p = fitInside(d.w, d.h, PREVIEW_MAX);
      out.preview = await encodeWebp(d.src, p.w, p.h, Q_PREVIEW);
      // dimensions reported = the preview's (converted images are shown from the preview)
      out.width = p.w;
      out.height = p.h;
      out.mime = 'image/webp';
    }
    return out;
  } finally {
    d.close();
  }
}

// ---- video / audio ---------------------------------------------------------------------------------------

const once = (el: EventTarget, ok: string[], bad: string[]) =>
  new Promise<string>((resolve) => {
    const done = (name: string) => {
      for (const n of [...ok, ...bad]) el.removeEventListener(n, handlers[n]);
      resolve(name);
    };
    const handlers: Record<string, () => void> = {};
    for (const n of [...ok, ...bad]) {
      handlers[n] = () => done(n);
      el.addEventListener(n, handlers[n]);
    }
  });

async function seekTo(v: HTMLVideoElement, t: number) {
  if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return;
  const seeked = once(v, ['seeked'], ['error']);
  v.currentTime = t;
  if ((await seeked) === 'error') throw new Error('seek failed');
}

/** Poster (1280) + thumb (512) + size + duration of a video, or null when the browser cannot decode it. */
export async function makeVideoAssets(file: Blob, mime: string): Promise<Pick<BuiltAssets, 'width' | 'height' | 'durationMs' | 'thumb' | 'poster'> | null> {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    return await withTimeout((async () => {
      v.src = url;
      v.load();
      if ((await once(v, ['loadeddata'], ['error'])) === 'error') return null;
      const w = v.videoWidth;
      const h = v.videoHeight;
      if (!w || !h) return null;
      const durationMs = isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration * 1000) : null;
      // same moment as the server: first frame, else 0.5 s
      let frame: ImageBitmap | null = null;
      for (const t of [0, 0.5]) {
        try {
          await seekTo(v, t);
          frame = await createImageBitmap(v);
          break;
        } catch {
          /* try the next time */
        }
      }
      if (!frame) return null;
      try {
        const p = fitInside(w, h, POSTER_MAX);
        const poster = await encodeWebp(frame, p.w, p.h, Q_POSTER);
        const thumb = await thumbOf(frame, w, h);
        return { width: w, height: h, durationMs, thumb, poster };
      } finally {
        frame.close();
      }
    })(), MEDIA_TIMEOUT_MS, `video ${mime}`);
  } catch {
    return null;
  } finally {
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

/** Duration of an audio file via <audio>; null when the browser cannot read it. */
export async function probeAudio(file: Blob): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const a = document.createElement('audio');
  a.preload = 'metadata';
  try {
    return await withTimeout((async () => {
      a.src = url;
      if ((await once(a, ['loadedmetadata'], ['error'])) === 'error') return null;
      return isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration * 1000) : null;
    })(), MEDIA_TIMEOUT_MS, 'audio');
  } catch {
    return null;
  } finally {
    a.removeAttribute('src');
    a.load();
    URL.revokeObjectURL(url);
  }
}

// ---- PDF ------------------------------------------------------------------------------------------------------

/** First-page thumb (768) + page count + page size of a PDF with the pdfjs the viewer already uses. */
export async function makePdfAssets(file: Blob): Promise<{ pages: number; width: number; height: number; thumb: Blob }> {
  const lib = await import('pdfjs-dist');
  lib.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const task = lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: PDF_MAX / Math.max(base.width, base.height) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    const thumb = await toWebp(canvas, Q_PDF);
    return { pages: doc.numPages, width: Math.round(base.width), height: Math.round(base.height), thumb };
  } finally {
    await task.destroy();
  }
}

// ---- orchestrator ------------------------------------------------------------------------------------------------

/**
 * Everything the browser derives from the original, per kind. Never throws: whatever cannot be produced stays null
 * (a file that claims to be a picture but cannot be decoded becomes a plain `file` card, like the server's failed state).
 */
export async function buildAssets(file: File, head: Uint8Array): Promise<BuiltAssets> {
  const det = detectKind(head, file.name, file.type);
  const ext = extOf(file.name);
  try {
    if (det.kind === 'image') return await makeImageAssets(file, det);
  } catch {
    return empty('file', 'application/octet-stream', ext || 'bin');
  }
  if (det.kind === 'video') {
    const out = empty('video', MIME_BY_EXT[ext] ?? det.mime);
    if (/^(mp4|m4v|mov|3gp)$/.test(ext) || /^video\/(mp4|quicktime)/.test(file.type)) {
      const info = await probeMp4(blobReader(file), file.size);
      out.fps = info.fps;
      out.codec = info.codec;
    }
    const v = await makeVideoAssets(file, out.mime);
    if (v) Object.assign(out, v);
    return out;
  }
  if (det.kind === 'audio') {
    const out = empty('audio', MIME_BY_EXT[ext] ?? det.mime);
    out.durationMs = await probeAudio(file);
    return out;
  }
  if (det.kind === 'document') {
    const out = empty('document', det.format === 'pdf' ? 'application/pdf' : MIME_BY_EXT[ext] ?? det.mime, det.format);
    if (det.format === 'pdf') {
      try {
        const r = await makePdfAssets(file);
        Object.assign(out, { pages: r.pages, width: r.width, height: r.height, thumb: r.thumb });
      } catch {
        /* damaged / unsupported PDF: plain card, original stays downloadable */
      }
    } else if (TEXT_EXT.has(det.format)) {
      const tf = textFormatOf(det.format) ?? det.format;
      out.mime = MIME_BY_EXT[tf] ?? 'text/plain';
      out.codec = tf;
      out.text = await textMetaOf(file, det.format);
    }
    return out;
  }
  return empty('file', MIME_BY_EXT[ext] ?? 'application/octet-stream', ext || 'bin');
}
