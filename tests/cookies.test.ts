import { describe, expect, it } from 'vitest';
import { CookieJar, domainMatches, parseSetCookie, pathMatches } from '../src/server/cookies.js';

const site = new URL('https://app.example.com/dir/page');

describe('Set-Cookie parsing', () => {
  it('parses attributes and defaults', () => {
    const parsed = parseSetCookie('sid=abc; Path=/app; Domain=example.com; Secure; HttpOnly; SameSite=Lax; Max-Age=3600', site);
    expect(parsed).toMatchObject({
      name: 'sid',
      value: 'abc',
      domain: 'example.com',
      hostOnly: false,
      path: '/app',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(parsed!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('defaults to a host-only cookie at the directory path', () => {
    const parsed = parseSetCookie('x=1', site);
    expect(parsed).toMatchObject({ domain: 'app.example.com', hostOnly: true, path: '/dir' });
    expect(parseSetCookie('bad', site)).toBeNull();
    expect(parseSetCookie('=value', site)).toBeNull();
  });

  it('rejects foreign domains and expired cookies', () => {
    expect(parseSetCookie('x=1; Domain=evil.example.net', site)?.domain).toBe('app.example.com');
    const expired = parseSetCookie('x=1; Max-Age=0', site);
    expect(expired?.expiresAt).toBe(0);
  });
});

describe('matching rules', () => {
  it('matches subdomains and paths correctly', () => {
    expect(domainMatches('a.example.com', 'example.com')).toBe(true);
    expect(domainMatches('notexample.com', 'example.com')).toBe(false);
    expect(pathMatches('/dir/page', '/dir')).toBe(true);
    expect(pathMatches('/dir/page', '/dir/')).toBe(true);
    expect(pathMatches('/directory', '/dir')).toBe(false);
  });
});

describe('CookieJar', () => {
  it('stores, scopes and sends cookies', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie('a=1; Path=/', site);
    jar.setFromSetCookie('b=2; Path=/dir; HttpOnly', site);
    jar.setFromSetCookie('c=3; Path=/; Secure', new URL('https://site.example/x'));

    expect(jar.headerFor(site)).toBe('b=2; a=1');
    expect(jar.headerFor(new URL('https://other.example/x'))).toBeNull();
    expect(jar.headerFor(new URL('http://app.example.com/x'))).toBe('a=1');
    expect(jar.documentCookieFor(site)).toBe('a=1');
  });

  it('replaces and deletes cookies', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie('a=1; Path=/', site);
    jar.setFromSetCookie('a=2; Path=/', site);
    expect(jar.headerFor(site)).toBe('a=2');
    expect(jar.size).toBe(1);
    jar.setFromSetCookie('a=deleted; Path=/; Max-Age=0', site);
    expect(jar.headerFor(site)).toBeNull();
  });

  it('applies document.cookie assignments and respects deletion', () => {
    const jar = new CookieJar();
    jar.setFromDocument('a=1', site);
    expect(jar.documentCookieFor(site)).toBe('a=1');
    jar.setFromDocument('a=; Max-Age=0', site);
    expect(jar.headerFor(site)).toBeNull();
    jar.setFromDocument('b=2; Path=/', site);
    expect(jar.headerFor(new URL('https://app.example.com/other'))).toBe('b=2');
  });

  it('isolates cookies between independent jars', () => {
    const jarA = new CookieJar();
    const jarB = new CookieJar();
    jarA.setFromSetCookie('session=one; Path=/', site);
    expect(jarB.headerFor(site)).toBeNull();
    jarA.clearDomain('app.example.com');
    expect(jarA.headerFor(site)).toBeNull();
  });

  it('caps oversized cookies', () => {
    const jar = new CookieJar();
    jar.setFromSetCookie(`big=${'x'.repeat(5000)}`, site);
    expect(jar.headerFor(site)).toBeNull();
  });
});
