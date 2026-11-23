import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db.js';
import { ffprobe } from '../src/ffmpeg.js';
import { bitDepthOf, codecLabel, detectSource, gatherInfo, isComfyJson } from '../src/mediaInfo.js';
import { FFMPEG, FFPROBE, ffmpegAvailable } from './samples.js';

const tools = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
let dir: string;
let basePng: Buffer;

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
/** Insert extra chunks just before IEND. */
function withChunks(png: Buffer, ...extra: Buffer[]): Buffer {
  const end = png.length - 12;
  return Buffer.concat([png.subarray(0, end), ...extra, png.subarray(end)]);
}
const Z = Buffer.from([0]);
const tEXt = (k: string, v: string) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Z, Buffer.from(v, 'latin1')]));
const iTXt = (k: string, v: string, compress = false) =>
  chunk('iTXt', Buffer.concat([
    Buffer.from(k, 'latin1'), Buffer.from([0, compress ? 1 : 0, 0, 0, 0]),
    compress ? zlib.deflateSync(Buffer.from(v)) : Buffer.from(v),
  ]));

const PROMPT = JSON.stringify({ '3': { class_type: 'KSampler', inputs: { seed: 1 } }, '4': { class_type: 'CheckpointLoaderSimple', inputs: {} } });
const f = (n: string) => path.join(dir, n);
const lavfi = ['-f', 'lavfi', '-i', 'testsrc=s=64x48:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
const ffm = (args: string[]) => spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-source-'));
  basePng = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('detectSource', () => {
  it('ComfyUI: PNG tEXt "prompt" chunk', async () => {
    fs.writeFileSync(f('c.png'), withChunks(basePng, tEXt('prompt', PROMPT)));
    const r = await detectSource(f('c.png'), 'ComfyUI_00001_.png');
    expect(r.source).toBe('ComfyUI');
    expect(r.evidence).toContain('workflow metadata');
    expect(r.evidence).toContain('prompt');
  });
  it('ComfyUI: compressed iTXt "workflow" chunk', async () => {
    const wf = JSON.stringify({ last_node_id: 3, nodes: [{ id: 1, type: 'KSampler' }], links: [] });
    fs.writeFileSync(f('c2.png'), withChunks(basePng, iTXt('workflow', wf, true)));
    expect((await detectSource(f('c2.png'), 'x.png')).source).toBe('ComfyUI');
  });
  it('ChatGPT: fake caBX chunk naming OpenAI', async () => {
    fs.writeFileSync(f('g.png'), withChunks(basePng, chunk('caBX', Buffer.from('....jumbc2pa claim_generator OpenAI contentcredentials', 'latin1'))));
    const r = await detectSource(f('g.png'), 'image.png');
    expect(r).toEqual({ source: 'ChatGPT', evidence: 'C2PA: OpenAI' });
  });
  it('C2PA naming another generator: "<name> (C2PA)"', async () => {
    const cbor = Buffer.concat([
      Buffer.from('claim_generator_info'), Buffer.from([0xa1, 0x64]), Buffer.from('name'), Buffer.from([0x6b]), Buffer.from('SomeTool-X1'),
    ]);
    fs.writeFileSync(f('o.png'), withChunks(basePng, chunk('caBX', Buffer.concat([Buffer.from('jumbc2pa'), cbor]))));
    expect((await detectSource(f('o.png'), 'o.png')).source).toBe('SomeTool-X1 (C2PA)');
  });
  it('Higgsfield: from the file name only', async () => {
    fs.writeFileSync(f('higgsfield_xyz.mp4'), Buffer.from('not really a video'));
    const r = await detectSource(f('higgsfield_xyz.mp4'), 'Higgsfield_XYZ.mp4');
    expect(r).toEqual({ source: 'Higgsfield', evidence: 'filename' });
  });
  it('Higgsfield: PNG text metadata', async () => {
    fs.writeFileSync(f('h.png'), withChunks(basePng, tEXt('Software', 'Higgsfield Soul 2')));
    const r = await detectSource(f('h.png'), 'a.png');
    expect(r.source).toBe('Higgsfield');
    expect(r.evidence).toContain('metadata');
  });
  it('Unknown for a plain PNG', async () => {
    fs.writeFileSync(f('p.png'), basePng);
    expect((await detectSource(f('p.png'), 'p.png')).source).toBe('Unknown');
  });
  it('isComfyJson ignores unrelated JSON', () => {
    expect(isComfyJson('{"prompt":"a cat"}')).toBe(false);
    expect(isComfyJson(`workflow:${PROMPT}`)).toBe(true);
    expect(isComfyJson(`{"prompt":${PROMPT}}`)).toBe(true);
  });

  it.runIf(ffmpegAvailable)('ComfyUI: mp4 with comment metadata (VHS style) + codec details', async () => {
    const comment = JSON.stringify({ prompt: JSON.parse(PROMPT) });
    const r0 = ffm([...lavfi, '-metadata', `comment=${comment}`, f('v.mp4')]);
    expect(r0.status, r0.stderr).toBe(0);
    const probe = await ffprobe(tools, f('v.mp4'));
    const r = await detectSource(f('v.mp4'), 'v.mp4', probe);
    expect(r.source).toBe('ComfyUI');
    expect(r.evidence).toContain('comment');
    const info = await gatherInfo(tools, f('v.mp4'), 'v.mp4', 'video');
    expect(info.source).toBe('ComfyUI');
    expect(info.codecLong).toMatch(/H\.264/);
    expect(info.pixFmt).toBe('yuv420p');
    expect(info.container).toBe('MP4');
    expect(info.bitRate).toBeGreaterThan(0);
  });
  it.runIf(ffmpegAvailable)('Higgsfield: mp4 comment tag', async () => {
    expect(ffm([...lavfi, '-metadata', 'comment=made with Higgsfield', f('hf.mp4')]).status).toBe(0);
    const r = await detectSource(f('hf.mp4'), 'clip.mp4', await ffprobe(tools, f('hf.mp4')));
    expect(r.source).toBe('Higgsfield');
  });
  it.runIf(ffmpegAvailable)('C2PA uuid box appended to an mp4 naming OpenAI', async () => {
    expect(ffm([...lavfi, f('plain.mp4')]).status).toBe(0);
    const base = fs.readFileSync(f('plain.mp4'));
    const payload = Buffer.concat([Buffer.from('d8fec3d61b0e483c92975828877ec481', 'hex'), Buffer.from('....jumbc2pa OpenAI')]);
    const box = Buffer.alloc(8);
    box.writeUInt32BE(8 + payload.length);
    box.write('uuid', 4, 'latin1');
    fs.writeFileSync(f('c2.mp4'), Buffer.concat([base, box, payload]));
    expect((await detectSource(f('c2.mp4'), 'c2.mp4')).source).toBe('ChatGPT');
  });
});

describe('labels + migration', () => {
  it('codec labels', () => {
    expect(codecLabel('h264')).toBe('H.264');
    expect(codecLabel('hevc')).toBe('HEVC (H.265)');
    expect(codecLabel('prores', 'HQ')).toBe('ProRes 422 HQ');
    expect(codecLabel('vp9')).toBe('VP9');
    expect(codecLabel('av1')).toBe('AV1');
    expect(codecLabel('png')).toBe('PNG');
    expect(codecLabel('pcm_s16le')).toBe('PCM 16-bit');
  });
  it('bit depth from pix_fmt', () => {
    expect(bitDepthOf('yuv422p10le')).toBe(10);
    expect(bitDepthOf('yuv420p')).toBe(8);
    expect(bitDepthOf(null)).toBeNull();
  });
  it('migrate adds the new columns to an old media table and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE media (id TEXT PRIMARY KEY, sizeBytes INTEGER)');
    migrate(db);
    migrate(db);
    const cols = (db.prepare('PRAGMA table_info(media)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['source', 'sourceEvidence', 'codecLong', 'codecProfile', 'pixFmt', 'bitRate', 'container']) expect(cols).toContain(c);
  });
});
