import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createGzip, createInflate } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingHttpHeaders } from 'node:http';
import { request as undiciRequest, type Dispatcher } from 'undici';
import { decodeProxyPath, proxifyUrl, type ProxyMode } from '../shared/url.js';
import { APP_VERSION, header, type AppConfig, type RequestOrigins } from './config.js';
import { renderErrorPage } from './pages.js';
import { rewriteCss } from './rewrite/css.js';
import { rewriteHtml } from './rewrite/html.js';
import { signDocumentHandle } from './handle.js';
import { assertSafeTarget, TargetError } from './ssrf.js';
import type { HourlyBudget, FixedWindowLimiter } from './rate-limit.js';
import type { Session, SessionStore } from './sessions.js';

export interface ProxyDeps {
  config: AppConfig;
  sessions: SessionStore;
  ipLimiter: FixedWindowLimiter;
  sessionLimiter: FixedWindowLimiter;
  budget: HourlyBudget;
  dispatcher: Dispatcher;
  secret: Buffer;
  buffer: { bytes: number };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'http2-settings',
]);

const REQUEST_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'content-length',
  'accept-encoding',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'cdn-loop',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
  'sec-purpose',
  'purpose',
  'priority',
  'expect',
  'upgrade-insecure-requests',
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'public-key-pins',
  'public-key-pins-report-only',
  'expect-ct',
  'alt-svc',
  'nel',
  'report-to',
  'reporting-endpoints',
  'clear-site-data',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'origin-agent-cluster',
  'content-length',
  'link',
  'server-timing',
  'cf-cache-status',
  'cf-ray',
  'x-served-by',
]);

function isNavigation(req: FastifyRequest): boolean {
  const accept = header(req.raw.headers, 'accept') ?? '';
  return accept.includes('text/html') || accept.includes('application/xhtml+xml');
}

function wantsCors(origins: RequestOrigins, req: FastifyRequest): boolean {
  return origins.mode === 'shared' && header(req.raw.headers, 'origin') === 'null';
}

function corsHeaders(req: FastifyRequest): Record<string, string> {
  const origin = header(req.raw.headers, 'origin');
  if (origin !== 'null') return {};
  return {
    'access-control-allow-origin': 'null',
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': 'content-length, content-type, content-range',
  };
}

