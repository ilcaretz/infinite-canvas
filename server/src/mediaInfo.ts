import fs from 'node:fs/promises';
import zlib from 'node:zlib';
import sharp from 'sharp';
import type { MediaKind, MediaRow } from './db.js';
import { ffprobe, type Probe, type Tools } from './ffmpeg.js';

/** Where a file came from + the codec details shown in the info card. Everything here is best-effort. */

const SCAN_BYTES = 4 * 1024 * 1024; // head / tail window for marker scans
const MAX_CHUNK = 16 * 1024 * 1024; // never load a metadata chunk bigger than this
const C2PA_UUID = Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex');
const XMP_UUID = Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex');

export interface SourceResult { source: string; evidence: string }
interface TextBit { where: string; key?: string; text: string }
interface Found { texts: TextBit[]; c2pa: Buffer[] }

async function readAt(fh: fs.FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return bytesRead === len ? b : b.subarray(0, bytesRead);
}

// ---- C2PA helpers -----------------------------------------------------------------------------

/** Text value that follows a CBOR text-string key (short form and 1-byte length only). */
function cborStrAfter(b: Buffer, key: string, from = 0): string | null {
  const i = b.indexOf(key, from, 'latin1');
  if (i < 0) return null;
  let p = i + key.length;
  const h = b[p];
  let len: number;
  if (h >= 0x60 && h <= 0x77) { len = h - 0x60; p += 1; }
  else if (h === 0x78) { len = b[p + 1]; p += 2; }
  else return null;
  const s = b.toString('utf8', p, p + len);
  return len > 0 && /^[\x20-\x7e]+$/.test(s) ? s : null;
}

export function c2paInfo(bufs: Buffer[]): { openai: boolean; higgsfield: boolean; generator: string | null } {
  const all = Buffer.concat(bufs);
  const text = all.toString('latin1');
  let generator: string | null = null;
  const gi = all.indexOf('claim_generator_info', 0, 'latin1');
  if (gi >= 0) generator = cborStrAfter(all, 'name', gi);
  generator ??= cborStrAfter(all, 'claim_generator');
  generator ??= /"claim_generator"\s*:\s*"([^"]{1,120})"/.exec(text)?.[1] ?? null;
  return { openai: /openai|chatgpt/i.test(text), higgsfield: /higgsfield/i.test(text), generator };
}

// ---- container walkers (read headers by offset; payloads only for metadata boxes) --------------

async function scanPng(fh: fs.FileHandle, size: number, f: Found) {
  let pos = 8;
  for (let n = 0; n < 20000 && pos + 12 <= size; n++) {
    const h = await readAt(fh, pos, 8);
    if (h.length < 8) break;
    const len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (pos + 12 + len > size) break;
    if (type === 'IEND') break;
    if (len <= MAX_CHUNK && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'caBX')) {
      const d = await readAt(fh, pos + 8, len);
      if (type === 'caBX') f.c2pa.push(d); // any caBX chunk is a C2PA / JUMBF store
      else {
        const z = d.indexOf(0);
        if (z > 0) {
          const key = d.toString('latin1', 0, z);
          let text = '';
          try {
            if (type === 'tEXt') text = d.toString('latin1', z + 1);
            else if (type === 'zTXt') text = zlib.inflateSync(d.subarray(z + 2)).toString('latin1');
            else {
              const compressed = d[z + 1] === 1;
              let p = z + 3;
              p = d.indexOf(0, p) + 1; // language tag
              p = d.indexOf(0, p) + 1; // translated keyword
              const body = d.subarray(p);
              text = (compressed ? zlib.inflateSync(body) : body).toString('utf8');
            }
          } catch { /* corrupt chunk: ignore */ }
          f.texts.push({ where: `PNG ${type} "${key}"`, key, text });
        }
      }
    }
    pos += 12 + len;
  }
}

async function scanJpeg(fh: fs.FileHandle, size: number, f: Found) {
  let pos = 2;
  for (let n = 0; n < 300 && pos + 4 <= size; n++) {
    const h = await readAt(fh, pos, 4);
    if (h[0] !== 0xff) break;
    const m = h[1];
    if (m === 0xda || m === 0xd9) break; // start of scan / EOI
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { pos += 2; continue; }
    const len = h.readUInt16BE(2);
    if (len < 2) break;
    if (m === 0xe1 || m === 0xeb || m === 0xfe) {
      const d = await readAt(fh, pos + 4, len - 2);
      if (m === 0xeb) {
        if (d.includes('jumb', 0, 'latin1') || d.includes('c2pa', 0, 'latin1')) f.c2pa.push(d);
      } else f.texts.push({ where: m === 0xe1 ? 'JPEG APP1 (EXIF/XMP)' : 'JPEG comment', text: d.toString('latin1') });
    }
    pos += 2 + len;
  }
}

