import { describe, expect, it } from 'vitest';
import { fitInside } from './assets';
import { analyzeMetadata, c2paInfo, isComfyJson } from './comfyMeta';
import { completeMeta } from './cloudUpload';
import { sha256Blob } from './hash';
import { isCloudConfig } from './mode';
import { probeMoov } from './mp4probe';
import { concat, detectKind, sniffImage } from './sniff';

const enc = new TextEncoder();
const randomBytes = (n: number) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536)));
  return b;
};
const sha256Hex = async (b: Uint8Array<ArrayBuffer>) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (...parts: Array<number[] | Uint8Array | string>) =>
  concat(parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p instanceof Uint8Array ? p : Uint8Array.from(p))));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const chunk = (type: string, data: Uint8Array) => bytes(be32(data.length), type, data, be32(0)); // CRC is not checked by the reader
const textChunk = (key: string, text: string) => chunk('tEXt', bytes(key, [0], text));
const png = (...chunks: Uint8Array[]) => bytes(PNG_SIG, chunk('IHDR', new Uint8Array(13)), ...chunks, chunk('IEND', new Uint8Array(0)));

const UI_WORKFLOW = { last_node_id: 2, nodes: [{ id: 1, type: 'KSampler' }, { id: 2, type: 'SaveImage' }], links: [] };
const API_PROMPT = { '3': { class_type: 'KSampler', inputs: { seed: 1 } }, '9': { class_type: 'SaveImage', inputs: {} } };

