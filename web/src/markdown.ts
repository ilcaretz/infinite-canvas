import DOMPurify from 'dompurify';
import { marked } from 'marked';

let hooked = false;

/** Markdown -> sanitized HTML (marked + DOMPurify; scripts, handlers and unsafe URLs are removed). */
export function renderMarkdown(src: string): string {
  if (!hooked) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    hooked = true;
  }
  const html = marked.parse(src, { async: false, gfm: true }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