async function scanWebp(fh: fs.FileHandle, size: number, f: Found) {
  let pos = 12;
  for (let n = 0; n < 2000 && pos + 8 <= size; n++) {
    const h = await readAt(fh, pos, 8);
    const id = h.toString('latin1', 0, 4);
    const len = h.readUInt32LE(4);
    if (len <= MAX_CHUNK && (id === 'EXIF' || id === 'XMP ' || id === 'C2PA')) {
      const d = await readAt(fh, pos + 8, len);
      if (id === 'C2PA') f.c2pa.push(d);
      else f.texts.push({ where: `WebP ${id.trim()} chunk`, text: d.toString('utf8') });
    }
    pos += 8 + len + (len & 1);
  }
}

async function scanIsoBmff(fh: fs.FileHandle, size: number, f: Found) {
  let pos = 0;
  for (let n = 0; n < 5000 && pos + 8 <= size; n++) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) break;
    let len = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hdr = 8;
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (len === 0) len = size - pos;
    if (len < hdr) break;
    if (type === 'uuid') {
      const u = await readAt(fh, pos + hdr, 16);
      const payload = Math.min(len - hdr - 16, MAX_CHUNK);
      if (u.equals(C2PA_UUID) && payload > 0) f.c2pa.push(await readAt(fh, pos + hdr + 16, payload));
      else if (u.equals(XMP_UUID) && payload > 0) f.texts.push({ where: 'MP4 XMP box', text: (await readAt(fh, pos + hdr + 16, payload)).toString('utf8') });
    }
    pos += len;
  }
}

/** Fallback: JUMBF superbox ("jumb" + "c2pa") sitting in the head or tail window of any container. */
function jumbFallback(bufs: Buffer[], f: Found) {
  if (f.c2pa.length) return;
  for (const b of bufs) {
    const i = b.indexOf('jumb', 0, 'latin1');
    if (i >= 0 && b.includes('c2pa', i, 'latin1')) { f.c2pa.push(b.subarray(Math.max(0, i - 4), i + 256 * 1024)); return; }
  }
}

// ---- ComfyUI recognition ------------------------------------------------------------------------

function comfyShape(o: unknown, depth = 0): boolean {
  if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 3) return false;
  const rec = o as Record<string, unknown>;
  if (Array.isArray(rec.nodes) && ('links' in rec || 'last_node_id' in rec || 'version' in rec)) return true;
  return Object.values(rec).some((v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && 'class_type' in (v as object)) return true;
    return comfyShape(v, depth + 1);
  });
}

export function isComfyJson(text: string): boolean {
  const i = text.indexOf('{');
  if (i < 0) return false;
  const j = text.lastIndexOf('}');
  try {
    return comfyShape(JSON.parse(text.slice(i, j + 1)));
  } catch {
    return /"class_type"\s*:\s*"/.test(text); // truncated / wrapped JSON
  }
}

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return !!v && typeof v === 'object';
  } catch {
    return false;
  }
}

// ---- source detection --------------------------------------------------------------------------

/** Walk the container (PNG / JPEG / WebP / ISO-BMFF) and collect metadata text + C2PA stores; add ffprobe tags when given. */
async function scanFile(file: string, probe: Probe | null): Promise<Found> {
  const f: Found = { texts: [], c2pa: [] };
  if (probe) {
    const add = (tags: Record<string, string> | undefined, scope: string) => {
      for (const [k, v] of Object.entries(tags ?? {})) f.texts.push({ where: `${scope} tag "${k}"`, key: k, text: String(v) });
    };
    add(probe.format.tags, 'video');
    for (const s of probe.streams) add(s.tags, 'video stream');
  }
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(file, 'r');
    const size = (await fh.stat()).size;
    const head = await readAt(fh, 0, Math.min(size, SCAN_BYTES));
    const tail = size > SCAN_BYTES ? await readAt(fh, Math.max(0, size - SCAN_BYTES), SCAN_BYTES) : Buffer.alloc(0);
    if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') await scanPng(fh, size, f);
    else if (head[0] === 0xff && head[1] === 0xd8) await scanJpeg(fh, size, f);
    else if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') await scanWebp(fh, size, f);
    else if (/^(ftyp|moov|mdat|free|wide|skip|uuid)/.test(head.toString('latin1', 4, 8))) await scanIsoBmff(fh, size, f);
    jumbFallback([head, tail], f);
  } catch {
    /* unreadable: fall through to tag / filename evidence */
  } finally {
    await fh?.close();
  }
  return f;
}

