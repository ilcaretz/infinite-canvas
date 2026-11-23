import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

/** Server-side PDF: page count + page-1 thumbnail (pdf.js legacy build + a prebuilt @napi-rs/canvas, no native build step). */

const require = createRequire(import.meta.url);
type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let lib: Promise<PdfJs> | null = null;
const loadLib = () => (lib ??= import('pdfjs-dist/legacy/build/pdf.mjs'));

function pdfDir(): string {
  return path.dirname(require.resolve('pdfjs-dist/package.json'));
}

export interface PdfAssets { pages: number; width: number; height: number; thumb: Buffer }

/** Render page 1 to a WebP (max `maxSide` px on the long side). Throws on a damaged PDF. */
export async function renderPdfFirstPage(file: string, maxSide = 768): Promise<PdfAssets> {
  const pdfjs = await loadLib();
  const data = new Uint8Array(await fs.readFile(file));
  const dir = pdfDir();
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: false,
    standardFontDataUrl: pathToFileURL(path.join(dir, 'standard_fonts') + path.sep).href,
    cMapUrl: pathToFileURL(path.join(dir, 'cmaps') + path.sep).href,
    cMapPacked: true,
    verbosity: 0,
  });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = maxSide / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const { createCanvas } = await import('@napi-rs/canvas');
    const canvas = createCanvas(Math.max(1, Math.round(vp.width)), Math.max(1, Math.round(vp.height)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport: vp }).promise;
    const png = canvas.toBuffer('image/png');
    const thumb = await sharp(png).webp({ quality: 85 }).toBuffer();
    return { pages: doc.numPages, width: Math.round(base.width), height: Math.round(base.height), thumb };
  } finally {
    await task.destroy();
  }
}
