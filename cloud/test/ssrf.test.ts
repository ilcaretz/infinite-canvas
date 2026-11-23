import { describe, expect, it } from 'vitest';
import { checkUrlSyntax, isPrivateHost } from '../src/ssrf';

describe('isPrivateHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.5.5', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', 'localhost', 'a.localhost', '::1', '[::1]', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::1', 'intranet', 'printer.local', 'db.internal', '2130706433', '0x7f000001', '999.1.1.1'])(
    'blocks %s',
    (h) => expect(isPrivateHost(h)).toBe(true),
  );
  it.each(['example.com', '8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', 'cdn.example.co.uk'])('allows %s', (h) => expect(isPrivateHost(h)).toBe(false));
});

describe('checkUrlSyntax', () => {
  it('only public http(s) without credentials', () => {
    expect(checkUrlSyntax('https://example.com/a.png').hostname).toBe('example.com');
    for (const u of ['file:///etc/passwd', 'http://127.0.0.1:8188/', 'http://u:p@example.com/', 'javascript:alert(1)', '']) expect(() => checkUrlSyntax(u)).toThrow();
  });
});
