import { AwsClient } from 'aws4fetch';
import type { Env } from './env';
import { presignTtl } from './env';

export class S3Error extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export const isNoSuchUpload = (e: unknown) => e instanceof S3Error && e.code === 'NoSuchUpload';

export interface UrlOpts { mime?: string; disposition?: string; cache?: string }
export interface DonePart { partNumber: number; size: number; etag: string }

const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/');
const xmlText = (xml: string, tag: string) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? '';
const unxml = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#34;/g, '"');

/** Presigning + the few S3 API calls the BUCKET binding cannot do for uploads created by presigned multipart (aws4fetch only). */
export class S3 {
  private aws: AwsClient;
  readonly ttl: number;
  private fetchFn: typeof fetch;
  private cache = new Map<string, { url: string; until: number }>();

  constructor(private env: Env, private now: () => number = Date.now) {
    this.aws = new AwsClient({
      accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, service: 's3', region: env.S3_REGION || 'auto',
    });
    this.ttl = presignTtl(env);
    this.fetchFn = env.TEST_FETCH ?? ((i, init) => fetch(i, init));
  }

  private base(key: string) {
    return `${this.env.S3_ENDPOINT.replace(/\/+$/, '')}/${this.env.S3_BUCKET}/${encodeKey(key)}`;
  }

  private async presign(method: string, key: string, params: Record<string, string | undefined>, ttl = this.ttl): Promise<string> {
    const u = new URL(this.base(key));
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set('X-Amz-Expires', String(ttl));
    const signed = await this.aws.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }

  /** Presigned GET, cached per key+headers for ~50 min (browsers' HTTP cache keeps working). */
  async url(key: string, o: UrlOpts = {}): Promise<string> {
    const ck = `${key}\n${o.mime ?? ''}\n${o.disposition ?? ''}\n${o.cache ?? ''}`;
    const t = this.now();
    const hit = this.cache.get(ck);
    if (hit && hit.until > t) return hit.url;
    const url = await this.presign('GET', key, {
      'response-content-type': o.mime, 'response-content-disposition': o.disposition, 'response-cache-control': o.cache,
    });
    this.cache.set(ck, { url, until: t + Math.min(50 * 60_000, this.ttl * 1000 * 0.83) });
    if (this.cache.size > 3000) for (const [k, v] of this.cache) if (v.until <= t) this.cache.delete(k);
    return url;
  }

  presignPut(key: string, ttl = this.ttl) {
    return this.presign('PUT', key, {}, ttl);
  }
  presignPart(key: string, uploadId: string, partNumber: number) {
    return this.presign('PUT', key, { partNumber: String(partNumber), uploadId });
  }

  private async call(method: string, key: string, params: Record<string, string>, body?: string): Promise<string> {
    const u = new URL(this.base(key));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    const signed = await this.aws.sign(u.toString(), { method, body, headers: body ? { 'content-type': 'application/xml' } : undefined });
    const res = await this.fetchFn(signed);
    const text = await res.text();
    if (!res.ok || /<Error>/.test(text)) {
      throw new S3Error(res.status, xmlText(text, 'Code') || `HTTP${res.status}`, xmlText(text, 'Message') || `S3 answered HTTP ${res.status}`);
    }
    return text;
  }

  async createMultipart(key: string): Promise<string> {
    const id = xmlText(await this.call('POST', key, { uploads: '' }), 'UploadId');
    if (!id) throw new Error('no UploadId returned');
    return id;
  }

  async listParts(key: string, uploadId: string): Promise<DonePart[]> {
    const out: DonePart[] = [];
    let marker = '';
    for (let page = 0; page < 20; page++) {
      const xml = await this.call('GET', key, { uploadId, 'max-parts': '1000', ...(marker ? { 'part-number-marker': marker } : {}) });
      for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
        out.push({ partNumber: Number(xmlText(m[1], 'PartNumber')), size: Number(xmlText(m[1], 'Size')), etag: unxml(xmlText(m[1], 'ETag')) });
      }
      if (xmlText(xml, 'IsTruncated') !== 'true') break;
      marker = xmlText(xml, 'NextPartNumberMarker');
      if (!marker) break;
    }
    return out;
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>): Promise<void> {
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const xml = `<CompleteMultipartUpload>${sorted.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${esc(p.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    await this.call('POST', key, { uploadId }, xml);
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    await this.call('DELETE', key, { uploadId });
  }
}

let shared: { sig: string; s3: S3 } | null = null;
/** One S3 helper per isolate (keeps the presign cache across requests). */
export function getS3(env: Env): S3 {
  if (env.TEST_FETCH) return new S3(env);
  const sig = `${env.S3_ENDPOINT}|${env.S3_BUCKET}|${env.S3_ACCESS_KEY_ID}|${env.PRESIGN_TTL_S}`;
  if (!shared || shared.sig !== sig) shared = { sig, s3: new S3(env) };
  return shared.s3;
}
