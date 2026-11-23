import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { registerAuth } from './auth.js';
import { configProblems, type Config } from './config.js';
import { openDb, Repo, type CommentMessageRow, type CommentRow, type ItemUpsert, type MediaRow, type VersionRow } from './db.js';
import { decodeText, MAX_TEXT_BYTES, parseFdx, textFormatOf, textStats, type TextFormat } from './documents.js';
import { openUrl } from './download.js';
import { BlockedUrlError } from './ssrf.js';
import { EmptyFileError, ingestRemote, ingestStream, MissingUploadError, remoteOriginalKey, TooLargeError, UUID_RE, type IngestContext } from './ingest.js';
import { extractWorkflow, gatherInfo, infoDto } from './mediaInfo.js';
import { ffprobe } from './ffmpeg.js';
import { PURGE_EVERY_MS, purgeExpired, purgeItems } from './trash.js';
import { spawn } from 'node:child_process';
import { Processor } from './process.js';
import { LocalDiskStorage, type Storage } from './storage.js';
import { S3Storage } from './s3storage.js';
import { MULTIPART_THRESHOLD, partSizeFor, planParts } from './uploadPlan.js';

export interface App {
  app: FastifyInstance;
  repo: Repo;
  storage: Storage;
  processor: Processor;
  /** Run the 30-day trash purge now (also runs on start and every 6 h). */
  purgeTrash: (now?: number) => Promise<{ items: number; media: number }>;
}

