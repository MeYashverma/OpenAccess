import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config.js';
import { assertSafeUrlShape, isBlockedIp, TargetError } from '../src/server/ssrf.js';

describe('IP classification', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::c0a8:1',
    '2002:c0a8:0101::',
    '2001:db8::1',
    'ff02::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '8.8.8.8'])(
    'allows public address %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('URL shape validation', () => {
  const config = loadConfig({});
  const expectCode = (url: string, code: string, selfHosts: Set<string> = new Set()) => {
    try {
      assertSafeUrlShape(new URL(url), config, selfHosts);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(TargetError);
      expect((error as TargetError).code).toBe(code);
    }
  };

  it('accepts ordinary web URLs', () => {
    assertSafeUrlShape(new URL('https://example.com/a?b=1'), config);
    assertSafeUrlShape(new URL('http://example.com:8080/'), config);
  });

  it('blocks schemes, credentials and unsafe ports', () => {
    expectCode('file:///etc/passwd', 'blocked-scheme');
    expectCode('ftp://example.com/', 'blocked-scheme');
    expectCode('https://user:pass@example.com/', 'blocked-credentials');
    expectCode('http://example.com:22/', 'blocked-port');
    expectCode('http://example.com:6379/', 'blocked-port');
  });

  it('blocks private hostnames and literals', () => {
    expectCode('http://localhost/', 'blocked-host');
    expectCode('http://printer.local/', 'blocked-host');
    expectCode('http://metadata.google.internal/', 'blocked-host');
    expectCode('http://127.0.0.1:3000/', 'blocked-address');
    expectCode('http://[::1]:3000/', 'blocked-address');
    expectCode('http://169.254.169.254/latest/meta-data/', 'blocked-address');
  });

  it('blocks the proxy itself and configured hosts', () => {
    expectCode('https://p.example.com/x', 'blocked-host', new Set(['p.example.com:443']));
    const blocked = loadConfig({ BLOCKED_HOSTS: 'bad.example', BLOCKED_HOST_SUFFIXES: '.onion' });
    try {
      assertSafeUrlShape(new URL('https://bad.example/x'), blocked);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as TargetError).code).toBe('blocked-host');
    }
    try {
      assertSafeUrlShape(new URL('https://foo.onion/x'), blocked);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as TargetError).code).toBe('blocked-host');
    }
  });

  it('honours an explicit port allowlist', () => {
    const restricted = loadConfig({ ALLOWED_UPSTREAM_PORTS: '443' });
    expect(() => assertSafeUrlShape(new URL('https://example.com/x'), restricted)).not.toThrow();
    try {
      assertSafeUrlShape(new URL('https://example.com:8080/x'), restricted);
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as TargetError).code).toBe('blocked-port');
    }
  });
});
