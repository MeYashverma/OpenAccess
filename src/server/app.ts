import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { APP_VERSION, header, resolveOrigins, type RequestOrigins } from './config.js';
import { closeDeps, type AppDeps } from './deps.js';
import { handleCookieSync, handleStorage, handleStorageRead } from './internal.js';
import { handleProxyRequest, sendProxyError } from './proxy.js';
import { attachWebSocketRelay } from './websocket.js';
import { SESSION_TOKEN_PATTERN } from '../shared/url.js';

declare module 'fastify' {
  interface FastifyRequest {
    oaOrigins: RequestOrigins;
  }
}

const CLIENT_DIR = resolve(process.cwd(), 'dist/client');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function isHttps(req: FastifyRequest, deps: AppDeps): boolean {
  if (deps.config.forceHttps) return true;
  const forwarded = header(req.raw.headers, 'x-forwarded-proto');
  if (forwarded) return forwarded.split(',')[0]!.trim() === 'https';
  return Boolean((req.raw.socket as { encrypted?: boolean }).encrypted);
}

function securityHeaders(req: FastifyRequest, origins: RequestOrigins, deps: AppDeps): Record<string, string> {
  const contentOrigin = new URL(origins.contentOrigin).origin;
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${contentOrigin}`,
    `frame-src ${contentOrigin}`,
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const headers: Record<string, string> = {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=(), serial=(), hid=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  };
  if (isHttps(req, deps)) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

async function sendClientFile(
  reply: FastifyReply,
  relativePath: string,
  cacheControl: string,
): Promise<void> {
  const safe = normalize(relativePath).replace(/^([./\\])+/, '');
  const filePath = join(CLIENT_DIR, safe);
  // Compare with a trailing separator so `/dist/client-evil` is not accepted
  // as a child of `/dist/client`.
  if (filePath !== CLIENT_DIR && !filePath.startsWith(`${CLIENT_DIR}${sep}`)) {
    reply.code(404).send('Not found');
    return;
  }
  try {
    const data = await readFile(filePath);
    reply
      .header('content-type', MIME_TYPES[extname(filePath)] ?? 'application/octet-stream')
      .header('cache-control', cacheControl)
      .header('x-content-type-options', 'nosniff')
      .send(data);
  } catch {
    reply.code(404).send('Not found');
  }
}

function parsePath(req: FastifyRequest): string {
  const raw = req.raw.url ?? '/';
  const mark = raw.indexOf('?');
  return mark === -1 ? raw : raw.slice(0, mark);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const { config } = deps;

  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    routerOptions: { ignoreTrailingSlash: true },
  });

  // Inbound slow-client protection. `requestTimeout` bounds how long a client
  // may take to finish sending a request (including uploads); it does not cut
  // off streamed responses.
  app.server.headersTimeout = 30_000;
  app.server.requestTimeout = 180_000;
  app.server.keepAliveTimeout = 72_000;

  app.decorateRequest('oaOrigins', null as unknown as RequestOrigins);

  app.addHook('onRequest', async (req, reply) => {
    const origins = resolveOrigins(config, req.raw.headers);
    req.oaOrigins = origins;
    const path = parsePath(req);
    if (path === '/healthz' || path === '/robots.txt') return;

    const host = (header(req.raw.headers, 'host') ?? '').toLowerCase();
    const publicHost = new URL(origins.publicOrigin).host.toLowerCase();
    const contentHost = new URL(origins.contentOrigin).host.toLowerCase();
    const isolated = publicHost !== contentHost;

    if (!isolated) return;

    const isContentRequest = host === contentHost;
    const isPublicRequest = host === publicHost;

    if (isContentRequest) {
      if (path.startsWith('/api')) {
        reply.code(404).send({ error: 'not-found' });
        return reply;
      }
      const allowed =
        path.startsWith('/p/') ||
        path.startsWith('/__oa/') ||
        path === '/favicon.ico' ||
        path === '/favicon.svg' ||
        path === '/robots.txt';
      if (!allowed) {
        reply.redirect(origins.publicOrigin + rawPathAndQuery(req), 302);
        return reply;
      }
      return;
    }

    if (isPublicRequest) {
      if (path.startsWith('/p/') || path.startsWith('/__oa/')) {
        // Keep a single content origin even if someone links to the public host
        // with a proxy path.
        reply.redirect(origins.contentOrigin + rawPathAndQuery(req), 307);
        return reply;
      }
      return;
    }

    reply
      .code(421)
      .header('content-type', 'text/plain; charset=utf-8')
      .send(`This server is configured for ${publicHost} and ${contentHost}.`);
    return reply;
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const path = parsePath(req);
    if (path.startsWith('/p/') || path.startsWith('/__oa/')) return payload;
    for (const [name, value] of Object.entries(securityHeaders(req, req.oaOrigins, deps))) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    return payload;
  });

  if (config.accessLog) {
    app.addHook('onResponse', async (req, reply) => {
      // Deliberately does not log the full URL: proxy paths contain a session
      // token and destination URLs (which may contain search terms).
      const path = parsePath(req);
      const redacted = path.startsWith('/p/') ? '/p/<redacted>' : path;
      process.stdout.write(
        `${new Date().toISOString()} ${req.method} ${redacted} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms\n`,
      );
    });
  }

  // ---------------------------------------------------------------------
  // UI surface
  // ---------------------------------------------------------------------

  const sendIndex = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      const html = await readFile(join(CLIENT_DIR, 'index.html'), 'utf8');
      // The social preview URL has to be absolute; the deployment origin is
      // known from configuration or from the incoming request.
      const origin = (config.publicOrigin ?? req.oaOrigins.publicOrigin).replace(/\/$/, '');
      reply
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(html.replaceAll('%OA_PUBLIC_ORIGIN%', origin));
    } catch {
      reply.code(404).send('Not found');
    }
  };

  app.get('/', async (req, reply) => {
    await sendIndex(req, reply);
  });

  app.get('/index.html', async (req, reply) => {
    await sendIndex(req, reply);
  });

  app.get('/assets/*', async (req, reply) => {
    const wildcard = (req.params as Record<string, string>)['*'] ?? '';
    if (wildcard.includes('..')) {
      reply.code(404).send('Not found');
      return;
    }
    await sendClientFile(reply, join('assets', wildcard), 'public, max-age=31536000, immutable');
  });

  for (const file of [
    'favicon.ico',
    'favicon.svg',
    'theme-init.js',
    'manifest.webmanifest',
    'apple-touch-icon.png',
    'og.png',
    'icons/192.png',
    'icons/512.png',
  ]) {
    app.get(`/${file}`, async (_req, reply) => {
      await sendClientFile(reply, file, file === 'robots.txt' ? 'public, max-age=3600' : 'public, max-age=86400');
    });
  }

  // ---------------------------------------------------------------------
  // Public API (UI origin only)
  // ---------------------------------------------------------------------

  app.get('/api/config', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      version: APP_VERSION,
      mode: req.oaOrigins.mode,
      contentOrigin: req.oaOrigins.contentOrigin,
      features: {
        websockets: config.enableWebSockets,
        serverStorage: config.enableServerStorage,
      },
      limits: {
        maxUploadMb: Math.floor(config.maxUploadBytes / (1024 * 1024)),
        maxResponseMb: Math.floor(config.maxResponseBytes / (1024 * 1024)),
        sessionIdleMinutes: Math.round(config.sessionIdleMs / 60_000),
        sessionMaxHours: Math.round(config.sessionMaxMs / 3_600_000),
        rateLimitPerMinute: config.maxRequestsPerSession,
      },
    };
  });

  app.post('/api/session', async (req, reply) => {
    const limit = deps.sessionCreateLimiter.check(req.ip);
    reply.header('cache-control', 'no-store');
    if (!limit.allowed) {
      reply.code(429).header('retry-after', String(limit.retryAfterSeconds));
      return { error: 'rate-limited', retryAfter: limit.retryAfterSeconds };
    }
    const result = deps.sessions.create(req.ip);
    if (!result.ok) {
      reply.code(503);
      return { error: 'capacity' };
    }
    return {
      token: result.session.token,
      expiresAt: result.session.createdAt + config.sessionMaxMs,
      idleExpiresAt: result.session.lastSeen + config.sessionIdleMs,
      mode: req.oaOrigins.mode,
      contentOrigin: req.oaOrigins.contentOrigin,
    };
  });

  app.get('/api/session/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    reply.header('cache-control', 'no-store');
    if (!SESSION_TOKEN_PATTERN.test(token)) return reply.code(400).send({ error: 'invalid-token' });
    const session = deps.sessions.get(token);
    if (!session) return reply.code(404).send({ error: 'not-found' });
    return {
      valid: true,
      idleExpiresAt: session.lastSeen + config.sessionIdleMs,
      expiresAt: session.createdAt + config.sessionMaxMs,
      mode: req.oaOrigins.mode,
      contentOrigin: req.oaOrigins.contentOrigin,
    };
  });

  app.delete('/api/session/:token', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    reply.header('cache-control', 'no-store');
    if (!SESSION_TOKEN_PATTERN.test(token)) return reply.code(400).send({ error: 'invalid-token' });
    const session = deps.sessions.get(token);
    if (session) session.jar.clear();
    deps.sessions.destroy(token);
    return { ok: true };
  });

  app.get('/api/health', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return {
      status: 'ok',
      version: APP_VERSION,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      sessions: deps.sessions.count,
      egress: deps.budget.snapshot(),
    };
  });

  app.get('/healthz', async (_req, reply) => {
    reply.header('cache-control', 'no-store').type('text/plain');
    return 'ok';
  });

  app.get('/robots.txt', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=3600').type('text/plain');
    return 'User-agent: *\nDisallow: /\n';
  });

  // ---------------------------------------------------------------------
  // Content surface: runtime asset
  // ---------------------------------------------------------------------

  app.get('/__oa/runtime.js', async (req, reply) => {
    const etag = deps.runtime.etag;
    reply
      .header('content-type', 'text/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('etag', etag);
    if (header(req.raw.headers, 'if-none-match') === etag) {
      reply.code(304).send();
      return reply;
    }
    return reply.send(deps.runtime.source);
  });

  // ---------------------------------------------------------------------
  // Content surface: internal runtime endpoints
  // ---------------------------------------------------------------------

  app.post('/p/:token/__oa/cookie', async (req, reply) => {
    await handleCookieSync(req, reply, deps, req.oaOrigins);
  });

  app.options('/p/:token/__oa/cookie', async (req, reply) => {
    await handleCookieSync(req, reply, deps, req.oaOrigins);
  });

  app.post('/p/:token/__oa/storage', async (req, reply) => {
    await handleStorage(req, reply, deps, req.oaOrigins);
  });

  app.get('/p/:token/__oa/storage', async (req, reply) => {
    await handleStorageRead(req, reply, deps, req.oaOrigins);
  });

  app.options('/p/:token/__oa/storage', async (req, reply) => {
    await handleStorage(req, reply, deps, req.oaOrigins);
  });

  // ---------------------------------------------------------------------
  // Content surface: the proxy itself
  // ---------------------------------------------------------------------

  void app.register(async (scope) => {
    // Hand the raw body stream to the proxy so uploads and form posts are
    // forwarded byte-for-byte without buffering twice.
    scope.addContentTypeParser('*', (request, payload, done) => {
      done(null, payload as unknown as Record<string, unknown>);
    });

    scope.all('/p/*', async (req, reply) => {
      await handleProxyRequest(req, reply, deps, req.oaOrigins);
    });
  });

  app.setNotFoundHandler((req, reply) => {
    const path = parsePath(req);
    if (path.startsWith('/api/')) {
      reply.code(404).send({ error: 'not-found' });
      return;
    }
    if (path.startsWith('/p/')) {
      sendProxyError(req, reply, {
        status: 400,
        title: 'That browsing address is not valid',
        message: 'The link is malformed or was truncated. Return to OpenAccess and enter the address again.',
        retry: false,
      });
      return;
    }
    reply.code(404).type('text/html; charset=utf-8').send(
      '<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font:16px system-ui;padding:40px">' +
        '<p>Not found. <a href="/">Open OpenAccess</a></p>',
    );
  });

  app.setErrorHandler((error: FastifyError, req, reply) => {
    // Never include request URLs in logs: they contain session tokens.
    process.stderr.write(
      `[openaccess] request error: ${error.name} ${String(error.message).slice(0, 200)}\n`,
    );
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    if (parsePath(req).startsWith('/api/')) {
      reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ error: 'server-error' });
      return;
    }
    reply
      .code(500)
      .type('text/html; charset=utf-8')
      .send('<!doctype html><meta charset="utf-8"><title>Server error</title><body style="font:16px system-ui;padding:40px"><h1>Something went wrong</h1><p>Reload the page to try again.</p>');
  });

  app.addHook('onClose', async () => {
    closeDeps(deps);
  });

  attachWebSocketRelay(app.server, deps);

  // Warm the client directory check early so misconfiguration fails loudly.
  if (!existsSync(join(CLIENT_DIR, 'index.html'))) {
    process.stderr.write(
      '[openaccess] warning: dist/client/index.html is missing. Run `npm run build:client` before starting the server.\n',
    );
  }

  return app;
}

function rawPathAndQuery(req: FastifyRequest): string {
  return req.raw.url ?? '/';
}
