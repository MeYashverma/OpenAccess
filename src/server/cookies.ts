/**
 * A small RFC 6265 cookie jar.
 *
 * Origin cookies never reach the user's browser: `Set-Cookie` headers from
 * upstream responses are stored here, and a `Cookie` header is synthesized for
 * each outbound request. This is what makes logins work through the proxy
 * without exposing credentials to page scripts, and it keeps upstream cookies
 * on the proxy origin instead of the OpenAccess UI origin.
 */

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  /** Epoch ms; Infinity for session cookies. */
  expiresAt: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | null;
  createdAt: number;
}

export interface ParsedSetCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expiresAt: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | null;
}

const MAX_COOKIE_BYTES = 4096;
const MAX_COOKIES_PER_DOMAIN = 300;
const MAX_COOKIES_TOTAL = 3000;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function isIpAddress(host: string): boolean {
  return /^\[?[0-9a-fA-F:.]+\]?$/.test(host) && (host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host));
}

export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\./, '').replace(/\.$/, '');
}

export function domainMatches(host: string, domain: string): boolean {
  if (host === domain) return true;
  return !isIpAddress(host) && host.endsWith(`.${domain}`);
}

export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return pathname.slice(0, lastSlash);
}

/** Parse a single Set-Cookie header value. Returns null for malformed cookies. */
export function parseSetCookie(header: string, requestUrl: URL): ParsedSetCookie | null {
  const segments = header.split(';');
  const pair = segments.shift();
  if (!pair) return null;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  let value = pair.slice(eq + 1).trim();
  if (!COOKIE_NAME.test(name)) return null;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (Buffer.byteLength(`${name}=${value}`) > MAX_COOKIE_BYTES) return null;

  const requestHost = canonicalHost(requestUrl.hostname);
  let domain: string | undefined;
  let path: string | undefined;
  let expiresAt = Infinity;
  let maxAge: number | null = null;
  let secure = false;
  let httpOnly = false;
  let sameSite: StoredCookie['sameSite'] = null;

  for (const segment of segments) {
    const index = segment.indexOf('=');
    const key = (index === -1 ? segment : segment.slice(0, index)).trim().toLowerCase();
    const raw = index === -1 ? '' : segment.slice(index + 1).trim();

    switch (key) {
      case 'domain': {
        if (!raw) break;
        const candidate = canonicalHost(raw);
        if (!candidate) break;
        if (!domainMatches(requestHost, candidate)) break; // reject foreign domains
        domain = candidate;
        break;
      }
      case 'path':
        if (raw.startsWith('/')) path = raw;
        break;
      case 'expires': {
        const time = Date.parse(raw);
        if (!Number.isNaN(time)) expiresAt = time;
        break;
      }
      case 'max-age': {
        if (/^-?\d+$/.test(raw)) maxAge = Number(raw);
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        const normal = raw.toLowerCase();
        if (normal === 'strict') sameSite = 'Strict';
        else if (normal === 'lax') sameSite = 'Lax';
        else if (normal === 'none') sameSite = 'None';
        break;
      }
      default:
        break;
    }
  }

  if (maxAge !== null) expiresAt = maxAge <= 0 ? 0 : Date.now() + maxAge * 1000;

  return {
    name,
    value,
    domain: domain ?? requestHost,
    hostOnly: domain === undefined,
    path: path ?? defaultPath(requestUrl.pathname),
    expiresAt,
    secure,
    httpOnly,
    sameSite,
  };
}

export class CookieJar {
  private cookies: StoredCookie[] = [];

  private purge(now = Date.now()): void {
    this.cookies = this.cookies.filter((cookie) => cookie.expiresAt > now);
  }

  setFromSetCookie(header: string, requestUrl: URL): void {
    const parsed = parseSetCookie(header, requestUrl);
    if (!parsed) return;
    this.purge();

    const existingIndex = this.cookies.findIndex(
      (cookie) =>
        cookie.name === parsed.name &&
        cookie.domain === parsed.domain &&
        cookie.path === parsed.path,
    );

    if (parsed.expiresAt <= Date.now()) {
      if (existingIndex !== -1) this.cookies.splice(existingIndex, 1);
      return;
    }

    const cookie: StoredCookie = {
      name: parsed.name,
      value: parsed.value,
      domain: parsed.domain,
      hostOnly: parsed.hostOnly,
      path: parsed.path,
      expiresAt: parsed.expiresAt,
      secure: parsed.secure,
      httpOnly: parsed.httpOnly,
      sameSite: parsed.sameSite,
      createdAt: Date.now(),
    };

    if (existingIndex !== -1) this.cookies[existingIndex] = cookie;
    else this.cookies.push(cookie);
    this.enforceLimits(cookie.domain);
  }

  /** Apply a `document.cookie = "..."` assignment coming from page scripts. */
  setFromDocument(cookieString: string, documentUrl: URL): void {
    const parsed = parseSetCookie(cookieString, documentUrl);
    if (!parsed) return;
    // document.cookie cannot create HttpOnly cookies.
    this.setFromSetCookie(`${cookieString}`, documentUrl);
  }

  private enforceLimits(domain: string): void {
    const forDomain = this.cookies.filter((cookie) => cookie.domain === domain);
    if (forDomain.length > MAX_COOKIES_PER_DOMAIN) {
      forDomain
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, forDomain.length - MAX_COOKIES_PER_DOMAIN)
        .forEach((cookie) => {
          const index = this.cookies.indexOf(cookie);
          if (index !== -1) this.cookies.splice(index, 1);
        });
    }
    if (this.cookies.length > MAX_COOKIES_TOTAL) {
      this.cookies.sort((a, b) => a.createdAt - b.createdAt);
      this.cookies.splice(0, this.cookies.length - MAX_COOKIES_TOTAL);
    }
  }

  private matching(url: URL): StoredCookie[] {
    const host = canonicalHost(url.hostname);
    const now = Date.now();
    return this.cookies
      .filter(
        (cookie) =>
          cookie.expiresAt > now &&
          (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
          pathMatches(url.pathname || '/', cookie.path) &&
          (!cookie.secure || url.protocol === 'https:'),
      )
      .sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
  }

  headerFor(url: URL): string | null {
    const cookies = this.matching(url);
    if (cookies.length === 0) return null;
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  /** Value of `document.cookie` as seen by page scripts (HttpOnly cookies hidden). */
  documentCookieFor(url: URL): string {
    return this.matching(url)
      .filter((cookie) => !cookie.httpOnly)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  }

  clear(): void {
    this.cookies = [];
  }

  clearDomain(domain: string): void {
    const host = canonicalHost(domain);
    this.cookies = this.cookies.filter((cookie) => cookie.domain !== host);
  }

  get size(): number {
    this.purge();
    return this.cookies.length;
  }

  snapshotForDebugging(): Array<Pick<StoredCookie, 'name' | 'domain' | 'path' | 'secure' | 'httpOnly' | 'expiresAt'>> {
    return this.cookies.map(({ name, domain, path, secure, httpOnly, expiresAt }) => ({
      name,
      domain,
      path,
      secure,
      httpOnly,
      expiresAt,
    }));
  }
}

export class CookieJarStore {
  private jars = new Map<string, CookieJar>();

  forToken(token: string): CookieJar {
    let jar = this.jars.get(token);
    if (!jar) {
      jar = new CookieJar();
      this.jars.set(token, jar);
    }
    return jar;
  }

  delete(token: string): void {
    this.jars.delete(token);
  }
}
