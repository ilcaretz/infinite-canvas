import {
  attemptKey, clearFails, cookieHeader, COOKIE, loginPage, parseCookies, parseUsers, recordFail, REFRESH_AFTER_MS, retryAfter,
  safeNext, SESSION_DAYS, signSession, verifyLogin, verifySession, type UserEntry,
} from './auth';
import { commentDto, cleanProps, IMMUTABLE, infoDto, isPdf, mediaDto, MIME_BY_KEY_EXT, parseProps } from './dto';
import { decodeText, parseFdx, textFormatOf, textStats, type TextFormat } from './documents';
import {
  FROM_URL_MAX, MAX_TEXT_BYTES, MULTIPART_THRESHOLD, maxFileBytes, partSizeFor, planParts, type Env,
} from './env';
import { Repo, type ItemUpsert, type MediaRow } from './repo';
import { getS3, isNoSuchUpload, S3 } from './s3';
import { BlockedUrlError, checkUrlSyntax } from './ssrf';
import {
  chunks, cleanName, contentDisposition, err, extOf, HttpError, int, json, posterKeyOf, previewKeyOf, readJson, redirect,
  remoteOriginalKey, safeWorkflowName, SHA_RE, text, thumbKeyOf, UUID_RE, num,
} from './util';

export const VERSION = '0.2.0-cloud';
const TRASH_DAYS = 30;
const ITEM_KINDS = new Set(['image', 'video', 'audio', 'document', 'file', 'text', 'group']);
const MEDIA_KINDS = new Set(['image', 'video', 'audio', 'document', 'file']);
const MAX_COMMENT = 8000;
/** Redirects to presigned URLs may be cached by the browser for this long (the signed URL lives >= 10 more minutes). */
const REDIRECT_CACHE_S = 300;

interface Ctx { req: Request; env: Env; url: URL; p: string[]; user: string; repo: Repo }
type Handler = (c: Ctx) => Promise<Response> | Response;

// ---------------------------------------------------------------------------------------------
// helpers

async function serve(c: Ctx, key: string, mime: string, opts: { disposition?: string; cache?: string } = {}): Promise<Response> {
  // SVG can carry script: never let it render inline as a page. <img> still draws it; opening the URL directly downloads it.
  const svg = mime === 'image/svg+xml' || key.toLowerCase().endsWith('.svg');
  const disposition = svg ? 'attachment' : opts.disposition;
  const url = await getS3(c.env).url(key, { mime, disposition, cache: opts.cache });
  return redirect(url, 302, { 'cache-control': opts.cache === IMMUTABLE ? `private, max-age=${REDIRECT_CACHE_S}` : 'no-store' });
}

function fixedLength(body: ReadableStream<Uint8Array>, len: number): ReadableStream<Uint8Array> {
  if (typeof FixedLengthStream === 'undefined') return body;
  const { readable, writable } = new FixedLengthStream(len);
  void body.pipeTo(writable).catch(() => {});
  return readable as ReadableStream<Uint8Array>;
}

async function deleteKeys(env: Env, keys: string[]) {
  for (const c of chunks(keys.filter(Boolean), 1000)) await env.BUCKET.delete(c);
}

async function purgeItems(env: Env, repo: Repo, ids: string[]) {
  const mediaIds = await repo.hardDeleteItems(ids);
  let media = 0;
  for (const mid of mediaIds) {
    const m = await repo.getMedia(mid);
    if (!m || m.status === 'processing' || (await repo.mediaRefCount(mid)) > 0) continue;
    await deleteKeys(env, await repo.hardDeleteMedia(mid));
    media++;
  }
  return { items: ids.length, media };
}

/** Items trashed more than 30 days ago go for good (cron trigger). */
export async function purgeExpired(env: Env, now = Date.now()) {
  const repo = new Repo(env.DB);
  const old = await repo.expiredItems(now - TRASH_DAYS * 24 * 3600 * 1000);
  return old.length ? purgeItems(env, repo, old.map((i) => i.id)) : { items: 0, media: 0 };
}

// ---------------------------------------------------------------------------------------------
// routes

const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, path: string, h: Handler) =>
  routes.push([method, new RegExp('^' + path.replace(/:[a-z]+/gi, '([^/]+)').replace(/\*/g, '(.+)') + '$'), h]);

route('GET', '/api/me', (c) => json({ user: c.user }));
route('GET', '/api/config', (c) =>
  json({ comfyUrl: '', canReveal: false, storage: 's3', authRequired: true, cloud: true, user: c.user }));

