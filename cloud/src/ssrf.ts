/** SSRF guard for drop-from-URL. Workers cannot resolve DNS themselves, so this is syntactic: IP literals + well known local names. */

export class BlockedUrlError extends Error {}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c <= 2) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
  );
}

/** Parse an IPv6 literal (no brackets) to 8 hextets; null when not valid. */
function parseV6(ip: string): number[] | null {
  let s = ip.split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const m = V4.exec(v4[1]);
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map(Number);
    s = s.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const parts = [...head, ...Array(fill).fill('0'), ...tail];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

/** True when `host` is an IP literal (or name) that is loopback, private, link-local, CGNAT, multicast, reserved or a local name. */
export function isPrivateHost(hostRaw: string): boolean {
  const host = hostRaw.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  const v4 = V4.exec(host);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    return [a, b, c, d].some((n) => n > 255) || privateV4(a, b, c);
  }
  if (host.includes(':')) {
    const h = parseV6(host);
    if (!h) return true;
    if (h.slice(0, 5).every((x) => x === 0)) {
      if (h[5] === 0xffff) return privateV4(h[6] >> 8, h[6] & 255, h[7] >> 8); // IPv4-mapped
      if (h[5] === 0) return true; // ::, ::1 and the deprecated IPv4-compatible form
    }
    const f = h[0];
    return (
      (f & 0xfe00) === 0xfc00 || (f & 0xffc0) === 0xfe80 || (f & 0xff00) === 0xff00 || // ULA, link-local, multicast
      (f === 0x64 && h[1] === 0xff9b) || f === 0x2002 || (f === 0x2001 && (h[1] === 0 || h[1] === 0xdb8)) || (f === 0x100 && h[1] === 0 && h[2] === 0 && h[3] === 0)
    );
  }
  // numeric-looking hosts such as 2130706433, 0x7f.1, 017700000001: browsers/curl read them as IPs, refuse them all
  if (/^[0-9x.]+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  if (!host.includes('.')) return true; // single-label intranet names
  return false;
}

/** Syntactic checks. Throws BlockedUrlError. */
export function checkUrlSyntax(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('only http and https URLs are allowed');
  if (u.username || u.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  if (isPrivateHost(u.hostname)) throw new BlockedUrlError('address is private or local');
  return u;
}