// ---- ComfyUI workflow extraction ---------------------------------------------------------------

/** Balanced `{...}` starting at `start` (string-aware); null when it never closes. */
function bracedJson(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === String.fromCharCode(92)) i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

const isUiWorkflow = (o: unknown): boolean => !!o && typeof o === 'object' && Array.isArray((o as { nodes?: unknown }).nodes);
const isApiPrompt = (o: unknown): boolean =>
  !!o && typeof o === 'object' && !Array.isArray(o) && Object.values(o as object).some((v) => !!v && typeof v === 'object' && 'class_type' in (v as object));
const asObj = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return null; }
};

/** Sort one parsed JSON value into a UI workflow and / or an API prompt (also looks inside {workflow, prompt} wrappers). */
function classify(o: unknown, hint: string | undefined, out: { ui: unknown; api: unknown }) {
  if (!o || typeof o !== 'object') return;
  if (isUiWorkflow(o)) out.ui ??= o;
  else if (isApiPrompt(o)) out.api ??= o;
  else {
    const rec = o as Record<string, unknown>;
    const w = asObj(rec.workflow);
    const p = asObj(rec.prompt);
    if (isUiWorkflow(w)) out.ui ??= w;
    if (isApiPrompt(p)) out.api ??= p;
    else if (hint === 'prompt' && isApiPrompt(rec)) out.api ??= rec;
  }
}

export interface ExtractedWorkflow { format: 'workflow' | 'prompt'; json: string }

