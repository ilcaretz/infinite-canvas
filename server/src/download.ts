import http from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import { BlockedUrlError, checkUrlSyntax, guardedLookup } from './ssrf.js';

export interface Opened {
  stream: Readable;
  filename: string;
  contentType: string;
  length: number | null;
  finalUrl: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/tiff': 'tif', 'image/heic': 'heic', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-matroska': 'mkv', 'video/mpeg': 'mpg',
};

function filenameFrom(url: URL, contentType: string, disposition: string | undefined): string {
  let name = '';
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition);
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition);
    try {
      name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : '';
    } catch {
      name = plain ? plain[1] : '';
    }
  }
  if (!name) {
    const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
  }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 180) || 'download';
  if (!/\.[A-Za-z0-9]{1,6}$/.test(name)) {
    const ext = EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()];
    if (ext) name += `.${ext}`;
  }
  return name;
}

/**
 * Open `rawUrl` for streaming. http/https only; every hop (incl. each redirect) is validated and the connection itself
 * goes through guardedLookup, so private/loopback/link-local targets are refused even after DNS resolution.
 */
export async function openUrl(rawUrl: string, maxBytes: number, maxRedirects = 5): Promise<Opened> {
  let url = checkUrlSyntax(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(
        url,
        {
          method: 'GET', lookup: guardedLookup, timeout: 30000,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; BoardLocal/0.2)', accept: '*/*', 'accept-encoding': 'identity' },
        },
        resolve,
      );
      req.on('timeout', () => req.destroy(new Error('connection timed out')));
      req.on('error', reject);
      req.end();
    });
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      url = checkUrlSyntax(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`server answered HTTP ${status}`);
    }
    const length = res.headers['content-length'] ? Number(res.headers['content-length']) : null;
    if (length !== null && length > maxBytes) {
      res.destroy();
      throw new Error('file is larger than the size limit');
    }
    const contentType = String(res.headers['content-type'] ?? '');
    if (/^text\/html/i.test(contentType)) {
      res.destroy();
      throw new Error('the link points to a web page, not a file');
    }
    return {
      stream: res, length, contentType, finalUrl: url.toString(),
      filename: filenameFrom(url, contentType, res.headers['content-disposition']),
    };
  }
  throw new BlockedUrlError('too many redirects');
}
