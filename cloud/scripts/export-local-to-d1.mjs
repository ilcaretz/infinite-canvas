// Export the local board.sqlite rows to a SQL file D1 can import (named columns, only columns D1 also has).
// Usage: node scripts/export-local-to-d1.mjs ../data/board.sqlite out.sql
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: export-local-to-d1.mjs <board.sqlite> <out.sql>'); process.exit(1); }
const schema = fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const mem = new DatabaseSync(':memory:');
mem.exec(schema);
const db = new DatabaseSync(src, { readOnly: true });

const cols = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
const lit = (v) => v === null || v === undefined ? 'NULL'
  : typeof v === 'number' || typeof v === 'bigint' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`;

// parents before children
const tables = ['boards', 'media', 'items', 'comments', 'comment_messages', 'document_versions'];
const lines = [];
for (const t of tables) {
  const have = new Set(cols(mem, t));
  let localCols;
  try { localCols = cols(db, t); } catch { continue; }
  const use = localCols.filter((c) => have.has(c));
  if (!use.length) continue;
  const rows = db.prepare(`SELECT ${use.map((c) => `"${c}"`).join(',')} FROM ${t}`).all();
  for (const r of rows) lines.push(`INSERT OR REPLACE INTO ${t} (${use.join(',')}) VALUES (${use.map((c) => lit(r[c])).join(',')});`);
  console.log(`${t}: ${rows.length} rows (${use.length} cols)`);
}
fs.writeFileSync(out, lines.join('\n') + '\n');
console.log(`wrote ${lines.length} statements to ${out}`);
