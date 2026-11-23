import { MAX_TEXT_BYTES } from './env';

export type TextFormat = 'txt' | 'md' | 'fountain' | 'fdx';
export { MAX_TEXT_BYTES };
export const PREVIEW_LINES = 20;

export function textFormatOf(ext: string): TextFormat | null {
  if (ext === 'txt') return 'txt';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (ext === 'fdx') return 'fdx';
  return null;
}

export function decodeText(buf: ArrayBuffer | Uint8Array): string {
  let t = new TextDecoder().decode(buf);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t;
}

export interface ScreenplayElement { type: string; text: string }

const FDX_TYPES: Record<string, string> = {
  'scene heading': 'scene', action: 'action', character: 'character', dialogue: 'dialogue', parenthetical: 'parenthetical',
  transition: 'transition', general: 'general', shot: 'scene',
};
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unent = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });

/** Final Draft paragraphs by regex (no XML library in the Worker). Capped at 3 MB of XML to respect the CPU budget. */
export function parseFdx(xml: string): ScreenplayElement[] {
  if (!/<FinalDraft[\s>]/.test(xml.slice(0, 4096))) throw new Error('not a Final Draft file');
  const out: ScreenplayElement[] = [];
  const src = xml.length > 3_000_000 ? xml.slice(0, 3_000_000) : xml;
  for (const m of src.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/g)) {
    const type = FDX_TYPES[(/\bType="([^"]*)"/.exec(m[1])?.[1] ?? '').toLowerCase()] ?? 'action';
    let t = '';
    for (const tm of m[2].matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/g)) t += unent(tm[1].replace(/<[^>]+>/g, ''));
    t = t.replace(/\s+/g, ' ').trim();
    if (!t) continue;
    out.push({ type, text: type === 'scene' || type === 'character' || type === 'transition' ? t.toUpperCase() : t });
  }
  return out;
}

export function previewOf(text: string, lines = PREVIEW_LINES, maxCols = 160): string {
  return text.replace(/\r\n?/g, '\n').split('\n').slice(0, lines).map((l) => (l.length > maxCols ? `${l.slice(0, maxCols)}…` : l)).join('\n').trimEnd();
}

export function countText(text: string): { lines: number; words: number } {
  const t = text.replace(/\r\n?/g, '\n');
  const trimmed = t.replace(/\n+$/, '');
  return { lines: trimmed === '' ? 0 : trimmed.split('\n').length, words: (t.match(/\S+/g) ?? []).length };
}

export function textStats(text: string) {
  return { ...countText(text), textPreview: previewOf(text) };
}
