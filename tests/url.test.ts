import { describe, expect, it } from 'vitest';
import {
  addressBarToUrl,
  decodeProxyPath,
  displayUrl,
  hostLabel,
  proxifyPath,
  proxifyUrl,
  rewriteReference,
  searchUrl,
  targetFromProxyUrl,
} from '../src/shared/url.js';

const TOKEN = 'A'.repeat(32);

describe('proxy path codec', () => {
  it('round-trips a URL with query, port and path', () => {
    const target = new URL('https://example.com:8443/docs/page?q=hello%20world&x=1#frag');
    const path = proxifyPath(TOKEN, target);
    expect(path).toBe(`/p/${TOKEN}/https/example.com:8443/docs/page?q=hello%20world&x=1`);
    const decoded = decodeProxyPath(path);
    expect(decoded?.token).toBe(TOKEN);
    expect(decoded?.url.href).toBe('https://example.com:8443/docs/page?q=hello%20world&x=1');
  });

  it('preserves percent-encoded and unicode paths', () => {
    const target = new URL('https://example.com/caf%C3%A9/%E2%9C%93?q=%2F');
    const decoded = decodeProxyPath(proxifyPath(TOKEN, target));
    expect(decoded?.url.pathname).toBe('/caf%C3%A9/%E2%9C%93');
    expect(decoded?.url.search).toBe('?q=%2F');
  });

  it('rejects malformed paths', () => {
    expect(decodeProxyPath('/p/')).toBeNull();
    expect(decodeProxyPath('/p/short/https/example.com/')).toBeNull();
    expect(decodeProxyPath(`/p/${TOKEN}/ftp/example.com/`)).toBeNull();
    expect(decodeProxyPath(`/p/${TOKEN}/https/`)).toBeNull();
    expect(decodeProxyPath(`/p/${TOKEN}/https/example.com`)).not.toBeNull();
    expect(decodeProxyPath(`/something/${TOKEN}/https/example.com/`)).toBeNull();
    expect(targetFromProxyUrl('https://p.example.com/x')).toBeNull();
  });

  it('builds absolute proxy URLs', () => {
    expect(proxifyUrl(TOKEN, 'https://example.com/a', 'https://p.example.com')).toBe(
      `https://p.example.com/p/${TOKEN}/https/example.com/a`,
    );
    expect(proxifyUrl(TOKEN, 'https://example.com/a', 'https://p.example.com/')).toBe(
      `https://p.example.com/p/${TOKEN}/https/example.com/a`,
    );
  });
});

describe('reference rewriting', () => {
  const doc = new URL('https://example.com/dir/page.html');
  const origin = 'https://p.example.com';

  it('leaves relative and hash references alone', () => {
    expect(rewriteReference('other.html', doc, TOKEN, origin)).toBe('other.html');
    expect(rewriteReference('../up.html', doc, TOKEN, origin)).toBe('../up.html');
    expect(rewriteReference('#section', doc, TOKEN, origin)).toBe('#section');
  });

  it('rewrites root-relative, protocol-relative and absolute URLs', () => {
    expect(rewriteReference('/img.png', doc, TOKEN, origin)).toBe(
      `https://p.example.com/p/${TOKEN}/https/example.com/img.png`,
    );
    expect(rewriteReference('//cdn.example.net/lib.js', doc, TOKEN, origin)).toBe(
      `https://p.example.com/p/${TOKEN}/https/cdn.example.net/lib.js`,
    );
    expect(rewriteReference('http://plain.example.org/x', doc, TOKEN, origin)).toBe(
      `https://p.example.com/p/${TOKEN}/http/plain.example.org/x`,
    );
  });

  it('leaves non-http schemes and data URLs untouched', () => {
    expect(rewriteReference('mailto:a@example.com', doc, TOKEN, origin)).toBe('mailto:a@example.com');
    expect(rewriteReference('javascript:void(0)', doc, TOKEN, origin)).toBe('javascript:void(0)');
    expect(rewriteReference('data:image/png;base64,AAAA', doc, TOKEN, origin)).toBe(
      'data:image/png;base64,AAAA',
    );
  });
});

describe('address bar', () => {
  it('detects URLs', () => {
    expect(addressBarToUrl('example.com', 'duckduckgo')?.href).toBe('https://example.com/');
    expect(addressBarToUrl('example.com/path?q=1', 'duckduckgo')?.href).toBe('https://example.com/path?q=1');
    expect(addressBarToUrl('http://localhost:8080/x', 'duckduckgo')?.href).toBe('http://localhost:8080/x');
    expect(addressBarToUrl('192.168.1.1', 'duckduckgo')?.href).toBe('https://192.168.1.1/');
  });

  it('falls back to search for phrases', () => {
    const url = addressBarToUrl('how to read a book', 'duckduckgo');
    expect(url?.origin).toBe('https://duckduckgo.com');
    expect(url?.searchParams.get('q')).toBe('how to read a book');
    expect(searchUrl('brave', 'a b')).toContain('q=a%20b');
  });

  it('does not treat files or bare words as hosts', () => {
    expect(addressBarToUrl('notes.txt', 'duckduckgo')?.origin).toBe('https://duckduckgo.com');
    expect(addressBarToUrl('hello', 'duckduckgo')?.origin).toBe('https://duckduckgo.com');
  });

  it('treats javascript: input as a search phrase', () => {
    const url = addressBarToUrl('javascript:alert(1)', 'duckduckgo');
    expect(url?.origin).toBe('https://duckduckgo.com');
  });
});

describe('display helpers', () => {
  it('formats URLs for the omnibox', () => {
    expect(displayUrl('https://example.com/')).toBe('https://example.com');
    expect(displayUrl('https://example.com/path/')).toBe('https://example.com/path/');
    expect(hostLabel('https://www.example.com/a')).toBe('example.com');
    expect(hostLabel(null)).toBe('New tab');
  });
});