// ---- boards ----
route('GET', '/api/boards', async (c) => json({ boards: await c.repo.listBoards() }));
route('POST', '/api/boards', async (c) => {
  const name = String((await readJson(c.req)).name ?? '').trim().slice(0, 120) || 'Untitled board';
  return json({ board: await c.repo.createBoard(name) });
});
route('PATCH', '/api/boards/:id', async (c) => {
  const name = String((await readJson(c.req)).name ?? '').trim().slice(0, 120);
  if (!name) return err(400, 'name required');
  if (!(await c.repo.renameBoard(c.p[0], name))) return err(404, 'no such board');
  return json({ board: await c.repo.getBoard(c.p[0]) });
});
route('DELETE', '/api/boards/:id', async (c) => {
  if (!(await c.repo.deleteBoard(c.p[0]))) return err(404, 'no such board');
  return json({ ok: true });
});
route('GET', '/api/boards/:id', async (c) => {
  const board = await c.repo.getBoard(c.p[0]);
  if (!board) return err(404, 'no such board');
  const [rows, comments] = await Promise.all([c.repo.listItems(board.id), c.repo.listComments(board.id)]);
  const mediaById = new Map((await c.repo.getMediaMany([...new Set(rows.map((r) => r.mediaId).filter((v): v is string => !!v))])).map((m) => [m.id, m]));
  const items = [];
  const deleted: Array<{ id: string; deletedAt: number }> = [];
  for (const r of rows) {
    if (r.deletedAt) {
      deleted.push({ id: r.id, deletedAt: r.deletedAt });
      continue;
    }
    const m = r.mediaId ? mediaById.get(r.mediaId) : undefined;
    items.push({
      id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z, mediaId: r.mediaId, name: r.name, props: parseProps(r.props),
      version: r.version, updatedAt: r.updatedAt, media: m ? mediaDto(m) : null,
    });
  }
  return json({ board, items, deleted, comments: comments.map(commentDto), serverTime: Date.now() });
});

// ---- comments ----
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const frac = (v: unknown) => { const n = fin(v); return n === null ? null : Math.min(1, Math.max(0, n)); };

route('POST', '/api/boards/:id/comments', async (c) => {
  const id = c.p[0];
  if (!(await c.repo.getBoard(id))) return err(404, 'no such board');
  const b = await readJson(c.req);
  const cid = str(b.id, 80) || crypto.randomUUID();
  const body = str(b.text, MAX_COMMENT);
  const author = str(b.author, 80);
  if (!body) return err(400, 'text required');
  if (!author) return err(400, 'author required');
  const itemId = str(b.itemId, 80) || null;
  if (itemId) {
    const it = await c.repo.getItem(itemId);
    if (!it || it.boardId !== id) return err(400, 'no such item on this board');
  }
  const itemX = itemId ? frac(b.itemX) : null;
  const itemY = itemId ? frac(b.itemY) : null;
  if (itemId && (itemX === null || itemY === null)) return err(400, 'itemX/itemY required');
  if (!itemId && (fin(b.x) === null || fin(b.y) === null)) return err(400, 'x/y required');
  const vt = fin(b.videoTimeMs);
  const prior = await c.repo.getComment(cid);
  if (prior && prior.boardId !== id) return err(409, 'id in use');
  await c.repo.createComment({
    id: cid, boardId: id, itemId, x: fin(b.x) ?? 0, y: fin(b.y) ?? 0, itemX, itemY,
    videoTimeMs: vt === null ? null : Math.max(0, Math.round(vt)), author, text: body, messageId: str(b.messageId, 80) || crypto.randomUUID(),
  });
  return json({ comment: commentDto((await c.repo.commentWithMessages(cid))!) });
});
route('POST', '/api/comments/:id/messages', async (c) => {
  const b = await readJson(c.req);
  const body = str(b.text, MAX_COMMENT);
  const author = str(b.author, 80);
  if (!body) return err(400, 'text required');
  if (!author) return err(400, 'author required');
  if (!(await c.repo.addMessage(c.p[0], str(b.id, 80) || crypto.randomUUID(), author, body))) return err(404, 'no such comment');
  return json({ comment: commentDto((await c.repo.commentWithMessages(c.p[0]))!) });
});
route('PATCH', '/api/comments/:id', async (c) => {
  const resolved = (await readJson(c.req)).resolved;
  if (typeof resolved !== 'boolean') return err(400, 'resolved (boolean) required');
  if (!(await c.repo.setCommentResolved(c.p[0], resolved))) return err(404, 'no such comment');
  return json({ comment: commentDto((await c.repo.commentWithMessages(c.p[0]))!) });
});
route('DELETE', '/api/comments/:id', async (c) => {
  if (!(await c.repo.deleteComment(c.p[0]))) return err(404, 'no such comment');
  return json({ ok: true });
});

