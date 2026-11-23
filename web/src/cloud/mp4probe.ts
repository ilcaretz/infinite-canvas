/** Best-effort MP4/MOV probe (frame rate + video codec) from the `moov` box. Pure box parsing, no dependency. Null when unknown. */
import { latin1, u32be } from './sniff';
import type { Reader } from './comfyMeta';

export interface Mp4Info { fps: number | null; codec: string | null }

const MAX_MOOV = 32 * 1024 * 1024;
const u64 = (b: Uint8Array, p: number) => u32be(b, p) * 2 ** 32 + u32be(b, p + 4);

const CODEC_BY_FOURCC: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4', apch: 'prores', apcn: 'prores',
  apcs: 'prores', apco: 'prores', ap4h: 'prores', ap4x: 'prores', jpeg: 'mjpeg', mjpg: 'mjpeg',
};

interface Box { type: string; start: number; end: number; body: number }

function* boxes(b: Uint8Array, from: number, to: number): Generator<Box> {
  let p = from;
  while (p + 8 <= to) {
    let size = u32be(b, p);
    let hdr = 8;
    if (size === 1) { size = u64(b, p + 8); hdr = 16; }
    else if (size === 0) size = to - p;
    if (size < hdr || p + size > to) return;
    yield { type: latin1(b, p + 4, p + 8), start: p, end: p + size, body: p + hdr };
    p += size;
  }
}

const child = (b: Uint8Array, parent: Box, type: string, skip = 0): Box | null => {
  for (const c of boxes(b, parent.body + skip, parent.end)) if (c.type === type) return c;
  return null;
};

/** Parse a moov box held in memory (`b` = the whole box including its header). */
export function probeMoov(b: Uint8Array): Mp4Info {
  const out: Mp4Info = { fps: null, codec: null };
  const moov = [...boxes(b, 0, b.length)].find((x) => x.type === 'moov');
  if (!moov) return out;
  for (const trak of boxes(b, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(b, trak, 'mdia');
    const hdlr = mdia && child(b, mdia, 'hdlr');
    if (!mdia || !hdlr || latin1(b, hdlr.body + 8, hdlr.body + 12) !== 'vide') continue;
    const mdhd = child(b, mdia, 'mdhd');
    const stbl = child(b, mdia, 'minf') && child(b, child(b, mdia, 'minf')!, 'stbl');
    if (!mdhd || !stbl) continue;
    const timescale = b[mdhd.body] === 1 ? u32be(b, mdhd.body + 20) : u32be(b, mdhd.body + 12);
    const stts = child(b, stbl, 'stts');
    if (stts && timescale) {
      const n = u32be(b, stts.body + 4);
      let samples = 0;
      let ticks = 0;
      for (let i = 0; i < n && stts.body + 8 + i * 8 + 8 <= stts.end; i++) {
        const c = u32be(b, stts.body + 8 + i * 8);
        samples += c;
        ticks += c * u32be(b, stts.body + 12 + i * 8);
      }
      if (samples > 1 && ticks > 0) out.fps = Math.round((samples * timescale / ticks) * 1000) / 1000;
    }
    const stsd = child(b, stbl, 'stsd');
    if (stsd && u32be(b, stsd.body + 4) > 0) {
      const fourcc = latin1(b, stsd.body + 12, stsd.body + 16);
      out.codec = CODEC_BY_FOURCC[fourcc] ?? (fourcc.trim() || null);
    }
    return out;
  }
  return out;
}

/** Find `moov` among the top-level boxes of the file (it may sit at the end) and probe it. */
export async function probeMp4(read: Reader, size: number): Promise<Mp4Info> {
  const none: Mp4Info = { fps: null, codec: null };
  try {
    const first = await read(0, 12);
    if (latin1(first, 4, 8) !== 'ftyp') return none;
    let pos = 0;
    for (let n = 0; n < 200 && pos + 8 <= size; n++) {
      const h = await read(pos, 16);
      if (h.length < 8) break;
      let len = u32be(h, 0);
      if (len === 1) len = u64(h, 8);
      else if (len === 0) len = size - pos;
      if (len < 8) break;
      if (latin1(h, 4, 8) === 'moov') {
        if (len > MAX_MOOV) return none;
        return probeMoov(await read(pos, len));
      }
      pos += len;
    }
  } catch {
    /* best effort */
  }
  return none;
}
