import { chunks } from './util';

export interface BoardRow { id: string; name: string; createdAt: number; updatedAt: number }
export interface ItemRow {
  id: string; boardId: string; kind: string; x: number; y: number; w: number; h: number; z: number;
  mediaId: string | null; name: string; version: number; updatedAt: number; deletedAt: number | null; props: string | null;
}
export interface MediaRow {
  id: string; originalKey: string; previewKey: string | null; thumbKey: string | null; posterKey: string | null;
  mime: string; kind: string; codec: string | null; width: number | null; height: number | null;
  durationMs: number | null; fps: number | null; sizeBytes: number; sha256: string; originalName: string;
  comfyMetadataJson: string | null; status: string; error: string | null; createdAt: number;
  codecLong: string | null; codecProfile: string | null; pixFmt: string | null; bitRate: number | null; container: string | null;
  source: string | null; sourceEvidence: string | null;
  sampleRate: number | null; channels: number | null; pages: number | null; lines: number | null; words: number | null;
  textPreview: string | null; uploadedBy: string;
}
export interface CommentRow {
  id: string; boardId: string; itemId: string | null; number: number; x: number; y: number;
  itemX: number | null; itemY: number | null; videoTimeMs: number | null; resolved: number;
  createdAt: number; updatedAt: number; deletedAt: number | null;
}
export interface CommentMessageRow { id: string; commentId: string; author: string; text: string; createdAt: number }
export interface VersionRow { id: string; mediaId: string; key: string; createdAt: number }
export interface UploadRow {
  id: string; filename: string; size: number; mime: string; sha256: string; originalKey: string; uploadId: string | null; uploadedBy: string; createdAt: number;
}
export type ItemUpsert = Omit<ItemRow, 'boardId' | 'deletedAt'>;

/** D1 allows 100 bound parameters per statement. */
const IN_MAX = 90;

/** All SQL lives here. Keys stored in the DB are R2 object keys. */
export class Repo {
  constructor(readonly db: D1Database) {}

