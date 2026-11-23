#!/usr/bin/env node
// Upload an existing local DATA_DIR (originals\, previews\, thumbs\, versions\) to the R2 / S3 bucket, keeping the same keys.
// The database (board.sqlite) is NOT uploaded: copy it into the DATA_DIR of the machine that runs the online server.
//
//   node scripts/migrate-local-to-r2.mjs --dry-run            # list what would be sent, contacts nothing
//   node scripts/migrate-local-to-r2.mjs                      # upload (skips objects that already exist with the same size)
//   node scripts/migrate-local-to-r2.mjs --data-dir D:\Board_data --concurrency 6 --force
//
// Settings come from .env / the environment: DATA_DIR, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);

if (flag('--help') || flag('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
const envFile = path.join(root, '.env');
const fromFile = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
const get = (k) => process.env[k] ?? fromFile[k];

const dryRun = flag('--dry-run');
const force = flag('--force');
const concurrency = Math.max(1, Number(opt('--concurrency', 4)) || 4);
const dataDir = path.resolve(opt('--data-dir', get('DATA_DIR') ? path.resolve(root, get('DATA_DIR')) : path.join(root, 'data')));
const DIRS = ['originals', 'previews', 'thumbs', 'versions'];
const MIME = {
  webp: 'image/webp', mp4: 'video/mp4', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', m4a: 'audio/mp4', pdf: 'application/pdf', txt: 'text/plain',
};

if (!fs.existsSync(dataDir)) {
  console.error(`DATA_DIR not found: ${dataDir}`);
  process.exit(1);
}

/** Every file under the data dirs as { key, abs, size }. */
function* walk(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const key = `${prefix}/${e.name}`;
    if (e.isDirectory()) yield* walk(abs, key);
    else if (e.isFile()) yield { key, abs, size: fs.statSync(abs).size };
  }
}
const files = DIRS.flatMap((d) => [...walk(path.join(dataDir, d), d)]);
const total = files.reduce((a, f) => a + f.size, 0);
const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
console.log(`${dryRun ? '[dry run] ' : ''}${files.length} files, ${gb(total)} in ${dataDir}`);

if (dryRun) {
  for (const f of files) console.log(`  would upload ${f.key}  (${(f.size / 1024 ** 2).toFixed(1)} MB)`);
  console.log(`[dry run] nothing was sent. board.sqlite stays local: copy it next to the online server's data.`);
  process.exit(0);
}

const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !get(k));
if (missing.length) {
  console.error(`Missing in .env / environment: ${missing.join(', ')}`);
  process.exit(1);
}
const req = createRequire(path.join(root, 'server', 'package.json'));
const { S3Client, HeadObjectCommand } = req('@aws-sdk/client-s3');
const { Upload } = req('@aws-sdk/lib-storage');
const client = new S3Client({
  region: get('S3_REGION') || 'auto',
  endpoint: get('S3_ENDPOINT'),
  forcePathStyle: true,
  credentials: { accessKeyId: get('S3_ACCESS_KEY_ID'), secretAccessKey: get('S3_SECRET_ACCESS_KEY') },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const Bucket = get('S3_BUCKET');

async function remoteSize(key) {
  try {
    return Number((await client.send(new HeadObjectCommand({ Bucket, Key: key }))).ContentLength ?? -1);
  } catch (e) {
    if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) return -1;
    throw e;
  }
}

let done = 0, skipped = 0, failed = 0, sent = 0;
const queue = [...files];
async function worker() {
  for (let f = queue.shift(); f; f = queue.shift()) {
    try {
      if (!force && (await remoteSize(f.key)) === f.size) {
        skipped++;
      } else {
        const ext = f.key.split('.').pop().toLowerCase();
        const up = new Upload({
          client, partSize: 64 * 1024 * 1024, queueSize: 3,
          params: { Bucket, Key: f.key, Body: fs.createReadStream(f.abs), ContentType: MIME[ext] ?? 'application/octet-stream' },
        });
        await up.done();
        sent += f.size;
      }
    } catch (e) {
      failed++;
      console.error(`  FAILED ${f.key}: ${e.message}`);
    }
    done++;
    if (done % 25 === 0 || done === files.length) console.log(`  ${done}/${files.length}  (sent ${gb(sent)}, skipped ${skipped}, failed ${failed})`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`Finished: ${files.length - skipped - failed} uploaded, ${skipped} already there, ${failed} failed.`);
console.log('Next: copy board.sqlite (stop the board first) into the online server\'s DATA_DIR and set STORAGE_DRIVER=s3.');
process.exit(failed ? 1 : 0);
