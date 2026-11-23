/** Browser port of server/src/documents.ts text handling: decodeText, Final Draft parsing, previewOf, countText, textStats. */

export type TextFormat = 'txt' | 'md' | 'fountain' | 'fdx';
export const MAX_TEXT_BYTES = 20 * 1024 * 1024;
export const PREVIEW_LINES = 20;

/** Same mapping as the server textFormatOf (extension -> format), null for non-text. */
export function textFormatOf(ext: string): TextFormat | null {
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (ext === 'fdx') return 'fdx';
  return null;
}

export function decodeText(buf: Uint8Array): string {
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

type ScreenplayType = 'scene' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'general';
export interface ScreenplayElement { type: ScreenplayType; text: string }

const FDX_TYPES: Record<string, ScreenplayType> = {
  'scene heading': 'scene', action: 'action', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical',
  transition: 'transition', general: 'general', shot: 'scene',
};

/** Paragraphs of a Final Draft (.fdx) file in document order (DOMParser instead of fast-xml-parser). Throws when it is not a Final Draft script. */
export function parseFdx(xml: string): ScreenplayElement[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  if (!root || root.localName !== 'FinalDraft' || doc.getElementsByTagName('parsererror').length) throw new Error('not a Final Draft file');
  const content = Array.from(root.children).find((c) => c.localName === 'Content');
  if (!content) throw new Error('not a Final Draft file');
  const out: ScreenplayElement[] = [];
  for (const p of Array.from(content.children)) {
    if (p.localName !== 'Paragraph') continue;
    const raw = Array.from(p.children).filter((c) => c.localName === 'Text').map((t) => t.textContent ?? '').join('');
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const type = FDX_TYPES[(p.getAttribute('Type') ?? '').toLowerCase()] ?? 'action';
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

export function previewOf(text: string, lines = PREVIEW_LINES, maxCols = 160): string {
  return text.replace(/\r\n?/g, '\n').split('\n').slice(0, lines).map((l) => (l.length > maxCols ? `${l.slice(0, maxCols)}…` : l)).join('\n').trimEnd();
}

export function countText(text: string): { lines: number; words: number } {
  const t = text.replace(/\r\n?/g, '\n');
  const trimmed = t.replace(/\n+$/, '');
  return { lines: trimmed === '' ? 0 : trimmed.split('\n').length, words: (t.match(/\S+/g) ?? []).length };
}

export function textStats(text: string, format: TextFormat) {
  const shown = format === 'fdx' ? elementsToText(parseFdx(text)) : text;
  return { ...countText(shown), textPreview: previewOf(shown) };
}

export interface TextMeta { textPreview: string; lines: number; words: number }

/** Stats of a text document file; null when it is over 20 MB, not text, or an invalid .fdx (the server fails those; here the file stays a plain card). */
export async function textMetaOf(file: Blob, ext: string): Promise<TextMeta | null> {
  const fmt = textFormatOf(ext);
  if (!fmt || file.size > MAX_TEXT_BYTES) return null;
  try {
    const s = textStats(decodeText(new Uint8Array(await file.arrayBuffer())), fmt);
    return { textPreview: s.textPreview, lines: s.lines, words: s.words };
  } catch {
    return null;
  }
}
