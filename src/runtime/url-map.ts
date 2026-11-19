import {
  SESSION_TOKEN_PATTERN,
  proxifyPath,
  decodeProxyPath,
} from '../shared/url.js';

export interface ProxyContext {
  token: string;
  /** e.g. https://p.example.com (or the UI origin in single-origin mode) */
  contentOrigin: string;
  /** Origin of the site being browsed, e.g. https://example.com */
  targetOrigin: string;
}

const NON_HTTP_SCHEME = /^(data|blob|javascript|mailto|tel|sms|about|file|chrome|moz-extension|chrome-extension):/i;

function proxiedTargetFromUrl(value: URL, ctx: ProxyContext): URL | null {
  if (value.origin !== new URL(ctx.contentOrigin).origin) return null;
  if (!value.pathname.startsWith('/p/')) return null;
  const decoded = decodeProxyPath(value.pathname);
  if (!decoded) return null;
  const target = decoded.url;
  target.search = value.search;
  target.hash = value.hash;
  return target;
}

/** Convert any page-visible URL into a URL that goes through the proxy. */
export function toProxyUrl(raw: string, base: string, ctx: ProxyContext): string {
  const value = String(raw ?? '').trim();
  if (!value) return raw;
  if (value.startsWith('#')) return raw;
  if (NON_HTTP_SCHEME.test(value)) return raw;

  let absolute: URL;
  try {
    // Root-relative and protocol-relative references belong to the destination
    // site, not to the proxy origin that hosts the document.
    if (value.startsWith('//')) {
      absolute = new URL(`${new URL(ctx.targetOrigin).protocol}${value}`);
    } else if (value.startsWith('/')) {
      absolute = new URL(value, ctx.targetOrigin);
    } else {
      absolute = new URL(value, base || ctx.targetOrigin);
    }
  } catch {
    return raw;
  }

  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return raw;

  const alreadyProxied = proxiedTargetFromUrl(absolute, ctx);
  if (alreadyProxied && absolute.pathname.startsWith(`/p/${ctx.token}/`)) {
    return absolute.href;
  }

  const target = alreadyProxied ?? absolute;
  const proxyRoot = ctx.contentOrigin.replace(/\/$/, '');
  try {
    return `${proxyRoot}${proxifyPath(ctx.token, target)}`;
  } catch {
    return raw;
  }
}

/** Convert any page-visible URL back to the real destination URL. */
export function toRealUrl(raw: string, base: string, ctx: ProxyContext): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (NON_HTTP_SCHEME.test(value)) return value.startsWith('blob:') ? value : null;
  try {
    const absolute = new URL(value, base || ctx.targetOrigin);
    const decoded = proxiedTargetFromUrl(absolute, ctx);
    if (decoded) return decoded.href;
    if (absolute.protocol === 'http:' || absolute.protocol === 'https:') return absolute.href;
    return null;
  } catch {
    return null;
  }
}

/** Build the relay WebSocket URL for a page-supplied WebSocket endpoint. */
export function toProxyWebSocketUrl(raw: string, base: string, ctx: ProxyContext): string {
  let target: URL;
  try {
    target = new URL(String(raw), base.replace(/^ws/, 'http'));
  } catch {
    return raw;
  }
  if (target.protocol === 'http:') target.protocol = 'ws:';
  else if (target.protocol === 'https:') target.protocol = 'wss:';
  if (target.protocol !== 'ws:' && target.protocol !== 'wss:') return raw;

  const content = new URL(ctx.contentOrigin);
  const scheme = content.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${content.host}/p/${ctx.token}/__oa/ws?url=${encodeURIComponent(target.href)}`;
}

/** True when the current document is being served through the proxy. */
export function isProxiedLocation(href: string, ctx: ProxyContext): boolean {
  try {
    const url = new URL(href);
    return proxiedTargetFromUrl(url, ctx) !== null && url.pathname.startsWith(`/p/${ctx.token}/`);
  } catch {
    return false;
  }
}

/** Real URL of the current document (falls back to location.href). */
export function realLocation(href: string, ctx: ProxyContext): string {
  try {
    const url = new URL(href);
    const target = proxiedTargetFromUrl(url, ctx);
    if (target) return target.href;
    return href;
  } catch {
    return href;
  }
}

/** Extract the proxied endpoint base for the runtime's own endpoints. */
export function endpointBase(ctx: ProxyContext): string {
  return `${ctx.contentOrigin.replace(/\/$/, '')}/p/${ctx.token}/__oa`;
}

export function isValidToken(token: string): boolean {
  return SESSION_TOKEN_PATTERN.test(token);
}
