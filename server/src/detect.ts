import fs from 'node:fs/promises';
import { textFormatOf } from './documents.js';
import { ffprobe, type Probe, type ProbeStream, type Tools } from './ffmpeg.js';
import type { MediaKind } from './db.js';

export type ImageFormat =
  | 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'bmp' | 'svg' // shown directly
  | 'tiff' | 'heic' | 'psd' | 'exr' | 'hdr' | 'other'; // converted to a WebP preview

const DIRECT_IMAGE: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
};

export type Detected =
  | { kind: 'image'; format: ImageFormat; direct: boolean; mime: string }
  | { kind: 'video'; probe: Probe; stream: ProbeStream; container: string; direct: boolean; mime: string; reason: string }
  | { kind: 'audio'; probe: Probe; mime: string }
  | { kind: 'document' | 'file'; mime: string; format: string };

const ascii = (b: Buffer, from: number, to: number) => b.toString('latin1', from, to);

/** Magic-byte sniff for image formats. Returns null when the header is not a known image. */
export function sniffImage(b: Buffer): ImageFormat | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  if (ascii(b, 0, 2) === 'BM') {
    const dib = b.readUInt32LE(14);
    if ([12, 40, 52, 56, 64, 108, 124].includes(dib)) return 'bmp';
  }
  if (ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    const brands = ascii(b, 8, Math.min(b.length, 8 + b.readUInt32BE(0) - 8));
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) return 'heic';
    if (brand === 'mif1' || brand === 'msf1') return /avif|avis/.test(brands) ? 'avif' : 'heic';
    return null; // ordinary MP4/MOV family
  }
  if ((b[0] === 0x49 && b[1] === 0x49 && (b[2] === 0x2a || b[2] === 0x2b) && b[3] === 0) ||
      (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && (b[3] === 0x2a || b[3] === 0x2b))) return 'tiff';
  if (ascii(b, 0, 4) === '8BPS') return 'psd';
  if (b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01) return 'exr';
  if (ascii(b, 0, 10) === '#?RADIANCE' || ascii(b, 0, 6) === '#?RGBE') return 'hdr';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'other'; // ICO
  return null;
}

export function looksLikeSvg(b: Buffer): boolean {
  const t = b.toString('utf8', 0, Math.min(b.length, 8192)).replace(/^﻿/, '').trimStart();
  if (!t.startsWith('<')) return false;
  return /<svg[\s>]/i.test(t);
}

const DOC_EXT = new Set(['pdf', 'txt', 'md', 'markdown', 'fountain', 'fdx', 'rtf', 'docx', 'doc', 'odt', 'csv', 'json']);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
}

const IMAGE_PIPE = /(^|,)(image2|image2pipe|.*_pipe|ico|tty|webp_pipe|png_pipe)(,|$)/;
const IMAGE_CODECS = new Set([
  'png', 'mjpeg', 'tiff', 'exr', 'bmp', 'webp', 'hdr', 'psd', 'targa', 'dds', 'jpeg2000', 'ppm', 'pgm', 'pam', 'xbm', 'sgi', 'pcx',
  'jpegxl', 'qoi', 'xwd', 'sunrast', 'pictor', 'wbmp', 'dpx', 'fits', 'pbm', 'pfm', 'phm', 'gif', 'apng', 'vbn', 'alias_pix', 'brender_pix',
]);

/** EBML doctype: 'webm' or 'matroska'. */
function ebmlDoctype(b: Buffer): 'webm' | 'matroska' | null {
  if (!(b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)) return null;
  const head = b.toString('latin1', 0, Math.min(b.length, 64));
  if (head.includes('webm')) return 'webm';
  return 'matroska';
}

const BROWSER_AUDIO_MP4 = new Set(['aac', 'mp3', 'opus', 'flac', 'vorbis']);
const BROWSER_AUDIO_WEBM = new Set(['opus', 'vorbis']);