  private first<T>(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).bind(...args).first<T>();
  }
  private async all<T>(sql: string, ...args: unknown[]) {
    return (await this.db.prepare(sql).bind(...args).all<T>()).results;
  }
  private async changes(sql: string, ...args: unknown[]) {
    return (await this.db.prepare(sql).bind(...args).run()).meta.changes > 0;
  }
  private st(sql: string, ...args: unknown[]) {
    return this.db.prepare(sql).bind(...args);
  }
  /** Rows of `table` whose `col` is in `ids`, chunked, one batch round trip. */
  private async byIds<T>(table: string, col: string, ids: string[], cols = '*'): Promise<T[]> {
    if (!ids.length) return [];
    const stmts = [...chunks(ids, IN_MAX)].map((c) => this.st(`SELECT ${cols} FROM ${table} WHERE ${col} IN (${c.map(() => '?').join(',')})`, ...c));
    return (await this.db.batch<T>(stmts)).flatMap((r) => r.results);
  }

  // ---- boards ----
  listBoards() {
    return this.all<BoardRow>('SELECT * FROM boards ORDER BY updatedAt DESC');
  }
  getBoard(id: string) {
    return this.first<BoardRow>('SELECT * FROM boards WHERE id=?', id);
  }
  async createBoard(name: string): Promise<BoardRow> {
    const now = Date.now();
    const row = { id: crypto.randomUUID(), name, createdAt: now, updatedAt: now };
    await this.st('INSERT INTO boards (id,name,createdAt,updatedAt) VALUES (?,?,?,?)', row.id, name, now, now).run();
    return row;
  }
  renameBoard(id: string, name: string) {
    return this.changes('UPDATE boards SET name=?, updatedAt=? WHERE id=?', name, Date.now(), id);
  }
  deleteBoard(id: string) {
    return this.changes('DELETE FROM boards WHERE id=?', id);
  }
  touchBoard(id: string) {
    return this.st('UPDATE boards SET updatedAt=? WHERE id=?', Date.now(), id).run();
  }

  // ---- items ----
  listItems(boardId: string) {
    return this.all<ItemRow>('SELECT * FROM items WHERE boardId=?', boardId);
  }
  getItem(id: string) {
    return this.first<ItemRow>('SELECT * FROM items WHERE id=?', id);
  }
  /** Last write wins per item (by client updatedAt). Returns ids rejected as stale / foreign. One read round trip + one atomic batch. */
  async saveItems(boardId: string, upserts: ItemUpsert[], deletes: Array<{ id: string; updatedAt: number }>): Promise<string[]> {
    const ids = [...new Set([...upserts.map((u) => u.id), ...deletes.map((d) => d.id)])];
    const cur = new Map((await this.byIds<{ id: string; boardId: string; updatedAt: number }>('items', 'id', ids, 'id,boardId,updatedAt')).map((r) => [r.id, r]));
    const rejected: string[] = [];
    const stmts: D1PreparedStatement[] = [];
    for (const it of upserts) {
      const c = cur.get(it.id);
      if (c && (c.boardId !== boardId || it.updatedAt < c.updatedAt)) {
        rejected.push(it.id);
        continue;
      }
      cur.set(it.id, { id: it.id, boardId, updatedAt: it.updatedAt });
      stmts.push(this.st(
        `INSERT INTO items (id,boardId,kind,x,y,w,h,z,mediaId,name,props,version,updatedAt,deletedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
         ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,x=excluded.x,y=excluded.y,w=excluded.w,h=excluded.h,z=excluded.z,
           mediaId=excluded.mediaId,name=excluded.name,props=excluded.props,version=excluded.version,updatedAt=excluded.updatedAt,deletedAt=NULL`,
        it.id, boardId, it.kind, it.x, it.y, it.w, it.h, it.z, it.mediaId, it.name, it.props, it.version, it.updatedAt,
      ));
    }
    for (const d of deletes) {
      const c = cur.get(d.id);
      if (!c || c.boardId !== boardId) continue;
      if (d.updatedAt < c.updatedAt) rejected.push(d.id);
      else stmts.push(this.st('UPDATE items SET deletedAt=?, updatedAt=?, version=version+1 WHERE id=?', d.updatedAt, d.updatedAt, d.id));
    }
    if (upserts.length || deletes.length) stmts.push(this.st('UPDATE boards SET updatedAt=? WHERE id=?', Date.now(), boardId));
    for (const c of chunks(stmts, 90)) await this.db.batch(c);
    return rejected;
  }

  // ---- media ----
  getMedia(id: string) {
    return this.first<MediaRow>('SELECT * FROM media WHERE id=?', id);
  }
  getMediaBySha(sha: string) {
    return this.first<MediaRow>('SELECT * FROM media WHERE sha256=?', sha);
  }
  getMediaMany(ids: string[]) {
    return this.byIds<MediaRow>('media', 'id', ids);
  }
  async existingMediaIds(ids: string[]): Promise<Set<string>> {
    return new Set((await this.byIds<{ id: string }>('media', 'id', ids, 'id')).map((r) => r.id));
  }
  async insertMedia(m: Omit<MediaRow, 'status' | 'error' | 'createdAt'> & { status?: string }) {
    const cols = Object.keys(m).concat(['createdAt']);
    const vals = Object.values(m).concat([Date.now()]);
    if (!('status' in m)) { cols.push('status'); vals.push('ready'); }
    await this.st(`INSERT INTO media (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...vals.map((v) => v ?? null)).run();
  }
  async updateMedia(id: string, patch: Partial<Omit<MediaRow, 'id'>>) {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    await this.st(`UPDATE media SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(patch).map((v) => v ?? null), id).run();
  }

  // ---- uploads in flight ----
  getUpload(id: string) {
    return this.first<UploadRow>('SELECT * FROM uploads WHERE id=?', id);
  }
  async addUpload(u: Omit<UploadRow, 'createdAt'>) {
    await this.st(
      'INSERT OR REPLACE INTO uploads (id,filename,size,mime,sha256,originalKey,uploadId,uploadedBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?)',
      u.id, u.filename, u.size, u.mime, u.sha256, u.originalKey, u.uploadId, u.uploadedBy, Date.now(),
    ).run();
  }
  async deleteUpload(id: string) {
    await this.st('DELETE FROM uploads WHERE id=?', id).run();
  }

  // ---- document versions ----
  listVersions(mediaId: string) {
    return this.all<VersionRow>('SELECT * FROM document_versions WHERE mediaId=? ORDER BY createdAt DESC, rowid DESC', mediaId);
  }
  getVersion(id: string) {
    return this.first<VersionRow>('SELECT * FROM document_versions WHERE id=?', id);
  }
  async addVersion(mediaId: string, key: string, patch: Partial<MediaRow>): Promise<void> {
    const keys = Object.keys(patch);
    await this.db.batch([
      this.st('INSERT INTO document_versions (id,mediaId,key,createdAt) VALUES (?,?,?,?)', crypto.randomUUID(), mediaId, key, Date.now()),
      ...(keys.length ? [this.st(`UPDATE media SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...Object.values(patch).map((v) => v ?? null), mediaId)] : []),
    ]);
  }

  // ---- comments ----
  /** Visible comments of a board: not deleted, and not attached to a trashed item. */
  async listComments(boardId: string): Promise<Array<CommentRow & { messages: CommentMessageRow[] }>> {
    const [rows, msgs] = (await this.db.batch([
      this.st(
        `SELECT c.* FROM comments c LEFT JOIN items i ON i.id = c.itemId
         WHERE c.boardId=? AND c.deletedAt IS NULL AND (c.itemId IS NULL OR (i.id IS NOT NULL AND i.deletedAt IS NULL))
         ORDER BY c.number`, boardId),
      this.st(
        `SELECT m.* FROM comment_messages m JOIN comments c ON c.id = m.commentId WHERE c.boardId=? ORDER BY m.createdAt, m.rowid`, boardId),
    ])) as [D1Result<CommentRow>, D1Result<CommentMessageRow>];
    const by = new Map<string, CommentMessageRow[]>();
    for (const m of msgs.results) (by.get(m.commentId) ?? by.set(m.commentId, []).get(m.commentId)!).push(m);
    return rows.results.map((r) => ({ ...r, messages: by.get(r.id) ?? [] }));
  }
  getComment(id: string) {
    return this.first<CommentRow>('SELECT * FROM comments WHERE id=?', id);
  }
  async commentWithMessages(id: string) {
    const c = await this.getComment(id);
    if (!c) return undefined;
    const messages = await this.all<CommentMessageRow>('SELECT * FROM comment_messages WHERE commentId=? ORDER BY createdAt, rowid', id);
    return { ...c, messages };
  }
  /** Comment + first message; number = next free one on the board (computed inside the INSERT). Idempotent on id. */
  async createComment(c: {
    id: string; boardId: string; itemId: string | null; x: number; y: number; itemX: number | null; itemY: number | null;
    videoTimeMs: number | null; author: string; text: string; messageId: string;
  }) {
    if (await this.getComment(c.id)) return;
    const now = Date.now();
    await this.db.batch([
      this.st(
        `INSERT INTO comments (id,boardId,itemId,number,x,y,itemX,itemY,videoTimeMs,resolved,createdAt,updatedAt,deletedAt)
         SELECT ?,?,?,COALESCE(MAX(number),0)+1,?,?,?,?,?,0,?,?,NULL FROM comments WHERE boardId=?`,
        c.id, c.boardId, c.itemId, c.x, c.y, c.itemX, c.itemY, c.videoTimeMs, now, now, c.boardId),
      this.st('INSERT INTO comment_messages (id,commentId,author,text,createdAt) VALUES (?,?,?,?,?)', c.messageId, c.id, c.author, c.text, now),
      this.st('UPDATE boards SET updatedAt=? WHERE id=?', now, c.boardId),
    ]);
  }
  async addMessage(commentId: string, id: string, author: string, text: string): Promise<boolean> {
    const c = await this.getComment(commentId);
    if (!c || c.deletedAt) return false;
    const now = Date.now();
    await this.db.batch([
      this.st('INSERT OR IGNORE INTO comment_messages (id,commentId,author,text,createdAt) VALUES (?,?,?,?,?)', id, commentId, author, text, now),
      this.st('UPDATE comments SET updatedAt=? WHERE id=?', now, commentId),
      this.st('UPDATE boards SET updatedAt=? WHERE id=?', now, c.boardId),
    ]);
    return true;
  }
  async setCommentResolved(id: string, resolved: boolean): Promise<boolean> {
    const c = await this.getComment(id);
    if (!c || c.deletedAt) return false;
    const now = Date.now();
    await this.db.batch([
      this.st('UPDATE comments SET resolved=?, updatedAt=? WHERE id=?', resolved ? 1 : 0, now, id),
      this.st('UPDATE boards SET updatedAt=? WHERE id=?', now, c.boardId),
    ]);
    return true;
  }
  async deleteComment(id: string): Promise<boolean> {
    const c = await this.getComment(id);
    if (!c || c.deletedAt) return false;
    const now = Date.now();
    await this.db.batch([
      this.st('UPDATE comments SET deletedAt=?, updatedAt=? WHERE id=?', now, now, id),
      this.st('UPDATE boards SET updatedAt=? WHERE id=?', now, c.boardId),
    ]);
    return true;
  }

  // ---- trash ----
  listTrash(boardId: string) {
    return this.all<ItemRow>('SELECT * FROM items WHERE boardId=? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC', boardId);
  }
  async restoreItem(id: string): Promise<ItemRow | undefined> {
    const it = await this.getItem(id);
    if (!it || !it.deletedAt) return undefined;
    const now = Math.max(Date.now(), it.updatedAt + 1);
    await this.db.batch([
      this.st('UPDATE items SET deletedAt=NULL, updatedAt=?, version=version+1 WHERE id=?', now, id),
      this.st('UPDATE boards SET updatedAt=? WHERE id=?', Date.now(), it.boardId),
    ]);
    return (await this.getItem(id)) ?? undefined;
  }
  expiredItems(cutoff: number) {
    return this.all<ItemRow>('SELECT * FROM items WHERE deletedAt IS NOT NULL AND deletedAt < ?', cutoff);
  }
  /** Hard-delete items and their comments (messages cascade). Returns the media ids they pointed at. */
  async hardDeleteItems(ids: string[]): Promise<string[]> {
    const rows = await this.byIds<{ id: string; mediaId: string | null }>('items', 'id', ids, 'id,mediaId');
    const stmts: D1PreparedStatement[] = [];
    for (const r of rows) {
      stmts.push(this.st('DELETE FROM comments WHERE itemId=?', r.id), this.st('DELETE FROM items WHERE id=?', r.id));
    }
    for (const c of chunks(stmts, 90)) await this.db.batch(c);
    return [...new Set(rows.map((r) => r.mediaId).filter((v): v is string => !!v))];
  }
  async mediaRefCount(mediaId: string): Promise<number> {
    return (await this.first<{ c: number }>('SELECT COUNT(*) c FROM items WHERE mediaId=?', mediaId))?.c ?? 0;
  }
  /** Remove the media row; returns every R2 key it owned (original, derived files, document versions). */
  async hardDeleteMedia(id: string): Promise<string[]> {
    const m = await this.getMedia(id);
    if (!m) return [];
    const keys = [m.originalKey, m.previewKey, m.thumbKey, m.posterKey, ...(await this.listVersions(id)).map((v) => v.key)].filter((k): k is string => !!k);
    await this.db.batch([this.st('DELETE FROM document_versions WHERE mediaId=?', id), this.st('DELETE FROM media WHERE id=?', id)]);
    return keys;
  }
}
