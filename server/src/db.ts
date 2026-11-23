import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type Db = Database.Database;
export type MediaStatus = 'processing' | 'ready' | 'failed';
export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'file';

export interface BoardRow { id: string; name: string; createdAt: number; updatedAt: number }
export interface ItemRow {
  id: string; boardId: string; kind: string; x: number; y: number; w: number; h: number; z: number;
  mediaId: string | null; name: string; version: number; updatedAt: number; deletedAt: number | null;
  /** JSON text with the style of a `text` / `group` item (null for media items). */
  props: string | null;
}
export interface MediaRow {
  id: string; originalKey: string; previewKey: string | null; thumbKey: string | null; posterKey: string | null;
  mime: string; kind: MediaKind; codec: string | null; width: number | null; height: number | null;
  durationMs: number | null; fps: number | null; sizeBytes: number; sha256: string; originalName: string;
  comfyMetadataJson: string | null; status: MediaStatus; error: string | null; createdAt: number;
  // info columns (added by migration; null until probed)
  codecLong: string | null; codecProfile: string | null; pixFmt: string | null; bitRate: number | null; container: string | null;
  source: string | null; sourceEvidence: string | null;
  // audio / document details
  sampleRate: number | null; channels: number | null; pages: number | null; lines: number | null; words: number | null;
  textPreview: string | null;
}
export interface CommentMessageRow { id: string; commentId: string; author: string; text: string; createdAt: number }
export interface CommentRow {
  id: string; boardId: string; itemId: string | null; number: number; x: number; y: number;
  itemX: number | null; itemY: number | null; videoTimeMs: number | null; resolved: number;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}
export interface CommentCreate {
  id: string; boardId: string; itemId: string | null; x: number; y: number; itemX: number | null; itemY: number | null;
  videoTimeMs: number | null; author: string; text: string; messageId: string;
}
export interface VersionRow { id: string; mediaId: string; key: string; createdAt: number }

/** Columns added after the first release: ALTER TABLE when missing (existing DBs keep their rows). */
const MEDIA_MIGRATIONS: Array<[string, string]> = [
  ['codecLong', 'TEXT'], ['codecProfile', 'TEXT'], ['pixFmt', 'TEXT'], ['bitRate', 'INTEGER'], ['container', 'TEXT'],
  ['source', 'TEXT'], ['sourceEvidence', 'TEXT'],
  ['sampleRate', 'INTEGER'], ['channels', 'INTEGER'], ['pages', 'INTEGER'], ['lines', 'INTEGER'], ['words', 'INTEGER'], ['textPreview', 'TEXT'],
];
const COMMENT_MIGRATIONS: Array<[string, string]> = [
  ['number', 'INTEGER NOT NULL DEFAULT 0'], ['itemX', 'REAL'], ['itemY', 'REAL'],
  ['updatedAt', 'INTEGER NOT NULL DEFAULT 0'], ['deletedAt', 'INTEGER'],
];
const ITEM_MIGRATIONS: Array<[string, string]> = [['props', 'TEXT']];
function addMissing(db: Db, table: string, cols: Array<[string, string]>) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  if (!have.size) return; // table does not exist (partial legacy DB)
  for (const [name, type] of cols) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
export function migrate(db: Db) {
  addMissing(db, 'media', MEDIA_MIGRATIONS);
  addMissing(db, 'items', ITEM_MIGRATIONS);
  addMissing(db, 'comments', COMMENT_MIGRATIONS);
  // Pre-numbering rows: number them per board in creation order.
  if (!(db.prepare('PRAGMA table_info(comments)').all() as unknown[]).length) return;
  const unnumbered = db.prepare('SELECT id, boardId FROM comments WHERE number=0 ORDER BY createdAt, rowid').all() as Array<{ id: string; boardId: string }>;
  const max = db.prepare('SELECT COALESCE(MAX(number),0) m FROM comments WHERE boardId=?');
  const set = db.prepare('UPDATE comments SET number=?, updatedAt=CASE WHEN updatedAt=0 THEN createdAt ELSE updatedAt END WHERE id=?');
  for (const c of unnumbered) set.run((max.get(c.boardId) as { m: number }).m + 1, c.id);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, originalKey TEXT NOT NULL, previewKey TEXT, thumbKey TEXT, posterKey TEXT,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream', kind TEXT NOT NULL DEFAULT 'file',
  codec TEXT, width INTEGER, height INTEGER, durationMs INTEGER, fps REAL,
  sizeBytes INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, originalName TEXT NOT NULL DEFAULT '',
  comfyMetadataJson TEXT, status TEXT NOT NULL DEFAULT 'processing', error TEXT, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, z REAL NOT NULL,
  mediaId TEXT REFERENCES media(id), name TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER);
