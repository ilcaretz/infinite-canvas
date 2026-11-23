/** Browser port of the pure parts of server/src/detect.ts (magic-byte sniffing, kind decision). Works on Uint8Array. */

export type ImageFormat =
  | 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'bmp' | 'svg' // shown directly
  | 'tiff' | 'heic' | 'psd' | 'exr' | 'hdr' | 'other';

/** Same values as server mediaKindOf(): the kind written to the media row. */
export type CloudKind = 'image' | 'video' | 'audio' | 'document' | 'file';

export const DIRECT_IMAGE: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};

/** Bytes [from,to) as a latin1 string (string index === byte index, so offsets carry over). */
export function latin1(b: Uint8Array, from = 0, to = b.length): string {
  let out = '';
  const end = Math.min(to, b.length);
  for (let i = from; i < end; i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(end, i + 8192)));
  return out;
}

export const utf8 = (b: Uint8Array, from = 0, to = b.length): string => new TextDecoder('utf-8').decode(b.subarray(from, to));

export function concat(bufs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let p = 0;
  for (const b of bufs) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

export const u32be = (b: Uint8Array, p: number): number => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const u32le = (b: Uint8Array, p: number): number => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;

/** Magic-byte sniff for image formats. Returns null when the header is not a known image. */
export function sniffImage(b: Uint8Array): ImageFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && latin1(b, 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (latin1(b, 0, 4) === 'GIF8') return 'gif';
  if (latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP') return 'webp';
  if (latin1(b, 0, 2) === 'BM') {
    const dib = u32le(b, 14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib)) return 'bmp';
  }
  if (latin1(b, 4, 8) === 'ftyp') {
    const brand = latin1(b, 8, 12);
    const brands = latin1(b, 8, Math.min(b.length, 8 + u32be(b, 0) - 8));
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) return 'heic';
    if (brand === 'mif1' || brand === 'msf1') return /avif|avis/.test(brands) ? 'avif' : 'heic';
    return null; // ordinary MP4/MOV family
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && (b[2] === 0x2a || b[2] === 0x2b) && b[3] === 0) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 0x2a || b[3] === 0x2b))) return 'tiff';
  if (latin1(b, 0, 4) === '8BPS') return 'psd';
  if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) return 'exr';
  if (latin1(b, 0, 10) === '#?RADIANCE' || latin1(b, 0, 6) === '#?RGBE') return 'hdr';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'other'; // ICO
  return null;
}

export function looksLikeSvg(b: Uint8Array): boolean {
  const t = utf8(b, 0, Math.min(b.length, 8192)).replace(/^﻿/, '').trimStart();
  if (!t.startsWith('<')) return false;
  return /<svg[\s>]/i.test(t);
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
}

const DOC_EXT = new Set(['pdf', 'txt', 'md', 'markdown', 'fountain', 'fdx', 'rtf', 'docx', 'doc', 'odt', 'csv', 'json']);
/** Text-like formats the app edits / previews (server documents.ts textFormatOf keys). */
export const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'fountain', 'spmd', 'fdx']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'mxf', 'ogv', 'ts', 'm2ts', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus', 'wma', 'aiff', 'aif']);

export interface Detected {
  kind: CloudKind;
  /** image format / document format (extension) / '' */
  format: string;
  /** shown straight from the original (no preview file needed) */
  direct: boolean;
  mime: string;
}

const hasNul = (b: Uint8Array) => b.subarray(0, 8192).includes(0);

/**
 * Decide the media kind from the file head + name + browser mime (the server uses ffprobe for video/audio; the browser
 * trusts container hints and lets the later decode attempt downgrade an undecodable file to a card).
 */
export function detectKind(head: Uint8Array, name: string, mime: string): Detected {
  const img = sniffImage(head);
  if (img) {
    const direct = img in DIRECT_IMAGE;
    return { kind: 'image', format: img, direct, mime: direct ? DIRECT_IMAGE[img] : 'image/webp' };
  }
  if (looksLikeSvg(head)) return { kind: 'image', format: 'svg', direct: true, mime: DIRECT_IMAGE.svg };
  const ext = extOf(name);
  if (TEXT_EXT.has(ext) && !hasNul(head)) return { kind: 'document', format: ext, direct: true, mime: 'text/plain' };
  if (latin1(head, 0, 4) === '%PDF') return { kind: 'document', format: 'pdf', direct: true, mime: 'application/pdf' };
  const m = (mime || '').toLowerCase();
  if (m.startsWith('video/') || VIDEO_EXT.has(ext)) return { kind: 'video', format: ext, direct: true, mime: m.startsWith('video/') ? m : 'video/mp4' };
  if (m.startsWith('audio/') || AUDIO_EXT.has(ext)) return { kind: 'audio', format: ext, direct: true, mime: m.startsWith('audio/') ? m : 'audio/mpeg' };
  if (DOC_EXT.has(ext)) return { kind: 'document', format: ext, direct: true, mime: 'application/octet-stream' };
  return { kind: 'file', format: ext || 'bin', direct: true, mime: 'application/octet-stream' };
}