/** The ComfyUI graph embedded in a file: UI `workflow` preferred, else the API `prompt`; null when there is none. */
export async function extractWorkflow(file: string, probe: Probe | null = null): Promise<ExtractedWorkflow | null> {
  const f = await scanFile(file, probe);
  const out: { ui: unknown; api: unknown } = { ui: undefined, api: undefined };
  for (const t of f.texts) {
    const png = t.where.startsWith('PNG');
    if (png) {
      if (t.key === 'workflow' || t.key === 'prompt') {
        try { classify(JSON.parse(t.text), t.key, out); } catch { /* not json */ }
      }
      continue;
    }
    const tried = new Set<number>();
    const tryAt = (i: number, hint?: string) => {
      if (i < 0 || tried.has(i)) return;
      tried.add(i);
      const js = bracedJson(t.text, i);
      if (!js) return;
      try { classify(JSON.parse(js), hint, out); } catch { /* not json */ }
    };
    for (const m of t.text.matchAll(/(workflow|prompt)\s*[:=]\s*(?=\{)/gi)) tryAt(m.index! + m[0].length, m[1].toLowerCase());
    tryAt(t.text.indexOf('{'), t.key?.toLowerCase());
  }
  if (out.ui) return { format: 'workflow', json: JSON.stringify(out.ui) };
  if (out.api) return { format: 'prompt', json: JSON.stringify(out.api) };
  return null;
}

export async function detectSource(file: string, originalName: string, probe: Probe | null = null): Promise<SourceResult> {
  const f = await scanFile(file, probe);

  // 1. ComfyUI workflow / prompt JSON
  for (const t of f.texts) {
    const png = t.where.startsWith('PNG');
    const ok = png ? (t.key === 'prompt' || t.key === 'workflow') && isJsonObject(t.text) : isComfyJson(t.text);
    if (ok) return { source: 'ComfyUI', evidence: `workflow metadata (${t.where})` };
  }
  const c2 = f.c2pa.length ? c2paInfo(f.c2pa) : null;
  // 2. Higgsfield named in metadata / tags / C2PA
  for (const t of f.texts) {
    if (/higgsfield/i.test(t.text) || /higgsfield/i.test(t.key ?? '')) return { source: 'Higgsfield', evidence: `metadata (${t.where})` };
  }
  if (c2?.higgsfield) return { source: 'Higgsfield', evidence: 'C2PA: Higgsfield' };
  // 3. ChatGPT / OpenAI via C2PA
  if (c2?.openai) return { source: 'ChatGPT', evidence: 'C2PA: OpenAI' };
  // 4. Higgsfield in the original filename
  if (/higgsfield/i.test(originalName)) return { source: 'Higgsfield', evidence: 'filename' };
  // 5. C2PA naming some other generator
  if (c2?.generator) return { source: `${c2.generator} (C2PA)`, evidence: `C2PA claim generator "${c2.generator}"` };
  return { source: 'Unknown', evidence: c2 ? 'C2PA manifest present, generator not readable' : 'no known markers' };
}

// ---- codec details -------------------------------------------------------------------------------

export interface InfoPatch {
  codecLong: string | null; codecProfile: string | null; pixFmt: string | null; bitRate: number | null; container: string | null;
  source: string; sourceEvidence: string;
}

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

/** Bit depth from an ffmpeg pix_fmt name ("yuv420p10le" -> 10, "yuv420p" -> 8); null when unknown. */
export function bitDepthOf(pixFmt: string | null): number | null {
  if (!pixFmt) return null;
  const m = /p(\d{2})(?:le|be)$/.exec(pixFmt);
  if (m) return Number(m[1]);
  return /^(yuvj?\d{3}p|rgb24|bgr24|rgba|bgra|nv12|nv21|gray|pal8|argb|abgr|0rgb|rgb0)$/.test(pixFmt) ? 8 : null;
}

export function friendlyContainer(formatName: string | undefined, originalName: string): string | null {
  if (!formatName) return null;
  const names = formatName.split(',');
  const ext = originalName.slice(originalName.lastIndexOf('.') + 1).toLowerCase();
  if (names.includes('mov') || names.includes('mp4')) return ext === 'mov' ? 'QuickTime (MOV)' : ext === 'm4a' ? 'MP4 (M4A)' : 'MP4';
  if (names.includes('matroska')) return ext === 'webm' ? 'WebM' : 'Matroska (MKV)';
  return names[0].toUpperCase();
}

export async function gatherInfo(
  tools: Tools, file: string, originalName: string, kind: MediaKind, probe?: Probe | null,
): Promise<InfoPatch> {
  const out: InfoPatch = {
    codecLong: null, codecProfile: null, pixFmt: null, bitRate: null, container: null, source: 'Unknown', sourceEvidence: 'no known markers',
  };
  let pr: Probe | null = probe ?? null;
  if (kind === 'video' || kind === 'audio') {
    try { pr ??= await ffprobe(tools, file); } catch { /* ffprobe missing */ }
    if (pr) {
      const s = pr.streams.find((x) => x.codec_type === kind && !x.disposition?.attached_pic);
      out.codecLong = s?.codec_long_name ?? null;
      out.codecProfile = s?.profile && s.profile !== 'unknown' ? s.profile : null;
      out.pixFmt = s?.pix_fmt ?? null;
      const br = Number(s?.bit_rate ?? pr.format.bit_rate);
      out.bitRate = isFinite(br) && br > 0 ? Math.round(br) : null;
      out.container = friendlyContainer(pr.format.format_name, originalName);
    }
  } else if (kind === 'image') {
    try {
      const m = await sharp(file, { failOn: 'none', limitInputPixels: false }).metadata();
      const bits = m.depth === 'ushort' ? 16 : m.depth === 'float' ? 32 : m.depth === 'uchar' ? 8 : null;
      out.pixFmt = [bits ? `${bits}-bit` : null, m.space, m.channels ? `${m.channels}ch${m.hasAlpha ? ' + alpha' : ''}` : null].filter(Boolean).join(' ') || null;
      out.container = m.format ? m.format.toUpperCase() : null;
    } catch { /* not a sharp-readable image */ }
  }
  if (kind === 'document' || kind === 'file') {
    if (/higgsfield/i.test(originalName)) { out.source = 'Higgsfield'; out.sourceEvidence = 'filename'; }
    return out;
  }
  const r = await detectSource(file, originalName, pr);
  out.source = r.source;
  out.sourceEvidence = r.evidence;
  return out;
}

/** The fields the info card shows, from a media row. */
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
    source: m.source ?? 'Unknown', sourceEvidence: m.sourceEvidence ?? '',
  };
}
