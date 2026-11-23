export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHA_RE = /^[0-9a-f]{64}$/i;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
export const err = (status: number, error: string, headers: Record<string, string> = {}) => json({ error }, status, headers);

export function redirect(location: string, status = 302, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { location, ...headers } });
}

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10) : '';
}

/** originals/<id[0:2]>/<id>.<ext>: same scheme as the Node server's remoteOriginalKey. */
export function remoteOriginalKey(mediaId: string, name: string): string {
  const ext = extOf(name);
  return `originals/${mediaId.slice(0, 2)}/${mediaId}${ext ? '.' + ext : ''}`;
}
export const thumbKeyOf = (id: string) => `thumbs/${id}.webp`;
export const previewKeyOf = (id: string) => `previews/${id}.webp`;
export const posterKeyOf = (id: string) => `previews/${id}.poster.webp`;

export const cleanName = (v: unknown) =>
  String(v ?? 'file').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'file';

/** Content-Disposition value that survives any UTF-8 file name. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim() || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/%/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** File name (no extension) safe for a ComfyUI workflows/Board/<name>.json path. */
export function safeWorkflowName(original: string): string {
  const base = original.replace(/\.[^./\\]*$/, '');
  const clean = base.replace(/[\u0000-\u001f\\/:*?"<>|%#]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
  return clean || 'workflow';
}

export const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);

export function* chunks<T>(arr: T[], n: number): Generator<T[]> {
  for (let i = 0; i < arr.length; i += n) yield arr.slice(i, i + n);
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
