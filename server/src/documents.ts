import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

/** Text documents: flavour by extension, counts, card preview, Final Draft parsing, LibreOffice conversion. */

export type TextFormat = 'txt' | 'md' | 'fountain' | 'fdx';
export const OFFICE_EXT = new Set(['docx', 'doc', 'odt', 'rtf']);
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const PREVIEW_LINES = 20;

export function textFormatOf(ext: string): TextFormat | null {
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (ext === 'fdx') return 'fdx';
  return null;
}

export function decodeText(buf: Buffer): string {
  let t = buf.toString('utf8');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

// ---- Final Draft -----------------------------------------------------------------------------

export type ScreenplayType = 'scene' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'general';
export interface ScreenplayElement { type: ScreenplayType; text: string }

const FDX_TYPES: Record<string, ScreenplayType> = {
  'scene heading': 'scene', action: 'action', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical',
  transition: 'transition', general: 'general', shot: 'scene',
};

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf((node as Record<string, unknown>)['#text']);
  return '';
}

/** Paragraphs of a Final Draft (.fdx) file in document order. Throws when the XML is not a Final Draft script. */
export function parseFdx(xml: string): ScreenplayElement[] {
  const parser = new XMLParser({
    ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true, parseTagValue: false,
    trimValues: false, isArray: (n) => n === 'Paragraph' || n === 'Text',
  });
  const doc = parser.parse(xml) as { FinalDraft?: { Content?: { Paragraph?: Array<Record<string, unknown>> } } };
  const paras = doc.FinalDraft?.Content?.Paragraph;
  if (!doc.FinalDraft || !Array.isArray(paras)) throw new Error('not a Final Draft file');
  const out: ScreenplayElement[] = [];
  for (const p of paras) {
    const text = textOf(p.Text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const type = FDX_TYPES[String(p['@_Type'] ?? '').toLowerCase()] ?? 'action';
    out.push({ type, text: type === 'scene' || type === 'character' || type === 'transition' ? text.toUpperCase() : text });
  }
  return out;
}

/** Plain text rendition (used for counts and the card preview of .fdx). */
export function elementsToText(els: ScreenplayElement[]): string {
  const out: string[] = [];
  for (const e of els) {
    if (e.type === 'scene' || e.type === 'transition') out.push('', e.text);
    else if (e.type === 'character') out.push('', e.text);
    else out.push(e.text);
  }
  return out.join('\n').replace(/^\n+/, '');
}

// ---- counts + preview ------------------------------------------------------------------------

export function previewOf(text: string, lines = PREVIEW_LINES, maxCols = 160): string {
  return text.replace(/\r\n?/g, '\n').split('\n').slice(0, lines).map((l) => (l.length > maxCols ? `${l.slice(0, maxCols)}…` : l)).join('\n').trimEnd();
}

export function countText(text: string): { lines: number; words: number } {
  const t = text.replace(/\r\n?/g, '\n');
  const trimmed = t.replace(/\n+$/, '');
  return { lines: trimmed === '' ? 0 : trimmed.split('\n').length, words: (t.match(/\S+/g) ?? []).length };
}

/** Everything the media row stores about a text document, from its current text. */
export function textStats(text: string, format: TextFormat) {
  const shown = format === 'fdx' ? elementsToText(parseFdx(text)) : text;
  return { ...countText(shown), textPreview: previewOf(shown) };
}

// ---- LibreOffice -----------------------------------------------------------------------------

/** Convert DOCX/ODT/RTF to PDF headless. Resolves to the produced PDF path (inside `outDir`). */
export async function convertToPdf(soffice: string, input: string, outDir: string, timeoutMs = 180000): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const profile = pathToFileURL(path.join(outDir, 'lo-profile')).href; // private profile: never collides with a running LibreOffice
  const args = [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', outDir, input];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(soffice, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    const t = setTimeout(() => { p.kill(); reject(new Error('LibreOffice timed out')); }, timeoutMs);
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`soffice exited ${code}: ${err.trim().slice(-200)}`));
    });
  });
  const out = path.join(outDir, `${path.basename(input, path.extname(input))}.pdf`);
  await fs.access(out);
  return out;
}