/** Decide whether a probed video can be played directly in a browser <video>. */
export function videoPlayability(probe: Probe, stream: ProbeStream, head: Buffer): { direct: boolean; container: string; mime: string; reason: string } {
  const fmt = probe.format.format_name ?? '';
  const vcodec = stream.codec_name ?? '';
  const pix = stream.pix_fmt ?? '';
  const audio = probe.streams.filter((s) => s.codec_type === 'audio').map((s) => s.codec_name ?? '');
  const doctype = ebmlDoctype(head);
  const isMp4 = /(^|,)(mov|mp4|m4a|3gp|3g2|mj2)(,|$)/.test(fmt);
  const isWebm = !!doctype && doctype === 'webm';
  const pixOk = pix === 'yuv420p' || (isWebm && pix === 'yuva420p');
  if (isMp4) {
    const vOk = vcodec === 'h264' || vcodec === 'vp9' || vcodec === 'av1';
    if (!vOk) return { direct: false, container: 'mp4', mime: 'video/mp4', reason: `video codec ${vcodec} in MP4/MOV` };
    if (!pixOk) return { direct: false, container: 'mp4', mime: 'video/mp4', reason: `pixel format ${pix}` };
    const bad = audio.find((a) => !BROWSER_AUDIO_MP4.has(a));
    if (bad) return { direct: false, container: 'mp4', mime: 'video/mp4', reason: `audio codec ${bad}` };
    return { direct: true, container: 'mp4', mime: 'video/mp4', reason: 'browser-safe' };
  }
  if (isWebm) {
    const vOk = vcodec === 'vp8' || vcodec === 'vp9' || vcodec === 'av1';
    if (!vOk) return { direct: false, container: 'webm', mime: 'video/webm', reason: `video codec ${vcodec} in WebM` };
    if (!pixOk) return { direct: false, container: 'webm', mime: 'video/webm', reason: `pixel format ${pix}` };
    const bad = audio.find((a) => !BROWSER_AUDIO_WEBM.has(a));
    if (bad) return { direct: false, container: 'webm', mime: 'video/webm', reason: `audio codec ${bad}` };
    return { direct: true, container: 'webm', mime: 'video/webm', reason: 'browser-safe' };
  }
  return { direct: false, container: doctype ?? fmt.split(',')[0] ?? 'unknown', mime: 'video/mp4', reason: `container ${fmt}` };
}

const AUDIO_DIRECT_CODECS = new Set(['mp3', 'aac', 'vorbis', 'opus', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_u8', 'pcm_f32le']);

/** Can a browser <audio> play this file as is? (MP3, WAV, M4A/AAC, OGG, FLAC; anything else becomes an M4A preview.) */
export function audioPlayability(probe: Probe): { direct: boolean; mime: string } {
  const fmt = probe.format.format_name ?? '';
  const codec = probe.streams.find((s) => s.codec_type === 'audio')?.codec_name ?? '';
  const ok = AUDIO_DIRECT_CODECS.has(codec);
  const names = fmt.split(',');
  if (names.includes('mp3')) return { direct: ok, mime: 'audio/mpeg' };
  if (names.includes('wav')) return { direct: ok, mime: 'audio/wav' };
  if (names.includes('flac')) return { direct: ok, mime: 'audio/flac' };
  if (names.includes('ogg')) return { direct: ok, mime: 'audio/ogg' };
  if (names.includes('aac')) return { direct: ok, mime: 'audio/aac' };
  if (names.includes('mp4') || names.includes('mov')) return { direct: ok && ['aac', 'mp3', 'flac', 'opus'].includes(codec), mime: 'audio/mp4' };
  return { direct: false, mime: 'audio/mp4' };
}

export async function readHead(file: string, n = 65536): Promise<Buffer> {
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** Detect by content (magic bytes + ffprobe). The extension is only a last resort for text-like documents. */
export async function detectFile(tools: Tools, file: string, originalName = ''): Promise<Detected> {
  const head = await readHead(file);
  const img = sniffImage(head);
  if (img) {
    const direct = img in DIRECT_IMAGE;
    return { kind: 'image', format: img, direct, mime: direct ? DIRECT_IMAGE[img] : 'image/webp' };
  }
  if (looksLikeSvg(head)) return { kind: 'image', format: 'svg', direct: true, mime: DIRECT_IMAGE.svg };

  // Plain text with a known script/text extension: ffprobe would mistake it for an ANSI (tty) video, so the extension decides.
  const textExt = extOf(originalName);
  if (textFormatOf(textExt) && !head.subarray(0, 8192).includes(0)) return { kind: 'document', mime: 'text/plain', format: textExt };

  const probe = head.length > 0 ? await ffprobe(tools, file) : null;
  if (probe && probe.streams.length) {
    const fmt = probe.format.format_name ?? '';
    const video = probe.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = probe.streams.find((s) => s.codec_type === 'audio');
    if (video) {
      const stillImage = IMAGE_PIPE.test(fmt) || (IMAGE_CODECS.has(video.codec_name ?? '') && !probe.format.duration && !audio);
      if (stillImage) return { kind: 'image', format: 'other', direct: false, mime: 'image/webp' };
      const p = videoPlayability(probe, video, head);
      return { kind: 'video', probe, stream: video, container: p.container, direct: p.direct, mime: p.mime, reason: p.reason };
    }
    if (audio) return { kind: 'audio', probe, mime: 'audio/mpeg' };
  }
  const ext = extOf(originalName);
  if (ascii(head, 0, 4) === '%PDF') return { kind: 'document', mime: 'application/pdf', format: 'pdf' };
  if (DOC_EXT.has(ext)) return { kind: 'document', mime: 'application/octet-stream', format: ext };
  return { kind: 'file', mime: 'application/octet-stream', format: ext || 'bin' };
}

export function mediaKindOf(d: Detected): MediaKind {
  return d.kind;
}