export function sendProxyError(
  req: FastifyRequest,
  reply: FastifyReply,
  options: {
    status: number;
    title: string;
    message: string;
    host?: string;
    detail?: string;
    retry?: boolean;
    homeOrigin?: string;
    extraHeaders?: Record<string, string>;
  },
): void {
  const html = renderErrorPage(options);
  const navigation = isNavigation(req);
  const body = navigation
    ? html
    : `<!DOCTYPE html><meta charset="utf-8"><title>${options.status}</title>${options.title}`;
  reply
    .code(options.status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .header('x-openaccess-error', String(options.status))
    .headers(options.extraHeaders ?? {})
    .send(body);
}

function decodeText(buffer: Buffer, contentType: string | undefined): string {
  let charset = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase();
  if (!charset) {
    const head = buffer.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }
  if (!charset || charset === 'utf-8' || charset === 'utf8') {
    return new TextDecoder('utf-8').decode(buffer);
  }
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

function parseContentType(contentType: string | undefined): { mime: string } {
  const mime = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return { mime };
}

function rewriteReferer(referer: string | undefined, _target: URL, contentOrigin: string): string | null {
  if (!referer) return null;
  try {
    const parsed = new URL(referer);
    if (parsed.origin !== new URL(contentOrigin).origin) return null;
    const decoded = decodeProxyPath(parsed.pathname);
    if (!decoded) return null;
    const original = decoded.url;
    original.search = parsed.search;
    return original.href;
  } catch {
    return null;
  }
}

function rewriteOrigin(origin: string | undefined, target: URL, contentOrigin: string): string | null {
  if (!origin) return null;
  try {
    if (new URL(origin).origin === new URL(contentOrigin).origin) return target.origin;
  } catch {
    return null;
  }
  return origin;
}

async function readRequestBody(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('Request body too large'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

interface UpstreamOptions {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  session: Session;
}

/**
 * Send one request upstream. Redirects are intentionally *not* followed here:
 * the 3xx is returned to the browser with a rewritten Location, so the browser's
 * address stays correct, relative URLs keep resolving against the right page,
 * and 307/308 bodies are replayed by the browser itself.
 */
async function requestUpstream(deps: ProxyDeps, options: UpstreamOptions) {
  const { config, dispatcher } = deps;
  const response = await undiciRequest(options.url, {
    method: options.method as Dispatcher.HttpMethod,
    headers: options.headers,
    body: options.body,
    dispatcher,
    headersTimeout: config.upstreamHeadersTimeoutMs,
    bodyTimeout: config.upstreamBodyTimeoutMs,
    signal: options.signal,
  });

  const setCookies = response.headers['set-cookie'];
  if (setCookies) {
    for (const cookie of Array.isArray(setCookies) ? setCookies : [setCookies]) {
      options.session.jar.setFromSetCookie(cookie, options.url);
    }
  }
  return response;
}

function buildUpstreamHeaders(
  req: FastifyRequest,
  target: URL,
  session: Session,
  contentOrigin: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.raw.headers)) {
    if (value === undefined) continue;
    if (REQUEST_HEADER_DENYLIST.has(name)) continue;
    if (name.startsWith('x-openaccess')) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  const referer = rewriteReferer(header(req.raw.headers, 'referer'), target, contentOrigin);
  if (referer) headers.referer = referer;
  else delete headers.referer;

  const origin = rewriteOrigin(header(req.raw.headers, 'origin'), target, contentOrigin);
  if (origin) headers.origin = origin;
  else delete headers.origin;

  // Ask for an uncompressed body: rewriting needs readable bytes, and this
  // keeps binary streaming byte-exact.
  headers['accept-encoding'] = 'identity';

  const cookie = session.jar.headerFor(target);
  if (cookie) headers.cookie = cookie;

  headers.host = target.host;
  return headers;
}

function shouldAbortForSize(contentLength: string | undefined, limit: number): boolean {
  if (!contentLength) return false;
  const parsed = Number(contentLength);
  return Number.isFinite(parsed) && parsed > limit;
}

async function collectBody(
  stream: Readable,
  limit: number,
  onBytes: (bytes: number) => void,
  trackBuffer: (delta: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      onBytes(buffer.length);
      trackBuffer(buffer.length);
      if (total > limit) {
        stream.destroy();
        throw Object.assign(new Error('Response too large'), { code: 'RESPONSE_TOO_LARGE' });
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  } finally {
    // Release the process-wide reservation even when the request aborts or the
    // per-response limit is exceeded.
    trackBuffer(-total);
  }
}

function decompress(stream: Readable, encoding: string | undefined): { stream: Readable; decoded: boolean } {
  switch ((encoding ?? '').toLowerCase().trim()) {
    case 'gzip':
    case 'x-gzip':
      return { stream: stream.pipe(createGunzip()), decoded: true };
    case 'deflate':
      return { stream: stream.pipe(createInflate()), decoded: true };
    case 'br':
      return { stream: stream.pipe(createBrotliDecompress()), decoded: true };
    default:
      return { stream, decoded: false };
  }
}

function acceptsGzip(req: FastifyRequest): boolean {
  return /(^|,)\s*gzip\s*(;|,|$)/i.test(header(req.raw.headers, 'accept-encoding') ?? '');
}

async function encodeForClient(
  req: FastifyRequest,
  body: Buffer,
): Promise<{ body: Buffer; encoding: string | null }> {
  if (body.length < 1024 || !acceptsGzip(req)) return { body, encoding: null };
  return {
    body: await new Promise<Buffer>((resolve, reject) => {
      const gzip = createGzip({ level: 6 });
      const chunks: Buffer[] = [];
      gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
      gzip.on('error', reject);
      gzip.on('end', () => resolve(Buffer.concat(chunks)));
      gzip.end(body);
    }),
    encoding: 'gzip',
  };
}

function responseHeaders(
  upstream: IncomingHttpHeaders,
  options: { rewriteLocation?: string; req: FastifyRequest },
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (value === undefined) continue;
    if (RESPONSE_HEADER_DENYLIST.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  if (options.rewriteLocation) headers.location = options.rewriteLocation;
  const cors = corsHeaders(options.req);
  if (Object.keys(cors).length > 0) {
    headers.vary = headers.vary ? `${headers.vary}, origin` : 'origin';
  }
  Object.assign(headers, cors);
  return headers;
}

export async function handleProxyRequest(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ProxyDeps,
  origins: RequestOrigins,
): Promise<void> {
  const { config, sessions } = deps;
  const rawUrl = req.raw.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const rawQuery = queryIndex === -1 ? '' : rawUrl.slice(queryIndex + 1);
  const decoded = decodeProxyPath(pathname);

  if (!decoded) {
    sendProxyError(req, reply, {
      status: 400,
      title: 'That browsing address is not valid',
      message: 'The link is malformed or was truncated. Return to OpenAccess and enter the address again.',
      homeOrigin: origins.publicOrigin,
      retry: false,
    });
    return;
  }

  const session = sessions.get(decoded.token);
  if (!session) {
    sendProxyError(req, reply, {
      status: 401,
      title: 'Your browsing session has ended',
      message:
        'Proxied sessions expire after a period of inactivity and whenever the server restarts. Reload the OpenAccess window to start a new session.',
      retry: false,
      homeOrigin: origins.mode === 'isolated' ? origins.publicOrigin : undefined,
      extraHeaders: corsHeaders(req),
    });
    return;
  }

  const ip = req.ip;
  const ipCheck = deps.ipLimiter.check(ip);
  if (!ipCheck.allowed) {
    sendProxyError(req, reply, {
      status: 429,
      title: 'Too many requests',
      message: 'This connection is making requests faster than the public rate limit allows. Wait a moment, then reload.',
      retry: true,
      homeOrigin: origins.mode === 'isolated' ? origins.publicOrigin : undefined,
      extraHeaders: { 'retry-after': String(ipCheck.retryAfterSeconds), ...corsHeaders(req) },
    });
    return;
  }
  const sessionCheck = deps.sessionLimiter.check(session.token);
  if (!sessionCheck.allowed) {
    sendProxyError(req, reply, {
      status: 429,
      title: 'Slow down for a moment',
      message: 'This browsing session hit its per-minute request limit. OpenAccess limits request rates to stay a healthy public service.',
      retry: true,
      extraHeaders: { 'retry-after': String(sessionCheck.retryAfterSeconds), ...corsHeaders(req) },
    });
    return;
  }

  if (deps.budget.exhausted) {
    sendProxyError(req, reply, {
      status: 503,
      title: 'The hourly bandwidth budget is used up',
      message:
        'This deployment has transferred its configured hourly allowance. It resets automatically at the top of the hour. Operators can raise EGRESS_LIMIT_MB_PER_HOUR.',
      retry: false,
      extraHeaders: corsHeaders(req),
    });
    return;
  }

  const target = decoded.url;
  if (rawQuery) target.search = `?${rawQuery}`;

  const selfHosts = new Set<string>();
  for (const origin of [origins.publicOrigin, origins.contentOrigin]) {
    try {
      const parsed = new URL(origin);
      selfHosts.add(`${parsed.hostname.toLowerCase()}:${parsed.port || (parsed.protocol === 'https:' ? 443 : 80)}`);
    } catch {
      /* ignore */
    }
  }

  try {
    await assertSafeTarget(target, config, selfHosts);
  } catch (error) {
    if (error instanceof TargetError) {
      sendProxyError(req, reply, {
        status: error.status,
        title:
          error.code === 'blocked-address' || error.code === 'blocked-host'
            ? 'That destination is not available through OpenAccess'
            : 'That address cannot be opened',
        message: error.message,
        host: target.host,
        detail: `Reason: ${error.code}`,
        homeOrigin: origins.mode === 'isolated' ? origins.publicOrigin : undefined,
        extraHeaders: corsHeaders(req),
      });
      return;
    }
    throw error;
  }

  const method = req.method.toUpperCase();
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    try {
      body = await readRequestBody(req.raw as unknown as Readable, config.maxUploadBytes);
    } catch (error) {
      const tooLarge = (error as { code?: string }).code === 'BODY_TOO_LARGE';
      sendProxyError(req, reply, {
        status: tooLarge ? 413 : 400,
        title: tooLarge ? 'That upload is too large' : 'Request could not be read',
        message: tooLarge
          ? `Uploads through the proxy are limited to ${Math.floor(config.maxUploadBytes / (1024 * 1024))} MB.`
          : 'The request body could not be read.',
        retry: false,
        extraHeaders: corsHeaders(req),
      });
      return;
    }
  }

  // Answer CORS preflights ourselves: the destination never sees them and
  // does not need to support OPTIONS.
  if (method === 'OPTIONS' && header(req.raw.headers, 'access-control-request-method')) {
    reply
      .code(204)
      .headers({
        ...corsHeaders(req),
        'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
        'access-control-allow-headers':
          header(req.raw.headers, 'access-control-request-headers') ?? '*',
        'access-control-max-age': '600',
        'cache-control': 'no-store',
      })
      .send();
    return;
  }

  if (session.inflight >= config.maxConcurrentPerSession) {
    sendProxyError(req, reply, {
      status: 503,
      title: 'This tab is loading too many resources at once',
      message: 'OpenAccess limits parallel requests per session to keep the service responsive. Reload the page to retry.',
      retry: true,
      extraHeaders: { 'retry-after': '2', ...corsHeaders(req) },
    });
    return;
  }

  const abort = new AbortController();
  const onClientClose = (): void => {
    if (!reply.raw.writableFinished) abort.abort();
  };
  reply.raw.once('close', onClientClose);

  session.inflight++;
  session.requests++;

  try {
    const headers = buildUpstreamHeaders(req, target, session, origins.contentOrigin);
    const response = await requestUpstream(deps, {
      url: target,
      method,
      headers,
      body,
      signal: abort.signal,
      session,
    });

    const finalUrl = target;
    const contentType = response.headers['content-type'] as string | undefined;
    const { mime } = parseContentType(contentType);
    const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '';
    const isCss = mime === 'text/css';

    const upstreamEncoding = (response.headers['content-encoding'] as string | undefined) ?? '';
    const { stream, decoded } = decompress(
      response.body as unknown as Readable,
      upstreamEncoding,
    );

    let rewrittenLocation: string | undefined;
    const rawLocation = response.headers.location;
    if (rawLocation) {
      try {
        const next = new URL(rawLocation, finalUrl);
        if (next.protocol === 'http:' || next.protocol === 'https:') {
          rewrittenLocation = proxifyUrl(session.token, next, origins.contentOrigin);
        }
      } catch {
        /* drop an unparseable Location header */
      }
    }

    const baseHeaders = responseHeaders(response.headers, {
      req,
      rewriteLocation: rewrittenLocation,
    });
    delete baseHeaders['transfer-encoding'];
    if (decoded) delete baseHeaders['content-encoding'];

    if (response.statusCode === 204 || response.statusCode === 304) {
      reply.hijack();
      reply.raw.writeHead(response.statusCode, baseHeaders);
      reply.raw.end();
      await response.body.dump().catch(() => {});
      return;
    }

    if ((isHtml || isCss) && response.statusCode !== 206) {
      if (shouldAbortForSize(response.headers['content-length'] as string | undefined, config.maxResponseBytes)) {
        await response.body.dump().catch(() => {});
        throw Object.assign(new Error('Response too large'), { code: 'RESPONSE_TOO_LARGE' });
      }

      const buffer = await collectBody(
        stream,
        config.maxResponseBytes,
        (bytes) => {
          session.bytesOut += bytes;
          deps.budget.add(bytes);
        },
        (delta) => {
          deps.buffer.bytes += delta;
          if (delta > 0 && deps.buffer.bytes > config.maxBufferedBytes) {
            throw Object.assign(new Error('Rewrite buffer exhausted'), { code: 'BUFFER_PRESSURE' });
          }
        },
      );

      // The document URL is the URL the browser asked for, not the redirect
      // target: relative URLs were resolved by the browser against the request
      // URL, so the base must match it or the two disagree.
      const documentUrl = target;
      const text = decodeText(buffer, contentType);

      if (isHtml) {
        const rewritten = rewriteHtml(text, {
          token: session.token,
          documentUrl,
          contentOrigin: origins.contentOrigin,
          parentOrigin: origins.publicOrigin,
          mode: origins.mode,
          cookieSnapshot: session.jar.documentCookieFor(documentUrl),
          runtimeUrl: `${origins.contentOrigin}/__oa/runtime.js`,
          enableServerStorage: config.enableServerStorage,
          documentHandle: signDocumentHandle(deps.secret, session.token, documentUrl.host),
        });
        const encoded = await encodeForClient(req, Buffer.from(rewritten, 'utf8'));
        baseHeaders['content-type'] = 'text/html; charset=utf-8';
        baseHeaders['content-length'] = String(encoded.body.length);
        baseHeaders['cache-control'] = 'no-store';
        if (encoded.encoding) {
          baseHeaders['content-encoding'] = encoded.encoding;
          baseHeaders.vary = baseHeaders.vary ? `${baseHeaders.vary}, accept-encoding` : 'accept-encoding';
        }
        reply.hijack();
        reply.raw.writeHead(response.statusCode, baseHeaders);
        if (method === 'HEAD') reply.raw.end();
        else reply.raw.end(encoded.body);
        return;
      }

      const rewritten = rewriteCss(text, {
        token: session.token,
        documentUrl,
        contentOrigin: origins.contentOrigin,
      });
      const encoded = await encodeForClient(req, Buffer.from(rewritten, 'utf8'));
      baseHeaders['content-type'] = 'text/css; charset=utf-8';
      baseHeaders['content-length'] = String(encoded.body.length);
      if (encoded.encoding) {
        baseHeaders['content-encoding'] = encoded.encoding;
        baseHeaders.vary = baseHeaders.vary ? `${baseHeaders.vary}, accept-encoding` : 'accept-encoding';
      }
      reply.hijack();
      reply.raw.writeHead(response.statusCode, baseHeaders);
      reply.raw.end(encoded.body);
      return;
    }

    reply.hijack();
    const raw = reply.raw;
    if (method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304) {
      raw.writeHead(response.statusCode, baseHeaders);
      raw.end();
      await response.body.dump().catch(() => {});
      return;
    }

    const declaredLength = response.headers['content-length'];
    if (!decoded && typeof declaredLength === 'string') baseHeaders['content-length'] = declaredLength;
    raw.writeHead(response.statusCode, baseHeaders);
    if (shouldAbortForSize(typeof declaredLength === 'string' ? declaredLength : undefined, config.maxResponseBytes)) {
      raw.destroy();
      await response.body.dump().catch(() => {});
      return;
    }

    let transferred = 0;
    stream.on('data', (chunk: Buffer) => {
      transferred += chunk.length;
      session.bytesOut += chunk.length;
      deps.budget.add(chunk.length);
      if (transferred > config.maxResponseBytes) {
        stream.destroy();
        raw.destroy();
      }
    });
    stream.on('error', () => {
      raw.destroy();
    });
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) stream.destroy();
    });
    stream.pipe(raw);
  } catch (error) {
    if (reply.raw.headersSent || reply.raw.writableEnded) {
      reply.raw.destroy();
      return;
    }
    const code = (error as { code?: string }).code;
    if (abort.signal.aborted) return;
    if (code === 'BUFFER_PRESSURE') {
      sendProxyError(req, reply, {
        status: 503,
        title: 'The server is busy rewriting pages',
        message:
          'Too many large pages are being processed at once. Wait a moment and reload; this is a capacity guard, not a ban.',
        retry: true,
        extraHeaders: { 'retry-after': '3', ...corsHeaders(req) },
      });
      return;
    }
    if (code === 'RESPONSE_TOO_LARGE') {
      sendProxyError(req, reply, {
        status: 502,
        title: 'That page is too large to open',
        message: `OpenAccess limits a single proxied response to ${Math.floor(config.maxResponseBytes / (1024 * 1024))} MB so one page cannot exhaust the server.`,
        host: target.host,
        retry: false,
        extraHeaders: corsHeaders(req),
      });
      return;
    }
    if (code === 'TOO_MANY_REDIRECTS') {
      sendProxyError(req, reply, {
        status: 502,
        title: 'Too many redirects',
        message: 'The site redirected more times than OpenAccess allows. This sometimes indicates a broken login loop.',
        host: target.host,
        retry: false,
        extraHeaders: corsHeaders(req),
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    const tls = /certificate|TLS|SSL/i.test(message);
    sendProxyError(req, reply, {
      status: 502,
      title: tls ? 'The site’s secure connection could not be verified' : 'The site could not be reached',
      message: tls
        ? 'The destination presented an invalid or untrusted certificate. OpenAccess does not bypass certificate errors.'
        : 'The destination did not respond, refused the connection, or returned an invalid response.',
      host: target.host,
      detail: message.slice(0, 500),
      retry: true,
      homeOrigin: origins.mode === 'isolated' ? origins.publicOrigin : undefined,
      extraHeaders: corsHeaders(req),
    });
  } finally {
    reply.raw.off('close', onClientClose);
    if (session.inflight > 0) session.inflight--;
    sessions.get(session.token, false);
  }
}

export { APP_VERSION };