// ---- items ----
route('PUT', '/api/boards/:id/items', async (c) => {
  const id = c.p[0];
  if (!(await c.repo.getBoard(id))) return err(404, 'no such board');
  const body = await readJson(c.req);
  const cand: Array<{ r: Record<string, unknown>; mediaId: string | null }> = [];
  for (const raw of Array.isArray(body.upserts) ? body.upserts : []) {
    if (raw && typeof raw === 'object') cand.push({ r: raw as Record<string, unknown>, mediaId: typeof (raw as { mediaId?: unknown }).mediaId === 'string' ? (raw as { mediaId: string }).mediaId : null });
  }
  const known = await c.repo.existingMediaIds([...new Set(cand.map((x) => x.mediaId).filter((v): v is string => !!v))]);
  const upserts: ItemUpsert[] = [];
  for (const { r, mediaId } of cand) {
    const [x, y, w, h, z, version, updatedAt] = ['x', 'y', 'w', 'h', 'z', 'version', 'updatedAt'].map((k) => num(r[k]));
    if (typeof r.id !== 'string' || !r.id || r.id.length > 80 || typeof r.kind !== 'string' || !ITEM_KINDS.has(r.kind)) continue;
    if ([x, y, w, h, z, version, updatedAt].some((v) => v === null)) continue;
    upserts.push({
      id: r.id, kind: r.kind, x: x!, y: y!, w: Math.max(1, w!), h: Math.max(1, h!), z: z!, mediaId: mediaId && known.has(mediaId) ? mediaId : null,
      name: String(r.name ?? '').slice(0, 512), props: cleanProps(r.kind, r.props), version: Math.round(version!), updatedAt: Math.round(updatedAt!),
    });
  }
  const deletes: Array<{ id: string; updatedAt: number }> = [];
  for (const raw of Array.isArray(body.deletes) ? body.deletes : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    if (typeof r.id === 'string' && num(r.updatedAt) !== null) deletes.push({ id: r.id, updatedAt: Math.round(r.updatedAt as number) });
  }
  return json({ ok: true, rejected: await c.repo.saveItems(id, upserts, deletes) });
});

// ---- media: uploads (browser -> R2 directly) ----
route('PUT', '/api/media', () => err(400, 'direct uploads are not available in the cloud version; use POST /api/uploads/init', { connection: 'close' }));

route('POST', '/api/uploads/init', async (c) => {
  const b = await readJson(c.req);
  const size = b.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return err(400, 'size (bytes) required');
  if (size > maxFileBytes(c.env)) return err(413, `file is larger than ${(maxFileBytes(c.env) / 1024 ** 3).toFixed(1)} GB`);
  const sha = typeof b.sha256 === 'string' && SHA_RE.test(b.sha256) ? b.sha256.toLowerCase() : '';
  if (sha) {
    const existing = await c.repo.getMediaBySha(sha);
    if (existing && existing.status === 'ready') return json({ deduped: true, media: mediaDto(existing) });
  }
  const filename = cleanName(b.filename);
  const mime = (text(b.mime, 200) ?? text(b.type, 200) ?? 'application/octet-stream').trim();
  const mediaId = crypto.randomUUID();
  const key = remoteOriginalKey(mediaId, filename);
  const s3 = getS3(c.env);
  const assetUrls = {
    thumb: await s3.presignPut(thumbKeyOf(mediaId)),
    preview: await s3.presignPut(previewKeyOf(mediaId)),
    poster: await s3.presignPut(posterKeyOf(mediaId)),
  };
  if (size <= MULTIPART_THRESHOLD) {
    await c.repo.addUpload({ id: mediaId, filename, size, mime, sha256: sha, originalKey: key, uploadId: null, uploadedBy: c.user });
    return json({
      deduped: false, mediaId, mode: 'single', url: await s3.presignPut(key), headers: { 'content-type': 'application/octet-stream' },
      expiresInS: s3.ttl, assetUrls,
    });
  }
  const uploadId = await s3.createMultipart(key);
  const partSize = partSizeFor(size);
  const plan = planParts(size, partSize);
  const partUrls = await Promise.all(plan.map((p) => s3.presignPart(key, uploadId, p.partNumber)));
  await c.repo.addUpload({ id: mediaId, filename, size, mime, sha256: sha, originalKey: key, uploadId, uploadedBy: c.user });
  return json({ deduped: false, mediaId, mode: 'multipart', uploadId, partSize, partCount: plan.length, partUrls, expiresInS: s3.ttl, assetUrls });
});

/** Common prologue of resume / abort / complete. */
async function uploadCtx(c: Ctx) {
  const id = c.p[0];
  if (!UUID_RE.test(id)) throw new HttpError(400, 'bad upload id');
  const b = await readJson(c.req);
  const upl = await c.repo.getUpload(id);
  const filename = b.filename !== undefined ? cleanName(b.filename) : upl?.filename ?? 'file';
  const key = upl?.originalKey ?? remoteOriginalKey(id, filename);
  return { id, b, upl, filename, key };
}

route('POST', '/api/uploads/:id/resume', async (c) => {
  const u = await uploadCtx(c);
  const size = u.b.size;
  const uploadId = String(u.b.uploadId ?? u.upl?.uploadId ?? '');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || !uploadId) return err(400, 'size and uploadId required');
  const s3 = getS3(c.env);
  const plan = planParts(size, partSizeFor(size));
  let parts: Awaited<ReturnType<S3['listParts']>> = [];
  try {
    parts = await s3.listParts(u.key, uploadId);
  } catch (e) {
    if (!isNoSuchUpload(e)) throw e;
    return err(410, 'upload session expired');
  }
  const partUrls = await Promise.all(plan.map((p) => s3.presignPart(u.key, uploadId, p.partNumber)));
  return json({ partSize: partSizeFor(size), parts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size, etag: p.etag })), partUrls });
});

