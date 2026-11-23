/**
 * Browser port of server/src/mediaInfo.ts: container walkers (PNG / JPEG / WebP / ISO-BMFF) that read headers by offset,
 * ComfyUI workflow extraction and source detection (ComfyUI / Higgsfield / ChatGPT / C2PA generator).
 * Reads only the head/tail window and the metadata chunks, never the whole file.
 */
import { concat, latin1, u32be, utf8 } from './sniff';

const SCAN_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';
const XMP_UUID = 'be7acfcb97a942e89c71999491e3afac';

export interface SourceResult { source: string; evidence: string }
interface TextBit { where: string; key?: string; text: string }
interface Found { texts: TextBit[]; c2pa: Uint8Array[] }

/** Random-access reader: bytes [pos, pos+len) (shorter at EOF). */
export type Reader = (pos: number, len: number) => Promise<Uint8Array>;

export const blobReader = (b: Blob): Reader => async (pos, len) => new Uint8Array(await b.slice(pos, pos + len).arrayBuffer());

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const u32le = (b: Uint8Array, p: number) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const u16be = (b: Uint8Array, p: number) => (b[p] << 8) | b[p + 1];
const u64be = (b: Uint8Array, p: number) => u32be(b, p) * 2 ** 32 + u32be(b, p + 4);

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---- C2PA helpers ------------------------------------------------------------------------------

/** Text value that follows a CBOR text-string key (short form and 1-byte length only). `s` is the latin1 view of `b`. */
function cborStrAfter(b: Uint8Array, s: string, key: string, from = 0): string | null {
  const i = s.indexOf(key, from);
  if (i < 0) return null;
  let p = i + key.length;
  const h = b[p];
  let len: number;
  if (h >= 0x60 && h <= 0x77) { len = h - 0x60; p += 1; }
  else if (h === 0x78) { len = b[p + 1]; p += 2; }
  else return null;
  const str = utf8(b, p, p + len);
  return len > 0 && /^[\x20-\x7e]+$/.test(str) ? str : null;
}

export function c2paInfo(bufs: Uint8Array[]): { openai: boolean; higgsfield: boolean; generator: string | null } {
  const all = concat(bufs);
  const text = latin1(all);
  let generator: string | null = null;
  const gi = text.indexOf('claim_generator_info');
  if (gi >= 0) generator = cborStrAfter(all, text, 'name', gi);
  generator ??= cborStrAfter(all, text, 'claim_generator');
  generator ??= /"claim_generator"\s*:\s*"([^"]{1,120})"/.exec(text)?.[1] ?? null;
  return { openai: /openai|chatgpt/i.test(text), higgsfield: /higgsfield/i.test(text), generator };
}

// ---- container walkers --------------------------------------------------------------------------

async function scanPng(read: Reader, size: number, f: Found) {
  let pos = 8;
  for (let n = 0; n < 20000 && pos + 12 <= size; n++) {
    const h = await read(pos, 8);
    if (h.length < 8) break;
    const len = u32be(h, 0);
    const type = latin1(h, 4, 8);
    if (pos + 12 + len > size) break;
    if (type === 'IEND') break;
    if (len <= MAX_CHUNK && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt' || type === 'caBX')) {
      const d = await read(pos + 8, len);
      if (type === 'caBX') f.c2pa.push(d); // any caBX chunk is a C2PA / JUMBF store
      else {
        const z = d.indexOf(0);
        if (z > 0) {
          const key = latin1(d, 0, z);
          let text = '';
          try {
            if (type === 'tEXt') text = latin1(d, z + 1);
            else if (type === 'zTXt') text = latin1(await inflate(d.subarray(z + 2)));
            else {
              const compressed = d[z + 1] === 1;
              let p = z + 3;
              p = d.indexOf(0, p) + 1; // language tag
              p = d.indexOf(0, p) + 1; // translated keyword
              const body = d.subarray(p);
              text = utf8(compressed ? await inflate(body) : body);
            }
          } catch { /* corrupt chunk: ignore */ }
          f.texts.push({ where: `PNG ${type} "${key}"`, key, text });
        }
      }
    }
    pos += 12 + len;
  }
}

async function scanJpeg(read: Reader, size: number, f: Found) {
  let pos = 2;
  for (let n = 0; n < 300 && pos + 4 <= size; n++) {
    const h = await read(pos, 4);
    if (h[0] !== 0xff) break;
    const m = h[1];
    if (m === 0xda || m === 0xd9) break; // start of scan / EOI
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { pos += 2; continue; }
    const len = u16be(h, 2);
    if (len < 2) break;
    if (m === 0xe1 || m === 0xeb || m === 0xfe) {
      const d = await read(pos + 4, len - 2);
      if (m === 0xeb) {
        const s = latin1(d);
        if (s.includes('jumb') || s.includes('c2pa')) f.c2pa.push(d);
      } else f.texts.push({ where: m === 0xe1 ? 'JPEG APP1 (EXIF/XMP)' : 'JPEG comment', text: latin1(d) });
    }
    pos += 2 + len;
  }
}

async function scanWebp(read: Reader, size: number, f: Found) {
  let pos = 12;
  for (let n = 0; n < 2000 && pos + 8 <= size; n++) {
    const h = await read(pos, 8);
    const id = latin1(h, 0, 4);
    const len = u32le(h, 4);
    if (len <= MAX_CHUNK && (id === 'EXIF' || id === 'XMP ' || id === 'C2PA')) {
      const d = await read(pos + 8, len);
      if (id === 'C2PA') f.c2pa.push(d);
      else f.texts.push({ where: `WebP ${id.trim()} chunk`, text: utf8(d) });
    }
    pos += 8 + len + (len & 1);
  }
}

