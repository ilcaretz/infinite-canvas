import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// Allow-list-free sanitizer: drop dangerous elements, event handlers, scripting URLs and external references.
const DROP_ELEMENTS = new Set([
  'script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'handler', 'listener',
  'set', 'animate', 'animatemotion', 'animatetransform', 'discard', 'link', 'meta', 'style-sheet',
]);

type XNode = Record<string, unknown>;

function cleanCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(/javascript\s*:/gi, '')
    // keep only url(#local) references
    .replace(/url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (m, _q: string, target: string) => (target.trim().startsWith('#') ? m : 'none'));
}

function safeHref(v: string): boolean {
  const t = v.trim();
  if (t.startsWith('#')) return true;
  return /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]*$/i.test(t);
}

function cleanAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const name = k.replace(/^@_/, '').toLowerCase();
    const val = String(v);
    if (name.startsWith('on')) continue;
    if (name === 'href' || name === 'xlink:href' || name === 'src') {
      if (!safeHref(val)) continue;
    } else if (name === 'style') {
      out[k] = cleanCss(val);
      continue;
    } else if (/javascript\s*:|data:text\/html/i.test(val)) continue;
    else if (/url\(/i.test(val)) {
      out[k] = cleanCss(val);
      continue;
    }
    out[k] = val;
  }
  return out;
}

function walk(nodes: XNode[]): XNode[] {
  const out: XNode[] = [];
  for (const node of nodes) {
    const keys = Object.keys(node).filter((k) => k !== ':@');
    const tag = keys[0];
    if (!tag) continue;
    if (tag === '#text') {
      out.push(node);
      continue;
    }
    if (tag.startsWith('?') || tag.startsWith('!') || tag === '#comment') continue; // PIs, doctype, comments
    const local = tag.includes(':') ? tag.split(':').pop()! : tag;
    if (DROP_ELEMENTS.has(local.toLowerCase())) continue;
    const children = walk((node[tag] as XNode[]) ?? []);
    if (local.toLowerCase() === 'style') {
      for (const c of children) if (typeof c['#text'] === 'string') c['#text'] = cleanCss(c['#text']);
    }
    const next: XNode = { [tag]: children };
    if (node[':@']) next[':@'] = cleanAttrs(node[':@'] as Record<string, string>);
    out.push(next);
  }
  return out;
}

/** Returns sanitized SVG markup, or throws when the input is not parseable SVG. */
export function sanitizeSvg(input: string): string {
  const text = input.replace(/^﻿/, '');
  const parser = new XMLParser({
    preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false,
    allowBooleanAttributes: true, parseAttributeValue: false, trimValues: false, commentPropName: '#comment', cdataPropName: false,
  });
  const tree = parser.parse(text) as XNode[];
  const cleaned = walk(tree);
  const root = cleaned.find((n) => Object.keys(n).some((k) => k.replace(/^.*:/, '').toLowerCase() === 'svg'));
  if (!root) throw new Error('not an SVG document');
  const builder = new XMLBuilder({
    preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', suppressEmptyNode: true,
    processEntities: false, format: false, suppressBooleanAttributes: false,
  });
  return builder.build([root]) as string;
}