route('POST', '/api/uploads/:id/abort', async (c) => {
  const u = await uploadCtx(c);
  if (await c.repo.getMedia(u.id)) return err(409, 'already stored');
  const uploadId = typeof u.b.uploadId === 'string' ? u.b.uploadId : u.upl?.uploadId ?? '';
  if (uploadId) await getS3(c.env).abortMultipart(u.key, uploadId).catch(() => {});
  await deleteKeys(c.env, [u.key, thumbKeyOf(u.id), previewKeyOf(u.id), posterKeyOf(u.id)]);
  await c.repo.deleteUpload(u.id);
  return json({ ok: true });
});

function parseSource(meta: Record<string, unknown>): { source: string | null; sourceEvidence: string | null } {
  let o: unknown = meta.sourceJson;
  if (typeof o === 'string') {
    try { o = JSON.parse(o.slice(0, 20000)); } catch { o = null; }
  }
  const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return {
    source: text(r.source, 200) ?? text(meta.source, 200),
    sourceEvidence: text(r.evidence, 2000) ?? text(r.sourceEvidence, 2000) ?? text(meta.sourceEvidence, 2000),
  };
}

route('POST', '/api/uploads/:id/complete', async (c) => {
  const u = await uploadCtx(c);
  const done = await c.repo.getMedia(u.id);
  if (done) return json({ media: mediaDto(done), deduped: false }); // idempotent retry
  const meta = (u.b.meta && typeof u.b.meta === 'object' ? u.b.meta : {}) as Record<string, unknown>;
  const s3 = getS3(c.env);
  const size = typeof u.b.size === 'number' && Number.isSafeInteger(u.b.size) ? u.b.size : u.upl?.size ?? 0;
  const uploadId = typeof u.b.uploadId === 'string' && u.b.uploadId ? u.b.uploadId : u.upl?.uploadId ?? '';
  if (uploadId) {
    const given = (Array.isArray(u.b.parts) ? u.b.parts : [])
      .map((p) => p as { partNumber?: unknown; etag?: unknown })
      .filter((p) => Number.isInteger(p.partNumber) && (p.partNumber as number) > 0 && typeof p.etag === 'string' && p.etag)
      .map((p) => ({ partNumber: p.partNumber as number, etag: p.etag as string }));
    const expected = size ? planParts(size).length : 0;
    let parts: Array<{ partNumber: number; etag: string }> | null = given;
    if (!parts.length || (expected && parts.length !== expected)) {
      try {
        parts = (await s3.listParts(u.key, uploadId)).map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
      } catch (e) {
        if (!isNoSuchUpload(e)) throw e;
        parts = null; // already completed by an earlier call
      }
    }
    if (parts) {
      if (expected && parts.length !== expected) return err(409, `upload incomplete: ${parts.length} of ${expected} parts`);
      try {
        await s3.completeMultipart(u.key, uploadId, parts);
      } catch (e) {
        if (!isNoSuchUpload(e)) throw e;
      }
    }
  }
  const head = await c.env.BUCKET.head(u.key);
  if (!head) return err(400, 'upload not found in storage');
  const assetKeys = [thumbKeyOf(u.id), previewKeyOf(u.id), posterKeyOf(u.id)];
  if (head.size > maxFileBytes(c.env)) {
    await deleteKeys(c.env, [u.key, ...assetKeys]);
    return err(413, `file is larger than ${(maxFileBytes(c.env) / 1024 ** 3).toFixed(1)} GB`);
  }
  if (head.size === 0) {
    await deleteKeys(c.env, [u.key, ...assetKeys]);
    return err(400, 'file is empty');
  }
  if (size && head.size !== size) return err(409, `size mismatch: stored ${head.size} bytes, expected ${size}`);
  const shaRaw = typeof meta.sha256 === 'string' && meta.sha256 ? meta.sha256 : u.upl?.sha256 ?? '';
  if (!SHA_RE.test(shaRaw)) return err(400, 'meta.sha256 required');
  const sha = shaRaw.toLowerCase();

  const dedupe = async (existing: MediaRow) => {
    if (existing.originalKey !== u.key) await deleteKeys(c.env, [u.key, ...assetKeys]);
    await c.repo.deleteUpload(u.id);
    return json({ media: mediaDto(existing), deduped: true });
  };
  const existing = await c.repo.getMediaBySha(sha);
  if (existing) return dedupe(existing);

  // keys only for the assets that really are in the bucket
  const [hasThumb, hasPreview, hasPoster] = await Promise.all(
    assetKeys.map((k, i) => (meta[['hasThumb', 'hasPreview', 'hasPoster'][i]] === true ? c.env.BUCKET.head(k).then((h) => !!h) : false)),
  );
  const kind = typeof meta.kind === 'string' && MEDIA_KINDS.has(meta.kind) ? meta.kind : 'file';
  const filename = u.filename.slice(0, 255);
  const src = parseSource(meta);
  const codec = text(meta.codec, 40) ?? (kind === 'document' ? extOf(filename) || null : null);
  const row = {
    id: u.id, originalKey: u.key,
    // a browser-made preview image describes images and PDFs; for video / audio the "preview" is the original itself
    previewKey: hasPreview && kind !== 'video' && kind !== 'audio' ? previewKeyOf(u.id) : null,
    thumbKey: hasThumb ? thumbKeyOf(u.id) : null,
    posterKey: hasPoster ? posterKeyOf(u.id) : null,
    mime: (text(meta.mime, 200) ?? (u.upl?.mime || 'application/octet-stream')).slice(0, 200), kind, codec,
    width: int(meta.width), height: int(meta.height), durationMs: int(meta.durationMs), fps: num(meta.fps),
    sizeBytes: head.size, sha256: sha, originalName: filename,
    comfyMetadataJson: typeof meta.comfyMetadataJson === 'string' && meta.comfyMetadataJson.length <= 4_000_000 ? meta.comfyMetadataJson : null,
    codecLong: text(meta.codecLong, 200), codecProfile: text(meta.codecProfile, 100), pixFmt: text(meta.pixFmt, 40), bitRate: int(meta.bitRate),
    container: text(meta.container, 100), source: src.source, sourceEvidence: src.sourceEvidence,
    sampleRate: int(meta.sampleRate), channels: int(meta.channels), pages: int(meta.pages), lines: int(meta.lines), words: int(meta.words),
    textPreview: text(meta.textPreview, 4000), uploadedBy: c.user,
  };
  try {
    await c.repo.insertMedia(row);
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) {
      const again = (await c.repo.getMedia(u.id)) ?? (await c.repo.getMediaBySha(sha));
      if (again) return again.id === u.id ? json({ media: mediaDto(again), deduped: false }) : dedupe(again);
    }
    throw e;
  }
  await c.repo.deleteUpload(u.id);
  return json({ media: mediaDto((await c.repo.getMedia(u.id))!), deduped: false });
});

