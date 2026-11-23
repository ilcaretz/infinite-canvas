import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app.js';
import { findSoffice, loadConfig } from '../src/config.js';
import { countText, parseFdx, previewOf, textFormatOf, textStats } from '../src/documents.js';
import { renderPdfFirstPage } from '../src/pdf.js';
import { FFMPEG, FFPROBE } from './samples.js';

let ctx: App;
let dataDir = '';
let dir = '';
const f = (n: string) => path.join(dir, n);

/** Smallest useful PDF: `pages` pages of 300x400, each carrying text. */
function tinyPdf(pages = 2): Buffer {
  const stream = 'BT /F1 24 Tf 40 300 Td (Hello PDF) Tj ET';
  const pageObj = (i: number) => 4 + i;
  const contentObj = (i: number) => 4 + pages + i;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${Array.from({ length: pages }, (_, i) => `${pageObj(i)} 0 R`).join(' ')}]/Count ${pages}>>`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ...Array.from({ length: pages }, (_, i) => `<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 400]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentObj(i)} 0 R>>`),
    ...Array.from({ length: pages }, () => `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`),
  ];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${x}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

const FDX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="2">
<Content>
<Paragraph Type="Scene Heading"><Text>int. kitchen - day</Text></Paragraph>
<Paragraph Type="Action"><Text>Anna  enters &amp; sits.</Text></Paragraph>
<Paragraph Type="Character"><Text>Anna</Text></Paragraph>
<Paragraph Type="Parenthetical"><Text>(tired)</Text></Paragraph>
<Paragraph Type="Dialogue"><Text>Morning.</Text></Paragraph>
<Paragraph Type="Transition"><Text>cut to:</Text></Paragraph>
</Content>
</FinalDraft>`;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ad-'));
  const ff = (args: string[]) => {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];
  ff([...sine, f('tone.wav')]);
  ff([...sine, '-c:a', 'libmp3lame', f('tone.mp3')]);
  ff([...sine, f('tone.aiff')]);
  fs.writeFileSync(f('doc.pdf'), tinyPdf(2));
  fs.writeFileSync(f('note.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the note`).join('\n'));
  fs.writeFileSync(f('script.fountain'), 'INT. ROOM - DAY\n\nBOB\nHi there.\n');
  fs.writeFileSync(f('script.fdx'), FDX);
  fs.writeFileSync(f('readme.md'), '# Title\n\nSome *text*.\n');
  fs.writeFileSync(f('fake.docx'), Buffer.from('PK\u0003\u0004not really a docx'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board data '));
});
afterAll(async () => {
  await ctx?.app.close();
  ctx?.repo.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.rmSync(dir, { recursive: true, force: true });
});

const boot = async (soffice: string | null = null) => {
  ctx = await buildApp(loadConfig({ dataDir, ffmpeg: FFMPEG, ffprobe: FFPROBE, soffice, maxFileBytes: 5 * 1024 * 1024, webDist: path.join(dataDir, 'none') }));
};
const upload = async (name: string, as = name) => {
  const res = await ctx.app.inject({
    method: 'PUT', url: '/api/media', headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(as) },
    payload: fs.readFileSync(f(name)),
  });
  const id = (res.json() as { media: { id: string } }).media.id;
  await ctx.processor.idle();
  return ctx.repo.getMedia(id)!;
};

describe('documents (pure)', () => {
  it('picks the text flavour by extension and counts lines/words', () => {
    expect(['txt', 'md', 'markdown', 'fountain', 'fdx', 'docx'].map(textFormatOf)).toEqual(['txt', 'md', 'md', 'fountain', 'fdx', null]);
    expect(countText('a b\nc\n\n')).toEqual({ lines: 2, words: 3 });
    expect(countText('')).toEqual({ lines: 0, words: 0 });
    expect(previewOf(Array.from({ length: 50 }, (_, i) => `l${i}`).join('\r\n')).split('\n')).toHaveLength(20);
  });
  it('parses Final Draft paragraphs', () => {
    const els = parseFdx(FDX);
    expect(els.map((e) => e.type)).toEqual(['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition']);
    expect(els[0].text).toBe('INT. KITCHEN - DAY');
    expect(els[1].text).toBe('Anna enters & sits.');
    expect(() => parseFdx('<html/>')).toThrow();
    expect(textStats(FDX, 'fdx').textPreview).toContain('INT. KITCHEN - DAY');
  });
  it('finds soffice from SOFFICE_PATH / PATH / default folders', () => {
    const has = new Set(['C:\\x\\soffice.exe', 'C:\\Program Files\\LibreOffice\\program\\soffice.exe']);
    const ex = (p: string) => has.has(p);
    expect(findSoffice('C:\\x\\soffice.exe', '', ex)).toBe('C:\\x\\soffice.exe');
    expect(findSoffice('C:\\nope\\soffice.exe', '', ex)).toBeNull();
    expect(findSoffice(undefined, '', ex)).toBe('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    expect(findSoffice(undefined, '', () => false)).toBeNull();
  });
  it('renders page 1 of a PDF and counts pages', async () => {
    const r = await renderPdfFirstPage(f('doc.pdf'));
    expect(r.pages).toBe(2);
    expect([r.width, r.height]).toEqual([300, 400]);
    const m = await sharp(r.thumb).metadata();
    expect(m.format).toBe('webp');
    expect(m.width! / m.height!).toBeCloseTo(0.75, 1);
  });
});

describe('audio + documents through the API', () => {
  beforeAll(() => boot(null));

  it('plays WAV/MP3 directly and makes a transparent waveform + duration', async () => {
    for (const name of ['tone.wav', 'tone.mp3']) {
      const m = await upload(name);
      expect(m.status).toBe('ready');
      expect(m.kind).toBe('audio');
      expect(m.previewKey).toBeNull();
      expect(m.durationMs).toBeGreaterThan(1900);
      expect(m.durationMs).toBeLessThan(2200);
      expect(m.sampleRate).toBeGreaterThan(8000);
      expect(m.channels).toBeGreaterThan(0);
      const w = await sharp(ctx.storage.localPath(m.thumbKey!)).metadata();
      expect([w.width, w.height, w.hasAlpha]).toEqual([1200, 200, true]);
      const info = (await ctx.app.inject({ url: `/api/media/${m.id}/info` })).json();
      expect(info.sampleRate).toBe(m.sampleRate);
      expect(info.durationMs).toBe(m.durationMs);
      const dto = (await ctx.app.inject({ url: `/api/media?ids=${m.id}` })).json().media[0];
      expect(dto.urls.thumb).toBe(`/api/media/${m.id}/thumb`);
      expect(dto.urls.preview).toBe(`/api/media/${m.id}/preview`);
    }
  });

  it('transcodes a non-browser format (AIFF) to an M4A preview', async () => {
    const m = await upload('tone.aiff');
    expect(m.kind).toBe('audio');
    expect(m.previewKey).toMatch(/\.m4a$/);
    const res = await ctx.app.inject({ url: `/api/media/${m.id}/preview` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mp4');
    expect(m.durationMs).toBeGreaterThan(1900);
  });

  it('PDF: page count, page-1 thumbnail, aspect', async () => {
    const m = await upload('doc.pdf');
    expect(m).toMatchObject({ kind: 'document', status: 'ready', pages: 2, mime: 'application/pdf', codec: 'pdf' });
    expect(m.thumbKey).toBeTruthy();
    const dto = (await ctx.app.inject({ url: `/api/media?ids=${m.id}` })).json().media[0];
    expect(dto.pages).toBe(2);
    expect(dto.urls.preview).toBe(`/api/media/${m.id}/preview`);
    const pv = await ctx.app.inject({ url: `/api/media/${m.id}/preview` });
    expect(pv.headers['content-type']).toBe('application/pdf');
    expect(pv.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
    expect((await ctx.app.inject({ url: `/api/media/${m.id}/info` })).json().pages).toBe(2);
  });

  it('text card preview shows the first 20 lines; counts are stored', async () => {
    const m = await upload('note.txt');
    expect(m).toMatchObject({ kind: 'document', codec: 'txt', lines: 30 });
    expect(m.textPreview!.split('\n')).toHaveLength(20);
    expect(m.textPreview).toContain('line 20 of the note');
    expect(m.textPreview).not.toContain('line 21');
    const fo = await upload('script.fountain');
    expect(fo.codec).toBe('fountain');
    const fd = await upload('script.fdx');
    expect(fd.codec).toBe('fdx');
    expect(fd.textPreview).toContain('ANNA');
  });

  it('DOCX without LibreOffice stays a ready file card with the original downloadable', async () => {
    const m = await upload('fake.docx');
    expect(m).toMatchObject({ kind: 'document', status: 'ready', thumbKey: null, previewKey: null });
    const dto = (await ctx.app.inject({ url: `/api/media?ids=${m.id}` })).json().media[0];
    expect(dto.urls.preview).toBeNull();
    expect((await ctx.app.inject({ url: `/api/media/${m.id}/download` })).statusCode).toBe(200);
  });

  it('saves versions, lists them, restores, and refreshes the card preview', async () => {
    const m = await upload('readme.md');
    const url = `/api/media/${m.id}/document`;
    const first = (await ctx.app.inject({ url })).json();
    expect(first).toMatchObject({ format: 'md', editable: true, current: 'original' });
    expect(first.text).toBe('# Title\n\nSome *text*.\n');
    expect(first.versions).toHaveLength(1);

    const put = (text: unknown) => ctx.app.inject({ method: 'PUT', url, payload: { text } });
    const v1 = (await put('# New title\nsecond')).json();
    expect(v1.text).toBe('# New title\nsecond');
    expect(v1.versions).toHaveLength(2);
    expect(v1.current).not.toBe('original');
    const v2 = (await put('third version here')).json();
    expect(v2.versions).toHaveLength(3);
    expect(ctx.repo.getMedia(m.id)!.textPreview).toBe('third version here');
    expect(ctx.repo.getMedia(m.id)!.words).toBe(3);
    expect((await ctx.app.inject({ url: `${url}?version=${v1.current}` })).json().text).toBe('# New title\nsecond');

    const restored = (await ctx.app.inject({ method: 'POST', url: `${url}/restore`, payload: { versionId: 'original' } })).json();
    expect(restored.text).toBe('# Title\n\nSome *text*.\n');
    expect(restored.versions).toHaveLength(4); // restoring adds a version, nothing is lost
    expect(ctx.repo.getMedia(m.id)!.textPreview).toContain('# Title');
    // the uploaded original is untouched
    expect(fs.readFileSync(ctx.storage.localPath(m.originalKey), 'utf8')).toBe('# Title\n\nSome *text*.\n');
    expect((await ctx.app.inject({ method: 'POST', url: `${url}/restore`, payload: { versionId: 'nope' } })).statusCode).toBe(404);
    expect((await put(undefined)).statusCode).toBe(400);
  });

  it('serves .fdx as parsed elements and refuses to edit it', async () => {
    const m = await upload('script.fdx');
    const d = (await ctx.app.inject({ url: `/api/media/${m.id}/document` })).json();
    expect(d.editable).toBe(false);
    expect(d.elements[0]).toEqual({ type: 'scene', text: 'INT. KITCHEN - DAY' });
    expect((await ctx.app.inject({ method: 'PUT', url: `/api/media/${m.id}/document`, payload: { text: 'x' } })).statusCode).toBe(400);
    const pdf = await upload('doc.pdf');
    expect((await ctx.app.inject({ url: `/api/media/${pdf.id}/document` })).statusCode).toBe(404);
  });
});
