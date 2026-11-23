/** Fountain -> screenplay elements (minimal, forgiving). Final Draft files arrive from the server already as elements. */

export type ScreenplayType =
  | 'title' | 'scene' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'centered' | 'section' | 'synopsis' | 'general';
export interface ScreenplayElement { type: ScreenplayType; text: string; /** section depth (# = 1) */ depth?: number; para?: boolean }

const SCENE = /^(INT|EXT|EST|INT\.?\/EXT|EXT\.?\/INT|I\/E)[. ]/i;

/** Remove boneyard and note blocks. */
function strip(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
}

const isUpper = (s: string) => /[A-Z]/.test(s) && s === s.toUpperCase();

export function parseFountain(source: string): ScreenplayElement[] {
  const lines = strip(source).split('\n');
  const out: ScreenplayElement[] = [];
  let i = 0;

  // Title page: "Key: value" lines at the very top, up to the first blank line.
  if (/^[A-Za-z ]{2,20}:/.test(lines[0] ?? '')) {
    const titleLines: string[] = [];
    let j = 0;
    while (j < lines.length && lines[j].trim() !== '') titleLines.push(lines[j++]);
    if (titleLines.every((l) => /^\s+\S/.test(l) || /^[A-Za-z ]{2,20}:/.test(l))) {
      for (const l of titleLines) {
        const m = /^([A-Za-z ]{2,20}):\s*(.*)$/.exec(l);
        out.push({ type: 'title', text: m ? (m[2] ? `${m[1]}: ${m[2]}` : m[1]) : l.trim() });
      }
      i = j;
    }
  }

  const blank = (k: number) => k < 0 || k >= lines.length || lines[k].trim() === '';
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    const prevBlank = blank(i - 1);

    if (t.startsWith('#')) {
      const m = /^(#+)\s*(.*)$/.exec(t)!;
      out.push({ type: 'section', text: m[2], depth: m[1].length });
    } else if (/^={3,}$/.test(t)) {
      continue; // page break
    } else if (t.startsWith('=')) {
      out.push({ type: 'synopsis', text: t.replace(/^=\s*/, '') });
    } else if (t.startsWith('~')) {
      out.push({ type: 'general', text: t.replace(/^~/, '') }); // lyrics
    } else if (t.startsWith('>') && t.endsWith('<')) {
      out.push({ type: 'centered', text: t.slice(1, -1).trim() });
    } else if (t.startsWith('>')) {
      out.push({ type: 'transition', text: t.slice(1).trim() });
    } else if (t.startsWith('!')) {
      out.push({ type: 'action', text: raw.replace(/^\s*!/, ''), para: prevBlank });
    } else if (prevBlank && ((t.startsWith('.') && !t.startsWith('..')) || SCENE.test(t))) {
      out.push({ type: 'scene', text: t.replace(/^\./, '').replace(/\s*#[^#]+#\s*$/, '').toUpperCase() });
    } else if (prevBlank && isUpper(t) && /TO:$/.test(t) && blank(i + 1)) {
      out.push({ type: 'transition', text: t });
    } else if (prevBlank && !blank(i + 1) && (t.startsWith('@') || (!t.startsWith('(') && isUpper(t.replace(/\(.*?\)/g, '').replace(/\^$/, '').trim())))) {
      out.push({ type: 'character', text: t.replace(/^@/, '').replace(/\^$/, '') });
      while (i + 1 < lines.length && lines[i + 1].trim() !== '') {
        i++;
        const d = lines[i].trim();
        out.push(/^\(.*\)$/.test(d) ? { type: 'parenthetical', text: d } : { type: 'dialogue', text: d });
      }
    } else {
      out.push({ type: 'action', text: raw.replace(/\s+$/, ''), para: prevBlank });
    }
  }
  return mergeActions(out);
}

/** Consecutive action lines (no blank between) become one paragraph, lines kept with 
. */
function mergeActions(els: ScreenplayElement[]): ScreenplayElement[] {
  const out: ScreenplayElement[] = [];
  for (const e of els) {
    const last = out[out.length - 1];
    if (e.type === 'action' && last?.type === 'action' && !e.para) last.text += `
${e.text}`;
    else out.push({ ...e });
  }
  return out.map(({ para: _para, ...rest }) => rest);
}
