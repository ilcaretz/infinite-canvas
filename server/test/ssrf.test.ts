import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openUrl } from '../src/download.js';
import { BlockedUrlError, checkUrlSyntax, isPrivateAddress } from '../src/ssrf.js';

describe('SSRF guard', () => {
  it('rejects private, loopback, link-local and reserved addresses', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
  it('only http/https URLs, no credentials, no private IP literals', () => {
    expect(() => checkUrlSyntax('file:///etc/passwd')).toThrow(BlockedUrlError);
    expect(() => checkUrlSyntax('ftp://example.com/a.png')).toThrow(BlockedUrlError);
    expect(() => checkUrlSyntax('http://user:pw@example.com/')).toThrow(BlockedUrlError);
    expect(() => checkUrlSyntax('http://127.0.0.1:5180/api/boards')).toThrow(BlockedUrlError);
    expect(() => checkUrlSyntax('http://[::1]/')).toThrow(BlockedUrlError);
    expect(() => checkUrlSyntax('http://2130706433/')).toThrow(BlockedUrlError); // decimal form of 127.0.0.1
    expect(() => checkUrlSyntax('https://example.com/a.png')).not.toThrow();
  });
});

describe('openUrl against a local server (must refuse, also via redirect and DNS name)', () => {
  let srv: http.Server;
  let port = 0;
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' }).end();
      } else res.writeHead(200, { 'content-type': 'image/png' }).end('x');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as { port: number }).port;
  });
  afterAll(() => srv.close());

  it('refuses a loopback IP literal', async () => {
    await expect(openUrl(`http://127.0.0.1:${port}/x.png`, 1e6)).rejects.toThrow(BlockedUrlError);
  });
  it('refuses "localhost" after DNS resolution', async () => {
    await expect(openUrl(`http://localhost:${port}/x.png`, 1e6)).rejects.toThrow(/private|local/i);
  });
  it('refuses a redirect to a link-local address', async () => {
    await expect(openUrl(`http://localhost:${port}/redir`, 1e6)).rejects.toThrow();
  });
});
