/**
 * URL helpers shared by the browser UI, the injected page runtime and the
 * server. Keeping one implementation of the proxy path format is important:
 * a mismatch silently breaks navigation.
 *
 * Proxy path format:
 *   /p/<session-token>/<scheme>/<host><pathname><search>
 *
 * Example:
 *   /p/9f2c.../https/example.com/docs/page?q=1
 *
 * The target host is kept verbatim (including an explicit port) so relative
 * links on the target site resolve exactly the way they would on the original
 * site: `/p/token/https/example.com/a/b` + `../c` = `/p/token/https/example.com/c`.
 */

export const PROXY_PREFIX = '/p/';
export const RUNTIME_PREFIX = '/__oa/';
export const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export type ProxyMode = 'isolated' | 'shared';

export interface DecodedProxyPath {
  token: string;
  url: URL;
}

const NAVIGABLE = new Set(['http:', 'https:']);

export function isNavigableUrl(url: URL): boolean {
  return NAVIGABLE.has(url.protocol);
}

/** Parse user input as an absolute HTTP(S) URL, or return null. */
export function parseAbsoluteUrl(input: string): URL | null {
  try {
    const url = new URL(input);
    if (!isNavigableUrl(url)) return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

/** Encode a target URL into a proxy path for the given session token. */
export function proxifyPath(token: string, target: URL): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new Error('Invalid session token');
  if (!isNavigableUrl(target)) throw new Error('Only http(s) URLs can be proxied');
  const scheme = target.protocol.slice(0, -1);
  return `${PROXY_PREFIX}${token}/${scheme}/${target.host}${target.pathname}${target.search}`;
}

/** Encode a target URL as an absolute proxy URL on `contentOrigin`. */
export function proxifyUrl(token: string, target: URL | string, contentOrigin = ''): string {
  const url = typeof target === 'string' ? new URL(target) : target;
  return `${contentOrigin.replace(/\/$/, '')}${proxifyPath(token, url)}`;
}

/**
 * Decode a proxy pathname. `pathname` may be the raw request path (percent
 * escapes intact) so that the reconstructed URL is byte-for-byte what the
 * browser will request upstream.
 */
export function decodeProxyPath(pathname: string): DecodedProxyPath | null {
  if (!pathname.startsWith(PROXY_PREFIX)) return null;
  const rest = pathname.slice(PROXY_PREFIX.length);
  const tokenEnd = rest.indexOf('/');
  if (tokenEnd <= 0) return null;
  const token = rest.slice(0, tokenEnd);
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;

  const afterToken = rest.slice(tokenEnd + 1);
  const schemeEnd = afterToken.indexOf('/');
  if (schemeEnd <= 0) return null;
  const scheme = afterToken.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;

  const hostAndPath = afterToken.slice(schemeEnd + 1);
  if (!hostAndPath) return null;
  const slash = hostAndPath.indexOf('/');
  const host = slash === -1 ? hostAndPath : hostAndPath.slice(0, slash);
  const restPath = slash === -1 ? '/' : hostAndPath.slice(slash);
  if (!host) return null;

  try {
    const url = new URL(`${scheme}://${host}${restPath}`);
    if (!isNavigableUrl(url)) return null;
    // URL parses `\` as `/` in special schemes; a host containing illegal
    // characters is rejected by the constructor above.
    return { token, url };
  } catch {
    return null;
  }
}

/** Extract the target URL from a proxy URL, or null if it is not one. */
export function targetFromProxyUrl(proxyUrl: string): URL | null {
  try {
    const parsed = new URL(proxyUrl, 'http://placeholder.invalid');
    return decodeProxyPath(parsed.pathname)?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Rewrite a URL reference found on a proxied page so that it stays inside the
 * proxy. Relative references are intentionally left alone: the injected
 * `<base>` element resolves them to the proxy automatically, which also keeps
 * runtime-generated relative URLs working.
 */
export function rewriteReference(
  raw: string,
  documentUrl: URL,
  token: string,
  contentOrigin = '',
): string {
  const value = raw.trim();
  if (!value) return raw;
  if (value.startsWith('#')) return raw;
  // Protocol-relative: inherit the document scheme.
  if (value.startsWith('//')) {
    try {
      return proxifyUrl(token, new URL(`${documentUrl.protocol}${value}`), contentOrigin);
    } catch {
      return raw;
    }
  }
  if (value.startsWith('/')) {
    try {
      return proxifyUrl(token, new URL(`${documentUrl.origin}${value}`), contentOrigin);
    } catch {
      return raw;
    }
  }
  // Absolute URL with an explicit scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    if (!/^https?:/i.test(value)) return raw;
    try {
      return proxifyUrl(token, new URL(value), contentOrigin);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Resolve a possibly-relative URL found in JavaScript or a Location header
 * against the document URL and convert it to a proxy URL.
 */
export function rewriteAbsolute(
  raw: string,
  documentUrl: URL,
  token: string,
  contentOrigin = '',
): string {
  try {
    const absolute = new URL(raw, documentUrl);
    if (!isNavigableUrl(absolute)) return raw;
    return proxifyUrl(token, absolute, contentOrigin);
  } catch {
    return raw;
  }
}

export interface SearchEngine {
  id: string;
  name: string;
  queryUrl: string; // %s placeholder
  homeUrl: string;
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', queryUrl: 'https://duckduckgo.com/?q=%s', homeUrl: 'https://duckduckgo.com/' },
  { id: 'brave', name: 'Brave Search', queryUrl: 'https://search.brave.com/search?q=%s', homeUrl: 'https://search.brave.com/' },
  { id: 'startpage', name: 'Startpage', queryUrl: 'https://www.startpage.com/sp/search?query=%s', homeUrl: 'https://www.startpage.com/' },
  { id: 'google', name: 'Google', queryUrl: 'https://www.google.com/search?q=%s', homeUrl: 'https://www.google.com/' },
  { id: 'bing', name: 'Bing', queryUrl: 'https://www.bing.com/search?q=%s', homeUrl: 'https://www.bing.com/' },
  { id: 'wikipedia', name: 'Wikipedia', queryUrl: 'https://en.wikipedia.org/w/index.php?search=%s', homeUrl: 'https://en.wikipedia.org/' },
];

export function searchUrl(engineId: string, query: string): string {
  const engine = SEARCH_ENGINES.find((e) => e.id === engineId) ?? SEARCH_ENGINES[0]!;
  return engine.queryUrl.replace('%s', encodeURIComponent(query));
}

const FILE_EXTENSIONS = new Set([
  'txt', 'html', 'htm', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'json', 'md',
  'js', 'mjs', 'css', 'zip', 'gz', 'tar', 'rar', '7z', 'mp3', 'mp4', 'mov', 'avi', 'webm', 'csv',
  'xml', 'yml', 'yaml', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'exe', 'dmg', 'apk', 'iso',
]);

/** Input that is clearly a hostname rather than a search phrase. */
function looksLikeHost(input: string): boolean {
  if (/\s/.test(input)) return false;
  const candidate = input.split(/[/?#]/, 1)[0]!;
  if (!candidate) return false;
  if (candidate === 'localhost') return true;
  if (/^\[[0-9a-fA-F:.]+\](:\d+)?$/.test(candidate)) return true; // [::1]:8080
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(candidate)) return true; // IPv4
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?$/.test(candidate)) {
    const hostPart = candidate.split(':')[0]!;
    const tld = hostPart.split('.').pop()!.toLowerCase();
    if (FILE_EXTENSIONS.has(tld)) return false;
    // A single-letter or purely numeric suffix is nearly always a file, not a host.
    return /^[a-zA-Z]{2,63}$/.test(tld);
  }
  return false;
}

/** Convert address-bar input into a navigable http(s) URL. */
export function addressBarToUrl(input: string, engineId: string): URL | null {
  const value = input.trim();
  if (!value) return null;

  const absolute = parseAbsoluteUrl(value);
  if (absolute) return absolute;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    // Non-HTTP scheme such as mailto: or javascript: — search for it instead.
    return new URL(searchUrl(engineId, value));
  }

  if (looksLikeHost(value)) {
    try {
      return new URL(`https://${value}`);
    } catch {
      /* fall through to search */
    }
  }

  return new URL(searchUrl(engineId, value));
}

/** Human-friendly URL for the address bar (drops the trailing slash on bare origins). */
export function displayUrl(url: URL | string): string {
  try {
    const parsed = typeof url === 'string' ? new URL(url) : url;
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return `${parsed.protocol}//${parsed.host}`;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return typeof url === 'string' ? url : url.href;
  }
}

/** Short label for a tab, based on the hostname. */
export function hostLabel(url: URL | string | null): string {
  if (!url) return 'New tab';
  const parsed = typeof url === 'string' ? parseAbsoluteUrl(url) : url;
  if (!parsed) return 'New tab';
  return parsed.hostname.replace(/^www\./, '');
}
