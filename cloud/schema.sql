-- D1 schema. Column ORDER mirrors server/src/db.ts after its ALTER TABLE migrations,
-- so a positional dump of the local board.sqlite imports cleanly.
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, originalKey TEXT NOT NULL, previewKey TEXT, thumbKey TEXT, posterKey TEXT,
  mime TEXT NOT NULL DEFAULT 'application/octet-stream', kind TEXT NOT NULL DEFAULT 'file',
  codec TEXT, width INTEGER, height INTEGER, durationMs INTEGER, fps REAL,
  sizeBytes INTEGER NOT NULL, sha256 TEXT NOT NULL UNIQUE, originalName TEXT NOT NULL DEFAULT '',
  comfyMetadataJson TEXT, status TEXT NOT NULL DEFAULT 'processing', error TEXT, createdAt INTEGER NOT NULL,
  codecLong TEXT, codecProfile TEXT, pixFmt TEXT, bitRate INTEGER, container TEXT,
  source TEXT, sourceEvidence TEXT,
  sampleRate INTEGER, channels INTEGER, pages INTEGER, lines INTEGER, words INTEGER, textPreview TEXT,
  uploadedBy TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL, z REAL NOT NULL,
  mediaId TEXT REFERENCES media(id), name TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER,
  props TEXT);
CREATE INDEX IF NOT EXISTS items_board ON items(boardId);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, boardId TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, itemId TEXT,
  x REAL NOT NULL, y REAL NOT NULL, videoTimeMs INTEGER, resolved INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL,
  number INTEGER NOT NULL DEFAULT 0, itemX REAL, itemY REAL,
  updatedAt INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER);

CREATE TABLE IF NOT EXISTS comment_messages (
  id TEXT PRIMARY KEY, commentId TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  author TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY, mediaId TEXT NOT NULL REFERENCES media(id), key TEXT NOT NULL, createdAt INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS versions_media ON document_versions(mediaId);

-- cloud only: browser uploads in flight (the media row is written by /complete)
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT '', originalKey TEXT NOT NULL, uploadId TEXT, uploadedBy TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL);

-- cloud only: failed logins, key = "<ip>|<username>"
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts(key, at);