// ---- media: drop from URL (the only place bytes pass through the Worker; streamed, no hashing) ----
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/mpeg': 'mpg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a', 'application/pdf': 'pdf',
};
const KIND_BY_EXT: Record<string, string> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', svg: 'image', bmp: 'image', tif: 'image', tiff: 'image', heic: 'image',
  mp4: 'video', webm: 'video', mov: 'video', mkv: 'video', mpg: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', flac: 'audio', ogg: 'audio', opus: 'audio', aac: 'audio',
  pdf: 'document', txt: 'document', md: 'document', fountain: 'document', fdx: 'document',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([m, e]) => [e, m]));

function filenameFrom(url: URL, contentType: string, disposition: string | null): string {
  let name = '';
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
    try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : ''; } catch { name = plain ? plain[1] : ''; }
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try { name = decodeURIComponent(last); } catch { name = last; }
  }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180) || 'download';
  if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) {
    const ext = EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()];
    if (ext) name += `.${ext}`;
  }
  return name;
}

route('POST', '/api/media/from-url', async (c) => {
  const doFetch = c.env.TEST_FETCH ?? ((i: RequestInfo | URL, init?: RequestInit) => fetch(i, init));
  let res: Response | null = null;
  let url: URL;
  try {
    url = checkUrlSyntax(String((await readJson(c.req)).url ?? ''));
    for (let hop = 0; hop <= 5; hop++) {
      const r = await doFetch(url.toString(), {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoardCloud/0.2)', accept: '*/*', 'accept-encoding': 'identity' },
      });
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        await r.body?.cancel();
        url = checkUrlSyntax(new URL(loc, url).toString());
        continue;
      }
      res = r;
      break;
    }
    if (!res) throw new BlockedUrlError('too many redirects');
  } catch (e) {
    if (e instanceof BlockedUrlError) return err(400, e.message);
    return err(502, (e as Error).message || 'download failed');
  }
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel();
    return err(502, `server answered HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  const len = Number(res.headers.get('content-length') ?? NaN);
  const limit = Math.min(FROM_URL_MAX, maxFileBytes(c.env));
  const fail = async (status: number, msg: string) => { await res!.body?.cancel(); return err(status, msg); };
  if (/^text\/html/i.test(contentType)) return fail(400, 'the link points to a web page, not a file');
  if (!Number.isFinite(len)) return fail(400, 'the server did not report a file size; download the file and drop it instead');
  if (len > limit) return fail(413, `link downloads are limited to ${Math.floor(limit / 1024 ** 2)} MB; download the file and drop it instead`);
  if (len === 0 || !res.body) return fail(400, 'file is empty');
  const name = filenameFrom(url, contentType, res.headers.get('content-disposition'));
  const id = crypto.randomUUID();
  const key = remoteOriginalKey(id, name);
  const ext = extOf(name);
  const mime = contentType.split(';')[0].trim().toLowerCase() || MIME_BY_EXT[ext] || 'application/octet-stream';
  try {
    await c.env.BUCKET.put(key, fixedLength(res.body, len), { httpMetadata: { contentType: 'application/octet-stream' } });
    const head = await c.env.BUCKET.head(key);
    if (!head || head.size !== len) throw new Error('download was cut short');
  } catch (e) {
    await c.env.BUCKET.delete(key).catch(() => {});
    return err(502, (e as Error).message || 'download failed');
  }
  const kind = KIND_BY_EXT[ext] ?? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'file');
  await c.repo.insertMedia({
    id, originalKey: key, previewKey: null, thumbKey: null, posterKey: null, mime, kind, codec: kind === 'document' ? ext || null : null,
    width: null, height: null, durationMs: null, fps: null, sizeBytes: len,
    sha256: `url-${id}`, // not hashed (CPU limit): URL imports are never de-duplicated
    originalName: name, comfyMetadataJson: null, codecLong: null, codecProfile: null, pixFmt: null, bitRate: null, container: null,
    source: null, sourceEvidence: null, sampleRate: null, channels: null, pages: null, lines: null, words: null, textPreview: null, uploadedBy: c.user,
  });
  return json({ media: mediaDto((await c.repo.getMedia(id))!), deduped: false, name });
});

// ---- media: status polling + info + workflow ----
route('GET', '/api/media', async (c) => {
  const ids = (c.url.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 200);
  return json({ media: (await c.repo.getMediaMany(ids)).map(mediaDto) });
});
route('GET', '/api/media/:id/info', async (c) => {
  const m = await c.repo.getMedia(c.p[0]);
  if (!m) return err(404, 'no such media');
  return json(infoDto(m), 200, { 'cache-control': 'no-store' });
});
/** The workflow text the browser extracted at upload time (meta.comfyMetadataJson); the Worker never parses media files. */
const workflowOf = (m: MediaRow | null) => {
  if (!m || m.status !== 'ready' || (m.kind !== 'image' && m.kind !== 'video') || !m.comfyMetadataJson) return null;
  return { json: m.comfyMetadataJson, format: m.comfyMetadataJson.includes('"nodes"') ? 'workflow' : 'prompt' };
};
route('GET', '/api/media/:id/workflow', async (c) => {
  const m = await c.repo.getMedia(c.p[0]);
  if (!m) return err(404, 'no such media');
  const wf = workflowOf(m);
  if (!wf) return err(404, 'no ComfyUI workflow in this file');
  return new Response(wf.json, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-workflow-format': wf.format } });
});
route('POST', '/api/media/:id/open-in-comfy', async (c) => {
  const m = await c.repo.getMedia(c.p[0]);
  if (!m) return err(404, 'no such media');
  const wf = workflowOf(m);
  if (!wf) return err(404, 'no ComfyUI workflow in this file');
  return json({
    saved: false, reason: 'ComfyUI cannot be launched from the cloud version; use "Copy workflow" and paste it into ComfyUI',
    format: wf.format, filename: safeWorkflowName(m.originalName) + '.json', workflow: wf.json,
  });
});

// ---- documents ----
type TextDoc = { m: MediaRow; fmt: TextFormat };
const textDoc = (m: MediaRow | null): TextDoc | null => {
  const fmt = m && m.status === 'ready' && m.kind === 'document' ? textFormatOf(m.codec ?? '') : null;
  return m && fmt ? { m, fmt } : null;
};

async function readText(env: Env, key: string): Promise<string | null> {
  const o = await env.BUCKET.get(key, { range: { offset: 0, length: MAX_TEXT_BYTES } });
  return o ? decodeText(await o.arrayBuffer()) : null;
}

async function documentPayload(c: Ctx, m: MediaRow, fmt: TextFormat, versionId?: string) {
  const versions = await c.repo.listVersions(m.id);
  const cur = versionId ? (versionId === 'original' ? null : await c.repo.getVersion(versionId)) : versions[0] ?? null;
  if (versionId && versionId !== 'original' && (!cur || cur.mediaId !== m.id)) return null;
  const body = await readText(c.env, cur ? cur.key : m.originalKey);
  if (body === null) throw new HttpError(404, 'file missing');
  let elements: ReturnType<typeof parseFdx> | null = null;
  if (fmt === 'fdx') {
    try { elements = parseFdx(body); } catch { elements = []; }
  }
  return {
    id: m.id, format: fmt, text: fmt === 'fdx' ? '' : body, elements, editable: fmt !== 'fdx',
    current: cur ? cur.id : 'original', versions: [...versions.map((v) => ({ id: v.id, createdAt: v.createdAt })), { id: 'original', createdAt: m.createdAt }],
    lines: m.lines, words: m.words, textPreview: m.textPreview,
  };
}
async function saveText(c: Ctx, m: MediaRow, body: string) {
  const key = `versions/${crypto.randomUUID()}.txt`;
  await c.env.BUCKET.put(key, body, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  await c.repo.addVersion(m.id, key, textStats(body));
}
const NOCACHE = { 'cache-control': 'no-store' };

route('GET', '/api/media/:id/document', async (c) => {
  const d = textDoc(await c.repo.getMedia(c.p[0]));
  if (!d) return err(404, 'not a text document');
  const p = await documentPayload(c, d.m, d.fmt, c.url.searchParams.get('version') ?? undefined);
  if (!p) return err(404, 'no such version');
  return json(p, 200, NOCACHE);
});
route('PUT', '/api/media/:id/document', async (c) => {
  const d = textDoc(await c.repo.getMedia(c.p[0]));
  if (!d) return err(404, 'not a text document');
  if (d.fmt === 'fdx') return err(400, 'Final Draft files are read-only');
  const len = Number(c.req.headers.get('content-length') ?? 0);
  if (len > MAX_TEXT_BYTES + 1024) return err(413, 'text too large');
  const body = (await readJson(c.req)).text;
  if (typeof body !== 'string') return err(400, 'text required');
  if (body.length > MAX_TEXT_BYTES || new TextEncoder().encode(body).length > MAX_TEXT_BYTES) return err(413, 'text too large');
  await saveText(c, d.m, body);
  return json(await documentPayload(c, (await c.repo.getMedia(d.m.id))!, d.fmt), 200, NOCACHE);
});
route('POST', '/api/media/:id/document/restore', async (c) => {
  const d = textDoc(await c.repo.getMedia(c.p[0]));
  if (!d) return err(404, 'not a text document');
  if (d.fmt === 'fdx') return err(400, 'Final Draft files are read-only');
  const old = await documentPayload(c, d.m, d.fmt, String((await readJson(c.req)).versionId ?? ''));
  if (!old) return err(404, 'no such version');
  await saveText(c, d.m, old.text); // restoring is itself a new version: nothing is ever lost
  return json(await documentPayload(c, (await c.repo.getMedia(d.m.id))!, d.fmt), 200, NOCACHE);
});

// ---- media files: 302 to a presigned GET ----
route('GET', '/api/media/:id/download', async (c) => {
  const m = await c.repo.getMedia(c.p[0]);
  if (!m) return err(404, 'no such media');
  return serve(c, m.originalKey, 'application/octet-stream', { disposition: contentDisposition('attachment', m.originalName) });
});
route('GET', '/api/media/:id/:variant', async (c) => {
  const [id, variant] = c.p;
  const m = await c.repo.getMedia(id);
  if (!m) return err(404, 'no such media');
  const ready = m.status === 'ready';
  const cache = ready ? IMMUTABLE : undefined;
  if (variant === 'original') {
    const mime = m.previewKey ? 'application/octet-stream' : m.mime; // converted media: original is download-only
    return serve(c, m.originalKey, mime, { cache, disposition: contentDisposition('inline', m.originalName) });
  }
  if (!ready) return err(404, 'not ready');
  if (variant === 'preview') {
    if (m.kind !== 'image' && m.kind !== 'video' && m.kind !== 'audio' && !isPdf(m)) return err(404, 'no preview');
    if (m.previewKey) return serve(c, m.previewKey, MIME_BY_KEY_EXT[m.previewKey.split('.').pop()!] ?? m.mime, { cache });
    return serve(c, m.originalKey, m.mime, { cache });
  }
  if (variant === 'thumb') {
    if (m.thumbKey) return serve(c, m.thumbKey, 'image/webp', { cache });
    if (m.kind === 'image') return serve(c, m.previewKey ?? m.originalKey, m.mime, { cache });
    if (m.posterKey) return serve(c, m.posterKey, 'image/webp', { cache });
    return err(404, 'no thumbnail');
  }
  if (variant === 'poster') {
    if (!m.posterKey) return err(404, 'no poster');
    return serve(c, m.posterKey, 'image/webp', { cache });
  }
  return err(404, 'unknown variant');
});

route('POST', '/api/items/:id/reveal', () => err(404, 'not available in the cloud version'));

// ---- trash ----
route('GET', '/api/boards/:id/trash', async (c) => {
  if (!(await c.repo.getBoard(c.p[0]))) return err(404, 'no such board');
  const rows = await c.repo.listTrash(c.p[0]);
  const mediaById = new Map((await c.repo.getMediaMany([...new Set(rows.map((r) => r.mediaId).filter((v): v is string => !!v))])).map((m) => [m.id, m]));
  return json({
    items: rows.map((r) => {
      const m = r.mediaId ? mediaById.get(r.mediaId) : undefined;
      return { id: r.id, kind: r.kind, name: r.name, deletedAt: r.deletedAt, media: m ? mediaDto(m) : null };
    }),
  });
});
route('POST', '/api/items/:id/restore', async (c) => {
  if (!(await c.repo.restoreItem(c.p[0]))) return err(404, 'not in the trash');
  return json({ ok: true });
});
route('DELETE', '/api/items/:id/trash', async (c) => {
  const it = await c.repo.getItem(c.p[0]);
  if (!it || !it.deletedAt) return err(404, 'not in the trash');
  await purgeItems(c.env, c.repo, [it.id]);
  await c.repo.touchBoard(it.boardId);
  return json({ ok: true });
});

route('GET', '/api/items/:id/original', async (c) => {
  const item = await c.repo.getItem(c.p[0]);
  const m = item?.mediaId ? await c.repo.getMedia(item.mediaId) : null;
  if (!item || !m) return err(404, 'no such item');
  return serve(c, m.originalKey, 'application/octet-stream', { disposition: contentDisposition('attachment', item.name || m.originalName) });
});

route('GET', '/api/files/*', async (c) => {
  let key: string;
  try { key = decodeURIComponent(c.p[0]); } catch { return err(404, 'not found'); }
  if (!/^(previews|thumbs)\/[^/]+$/.test(key)) return err(404, 'not found');
  return serve(c, key, MIME_BY_KEY_EXT[key.split('.').pop()!] ?? 'application/octet-stream', { cache: IMMUTABLE });
});

// ---------------------------------------------------------------------------------------------
// entry: auth gate + dispatch

const htmlHeaders = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

async function readForm(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') ?? '';
  try {
    if (ct.includes('json')) return await readJson(req);
    return Object.fromEntries(new URLSearchParams(await req.text()));
  } catch {
    return {};
  }
}

async function login(req: Request, env: Env, users: Map<string, UserEntry>, secure: boolean): Promise<Response> {
  const b = await readForm(req);
  const user = String(b.username ?? '').trim().toLowerCase().slice(0, 64);
  const next = safeNext(b.next);
  const wantsJson = (req.headers.get('accept') ?? '').includes('application/json') || (req.headers.get('content-type') ?? '').includes('json');
  const fail = (code: number, error: string, retry?: number) => {
    const h: Record<string, string> = retry ? { 'retry-after': String(retry) } : {};
    return wantsJson ? json({ error }, code, h) : new Response(loginPage({ error, next, user }), { status: code, headers: { ...htmlHeaders, ...h } });
  };
  const key = attemptKey(req.headers.get('cf-connecting-ip') ?? 'local', user);
  const wait = await retryAfter(env, key);
  if (wait) return fail(429, `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.`, wait);
  if (typeof b.password !== 'string' || !user || !(await verifyLogin(users, user, b.password))) {
    await recordFail(env, key);
    return fail(401, 'Wrong name or password.');
  }
  await clearFails(env, key);
  const cookie = cookieHeader(await signSession(env.SESSION_SECRET, user), SESSION_DAYS * 24 * 3600, secure);
  return wantsJson
    ? json({ ok: true, user }, 200, { 'set-cookie': cookie })
    : new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie, 'cache-control': 'no-store' } });
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const secure = url.protocol === 'https:';
  if (p === '/api/health') return json({ ok: true, version: VERSION, maxFileBytes: maxFileBytes(env), cloud: true });

  const users = parseUsers(env.USERS);
  if (!env.SESSION_SECRET || !users.size) return err(500, 'server not configured: set the USERS and SESSION_SECRET secrets');
  const session = await verifySession(env.SESSION_SECRET, users, parseCookies(req.headers.get('cookie'))[COOKIE]);
  const clearCookie = cookieHeader('', 0, secure);

  if (p === '/logout') return new Response(null, { status: 303, headers: { location: '/login', 'set-cookie': clearCookie, 'cache-control': 'no-store' } });
  if (p === '/login') {
    if (req.method === 'POST') return login(req, env, users, secure);
    if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'method not allowed');
    if (session) return redirect(safeNext(url.searchParams.get('next')), 302, { 'cache-control': 'no-store' });
    return new Response(loginPage({ next: safeNext(url.searchParams.get('next')) }), { headers: htmlHeaders });
  }

  const isApi = p.startsWith('/api/');
  if (!session) {
    if (isApi) return err(401, 'login required');
    return redirect('/login' + (p !== '/' ? `?next=${encodeURIComponent(p + url.search)}` : ''), 302, { 'cache-control': 'no-store' });
  }
  if (!isApi) return env.ASSETS.fetch(req);

  const repo = new Repo(env.DB);
  let res: Response | undefined;
  try {
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(p);
      if (m) {
        res = await h({ req, env, url, p: m.slice(1), user: session.user, repo });
        break;
      }
    }
    res ??= err(404, 'not found');
  } catch (e) {
    if (e instanceof HttpError) res = err(e.status, e.message);
    else {
      console.error('[api]', e);
      res = err(500, (e as Error).message || 'internal error');
    }
  }
  // sliding session: re-issue the cookie with a fresh 90 days when the current one is more than a day old
  if (Date.now() - session.issuedAt > REFRESH_AFTER_MS) {
    res.headers.append('set-cookie', cookieHeader(await signSession(env.SESSION_SECRET, session.user), SESSION_DAYS * 24 * 3600, secure));
  }
  return res;
}
