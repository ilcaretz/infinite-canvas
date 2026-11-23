import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { initializeCanvas, readPsd } from 'ag-psd';
import type { MediaRow, Repo } from './db.js';
import { audioPlayability, detectFile, extOf, type Detected } from './detect.js';
import { convertToPdf, decodeText, MAX_TEXT_BYTES, OFFICE_EXT, textFormatOf, textStats } from './documents.js';
import { renderPdfFirstPage } from './pdf.js';
import { displaySize, ffmpeg, ffprobe, parseFps, type Tools } from './ffmpeg.js';
import { gatherInfo } from './mediaInfo.js';
import { sanitizeSvg } from './svg.js';
import type { Storage } from './storage.js';

sharp.cache(false); // no cached file handles: Windows cannot delete files sharp still holds

const THUMB = 512;
const POSTER_MAX = 1280;
const PREVIEW_MAX = 8192; // WebP hard limit is 16383
const MAX_PSD_BYTES = 1024 ** 3;
const WAVE_W = 1200;
const WAVE_H = 200;

const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', fountain: 'text/plain', fdx: 'application/xml',
  rtf: 'application/rtf', json: 'application/json', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', odt: 'application/vnd.oasis.opendocument.text',
};

// ag-psd only needs an ImageData factory to decode the flattened composite; no canvas is ever created.
initializeCanvas(
  () => { throw new Error('canvas is not available'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }) as ImageData,
);

const CLAIMS_MEDIA = new Set([
  'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif', 'psd', 'exr', 'hdr', 'ico',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mxf', 'ogv', 'ts', 'm2ts', '3gp',
]);

const SHARP_OPTS = { failOn: 'none', limitInputPixels: false } as const;

export interface ImageAssets {
  width: number;
  height: number;
  previewKey: string | null;
  thumbKey: string | null;
  mime: string;
}

/** Job queue: one job at a time. */
export class Processor {
  readonly progress = new Map<string, number>();
  private queue: string[] = [];
  private running = false;
  private waiters: Array<() => void> = [];

  constructor(private repo: Repo, private storage: Storage, private tools: Tools) {}

  enqueue(mediaId: string) {
    if (this.queue.includes(mediaId) || this.progress.has(mediaId)) return;
    this.progress.set(mediaId, 0);
    this.queue.push(mediaId);
    void this.pump();
  }