describe('PNG ComfyUI chunk extraction', () => {
  it('reads a tEXt "workflow" chunk and names ComfyUI as the source', async () => {
    const file = new Blob([png(textChunk('workflow', JSON.stringify(UI_WORKFLOW)))], { type: 'image/png' });
    const m = await analyzeMetadata(file, 'a.png', true);
    expect(JSON.parse(m.comfyMetadataJson!)).toEqual(UI_WORKFLOW);
    expect(JSON.parse(m.sourceJson!)).toEqual({ source: 'ComfyUI', evidence: 'workflow metadata (PNG tEXt "workflow")' });
  });

  it('prefers the UI workflow over the API prompt, falls back to the prompt alone', async () => {
    const both = new Blob([png(textChunk('prompt', JSON.stringify(API_PROMPT)), textChunk('workflow', JSON.stringify(UI_WORKFLOW)))]);
    expect(JSON.parse((await analyzeMetadata(both, 'a.png', true)).comfyMetadataJson!)).toEqual(UI_WORKFLOW);
    const only = new Blob([png(textChunk('prompt', JSON.stringify(API_PROMPT)))]);
    expect(JSON.parse((await analyzeMetadata(only, 'a.png', true)).comfyMetadataJson!)).toEqual(API_PROMPT);
  });

  it('inflates a compressed zTXt chunk', async () => {
    const z = new Uint8Array(await new Response(new Blob([enc.encode(JSON.stringify(UI_WORKFLOW))]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
    const file = new Blob([png(chunk('zTXt', bytes('workflow', [0, 0], z)))]);
    expect(JSON.parse((await analyzeMetadata(file, 'z.png', true)).comfyMetadataJson!)).toEqual(UI_WORKFLOW);
  });

  it('reads an uncompressed iTXt chunk', async () => {
    const file = new Blob([png(chunk('iTXt', bytes('workflow', [0, 0, 0], 'en', [0], 'workflow', [0], JSON.stringify(UI_WORKFLOW))))]);
    expect(JSON.parse((await analyzeMetadata(file, 'i.png', true)).comfyMetadataJson!)).toEqual(UI_WORKFLOW);
  });

  it('plain PNG: no workflow, Unknown source; Higgsfield from the filename', async () => {
    const file = new Blob([png(textChunk('Software', 'paint'))]);
    const m = await analyzeMetadata(file, 'plain.png', true);
    expect(m.comfyMetadataJson).toBeNull();
    expect(JSON.parse(m.sourceJson!)).toEqual({ source: 'Unknown', evidence: 'no known markers' });
    expect(JSON.parse((await analyzeMetadata(file, 'higgsfield_shot.png', true)).sourceJson!).source).toBe('Higgsfield');
  });

  it('documents / files are not container-scanned (filename check only)', async () => {
    const m = await analyzeMetadata(new Blob([png(textChunk('workflow', JSON.stringify(UI_WORKFLOW)))]), 'x.pdf', false);
    expect(m.comfyMetadataJson).toBeNull();
  });

  it('isComfyJson / c2paInfo helpers', () => {
    expect(isComfyJson(JSON.stringify(UI_WORKFLOW))).toBe(true);
    expect(isComfyJson('{"a":1}')).toBe(false);
    expect(c2paInfo([enc.encode('xx OpenAI yy')]).openai).toBe(true);
  });
});

describe('sniff', () => {
  const pad = (b: number[]) => Uint8Array.from([...b, ...new Array(Math.max(0, 16 - b.length)).fill(0)]);
  it('recognises image magic bytes', () => {
    expect(sniffImage(png())).toBe('png');
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImage(bytes('GIF89a', new Array(10).fill(0)))).toBe('gif');
    expect(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WEBP', [0, 0]))).toBe('webp');
    expect(sniffImage(bytes('8BPS', new Array(12).fill(0)))).toBe('psd');
    expect(sniffImage(bytes([0, 0, 0, 0x18], 'ftypavif', new Array(8).fill(0)))).toBe('avif');
    expect(sniffImage(bytes([0, 0, 0, 0x18], 'ftypisom', new Array(8).fill(0)))).toBeNull(); // plain MP4
    expect(sniffImage(enc.encode('hello'))).toBeNull();
  });

  it('decides the kind with the server mediaKindOf vocabulary', () => {
    const k = (name: string, mime: string, head: Uint8Array = enc.encode('plain text here')) => detectKind(head, name, mime).kind;
    expect(k('a.png', 'image/png', png())).toBe('image');
    expect(detectKind(enc.encode('<?xml version="1.0"?><svg xmlns="x"></svg>'), 'a.svg', '').format).toBe('svg');
    expect(k('clip.mp4', 'video/mp4')).toBe('video');
    expect(k('clip.mov', '')).toBe('video');
    expect(k('song.wav', 'audio/wav')).toBe('audio');
    expect(k('doc.pdf', '', enc.encode('%PDF-1.7 ....'))).toBe('document');
    expect(k('script.fountain', '')).toBe('document');
    expect(k('notes.md', 'text/markdown')).toBe('document');
    expect(k('blob.bin', '')).toBe('file');
    expect(detectKind(pad([0x38, 0x42, 0x50, 0x53]), 'x.psd', '')).toMatchObject({ kind: 'image', format: 'psd', direct: false, mime: 'image/webp' });
  });
});

describe('sha256 chunked', () => {
  it('equals the one-shot digest on a 3 MB buffer (odd chunk size, exact multiple, bigger than file)', async () => {
    const buf = randomBytes(3 * 1024 * 1024 + 17);
    const expected = await sha256Hex(buf);
    const blob = new Blob([buf]);
    expect(await sha256Blob(blob, undefined, 1024 * 1024 + 3)).toBe(expected);
    expect(await sha256Blob(blob, undefined, 1024 * 1024)).toBe(expected);
    expect(await sha256Blob(blob, undefined, 8 * 1024 * 1024)).toBe(expected);
  });

  it('reports progress and honours cancel', async () => {
    const blob = new Blob([randomBytes(300_000)]);
    const seen: number[] = [];
    await sha256Blob(blob, (f) => seen.push(f), 100_000);
    expect(seen[seen.length - 1]).toBe(1);
    await expect(sha256Blob(blob, undefined, 100_000, () => true)).rejects.toThrow('aborted');
  });

  it('empty input has the known digest', async () => {
    expect(await sha256Blob(new Blob([]))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('cloud mode detection from /api/config', () => {
  it('accepts storage s3 + cloud:true, or mode cloud; rejects the rest', () => {
    expect(isCloudConfig({ storage: 's3', cloud: true })).toBe(true);
    expect(isCloudConfig({ mode: 'cloud' })).toBe(true);
    expect(isCloudConfig({ mode: 'cloud', storage: 'local' })).toBe(true);
    expect(isCloudConfig({ storage: 's3' })).toBe(false); // plain bucket mode with the Node server
    expect(isCloudConfig({ storage: 'local', cloud: true })).toBe(false);
    expect(isCloudConfig({ mode: 'local' })).toBe(false);
    expect(isCloudConfig(undefined)).toBe(false);
  });
});

describe('complete body meta', () => {
  it('has exactly the contract fields', () => {
    const meta = completeMeta(
      {
        sha256: 'ab'.repeat(32),
        assets: { kind: 'video', mime: 'video/mp4', codec: 'h264', width: 1920, height: 1080, durationMs: 4000, fps: 24, pages: null, text: null, thumb: null, preview: null, poster: null },
        metadata: { comfyMetadataJson: null, sourceJson: '{"source":"Unknown","evidence":"no known markers"}' },
      },
      { thumb: true, preview: false, poster: true },
    );
    expect(Object.keys(meta).sort()).toEqual([
      'codec', 'comfyMetadataJson', 'durationMs', 'fps', 'hasPoster', 'hasPreview', 'hasThumb', 'height', 'kind', 'lines', 'mime', 'pages', 'sha256', 'sourceJson', 'textPreview', 'width', 'words',
    ]);
    expect(meta).toMatchObject({ kind: 'video', hasThumb: true, hasPreview: false, hasPoster: true, width: 1920, fps: 24 });
  });
});

describe('asset sizing + mp4 probe', () => {
  it('fitInside never enlarges and keeps the aspect', () => {
    expect(fitInside(4000, 2000, 512)).toEqual({ w: 512, h: 256 });
    expect(fitInside(300, 200, 512)).toEqual({ w: 300, h: 200 });
    expect(fitInside(2000, 4000, 8192)).toEqual({ w: 2000, h: 4000 });
    expect(fitInside(0, 10, 512)).toEqual({ w: 0, h: 0 });
  });

  it('reads fps and codec from a minimal moov', () => {
    const box = (type: string, ...p: Array<number[] | Uint8Array>) => {
      const body = concat(p.map((x) => Uint8Array.from(x)));
      return bytes(be32(8 + body.length), type, body);
    };
    const stts = box('stts', [0, 0, 0, 0], be32(1), be32(48), be32(500)); // 48 samples x 500 ticks @ 12000/s = 2 s -> 24 fps
    const stsd = box('stsd', [0, 0, 0, 0], be32(1), be32(16), enc.encode('avc1'), new Array(8).fill(0));
    const stbl = box('stbl', stts, stsd);
    const mdhd = box('mdhd', [0, 0, 0, 0], be32(0), be32(0), be32(12000), be32(24000), [0, 0, 0, 0]);
    const hdlr = box('hdlr', [0, 0, 0, 0], be32(0), enc.encode('vide'), new Array(12).fill(0));
    const moov = box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', stbl))));
    expect(probeMoov(moov)).toEqual({ fps: 24, codec: 'h264' });
  });
});