export interface AppHooks {
  /** Show a file in Explorer (tests replace it). */
  reveal?: (absPath: string) => void;
  /** Tests inject a storage (e.g. an S3Storage over a mocked client) instead of the one the config selects. */
  storage?: Storage;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** File name (no extension) safe for a ComfyUI workflows/Board/<name>.json path. */
export function safeWorkflowName(original: string): string {
  const base = original.replace(/\.[^./\\]*$/, '');
  const clean = base.replace(/[\u0000-\u001f\\/:*?"<>|%#]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
  return clean || 'workflow';
}

function defaultReveal(abs: string) {
  const p = spawn('explorer.exe', [`/select,"${abs}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
  p.on('error', () => {});
  p.unref();
}

/** Style of a text / group item, sanitised per kind; other kinds carry none. */
export function cleanProps(kind: string, raw: unknown): string | null {
  if (kind !== 'text' && kind !== 'group') return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const out: Record<string, unknown> = {};
  if (kind === 'text') {
    out.text = str(r.text, 50000) ?? '';
    if (typeof r.size === 'number' && Number.isFinite(r.size)) out.size = Math.min(2000, Math.max(1, r.size));
    const color = str(r.color, 32);
    if (color) out.color = color;
    if (typeof r.bold === 'boolean') out.bold = r.bold;
    if (r.align === 'left' || r.align === 'center' || r.align === 'right') out.align = r.align;
  } else {
    out.title = str(r.title, 200) ?? '';
    const color = str(r.color, 32);
    if (color) out.color = color;
  }
  return JSON.stringify(out);
}
export function parseProps(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

const ITEM_KINDS = new Set(['image', 'video', 'audio', 'document', 'file', 'text', 'group']);
const MIME_BY_KEY_EXT: Record<string, string> = {
  webp: 'image/webp', mp4: 'video/mp4', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', m4a: 'audio/mp4', pdf: 'application/pdf',
};
const IMMUTABLE = 'public, max-age=31536000, immutable';

const MAX_COMMENT = 8000;

export function commentDto(c: CommentRow & { messages: CommentMessageRow[] }) {
  return {
    id: c.id, boardId: c.boardId, itemId: c.itemId, number: c.number, x: c.x, y: c.y, itemX: c.itemX, itemY: c.itemY,
    videoTimeMs: c.videoTimeMs, resolved: !!c.resolved, createdAt: c.createdAt, updatedAt: c.updatedAt,
    messages: c.messages.map((m) => ({ id: m.id, author: m.author, text: m.text, createdAt: m.createdAt })),
  };
}

export interface MediaUrls { original: string; preview: string | null; thumb: string | null; poster: string | null }

/** URLs the browser uses for a media row in s3 mode: presigned GETs straight from the bucket (cached per key by the storage). */
export async function remoteUrls(storage: Storage, m: MediaRow): Promise<MediaUrls> {
  const visual = m.kind === 'image' || m.kind === 'video';
  const isPdf = m.kind === 'document' && (!!m.previewKey || m.codec === 'pdf');
  const u = (key: string, mime: string, disposition?: string) => storage.url(key, { mime, disposition, cache: IMMUTABLE });
  const preview = visual || m.kind === 'audio' || isPdf
    ? m.previewKey ? await u(m.previewKey, MIME_BY_KEY_EXT[m.previewKey.split('.').pop()!] ?? m.mime) : await u(m.originalKey, m.mime)
    : null;
  return {
    original: await u(m.originalKey, m.previewKey ? 'application/octet-stream' : m.mime, contentDisposition('inline', m.originalName)),
    preview,
    thumb: m.thumbKey ? await u(m.thumbKey, 'image/webp') : visual ? preview : null,
    poster: m.posterKey ? await u(m.posterKey, 'image/webp') : null,
  };
}

export function mediaDto(m: MediaRow, progress?: number, remote?: MediaUrls | null) {
  const base = `/api/media/${m.id}`;
  const ready = m.status === 'ready';
  const visual = m.kind === 'image' || m.kind === 'video';
  const isPdf = m.kind === 'document' && (!!m.previewKey || m.codec === 'pdf');
  return {
    id: m.id, kind: m.kind, status: m.status, mime: m.mime, codec: m.codec, width: m.width, height: m.height,
    durationMs: m.durationMs, fps: m.fps, sizeBytes: m.sizeBytes, originalName: m.originalName, error: m.error,
    source: m.source, pages: m.pages, textPreview: m.kind === 'document' ? m.textPreview : null,
    progress: m.status === 'processing' ? progress ?? 0 : 1,
    urls: ready && remote
      ? remote
      : ready
      ? {
          original: `${base}/original`,
          preview: visual || m.kind === 'audio' || isPdf ? `${base}/preview` : null,
          thumb: visual ? (m.thumbKey || m.kind === 'video' ? `${base}/thumb` : `${base}/preview`) : m.thumbKey ? `${base}/thumb` : null,
          poster: m.posterKey ? `${base}/poster` : null,
        }
      : null,
  };
}

/** Content-Disposition value that survives any UTF-8 file name. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f"\\/]/g, '_').trim() || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/%/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}

async function sendKey(
  storage: Storage, req: FastifyRequest, reply: FastifyReply, key: string, mime: string,
  opts: { disposition?: string; cache?: string; csp?: boolean } = {},
) {
  let size: number;
  try {
    size = await storage.size(key);
  } catch {
    return reply.code(404).send({ error: 'file missing' });
  }
  reply.header('accept-ranges', 'bytes').header('content-type', mime).header('x-content-type-options', 'nosniff');
  reply.header('cache-control', opts.cache ?? 'no-store');
  if (opts.disposition) reply.header('content-disposition', opts.disposition);
  if (opts.csp || mime === 'image/svg+xml') reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  const range = parseRange(req.headers.range, size);
  if (range === 'invalid') return reply.code(416).header('content-range', `bytes */${size}`).send();
  if (range) {
    reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${size}`).header('content-length', range.end - range.start + 1);
    return reply.send(storage.stream(key, range));
  }
  reply.header('content-length', size);
  return reply.send(storage.stream(key));
}

export async function buildApp(cfg: Config, hooks: AppHooks = {}): Promise<App> {
  const problems = hooks.storage ? [] : configProblems(cfg);
  if (problems.length) throw new Error(problems.join('; '));
  const db = openDb(cfg.dataDir);
  const repo = new Repo(db);
  const storage: Storage =
    hooks.storage ??
    (cfg.storageDriver === 's3'
      ? new S3Storage({ bucket: cfg.s3.bucket, tmpRoot: cfg.dataDir, endpoint: cfg.s3.endpoint, region: cfg.s3.region, accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey, presignTtlS: cfg.presignTtlS })
      : new LocalDiskStorage(cfg.dataDir));
  const s3 = storage instanceof S3Storage ? storage : null;
  await fsp.mkdir(path.join(cfg.dataDir, 'tmp'), { recursive: true });
  // leftovers of interrupted uploads
  for (const f of await fsp.readdir(path.join(cfg.dataDir, 'tmp'))) await fsp.rm(path.join(cfg.dataDir, 'tmp', f), { force: true, recursive: true });
  await (storage as { init?: () => Promise<void> }).init?.();

  const processor = new Processor(repo, storage, { ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe, soffice: cfg.soffice });
  for (const m of repo.processingMedia()) processor.enqueue(m.id);
  const ctx: IngestContext = { repo, storage, processor, maxBytes: cfg.maxFileBytes };

  const app = Fastify({ logger: false, connectionTimeout: 0, requestTimeout: 0, keepAliveTimeout: 30000, bodyLimit: 8 * 1024 * 1024, trustProxy: cfg.trustProxy as boolean | string });
  // login routes + guard hook: must come before every route so the hook covers them all (no-op without APP_PASSWORD)
  registerAuth(app, cfg.appPassword);
  // Raw bodies (uploads) are left as an unread stream: never buffered.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err instanceof TooLargeError ? 413 : err instanceof EmptyFileError || err instanceof MissingUploadError ? 400 : err.statusCode ?? 500;
    if (code >= 500) console.error('[api]', err);
    reply.code(code).send({ error: err.message });
  });

  // ---- health ----
  app.get('/api/health', async () => ({ ok: true, version: '0.2.0', maxFileBytes: cfg.maxFileBytes }));

  const isLocalReq = (req: FastifyRequest) => LOOPBACK.has(req.socket.remoteAddress ?? '');
  const reveal = hooks.reveal ?? defaultReveal;
  app.get('/api/config', async (req) => ({
    comfyUrl: cfg.comfyUrl, canReveal: !s3 && process.platform === 'win32' && isLocalReq(req), storage: s3 ? 's3' : 'local', authRequired: !!cfg.appPassword,
  }));

  /** DTO with presigned URLs in s3 mode. */
  const dtoOf = async (m: MediaRow) =>
    mediaDto(m, processor.progress.get(m.id), s3 && m.status === 'ready' ? await remoteUrls(storage, m) : undefined);
  /** Local: stream the file (Range). s3: 302 to the presigned URL, so the bytes never pass through this server. */
  const serve = async (req: FastifyRequest, reply: FastifyReply, key: string, mime: string, opts: { disposition?: string; cache?: string; csp?: boolean } = {}) => {
    if (!s3) return sendKey(storage, req, reply, key, mime, opts);
    const url = await storage.url(key, { mime, disposition: opts.disposition, cache: opts.cache });
    return reply.header('cache-control', 'no-store').redirect(url);
  };

  // ---- boards ----
  app.get('/api/boards', async () => ({ boards: repo.listBoards() }));
  app.post('/api/boards', async (req) => {
    const name = String((req.body as { name?: unknown } | null)?.name ?? '').trim().slice(0, 120) || 'Untitled board';
    return { board: repo.createBoard(name) };
  });
  app.patch('/api/boards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const name = String((req.body as { name?: unknown } | null)?.name ?? '').trim().slice(0, 120);
    if (!name) return reply.code(400).send({ error: 'name required' });
    if (!repo.renameBoard(id, name)) return reply.code(404).send({ error: 'no such board' });
    return { board: repo.getBoard(id) };
  });
  app.delete('/api/boards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.deleteBoard(id)) return reply.code(404).send({ error: 'no such board' });
    return { ok: true };
  });

  app.get('/api/boards/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const board = repo.getBoard(id);
    if (!board) return reply.code(404).send({ error: 'no such board' });
    const rows = repo.listItems(id);
    const mediaById = new Map(repo.getMediaMany([...new Set(rows.map((r) => r.mediaId).filter((v): v is string => !!v))]).map((m) => [m.id, m]));
    const items = [];
    const deleted: Array<{ id: string; deletedAt: number }> = [];
    const dtos = new Map<string, Awaited<ReturnType<typeof dtoOf>>>(await Promise.all([...mediaById.values()].map(async (m) => [m.id, await dtoOf(m)] as const)));
    for (const r of rows) {
      if (r.deletedAt) {
        deleted.push({ id: r.id, deletedAt: r.deletedAt });
        continue;
      }
      const m = r.mediaId ? mediaById.get(r.mediaId) : undefined;
      items.push({
        id: r.id, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h, z: r.z, mediaId: r.mediaId, name: r.name, props: parseProps(r.props),
        version: r.version, updatedAt: r.updatedAt, media: m ? dtos.get(m.id) ?? null : null,
      });
    }
    return { board, items, deleted, comments: repo.listComments(id).map(commentDto), serverTime: Date.now() };
  });

  // ---- comments ----
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const frac = (v: unknown) => { const n = fin(v); return n === null ? null : Math.min(1, Math.max(0, n)); };
  app.post('/api/boards/:id/comments', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.getBoard(id)) return reply.code(404).send({ error: 'no such board' });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cid = str(b.id, 80) || randomUUID();
    const text = str(b.text, MAX_COMMENT);
    const author = str(b.author, 80);
    if (!text) return reply.code(400).send({ error: 'text required' });
    if (!author) return reply.code(400).send({ error: 'author required' });
    const itemId = str(b.itemId, 80) || null;
    if (itemId) {
      const it = repo.getItem(itemId);
      if (!it || it.boardId !== id) return reply.code(400).send({ error: 'no such item on this board' });
    }
    const itemX = itemId ? frac(b.itemX) : null;
    const itemY = itemId ? frac(b.itemY) : null;
    if (itemId && (itemX === null || itemY === null)) return reply.code(400).send({ error: 'itemX/itemY required' });
    if (!itemId && (fin(b.x) === null || fin(b.y) === null)) return reply.code(400).send({ error: 'x/y required' });
    const vt = fin(b.videoTimeMs);
    const prior = repo.getComment(cid);
    if (prior && prior.boardId !== id) return reply.code(409).send({ error: 'id in use' });
    repo.createComment({
      id: cid, boardId: id, itemId, x: fin(b.x) ?? 0, y: fin(b.y) ?? 0, itemX, itemY,
      videoTimeMs: vt === null ? null : Math.max(0, Math.round(vt)),
      author, text, messageId: str(b.messageId, 80) || randomUUID(),
    });
    return { comment: commentDto(repo.commentWithMessages(cid)!) };
  });
  app.post('/api/comments/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = str(b.text, MAX_COMMENT);
    const author = str(b.author, 80);
    if (!text) return reply.code(400).send({ error: 'text required' });
    if (!author) return reply.code(400).send({ error: 'author required' });
    if (!repo.addMessage(id, str(b.id, 80) || randomUUID(), author, text)) return reply.code(404).send({ error: 'no such comment' });
    return { comment: commentDto(repo.commentWithMessages(id)!) };
  });
  app.patch('/api/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const resolved = (req.body as { resolved?: unknown } | null)?.resolved;
    if (typeof resolved !== 'boolean') return reply.code(400).send({ error: 'resolved (boolean) required' });
    if (!repo.setCommentResolved(id, resolved)) return reply.code(404).send({ error: 'no such comment' });
    return { comment: commentDto(repo.commentWithMessages(id)!) };
  });
  app.delete('/api/comments/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.deleteComment(id)) return reply.code(404).send({ error: 'no such comment' });
    return { ok: true };
  });

  app.put('/api/boards/:id/items', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.getBoard(id)) return reply.code(404).send({ error: 'no such board' });
    const body = (req.body ?? {}) as { upserts?: unknown; deletes?: unknown };
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const upserts: ItemUpsert[] = [];
    for (const raw of Array.isArray(body.upserts) ? body.upserts : []) {
      const r = raw as Record<string, unknown>;
      const [x, y, w, h, z, version, updatedAt] = ['x', 'y', 'w', 'h', 'z', 'version', 'updatedAt'].map((k) => num(r[k]));
      if (typeof r.id !== 'string' || !r.id || r.id.length > 80 || typeof r.kind !== 'string' || !ITEM_KINDS.has(r.kind)) continue;
      if ([x, y, w, h, z, version, updatedAt].some((v) => v === null)) continue;
      const mediaId = typeof r.mediaId === 'string' && repo.getMedia(r.mediaId) ? r.mediaId : null;
      upserts.push({
        id: r.id, kind: r.kind, x: x!, y: y!, w: Math.max(1, w!), h: Math.max(1, h!), z: z!, mediaId,
        name: String(r.name ?? '').slice(0, 512), props: cleanProps(r.kind, r.props), version: Math.round(version!), updatedAt: Math.round(updatedAt!),
      });
    }
    const deletes: Array<{ id: string; updatedAt: number }> = [];
    for (const raw of Array.isArray(body.deletes) ? body.deletes : []) {
      const r = raw as Record<string, unknown>;
      if (typeof r.id === 'string' && num(r.updatedAt) !== null) deletes.push({ id: r.id, updatedAt: Math.round(r.updatedAt as number) });
    }
    return { ok: true, rejected: repo.saveItems(id, upserts, deletes) };
  });

  // ---- media: upload (raw streamed body) ----
  app.put('/api/media', async (req, reply) => {
    if (s3) return reply.code(409).header('connection', 'close').send({ error: 'direct uploads are disabled with STORAGE_DRIVER=s3; use POST /api/uploads/init' });
    const len = Number(req.headers['content-length'] ?? 0);
    if (len > cfg.maxFileBytes) {
      return reply.code(413).header('connection', 'close').send({ error: `file is larger than ${(cfg.maxFileBytes / 1024 ** 3).toFixed(1)} GB` });
    }
    let name = 'file';
    try {
      name = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
    } catch {
      /* keep default */
    }
    name = name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'file';
    const { media, deduped } = await ingestStream(ctx, req.raw, name);
    return { media: await dtoOf(media), deduped };
  });

  // ---- media: s3 mode, browser -> bucket directly (presigned PUT / multipart); this server only signs, completes and processes ----
  const cleanName = (v: unknown) =>
    String(v ?? 'file').replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim().slice(0, 200) || 'file';
  const needS3 = (reply: FastifyReply) => (s3 ? null : reply.code(404).send({ error: 'only available with STORAGE_DRIVER=s3' }));
  const uploadKey = (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as { id: string }).id;
    if (!UUID_RE.test(id)) {
      void reply.code(400).send({ error: 'bad upload id' });
      return null;
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const filename = cleanName(b.filename);
    return { id, filename, key: remoteOriginalKey(id, filename), b };
  };
  const noSuchUpload = (e: unknown) => (e as { name?: string })?.name === 'NoSuchUpload';

  app.post('/api/uploads/init', async (req, reply) => {
    if (!s3) return needS3(reply);
    const b = (req.body ?? {}) as { filename?: unknown; size?: unknown };
    const size = b.size;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return reply.code(400).send({ error: 'size (bytes) required' });
    if (size > cfg.maxFileBytes) return reply.code(413).send({ error: `file is larger than ${(cfg.maxFileBytes / 1024 ** 3).toFixed(1)} GB` });
    const filename = cleanName(b.filename);
    const mediaId = randomUUID();
    const key = remoteOriginalKey(mediaId, filename);
    if (size <= MULTIPART_THRESHOLD) {
      return { mediaId, mode: 'single', url: await s3.presignPut(key), headers: { 'content-type': 'application/octet-stream' }, expiresInS: s3.ttl };
    }
    const uploadId = await s3.createMultipart(key);
    const partSize = partSizeFor(size);
    const plan = planParts(size, partSize);
    const partUrls = await Promise.all(plan.map((p) => s3.presignPart(key, uploadId, p.partNumber)));
    return { mediaId, mode: 'multipart', uploadId, partSize, partCount: plan.length, partUrls, expiresInS: s3.ttl };
  });

  /** Resume: which parts the bucket already holds + fresh part URLs (the first ones may have expired on a slow link). */
  app.post('/api/uploads/:id/resume', async (req, reply) => {
    if (!s3) return needS3(reply);
    const u = uploadKey(req, reply);
    if (!u) return;
    const size = u.b.size;
    const uploadId = String(u.b.uploadId ?? '');
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || !uploadId) return reply.code(400).send({ error: 'size and uploadId required' });
    const partSize = partSizeFor(size);
    const plan = planParts(size, partSize);
    let parts: Awaited<ReturnType<S3Storage['listParts']>> = [];
    try {
      parts = await s3.listParts(u.key, uploadId);
    } catch (e) {
      if (!noSuchUpload(e)) throw e;
      return reply.code(410).send({ error: 'upload session expired' });
    }
    const partUrls = await Promise.all(plan.map((p) => s3.presignPart(u.key, uploadId, p.partNumber)));
    return { partSize, parts: parts.map((p) => ({ partNumber: p.partNumber, size: p.size, etag: p.etag })), partUrls };
  });

  const completing = new Map<string, Promise<{ media: MediaRow; deduped: boolean }>>();
  app.post('/api/uploads/:id/complete', async (req, reply) => {
    if (!s3) return needS3(reply);
    const u = uploadKey(req, reply);
    if (!u) return;
    const uploadId = typeof u.b.uploadId === 'string' ? u.b.uploadId : '';
    const size = typeof u.b.size === 'number' && Number.isSafeInteger(u.b.size) ? u.b.size : 0;
    const given = (Array.isArray(u.b.parts) ? u.b.parts : [])
      .map((p) => p as { partNumber?: unknown; etag?: unknown })
      .filter((p) => Number.isInteger(p.partNumber) && (p.partNumber as number) > 0 && typeof p.etag === 'string' && p.etag)
      .map((p) => ({ partNumber: p.partNumber as number, etag: p.etag as string }));
    // idempotent: a retried complete (e.g. after a tunnel timeout) joins the run that is already hashing
    let run = completing.get(u.id);
    if (!run) {
      run = (async () => {
        if (uploadId) {
          const expected = size ? planParts(size).length : 0;
          let parts: Array<{ partNumber: number; etag: string }> | null = given;
          if (!parts.length || (expected && parts.length !== expected)) {
            try {
              parts = (await s3.listParts(u.key, uploadId)).map((p) => ({ partNumber: p.partNumber, etag: p.etag }));
            } catch (e) {
              if (!noSuchUpload(e)) throw e;
              parts = null; // already completed by an earlier call
            }
          }
          if (parts) {
            if (expected && parts.length !== expected) throw Object.assign(new Error(`upload incomplete: ${parts.length} of ${expected} parts`), { statusCode: 409 });
            try {
              await s3.completeMultipart(u.key, uploadId, parts);
            } catch (e) {
              if (!noSuchUpload(e)) throw e;
            }
          }
        }
        return ingestRemote(ctx, s3, u.id, u.key, u.filename);
      })().finally(() => completing.delete(u.id));
      completing.set(u.id, run);
    }
    const { media, deduped } = await run;
    return { media: await dtoOf(media), deduped };
  });

  app.post('/api/uploads/:id/abort', async (req, reply) => {
    if (!s3) return needS3(reply);
    const u = uploadKey(req, reply);
    if (!u) return;
    const uploadId = typeof u.b.uploadId === 'string' ? u.b.uploadId : '';
    if (repo.getMedia(u.id)) return reply.code(409).send({ error: 'already stored' });
    if (uploadId) await s3.abortMultipart(u.key, uploadId).catch(() => {});
    await s3.delete(u.key).catch(() => {});
    return { ok: true };
  });

  // ---- media: server-side download of a URL dropped from another tab ----
  app.post('/api/media/from-url', async (req, reply) => {
    const url = String((req.body as { url?: unknown } | null)?.url ?? '');
    try {
      const opened = await openUrl(url, cfg.maxFileBytes);
      const { media, deduped } = await ingestStream(ctx, opened.stream, opened.filename);
      return { media: await dtoOf(media), deduped, name: opened.filename };
    } catch (e) {
      if (e instanceof BlockedUrlError) return reply.code(400).send({ error: e.message });
      if (e instanceof TooLargeError) return reply.code(413).send({ error: e.message });
      const err = e as NodeJS.ErrnoException;
      const msg = err.code === 'ENOTFOUND' ? 'host not found' : err.code === 'ECONNREFUSED' ? 'connection refused' : err.message;
      return reply.code(502).send({ error: msg });
    }
  });

  // ---- media: status polling ----
  app.get('/api/media', async (req) => {
    const ids = String((req.query as { ids?: string }).ids ?? '').split(',').filter(Boolean).slice(0, 200);
    return { media: await Promise.all(repo.getMediaMany(ids).map(dtoOf)) };
  });

  // ---- media: info card (backfills codec details + source lazily for media processed before they existed) ----
  app.get('/api/media/:id/info', async (req, reply) => {
    const m0 = repo.getMedia((req.params as { id: string }).id);
    if (!m0) return reply.code(404).send({ error: 'no such media' });
    let m = m0;
    if (m.status === 'ready' && m.source == null) {
      try {
        const row = m;
        repo.updateMedia(row.id, await storage.withLocal(row.originalKey, (f) => gatherInfo({ ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe }, f, row.originalName, row.kind)));
        m = repo.getMedia(m.id) ?? m;
      } catch (e) {
        console.error('[info]', e);
      }
    }
    return reply.header('cache-control', 'no-store').send(infoDto(m));
  });

  // ---- ComfyUI: the workflow embedded in a file, and "Open in ComfyUI" ----
  const workflowOf = async (m: MediaRow) => {
    if (m.status !== 'ready' || (m.kind !== 'image' && m.kind !== 'video')) return null;
    return storage.withLocal(m.originalKey, async (file) => {
      const probe = m.kind === 'video' ? await ffprobe({ ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe }, file) : null;
      return extractWorkflow(file, probe);
    });
  };
  app.get('/api/media/:id/workflow', async (req, reply) => {
    const m = repo.getMedia((req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: 'no such media' });
    const wf = await workflowOf(m);
    if (!wf) return reply.code(404).send({ error: 'no ComfyUI workflow in this file' });
    return reply.header('cache-control', 'no-store').header('x-workflow-format', wf.format).type('application/json').send(wf.json);
  });
  app.post('/api/media/:id/open-in-comfy', async (req, reply) => {
    const m = repo.getMedia((req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: 'no such media' });
    const wf = await workflowOf(m);
    if (!wf) return reply.code(404).send({ error: 'no ComfyUI workflow in this file' });
    const name = safeWorkflowName(m.originalName);
    const rel = 'Board/' + name + '.json';
    const url = cfg.comfyUrl + '/api/userdata/' + encodeURIComponent('workflows/' + rel) + '?overwrite=true';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: wf.json, signal: AbortSignal.timeout(2000) });
      if (!r.ok) return { saved: false, reason: 'ComfyUI answered HTTP ' + r.status + ' at ' + cfg.comfyUrl };
      return { saved: true, path: rel, format: wf.format };
    } catch {
      return { saved: false, reason: 'ComfyUI not running at ' + cfg.comfyUrl };
    }
  });

  // ---- documents: text content, versions, save / restore ----
  const textDoc = (m: MediaRow | undefined): { m: MediaRow; fmt: TextFormat } | null => {
    const fmt = m && m.status === 'ready' && m.kind === 'document' ? textFormatOf(m.codec ?? '') : null;
    return m && fmt ? { m, fmt } : null;
  };
  const versionLabel = (v: VersionRow) => ({ id: v.id, createdAt: v.createdAt });
  const documentPayload = async (m: MediaRow, fmt: TextFormat, versionId?: string) => {
    const versions = repo.listVersions(m.id);
    const cur = versionId ? (versionId === 'original' ? null : repo.getVersion(versionId)) : versions[0] ?? null;
    if (versionId && versionId !== 'original' && (!cur || cur.mediaId !== m.id)) return null;
    const buf = await storage.get(cur ? cur.key : m.originalKey);
    const text = decodeText(buf.subarray(0, MAX_TEXT_BYTES));
    let elements: ReturnType<typeof parseFdx> | null = null;
    if (fmt === 'fdx') {
      try { elements = parseFdx(text); } catch { elements = []; }
    }
    return {
      id: m.id, format: fmt, text: fmt === 'fdx' ? '' : text, elements, editable: fmt !== 'fdx',
      current: cur ? cur.id : 'original', versions: [...versions.map(versionLabel), { id: 'original', createdAt: m.createdAt }],
      lines: m.lines, words: m.words, textPreview: m.textPreview,
    };
  };
  /** Store `text` as a new version and refresh the card preview + counts. */
  const saveText = async (m: MediaRow, fmt: TextFormat, text: string) => {
    const key = `versions/${randomUUID()}.txt`;
    await storage.put(key, Buffer.from(text, 'utf8'));
    repo.addVersion(m.id, key);
    const st = textStats(text, fmt);
    repo.updateMedia(m.id, { lines: st.lines, words: st.words, textPreview: st.textPreview });
  };

  app.get('/api/media/:id/document', async (req, reply) => {
    const q = req.query as { version?: string };
    const d = textDoc(repo.getMedia((req.params as { id: string }).id));
    if (!d) return reply.code(404).send({ error: 'not a text document' });
    const p = await documentPayload(d.m, d.fmt, q.version);
    if (!p) return reply.code(404).send({ error: 'no such version' });
    return reply.header('cache-control', 'no-store').send(p);
  });
  app.put('/api/media/:id/document', async (req, reply) => {
    const d = textDoc(repo.getMedia((req.params as { id: string }).id));
    if (!d) return reply.code(404).send({ error: 'not a text document' });
    if (d.fmt === 'fdx') return reply.code(400).send({ error: 'Final Draft files are read-only' });
    const text = (req.body as { text?: unknown } | null)?.text;
    if (typeof text !== 'string') return reply.code(400).send({ error: 'text required' });
    if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return reply.code(413).send({ error: 'text too large' });
    await saveText(d.m, d.fmt, text);
    return reply.header('cache-control', 'no-store').send(await documentPayload(repo.getMedia(d.m.id)!, d.fmt));
  });
  app.post('/api/media/:id/document/restore', async (req, reply) => {
    const d = textDoc(repo.getMedia((req.params as { id: string }).id));
    if (!d) return reply.code(404).send({ error: 'not a text document' });
    if (d.fmt === 'fdx') return reply.code(400).send({ error: 'Final Draft files are read-only' });
    const vid = String((req.body as { versionId?: unknown } | null)?.versionId ?? '');
    const old = await documentPayload(d.m, d.fmt, vid);
    if (!old) return reply.code(404).send({ error: 'no such version' });
    await saveText(d.m, d.fmt, old.text); // restoring is itself a new version: nothing is ever lost
    return reply.header('cache-control', 'no-store').send(await documentPayload(repo.getMedia(d.m.id)!, d.fmt));
  });

  // ---- media: files (Range supported) ----
  app.get('/api/media/:id/:variant', async (req, reply) => {
    const { id, variant } = req.params as { id: string; variant: string };
    const m = repo.getMedia(id);
    if (!m) return reply.code(404).send({ error: 'no such media' });
    const ready = m.status === 'ready';
    const cache = ready ? IMMUTABLE : 'no-store';
    if (variant === 'original') {
      const mime = m.previewKey ? 'application/octet-stream' : m.mime; // converted media: original is download-only
      return serve(req, reply, m.originalKey, mime, { cache, disposition: contentDisposition('inline', m.originalName), csp: true });
    }
    if (!ready) return reply.code(404).send({ error: 'not ready' });
    if (variant === 'preview') {
      const pdfDoc = m.kind === 'document' && (!!m.previewKey || m.codec === 'pdf');
      if (m.kind !== 'image' && m.kind !== 'video' && m.kind !== 'audio' && !pdfDoc) return reply.code(404).send({ error: 'no preview' });
      if (m.previewKey) return serve(req, reply, m.previewKey, MIME_BY_KEY_EXT[m.previewKey.split('.').pop()!] ?? m.mime, { cache });
      return serve(req, reply, m.originalKey, m.mime, { cache });
    }
    if (variant === 'thumb') {
      if (m.thumbKey) return serve(req, reply, m.thumbKey, 'image/webp', { cache });
      if (m.kind === 'image') return serve(req, reply, m.previewKey ?? m.originalKey, m.mime, { cache });
      return reply.code(404).send({ error: 'no thumbnail' });
    }
    if (variant === 'poster') {
      if (!m.posterKey) return reply.code(404).send({ error: 'no poster' });
      return serve(req, reply, m.posterKey, 'image/webp', { cache });
    }
    return reply.code(404).send({ error: 'unknown variant' });
  });

  // Show the stored original in Explorer (Windows, same machine only, never outside DATA_DIR).
  app.post('/api/items/:id/reveal', async (req, reply) => {
    if (s3 || process.platform !== 'win32' || !isLocalReq(req)) return reply.code(403).send({ error: 'only available on the machine running the server' });
    const item = repo.getItem((req.params as { id: string }).id);
    const m = item?.mediaId ? repo.getMedia(item.mediaId) : undefined;
    if (!item || !m) return reply.code(404).send({ error: 'no such item' });
    const abs = path.resolve(storage.localPath(m.originalKey));
    const rel = path.relative(path.resolve(cfg.dataDir), abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return reply.code(403).send({ error: 'outside the data folder' });
    if (!fs.existsSync(abs)) return reply.code(404).send({ error: 'file missing' });
    reveal(abs);
    return { ok: true, path: abs };
  });

  // ---- trash ----
  app.get('/api/boards/:id/trash', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!repo.getBoard(id)) return reply.code(404).send({ error: 'no such board' });
    const rows = repo.listTrash(id);
    const mediaById = new Map(repo.getMediaMany([...new Set(rows.map((r) => r.mediaId).filter((v): v is string => !!v))]).map((m) => [m.id, m]));
    return {
      items: await Promise.all(rows.map(async (r) => {
        const m = r.mediaId ? mediaById.get(r.mediaId) : undefined;
        return { id: r.id, kind: r.kind, name: r.name, deletedAt: r.deletedAt, media: m ? await dtoOf(m) : null };
      })),
    };
  });
  app.post('/api/items/:id/restore', async (req, reply) => {
    if (!repo.restoreItem((req.params as { id: string }).id)) return reply.code(404).send({ error: 'not in the trash' });
    return { ok: true };
  });
  app.delete('/api/items/:id/trash', async (req, reply) => {
    const it = repo.getItem((req.params as { id: string }).id);
    if (!it || !it.deletedAt) return reply.code(404).send({ error: 'not in the trash' });
    await purgeItems(repo, storage, [it.id]);
    repo.touchBoard(it.boardId);
    return { ok: true };
  });

  // Items trashed more than 30 days ago go for good: on start and every 6 h.
  const purgeTrash = (now?: number) => purgeExpired(repo, storage, now);
  void purgeTrash().catch((e) => console.error('[purge]', e));
  const purgeTimer = setInterval(() => void purgeTrash().catch((e) => console.error('[purge]', e)), PURGE_EVERY_MS);
  purgeTimer.unref();
  app.addHook('onClose', async () => clearInterval(purgeTimer));

  // Download original: exact bytes, original (item) file name.
  app.get('/api/items/:id/original', async (req, reply) => {
    const item = repo.getItem((req.params as { id: string }).id);
    const m = item?.mediaId ? repo.getMedia(item.mediaId) : undefined;
    if (!item || !m) return reply.code(404).send({ error: 'no such item' });
    return serve(req, reply, m.originalKey, 'application/octet-stream', {
      disposition: contentDisposition('attachment', item.name || m.originalName), cache: 'no-store',
    });
  });
  app.get('/api/media/:id/download', async (req, reply) => {
    const m = repo.getMedia((req.params as { id: string }).id);
    if (!m) return reply.code(404).send({ error: 'no such media' });
    return serve(req, reply, m.originalKey, 'application/octet-stream', {
      disposition: contentDisposition('attachment', m.originalName), cache: 'no-store',
    });
  });

  // Generic key URL (Storage.url): previews and thumbs only, never originals.
  app.get('/api/files/*', async (req, reply) => {
    const key = decodeURIComponent((req.params as { '*': string })['*']);
    if (!/^(previews|thumbs)\/[^/]+$/.test(key)) return reply.code(404).send({ error: 'not found' });
    return serve(req, reply, key, MIME_BY_KEY_EXT[key.split('.').pop()!] ?? 'application/octet-stream', { cache: IMMUTABLE });
  });

  // ---- built frontend (+ SPA fallback) ----
  const indexHtml = path.join(cfg.webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: cfg.webDist, index: ['index.html'], wildcard: true });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').header('cache-control', 'no-store').send(fs.createReadStream(indexHtml));
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Board server is running, but web/dist is missing. Run "npm run build" at the app root (or use start.bat).'));
  }

  return { app, repo, storage, processor, purgeTrash };
}