CREATE INDEX IF NOT EXISTS items_board ON items(boardId);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, itemId TEXT,
  x REAL NOT NULL, y REAL NOT NULL, videoTimeMs INTEGER, resolved INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS comment_messages (
  id TEXT PRIMARY KEY, commentId TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  author TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY, mediaId TEXT NOT NULL REFERENCES media(id), key TEXT NOT NULL, createdAt INTEGER NOT NULL);
`;

export function openDb(dataDir: string): Db {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'board.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export type ItemUpsert = Omit<ItemRow, 'boardId' | 'deletedAt'>;

/** All SQL lives here. Keys stored in the DB are always relative to DATA_DIR. */
export class Repo {
  constructor(readonly db: Db) {}

  // ---- boards ----
  listBoards(): BoardRow[] {
    return this.db.prepare('SELECT * FROM boards ORDER BY updatedAt DESC').all() as BoardRow[];
  }
  getBoard(id: string): BoardRow | undefined {
    return this.db.prepare('SELECT * FROM boards WHERE id = ?').get(id) as BoardRow | undefined;
  }
  createBoard(name: string): BoardRow {
    const now = Date.now();
    const row = { id: randomUUID(), name, createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO boards (id,name,createdAt,updatedAt) VALUES (@id,@name,@createdAt,@updatedAt)').run(row);
    return row;
  }
  renameBoard(id: string, name: string): boolean {
    return this.db.prepare('UPDATE boards SET name=?, updatedAt=? WHERE id=?').run(name, Date.now(), id).changes > 0;
  }
  deleteBoard(id: string): boolean {
    return this.db.prepare('DELETE FROM boards WHERE id=?').run(id).changes > 0;
  }
  touchBoard(id: string) {
    this.db.prepare('UPDATE boards SET updatedAt=? WHERE id=?').run(Date.now(), id);
  }

  // ---- items ----
  listItems(boardId: string): ItemRow[] {
    return this.db.prepare('SELECT * FROM items WHERE boardId=?').all(boardId) as ItemRow[];
  }
  getItem(id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM items WHERE id=?').get(id) as ItemRow | undefined;
  }

  /** Last write wins per item (by client updatedAt). Returns ids that were rejected as stale / foreign. */
  saveItems(boardId: string, upserts: ItemUpsert[], deletes: Array<{ id: string; updatedAt: number }>): string[] {
    const rejected: string[] = [];
    const get = this.db.prepare('SELECT boardId, updatedAt FROM items WHERE id=?');
    const ins = this.db.prepare(
      `INSERT INTO items (id,boardId,kind,x,y,w,h,z,mediaId,name,props,version,updatedAt,deletedAt)
       VALUES (@id,@boardId,@kind,@x,@y,@w,@h,@z,@mediaId,@name,@props,@version,@updatedAt,NULL)
       ON CONFLICT(id) DO UPDATE SET kind=@kind,x=@x,y=@y,w=@w,h=@h,z=@z,mediaId=@mediaId,name=@name,props=@props,
         version=@version,updatedAt=@updatedAt,deletedAt=NULL`,
    );
    const del = this.db.prepare('UPDATE items SET deletedAt=?, updatedAt=?, version=version+1 WHERE id=?');
    this.db.transaction(() => {
      for (const it of upserts) {
        const cur = get.get(it.id) as { boardId: string; updatedAt: number } | undefined;
        if (cur && (cur.boardId !== boardId || it.updatedAt < cur.updatedAt)) {
          rejected.push(it.id);
          continue;
        }
        ins.run({ ...it, boardId });
      }
      for (const d of deletes) {
        const cur = get.get(d.id) as { boardId: string; updatedAt: number } | undefined;
        if (!cur || cur.boardId !== boardId) continue;
        if (d.updatedAt < cur.updatedAt) rejected.push(d.id);
        else del.run(d.updatedAt, d.updatedAt, d.id);
      }
    })();
    if (upserts.length || deletes.length) this.touchBoard(boardId);
    return rejected;
  }

  // ---- media ----
  getMedia(id: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow | undefined;
  }
  getMediaBySha(sha256: string): MediaRow | undefined {
    return this.db.prepare('SELECT * FROM media WHERE sha256=?').get(sha256) as MediaRow | undefined;
  }
  getMediaMany(ids: string[]): MediaRow[] {
    if (!ids.length) return [];
    return this.db.prepare(`SELECT * FROM media WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as MediaRow[];
  }
  insertMedia(m: Pick<MediaRow, 'id' | 'originalKey' | 'mime' | 'sizeBytes' | 'sha256' | 'originalName'>): MediaRow {
    this.db.prepare(
      `INSERT INTO media (id,originalKey,mime,sizeBytes,sha256,originalName,status,createdAt)
       VALUES (@id,@originalKey,@mime,@sizeBytes,@sha256,@originalName,'processing',@createdAt)`,
    ).run({ ...m, createdAt: Date.now() });
    return this.getMedia(m.id)!;
  }
  updateMedia(id: string, patch: Partial<Omit<MediaRow, 'id'>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    this.db.prepare(`UPDATE media SET ${keys.map((k) => `${k}=@${k}`).join(',')} WHERE id=@id`).run({ ...patch, id });
  }
  // ---- document versions (every save; the original upload is the implicit version 0) ----
  listVersions(mediaId: string): VersionRow[] {
    return this.db.prepare('SELECT * FROM document_versions WHERE mediaId=? ORDER BY createdAt DESC, rowid DESC').all(mediaId) as VersionRow[];
  }
  getVersion(id: string): VersionRow | undefined {
    return this.db.prepare('SELECT * FROM document_versions WHERE id=?').get(id) as VersionRow | undefined;
  }
  addVersion(mediaId: string, key: string): VersionRow {
    const row = { id: randomUUID(), mediaId, key, createdAt: Date.now() };
    this.db.prepare('INSERT INTO document_versions (id,mediaId,key,createdAt) VALUES (@id,@mediaId,@key,@createdAt)').run(row);
    return row;
  }
  // ---- comments ----
  /** Visible comments of a board: not deleted, and not attached to a trashed item (restoring the item brings them back). */
  listComments(boardId: string): Array<CommentRow & { messages: CommentMessageRow[] }> {
    const rows = this.db.prepare(
      `SELECT c.* FROM comments c LEFT JOIN items i ON i.id = c.itemId
       WHERE c.boardId=? AND c.deletedAt IS NULL AND (c.itemId IS NULL OR (i.id IS NOT NULL AND i.deletedAt IS NULL))
       ORDER BY c.number`,
    ).all(boardId) as CommentRow[];
    const msgs = this.db.prepare('SELECT * FROM comment_messages WHERE commentId=? ORDER BY createdAt, rowid');
    return rows.map((r) => ({ ...r, messages: msgs.all(r.id) as CommentMessageRow[] }));
  }
  getComment(id: string): CommentRow | undefined {
    return this.db.prepare('SELECT * FROM comments WHERE id=?').get(id) as CommentRow | undefined;
  }
  commentWithMessages(id: string) {
    const c = this.getComment(id);
    if (!c) return undefined;
    const messages = this.db.prepare('SELECT * FROM comment_messages WHERE commentId=? ORDER BY createdAt, rowid').all(id) as CommentMessageRow[];
    return { ...c, messages };
  }
  /** Creates the comment with its first message (number = next free one on the board). Idempotent on id. */
  createComment(c: CommentCreate): CommentRow {
    const exist = this.getComment(c.id);
    if (exist) return exist;
    const now = Date.now();
    this.db.transaction(() => {
      const n = (this.db.prepare('SELECT COALESCE(MAX(number),0) m FROM comments WHERE boardId=?').get(c.boardId) as { m: number }).m + 1;
      this.db.prepare(
        `INSERT INTO comments (id,boardId,itemId,number,x,y,itemX,itemY,videoTimeMs,resolved,createdAt,updatedAt,deletedAt)
         VALUES (@id,@boardId,@itemId,@n,@x,@y,@itemX,@itemY,@videoTimeMs,0,@now,@now,NULL)`,
      ).run({ id: c.id, boardId: c.boardId, itemId: c.itemId, x: c.x, y: c.y, itemX: c.itemX, itemY: c.itemY, videoTimeMs: c.videoTimeMs, n, now });
      this.db.prepare('INSERT INTO comment_messages (id,commentId,author,text,createdAt) VALUES (?,?,?,?,?)').run(c.messageId, c.id, c.author, c.text, now);
    })();
    this.touchBoard(c.boardId);
    return this.getComment(c.id)!;
  }
  addMessage(commentId: string, id: string, author: string, text: string): boolean {
    const c = this.getComment(commentId);
    if (!c || c.deletedAt) return false;
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO comment_messages (id,commentId,author,text,createdAt) VALUES (?,?,?,?,?)').run(id, commentId, author, text, now);
      this.db.prepare('UPDATE comments SET updatedAt=? WHERE id=?').run(now, commentId);
    })();
    this.touchBoard(c.boardId);
    return true;
  }
  setCommentResolved(id: string, resolved: boolean): boolean {
    const c = this.getComment(id);
    if (!c || c.deletedAt) return false;
    this.db.prepare('UPDATE comments SET resolved=?, updatedAt=? WHERE id=?').run(resolved ? 1 : 0, Date.now(), id);
    this.touchBoard(c.boardId);
    return true;
  }
  deleteComment(id: string): boolean {
    const c = this.getComment(id);
    if (!c || c.deletedAt) return false;
    const now = Date.now();
    this.db.prepare('UPDATE comments SET deletedAt=?, updatedAt=? WHERE id=?').run(now, now, id);
    this.touchBoard(c.boardId);
    return true;
  }

  // ---- trash ----
  listTrash(boardId: string): ItemRow[] {
    return this.db.prepare('SELECT * FROM items WHERE boardId=? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC').all(boardId) as ItemRow[];
  }
  /** Un-delete: newer updatedAt + version so every open tab picks it up on its next poll. */
  restoreItem(id: string): ItemRow | undefined {
    const it = this.getItem(id);
    if (!it || !it.deletedAt) return undefined;
    const now = Math.max(Date.now(), it.updatedAt + 1);
    this.db.prepare('UPDATE items SET deletedAt=NULL, updatedAt=?, version=version+1 WHERE id=?').run(now, id);
    this.touchBoard(it.boardId);
    return this.getItem(id);
  }
  expiredItems(cutoff: number): ItemRow[] {
    return this.db.prepare('SELECT * FROM items WHERE deletedAt IS NOT NULL AND deletedAt < ?').all(cutoff) as ItemRow[];
  }
  /** Hard-delete items and their comments (messages cascade). Returns the media ids they pointed at. */
  hardDeleteItems(ids: string[]): string[] {
    const mediaIds = new Set<string>();
    this.db.transaction(() => {
      for (const id of ids) {
        const it = this.getItem(id);
        if (!it) continue;
        if (it.mediaId) mediaIds.add(it.mediaId);
        this.db.prepare('DELETE FROM comments WHERE itemId=?').run(id);
        this.db.prepare('DELETE FROM items WHERE id=?').run(id);
      }
    })();
    return [...mediaIds];
  }
  mediaRefCount(mediaId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM items WHERE mediaId=?').get(mediaId) as { c: number }).c;
  }
  /** Remove the media row and return every storage key it owned (original, derived files, document versions). */
  hardDeleteMedia(id: string): string[] {
    const m = this.getMedia(id);
    if (!m) return [];
    const keys = [m.originalKey, m.previewKey, m.thumbKey, m.posterKey, ...this.listVersions(id).map((v) => v.key)].filter((k): k is string => !!k);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM document_versions WHERE mediaId=?').run(id);
      this.db.prepare('DELETE FROM media WHERE id=?').run(id);
    })();
    return keys;
  }

  processingMedia(): MediaRow[] {
    return this.db.prepare("SELECT * FROM media WHERE status='processing' ORDER BY createdAt").all() as MediaRow[];
  }
}
