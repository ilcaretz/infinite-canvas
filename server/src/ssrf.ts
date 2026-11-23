import dns from 'node:dns';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(addr, bits, 'ipv4');
for (const [addr, bits] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16],
  ['2001::', 32], ['2001:db8::', 32], ['100::', 64],
] as const) blocked.addSubnet(addr, bits, 'ipv6');

/** Extract the IPv4 address from an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:aabb:ccdd), else null. */
function mappedV4(ip: string): string | null {
  const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/i.exec(ip) ?? /^::ffff:(.+)$/i.exec(ip);
  if (!m) return null;
  const rest = m[1];
  if (net.isIPv4(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True when `ip` is loopback, private, link-local, CGNAT, multicast, reserved or otherwise not a public unicast address. */
export function isPrivateAddress(ipRaw: string): boolean {
  const ip = ipRaw.replace(/^\[|\]$/g, '').split('%')[0];
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (net.isIPv6(ip)) {
    const v4 = mappedV4(ip);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export class BlockedUrlError extends Error {}

/** Syntactic checks that need no DNS. Throws BlockedUrlError. */
export function checkUrlSyntax(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BlockedUrlError('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError('only http and https URLs are allowed');
  if (u.username || u.password) throw new BlockedUrlError('URLs with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) throw new BlockedUrlError('address is private or local');
  return u;
}

/** dns.lookup replacement for http(s).request: resolves, then refuses private results (checked at connect time, so DNS rebinding cannot swap it). */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return (callback as (e: Error | null, a?: unknown, f?: number) => void)(err);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (!list.length || bad) {
      return (callback as (e: Error | null) => void)(new BlockedUrlError(`address is private or local (${bad?.address ?? 'none'})`));
    }
    if (options.all) (callback as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    else (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};