  /** Resolves when the queue is empty (used by tests / shutdown). */
  idle(): Promise<void> {
    if (!this.running && !this.queue.length) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private async pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const media = this.repo.getMedia(id);
        if (media && media.status === 'processing') {
          try {
            await this.processOne(media);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[process] ${id} failed: ${msg}`);
            this.repo.updateMedia(id, { status: 'failed', error: msg.slice(0, 500) });
          }
        }
        this.progress.delete(id);
      }
    } finally {
      this.running = false;
      this.waiters.splice(0).forEach((r) => r());
    }
  }

  private processOne(media: MediaRow) {
    // local: the stored file itself; s3: a tmp download that is removed afterwards
    return this.storage.withLocal(media.originalKey, (orig) => this.processFile(media, orig));
  }

  private async processFile(media: MediaRow, orig: string) {
    const det = await detectFile(this.tools, orig, media.originalName);
    const set = (p: number) => this.progress.set(media.id, Math.max(0, Math.min(1, p)));
    const created: string[] = [];
    // codec details + source detection first, so they are already there when the status flips to 'ready'; never fails the upload
    try {
      const probe = det.kind === 'video' || det.kind === 'audio' ? det.probe : null;
      this.repo.updateMedia(media.id, await gatherInfo(this.tools, orig, media.originalName, det.kind, probe));
    } catch (e) {
      console.error(`[process] ${media.id} info failed: ${e instanceof Error ? e.message : e}`);
    }
    try {
      if (det.kind === 'image') await this.doImage(media, det, orig, created);
      else if (det.kind === 'video') await this.doVideo(media, det, orig, created, set);
      else if (det.kind === 'audio') await this.doAudio(media, det, orig, created);
      else if (det.kind === 'document' && (det.format === 'pdf' || OFFICE_EXT.has(det.format) || textFormatOf(det.format))) {
        await this.doDocument(media, det.format, orig, created);
      } else {
        const ext = extOf(media.originalName);
        // A file that claims to be a picture or a video but is neither: unreadable (grey card, original kept)
        if (CLAIMS_MEDIA.has(ext)) throw new Error(`not a readable .${ext} file`);
        this.repo.updateMedia(media.id, { kind: det.kind, mime: MIME_BY_EXT[ext] ?? det.mime, status: 'ready', error: null });
      }
    } catch (e) {
      for (const k of created) await this.storage.delete(k);
      throw e;
    }
  }

  // ---- audio --------------------------------------------------------------------------------

  private async doAudio(media: MediaRow, det: Extract<Detected, { kind: 'audio' }>, orig: string, created: string[]) {
    const stream = det.probe.streams.find((x) => x.codec_type === 'audio');
    const dur = Number(det.probe.format.duration ?? stream?.duration);
    const durationMs = isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null;
    const play = audioPlayability(det.probe);
    let previewKey: string | null = null;
    let mime = play.mime;
    if (!play.direct) {
      previewKey = `previews/${media.id}.m4a`;
      created.push(previewKey);
      await ffmpeg(this.tools, ['-i', orig, '-map', '0:a:0', '-vn', '-sn', '-dn', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', this.storage.localPath(previewKey)]);
      await this.storage.publish(previewKey);
      mime = 'audio/mp4';
    }
    const thumbKey = `thumbs/${media.id}.webp`;
    let thumb: string | null = null;
    const tmpPng = this.storage.tmpPath(`${randomUUID()}.png`);
    try {
      await ffmpeg(this.tools, [
        '-i', orig, '-filter_complex',
        `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${WAVE_W}x${WAVE_H}:colors=0xd0d0d0:scale=sqrt[w]`, '-map', '[w]', '-frames:v', '1', tmpPng,
      ]);
      await sharp(tmpPng, SHARP_OPTS).webp({ quality: 85, alphaQuality: 100 }).toFile(this.storage.localPath(thumbKey));
      created.push(thumbKey);
      await this.storage.publish(thumbKey);
      thumb = thumbKey;
    } catch (e) {
      console.error(`[process] ${media.id} waveform failed: ${e instanceof Error ? e.message : e}`); // card without a waveform, still playable
    } finally {
      await fs.rm(tmpPng, { force: true });
    }
    const sr = Number(stream?.sample_rate);
    this.repo.updateMedia(media.id, {
      kind: 'audio', mime, codec: stream?.codec_name ?? null, durationMs, previewKey, thumbKey: thumb,
      sampleRate: isFinite(sr) && sr > 0 ? sr : null, channels: stream?.channels ?? null, status: 'ready', error: null,
    });
  }

  // ---- documents ----------------------------------------------------------------------------

  private async doDocument(media: MediaRow, format: string, orig: string, created: string[]) {
    const ext = extOf(media.originalName);
    const tf = textFormatOf(format);
    if (tf) {
      const st = await fs.stat(orig);
      const fh = await fs.open(orig, 'r');
      let text: string;
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        text = decodeText(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
      const stats = textStats(text, tf); // throws for a .fdx that is not Final Draft XML
      this.repo.updateMedia(media.id, {
        kind: 'document', mime: MIME_BY_EXT[tf] ?? 'text/plain', codec: tf, lines: stats.lines, words: stats.words,
        textPreview: stats.textPreview, status: 'ready', error: null,
      });
      return;
    }
    let pdf = orig;
    let previewKey: string | null = null;
    if (OFFICE_EXT.has(format)) {
      if (!this.tools.soffice) {
        // no LibreOffice: a plain file card; the original stays downloadable
        this.repo.updateMedia(media.id, { kind: 'document', mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', codec: format, status: 'ready', error: null });
        return;
      }
      const work = this.storage.tmpPath(`lo-${randomUUID()}`);
      try {
        const out = await convertToPdf(this.tools.soffice, orig, work);
        previewKey = `previews/${media.id}.pdf`;
        created.push(previewKey);
        await this.storage.put(previewKey, { path: out });
        pdf = this.storage.localPath(previewKey);
        if (this.storage.kind === 's3') {
          // the object is in the bucket now: render from a local copy of it
          const r = await this.storage.withLocal(previewKey, (p) => renderPdfFirstPage(p));
          return await this.finishPdf(media, format, ext, previewKey, r, created);
        }
      } finally {
        await fs.rm(work, { recursive: true, force: true });
      }
    }
    const r = await renderPdfFirstPage(pdf);
    return this.finishPdf(media, format, ext, previewKey, r, created);
  }

  private async finishPdf(
    media: MediaRow, format: string, ext: string, previewKey: string | null, r: Awaited<ReturnType<typeof renderPdfFirstPage>>, created: string[],
  ) {
    const thumbKey = `thumbs/${media.id}.webp`;
    created.push(thumbKey);
    await this.storage.put(thumbKey, r.thumb);
    this.repo.updateMedia(media.id, {
      kind: 'document', mime: previewKey ? 'application/pdf' : MIME_BY_EXT[ext] ?? 'application/pdf', codec: format, pages: r.pages,
      width: r.width, height: r.height, previewKey, thumbKey, status: 'ready', error: null,
    });
  }

  // ---- images -------------------------------------------------------------------------------

  private async doImage(media: MediaRow, det: Extract<Detected, { kind: 'image' }>, orig: string, created: string[]) {
    const a = await makeImageAssets(this.tools, this.storage, media.id, orig, det.format, created);
    this.repo.updateMedia(media.id, {
      kind: 'image', mime: det.direct && det.format !== 'svg' ? det.mime : a.mime, width: a.width, height: a.height,
      previewKey: a.previewKey, thumbKey: a.thumbKey, status: 'ready', error: null, codec: det.format,
    });
  }

  // ---- video --------------------------------------------------------------------------------

  private async doVideo(
    media: MediaRow, det: Extract<Detected, { kind: 'video' }>, orig: string, created: string[], progress: (p: number) => void,
  ) {
    const size = displaySize(det.stream);
    const durS = Number(det.probe.format.duration ?? det.stream.duration);
    const durationMs = isFinite(durS) && durS > 0 ? Math.round(durS * 1000) : null;
    let previewKey: string | null = null;
    let width = size?.width ?? null;
    let height = size?.height ?? null;
    let mime = det.mime;

    if (!det.direct) {
      previewKey = `previews/${media.id}.mp4`;
      created.push(previewKey);
      const out = this.storage.localPath(previewKey);
      const hasAudio = det.probe.streams.some((s) => s.codec_type === 'audio');
      const vf =
        "scale=w='if(gte(iw,ih),min(2560,trunc(iw/2)*2),-2)':h='if(gte(iw,ih),-2,min(2560,trunc(ih/2)*2))',format=yuv420p";
      await ffmpeg(
        this.tools,
        [
          '-i', orig, '-map', `0:${det.stream.index}`, ...(hasAudio ? ['-map', '0:a:0'] : []), '-sn', '-dn',
          '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', out,
        ],
        (ms) => progress(durationMs ? ms / durationMs : 0),
      );
      mime = 'video/mp4';
      const pr = await ffprobe(this.tools, out);
      await this.storage.publish(previewKey);
      const vs = pr?.streams.find((s) => s.codec_type === 'video');
      if (vs?.width && vs.height) {
        width = vs.width;
        height = vs.height;
      }
    }

    // Poster (full frame, max 1280) + 512 px thumb, both WebP, from the ORIGINAL for best quality.
    const posterKey = `previews/${media.id}.poster.webp`;
    const thumbKey = `thumbs/${media.id}.webp`;
    created.push(posterKey, thumbKey);
    const tmpPng = this.storage.tmpPath(`${randomUUID()}.png`);
    try {
      const grab = async (ss: string) =>
        ffmpeg(this.tools, [
          '-ss', ss, '-i', orig, '-map', `0:${det.stream.index}`, '-frames:v', '1',
          '-vf', `scale='min(${POSTER_MAX},iw)':'min(${POSTER_MAX},ih)':force_original_aspect_ratio=decrease`, tmpPng,
        ]);
      try {
        await grab('0');
        await fs.access(tmpPng);
      } catch {
        await grab('0.5');
      }
      await sharp(tmpPng, SHARP_OPTS).webp({ quality: 82 }).toFile(this.storage.localPath(posterKey));
      await sharp(tmpPng, SHARP_OPTS).resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 }).toFile(this.storage.localPath(thumbKey));
      await this.storage.publish(posterKey);
      await this.storage.publish(thumbKey);
      if (!width || !height) {
        const m = await sharp(tmpPng, SHARP_OPTS).metadata();
        width = m.width ?? null;
        height = m.height ?? null;
      }
    } finally {
      await fs.rm(tmpPng, { force: true });
    }

    this.repo.updateMedia(media.id, {
      kind: 'video', mime, codec: det.stream.codec_name ?? null, width, height, durationMs,
      fps: parseFps(det.stream.avg_frame_rate) ?? parseFps(det.stream.r_frame_rate), previewKey, thumbKey, posterKey,
      status: 'ready', error: null,
    });
  }
}

// ---- image pipeline (exported for tests) ----------------------------------------------------

/** Run ffmpeg to get a PNG sharp can read (BMP, EXR/HDR tone-mapped, HEIC fallback, anything else ffmpeg knows). */
async function ffmpegToPng(tools: Tools, src: string, dst: string, tonemap: boolean) {
  const vf = tonemap
    ? 'format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=tin=linear:t=iec61966-2-1,format=rgb24'
    : 'format=rgba';
  await ffmpeg(tools, ['-i', src, '-frames:v', '1', '-vf', vf, dst]);
}

function psdToRaw(file: Buffer): { data: Buffer; width: number; height: number } {
  const psd = readPsd(file, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  const img = psd.imageData;
  if (!img) throw new Error('PSD has no flattened composite (saved without "Maximize Compatibility")');
  return { data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height };
}

export async function makeImageAssets(
  tools: Tools, storage: Storage, mediaId: string, orig: string, format: string, created: string[] = [],
): Promise<ImageAssets> {
  const tmpFiles: string[] = [];
  const tmp = (ext: string) => {
    const p = storage.tmpPath(`${randomUUID()}.${ext}`);
    tmpFiles.push(p);
    return p;
  };
  try {
    // 1. Build a decodable source for sharp.
    let input: string | Buffer | { raw: Buffer; width: number; height: number } = orig;
    let svgText: string | null = null;
    const viaFfmpeg = async (tonemap: boolean) => {
      const png = tmp('png');
      await ffmpegToPng(tools, orig, png, tonemap);
      return png;
    };
    const isDirect = ['png', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].includes(format);

    if (format === 'svg') {
      svgText = sanitizeSvg(await fs.readFile(orig, 'utf8'));
      input = Buffer.from(svgText);
    } else if (format === 'bmp' || format === 'exr' || format === 'hdr') {
      input = await viaFfmpeg(format !== 'bmp');
    } else if (format === 'psd') {
      const st = await fs.stat(orig);
      if (st.size > MAX_PSD_BYTES) throw new Error('PSD larger than 1 GB is not supported');
      const r = psdToRaw(await fs.readFile(orig));
      input = { raw: r.data, width: r.width, height: r.height };
    } else {
      // png/jpeg/webp/gif/avif/tiff/heic/other: sharp first, ffmpeg as the fallback decoder
      try {
        await sharp(orig, SHARP_OPTS).metadata().then((m) => {
          if (!m.width) throw new Error('unreadable');
        });
        await sharp(orig, { ...SHARP_OPTS }).resize(8, 8, { fit: 'inside' }).raw().toBuffer(); // proves decode works
      } catch (e) {
        input = await viaFfmpeg(false).catch(() => {
          throw new Error(`cannot decode ${format}: ${(e as Error).message}`);
        });
      }
    }

    const mk = (s: typeof input) =>
      typeof s === 'string' || Buffer.isBuffer(s)
        ? sharp(s, { ...SHARP_OPTS, ...(svgText ? { density: 144 } : {}) })
        : sharp(s.raw, { raw: { width: s.width, height: s.height, channels: 4 }, ...SHARP_OPTS });

    // 2. Dimensions (EXIF-oriented; for animated images the height of ONE frame).
    const meta = await mk(input).metadata();
    let width = meta.width ?? 0;
    let height = meta.pageHeight ?? meta.height ?? 0;
    if (meta.orientation && meta.orientation >= 5) [width, height] = [height, width];
    if (svgText && (!width || !height)) {
      width = 512;
      height = 512;
    }
    if (!width || !height) throw new Error('image has no size');

    // 3. Thumbnail (first frame only).
    const thumbKey = `thumbs/${mediaId}.webp`;
    created.push(thumbKey);
    let thumbOk = true;
    try {
      await mk(input)
        .rotate()
        .resize({ width: THUMB, height: THUMB, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(storage.localPath(thumbKey));
      await storage.publish(thumbKey);
    } catch (e) {
      if (!isDirect) throw e;
      thumbOk = false; // direct image whose thumbnail failed: the browser can still show the original
    }

    // 4. Preview.
    let previewKey: string | null = null;
    let mime = 'image/webp';
    if (svgText) {
      previewKey = `previews/${mediaId}.svg`;
      created.push(previewKey);
      await storage.put(previewKey, Buffer.from(svgText));
      mime = 'image/svg+xml';
    } else if (!isDirect) {
      previewKey = `previews/${mediaId}.webp`;
      created.push(previewKey);
      await mk(input)
        .rotate()
        .resize({ width: PREVIEW_MAX, height: PREVIEW_MAX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toFile(storage.localPath(previewKey));
      const pm = await sharp(storage.localPath(previewKey)).metadata();
      await storage.publish(previewKey);
      // dimensions reported = the preview's (converted images are shown from the preview)
      width = pm.width ?? width;
      height = pm.height ?? height;
    }
    return { width, height, previewKey, thumbKey: thumbOk ? thumbKey : null, mime };
  } finally {
    for (const f of tmpFiles) await fs.rm(f, { force: true });
  }
}
