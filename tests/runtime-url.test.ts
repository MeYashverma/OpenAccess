import { describe, expect, it } from 'vitest';
import {
  endpointBase,
  isProxiedLocation,
  realLocation,
  toProxyUrl,
  toProxyWebSocketUrl,
  toRealUrl,
  type ProxyContext,
} from '../src/runtime/url-map.js';

const TOKEN = 'T'.repeat(32);
const ctx: ProxyContext = {
  token: TOKEN,
  contentOrigin: 'http://localhost:3000',
  targetOrigin: 'https://example.com',
};
const pageUrl = `http://localhost:3000/p/${TOKEN}/https/example.com/dir/page`;
const proxy = (scheme: string, host: string, path: string) =>
  `http://localhost:3000/p/${TOKEN}/${scheme}/${host}${path}`;

describe('runtime URL mapping', () => {
  it('keeps relative URLs inside proxy space', () => {
    expect(toProxyUrl('api/items', pageUrl, ctx)).toBe(proxy('https', 'example.com', '/dir/api/items'));
    expect(toProxyUrl('?x=1', pageUrl, ctx)).toBe(proxy('https', 'example.com', '/dir/page?x=1'));
    expect(toProxyUrl('/rooted', pageUrl, ctx)).toBe(proxy('https', 'example.com', '/rooted'));
  });

  it('routes absolute third-party URLs through the proxy', () => {
    expect(toProxyUrl('https://cdn.example.net/lib.js', pageUrl, ctx)).toBe(
      proxy('https', 'cdn.example.net', '/lib.js'),
    );
    expect(toProxyUrl('//cdn.example.net/lib.js', pageUrl, ctx)).toBe(
      proxy('https', 'cdn.example.net', '/lib.js'),
    );
    expect(toProxyUrl('http://plain.example.org/a?b=1', pageUrl, ctx)).toBe(
      proxy('http', 'plain.example.org', '/a?b=1'),
    );
  });

  it('does not double-proxy its own references', () => {
    const target = proxy('https', 'example.com', '/dir/image.png');
    expect(toProxyUrl(target, pageUrl, ctx)).toBe(target);
  });

  it('leaves non-navigable schemes alone', () => {
    expect(toProxyUrl('mailto:a@example.com', pageUrl, ctx)).toBe('mailto:a@example.com');
    expect(toProxyUrl('data:text/plain,hi', pageUrl, ctx)).toBe('data:text/plain,hi');
    expect(toProxyUrl('blob:http://x/y', pageUrl, ctx)).toBe('blob:http://x/y');
    expect(toProxyUrl('javascript:void(0)', pageUrl, ctx)).toBe('javascript:void(0)');
    expect(toProxyUrl('#section', pageUrl, ctx)).toBe('#section');
  });

  it('decodes proxy URLs back to real URLs', () => {
    expect(toRealUrl(proxy('https', 'example.com', '/a?b=1'), pageUrl, ctx)).toBe(
      'https://example.com/a?b=1',
    );
    expect(toRealUrl('https://example.com/x', pageUrl, ctx)).toBe('https://example.com/x');
    expect(toRealUrl('mailto:a@example.com', pageUrl, ctx)).toBeNull();
    expect(toRealUrl('#x', pageUrl, ctx)).toBe('https://example.com/dir/page#x');
  });

  it('reports the real location and proxied state', () => {
    expect(realLocation(proxy('https', 'example.com', '/a?b=1#h'), ctx)).toBe(
      'https://example.com/a?b=1#h',
    );
    expect(realLocation('https://example.com/', ctx)).toBe('https://example.com/');
    expect(isProxiedLocation(pageUrl, ctx)).toBe(true);
    expect(isProxiedLocation('https://example.com/', ctx)).toBe(false);
  });

  it('builds relay WebSocket URLs', () => {
    expect(toProxyWebSocketUrl('wss://chat.example/socket?x=1', pageUrl, ctx)).toBe(
      `ws://localhost:3000/p/${TOKEN}/__oa/ws?url=${encodeURIComponent('wss://chat.example/socket?x=1')}`,
    );
    expect(toProxyWebSocketUrl('ws://localhost:9999/x', pageUrl, ctx)).toContain(
      `url=${encodeURIComponent('ws://localhost:9999/x')}`,
    );
  });

  it('builds the runtime endpoint base', () => {
    expect(endpointBase(ctx)).toBe(`http://localhost:3000/p/${TOKEN}/__oa`);
  });
});
