import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectFile, sniffImage } from '../src/detect.js';
import { sanitizeSvg } from '../src/svg.js';
import { FFMPEG, FFPROBE, makeSamples } from './samples.js';

const tools = { ffmpeg: FFMPEG, ffprobe: FFPROBE };
let dir = '';
let files: Record<string, string> = {};

beforeAll(async () => {
  ({ dir, files } = await makeSamples());
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('format detection (by content, not extension)', () => {
  const imageCases: Array<[string, string, boolean]> = [
    ['a.png', 'png', true], ['a.jpg', 'jpeg', true], ['anim.webp', 'webp', true], ['a.gif', 'gif', true],
    ['a.avif', 'avif', true], ['a.bmp', 'bmp', true], ['clean.svg', 'svg', true],
    ['a.tif', 'tiff', false], ['a.psd', 'psd', false], ['a.exr', 'exr', false],
  ];
  for (const [name, fmt, direct] of imageCases) {
    it(`${name} -> image/${fmt} (${direct ? 'direct' : 'converted'})`, async () => {
      const d = await detectFile(tools, files[name], name);
      expect(d.kind).toBe('image');
      if (d.kind === 'image') {
        expect(d.format).toBe(fmt);
        expect(d.direct).toBe(direct);
      }
    });
  }

  const videoCases: Array<[string, boolean]> = [
    ['h264.mp4', true], ['h264_noaudio.mov', true], ['vp9.webm', true],
    ['hevc.mp4', false], ['prores.mov', false], ['h264.mkv', false], ['odd444.mp4', false],
  ];
  for (const [name, direct] of videoCases) {
    it(`${name} -> video (${direct ? 'play directly' : 'transcode'})`, async () => {
      const d = await detectFile(tools, files[name], name);
      expect(d.kind).toBe('video');
      if (d.kind === 'video') expect(d.direct).toBe(direct);
    });
  }

  it('a renamed file is still detected by content', async () => {
    const copy = files['a.png'] + '.mov';
    fs.copyFileSync(files['a.png'], copy);
    const d = await detectFile(tools, copy, 'clip.mov');
    expect(d.kind).toBe('image');
  });

  it('text and random binary are documents/files, not media', async () => {
    expect((await detectFile(tools, files['notes.txt'], 'notes.txt')).kind).toBe('document');
    expect((await detectFile(tools, files['random.bin'], 'random.bin')).kind).toBe('file');
  });

  it('HEIC / AVIF brands in an ISO-BMFF header', () => {
    const mk = (brand: string) => {
      const b = Buffer.alloc(32);
      b.writeUInt32BE(24, 0);
      b.write('ftyp', 4, 'latin1');
      b.write(brand, 8, 'latin1');
      return b;
    };
    expect(sniffImage(mk('heic'))).toBe('heic');
    expect(sniffImage(mk('avif'))).toBe('avif');
    expect(sniffImage(mk('isom'))).toBeNull();
  });
});

describe('SVG sanitizer', () => {
  it('strips scripts, handlers, external refs and javascript: links', () => {
    const out = sanitizeSvg(fs.readFileSync(files['evil.svg'], 'utf8'));
    expect(out).toContain('<rect');
    expect(out).not.toMatch(/script|onload|onclick|evil\.test|javascript|foreignObject/i);
  });
  it('keeps a clean SVG intact', () => {
    expect(sanitizeSvg(fs.readFileSync(files['clean.svg'], 'utf8'))).toContain('fill="red"');
  });
});
