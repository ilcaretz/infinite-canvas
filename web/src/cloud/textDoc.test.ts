// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { putAsset } from './cloudUpload';
import { countText, MAX_TEXT_BYTES, parseFdx, previewOf, textFormatOf, textMetaOf } from './textDoc';

const FDX = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<FinalDraft DocumentType="Script" Template="No" Version="5">
  <Content>
    <Paragraph Type="Scene Heading"><Text>int. kitchen - day</Text></Paragraph>
    <Paragraph Type="Action"><Text>Anna  enters</Text><Text> and sits.</Text></Paragraph>
    <Paragraph Type="Character"><Text>anna</Text></Paragraph>
    <Paragraph Type="Dialogue"><Text>Hello &amp; welcome.</Text></Paragraph>
    <Paragraph Type="Action"><Text>   </Text></Paragraph>
    <Paragraph Type="Transition"><Text>cut to:</Text></Paragraph>
  </Content>
</FinalDraft>`;

describe('text document meta (port of documents.ts)', () => {
  it('formats by extension like the server', () => {
    expect(textFormatOf('markdown')).toBe('md');
    expect(textFormatOf('spmd')).toBe('fountain');
    expect(textFormatOf('pdf')).toBeNull();
  });

  it('plain text: BOM stripped, CRLF counted, preview limited to 20 lines / 160 cols', async () => {
    const body = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n\r\n';
    const m = await textMetaOf(new Blob(['\uFEFF', body]), 'txt');
    expect(m).toMatchObject({ lines: 30, words: 60 });
    expect(m!.textPreview.split('\n')).toHaveLength(20);
    expect(m!.textPreview.startsWith('line 1\n')).toBe(true);
    expect(previewOf('x'.repeat(200))).toBe('x'.repeat(160) + '…');
    expect(countText('')).toEqual({ lines: 0, words: 0 });
  });

  it('fdx: paragraphs in order, headings / characters / transitions upper-cased, blanks dropped', async () => {
    expect(parseFdx(FDX).map((e) => e.type)).toEqual(['scene', 'action', 'character', 'dialogue', 'transition']);
    const m = await textMetaOf(new Blob([FDX]), 'fdx');
    expect(m!.textPreview).toBe('INT. KITCHEN - DAY\nAnna enters and sits.\n\nANNA\nHello & welcome.\n\nCUT TO:');
    expect(m).toMatchObject({ lines: 7, words: 14 });
  });

  it('invalid fdx, non-text and files over 20 MB give null', async () => {
    expect(await textMetaOf(new Blob(['<html/>']), 'fdx')).toBeNull();
    expect(await textMetaOf(new Blob(['x']), 'pdf')).toBeNull();
    expect(await textMetaOf({ size: MAX_TEXT_BYTES + 1 } as Blob, 'txt')).toBeNull();
  });
});

describe('asset PUT content-type', () => {
  it('sends the blob type (png from Safari), webp by default', async () => {
    const seen: string[] = [];
    const f = (async (_u: unknown, init: RequestInit) => {
      seen.push((init.headers as Record<string, string>)['content-type']);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    expect(await putAsset('u', new Blob(['x'], { type: 'image/png' }), f)).toBe(true);
    expect(await putAsset('u', new Blob(['x'], { type: 'image/webp' }), f)).toBe(true);
    expect(await putAsset('u', new Blob(['x']), f)).toBe(true);
    expect(seen).toEqual(['image/png', 'image/webp', 'image/webp']);
  });
});