async function scanIsoBmff(read: Reader, size: number, f: Found) {
  let pos = 0;
  for (let n = 0; n < 5000 && pos + 8 <= size; n++) {
    const h = await read(pos, 16);
    if (h.length < 8) break;
    let len = u32be(h, 0);
    const type = latin1(h, 4, 8);
    let hdr = 8;
    if (len === 1) { len = u64be(h, 8); hdr = 16; }
    else if (len === 0) len = size - pos;
    if (len < hdr) break;
    if (type === 'uuid') {
      const u = hex(await read(pos + hdr, 16));
      const payload = Math.min(len - hdr - 16, MAX_CHUNK);
      if (u === C2PA_UUID && payload > 0) f.c2pa.push(await read(pos + hdr + 16, payload));
      else if (u === XMP_UUID && payload > 0) f.texts.push({ where: 'MP4 XMP box', text: utf8(await read(pos + hdr + 16, payload)) });
    }
    pos += len;
  }
}

/** Fallback: JUMBF superbox ("jumb" + "c2pa") sitting in the head or tail window of any container. */
function jumbFallback(bufs: Uint8Array[], f: Found) {
  if (f.c2pa.length) return;
  for (const b of bufs) {
    const s = latin1(b);
    const i = s.indexOf('jumb');
    if (i >= 0 && s.indexOf('c2pa', i) >= 0) { f.c2pa.push(b.subarray(Math.max(0, i - 4), i + 256 * 1024)); return; }
  }
}

/** Walk the container and collect metadata text + C2PA stores. Never throws. */
export async function scanFile(read: Reader, size: number): Promise<Found> {
  const f: Found = { texts: [], c2pa: [] };
  try {
    const head = await read(0, Math.min(size, SCAN_BYTES));
    const tail = size > SCAN_BYTES ? await read(Math.max(0, size - SCAN_BYTES), SCAN_BYTES) : new Uint8Array(0);
    if (head[0] === 0x89 && latin1(head, 1, 4) === 'PNG') await scanPng(read, size, f);
    else if (head[0] === 0xff && head[1] === 0xd8) await scanJpeg(read, size, f);
    else if (latin1(head, 0, 4) === 'RIFF' && latin1(head, 8, 12) === 'WEBP') await scanWebp(read, size, f);
    else if (/^(ftyp|moov|mdat|free|wide|skip|uuid)/.test(latin1(head, 4, 8))) await scanIsoBmff(read, size, f);
    jumbFallback([head, tail], f);
  } catch {
    /* unreadable: fall through to filename evidence */
  }
  return f;
}

// ---- ComfyUI recognition --------------------------------------------------------------------------

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

/** Balanced `{...}` starting at `start` (string-aware); null when it never closes. */
function bracedJson(text: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
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

/** The ComfyUI graph in the scanned metadata: UI `workflow` preferred, else the API `prompt`; null when there is none. */
export function workflowFrom(f: Found): ExtractedWorkflow | null {
  const out: { ui: unknown; api: unknown } = { ui: undefined, api: undefined };
  for (const t of f.texts) {
    if (t.where.startsWith('PNG')) {
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

/** Source of the file: ComfyUI metadata > Higgsfield metadata > ChatGPT (C2PA) > Higgsfield filename > other C2PA generator. */
export function sourceFrom(f: Found, originalName: string): SourceResult {
  for (const t of f.texts) {
    const png = t.where.startsWith('PNG');
    const ok = png ? (t.key === 'prompt' || t.key === 'workflow') && isJsonObject(t.text) : isComfyJson(t.text);
    if (ok) return { source: 'ComfyUI', evidence: `workflow metadata (${t.where})` };
  }
  const c2 = f.c2pa.length ? c2paInfo(f.c2pa) : null;
  for (const t of f.texts) {
    if (/higgsfield/i.test(t.text) || /higgsfield/i.test(t.key ?? '')) return { source: 'Higgsfield', evidence: `metadata (${t.where})` };
  }
  if (c2?.higgsfield) return { source: 'Higgsfield', evidence: 'C2PA: Higgsfield' };
  if (c2?.openai) return { source: 'ChatGPT', evidence: 'C2PA: OpenAI' };
  if (/higgsfield/i.test(originalName)) return { source: 'Higgsfield', evidence: 'filename' };
  if (c2?.generator) return { source: `${c2.generator} (C2PA)`, evidence: `C2PA claim generator "${c2.generator}"` };
  return { source: 'Unknown', evidence: c2 ? 'C2PA manifest present, generator not readable' : 'no known markers' };
}

export interface FileMetadata {
  /** the ComfyUI graph as JSON text (what /api/media/:id/workflow returns); null when none */
  comfyMetadataJson: string | null;
  /** JSON text of {source, evidence}; null for kinds the server does not scan (document / file without a filename hint) */
  sourceJson: string | null;
}

/** One scan -> workflow + source, in the shape the server stores. Documents / plain files only get the filename check (as the server does). */
export async function analyzeMetadata(blob: Blob, originalName: string, scanContainer: boolean): Promise<FileMetadata> {
  if (!scanContainer) {
    const hf = /higgsfield/i.test(originalName);
    return { comfyMetadataJson: null, sourceJson: JSON.stringify(hf ? { source: 'Higgsfield', evidence: 'filename' } : { source: 'Unknown', evidence: 'no known markers' }) };
  }
  const f = await scanFile(blobReader(blob), blob.size);
  const wf = workflowFrom(f);
  return { comfyMetadataJson: wf?.json ?? null, sourceJson: JSON.stringify(sourceFrom(f, originalName)) };
}
