import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** App root = folder holding server\, web\, .env (server/src and server/dist are both 2 levels below it). */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Minimal .env parser (KEY=VALUE, # comments, optional quotes). Does not override real env vars. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '');
    out[key] = val;
  }
  return out;
}

export interface Config {
  appRoot: string;
  host: string;
  port: number;
  dataDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** LibreOffice (DOCX/ODT/RTF -> PDF preview); null = not installed. */
  soffice: string | null;
  maxFileBytes: number;
  webDist: string;
  /** ComfyUI base URL (COMFYUI_URL), no trailing slash. */
  comfyUrl: string;
  /** `local` (default, files under DATA_DIR) or `s3` (Cloudflare R2 / any S3 API; media bytes bypass this server). */
  storageDriver: 'local' | 's3';
  s3: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };
  /** Lifetime of presigned URLs in seconds (PRESIGN_TTL_S). */
  presignTtlS: number;
  /** APP_PASSWORD: non-empty turns the login on; empty = no auth (local default). */
  appPassword: string;
  /** TRUST_PROXY: true | hop count | comma separated proxy IPs/CIDRs (Fastify `trustProxy`). false = off. */
  trustProxy: boolean | number | string;
}

/** TRUST_PROXY text -> Fastify trustProxy value. */
export function parseTrustProxy(v: string | undefined): boolean | number | string {
  const t = (v ?? '').trim();
  if (!t || /^(0|false|no|off)$/i.test(t)) return false;
  if (/^(1|true|yes|on)$/i.test(t)) return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

/** Problems that make the configuration unusable (empty = ok). */
export function configProblems(cfg: Config): string[] {
  const out: string[] = [];
  if (cfg.storageDriver === 's3') {
    for (const [k, v] of [['S3_ENDPOINT', cfg.s3.endpoint], ['S3_BUCKET', cfg.s3.bucket], ['S3_ACCESS_KEY_ID', cfg.s3.accessKeyId], ['S3_SECRET_ACCESS_KEY', cfg.s3.secretAccessKey]]) {
      if (!v) out.push(`${k} is required when STORAGE_DRIVER=s3`);
    }
  }
  return out;
}

/** SOFFICE_PATH, else soffice on PATH, else the default LibreOffice install folders. null when not found. */
export function findSoffice(explicit?: string, pathEnv = process.env.PATH ?? '', exists: (p: string) => boolean = fs.existsSync): string | null {
  if (explicit) return exists(explicit) ? explicit : null;
  const names = process.platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice'];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir.replace(/^"|"$/g, ''), n);
      if (exists(p)) return p;
    }
  }
  for (const p of ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']) {
    if (exists(p)) return p;
  }
  return null;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const envFile = path.join(APP_ROOT, '.env');
  const fromFile = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};
  const get = (k: string) => process.env[k] ?? fromFile[k];
  const dataRaw = get('DATA_DIR');
  const maxGb = Number(get('MAX_FILE_GB') ?? 5);
  const cfg: Config = {
    appRoot: APP_ROOT,
    host: get('HOST') || '127.0.0.1',
    port: Number(get('PORT') ?? 5180),
    dataDir: dataRaw ? path.resolve(APP_ROOT, dataRaw) : path.join(APP_ROOT, 'data'),
    ffmpeg: get('FFMPEG_PATH') || 'ffmpeg',
    ffprobe: get('FFPROBE_PATH') || 'ffprobe',
    soffice: findSoffice(get('SOFFICE_PATH') || undefined),
    maxFileBytes: Math.floor((Number.isFinite(maxGb) && maxGb > 0 ? maxGb : 5) * 1024 ** 3),
    webDist: path.join(APP_ROOT, 'web', 'dist'),
    comfyUrl: (get('COMFYUI_URL') || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    storageDriver: (get('STORAGE_DRIVER') || 'local').trim().toLowerCase() === 's3' ? 's3' : 'local',
    s3: {
      endpoint: (get('S3_ENDPOINT') || '').trim().replace(/\/+$/, ''),
      bucket: (get('S3_BUCKET') || '').trim(),
      accessKeyId: (get('S3_ACCESS_KEY_ID') || '').trim(),
      secretAccessKey: (get('S3_SECRET_ACCESS_KEY') || '').trim(),
      region: (get('S3_REGION') || 'auto').trim(),
    },
    presignTtlS: Math.max(60, Math.min(604800, Number(get('PRESIGN_TTL_S')) || 3600)),
    appPassword: get('APP_PASSWORD') ?? '',
    trustProxy: parseTrustProxy(get('TRUST_PROXY')),
  };
  return { ...cfg, ...overrides };
}
