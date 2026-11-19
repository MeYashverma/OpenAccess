import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RequestOrigins } from './config.js';
import type { AppDeps } from './deps.js';
import { verifyDocumentHandle } from './handle.js';
import { SESSION_TOKEN_PATTERN } from '../shared/url.js';

/**
 * Endpoints used by the injected page runtime. They are scoped to a browsing
 * session and to the exact document that called them (via an HMAC-signed
 * handle), so a page cannot read another site's storage bucket or set cookies
 * for another domain in the same session.
 */

function corsHeaders(req: FastifyRequest, origins: RequestOrigins): Record<string, string> {
  if (origins.mode === 'shared' && req.headers.origin === 'null') {
    return {
      'access-control-allow-origin': 'null',
      'access-control-allow-credentials': 'true',
    };
  }
  return {};
}

function corsPreflight(req: FastifyRequest, reply: FastifyReply, origins: RequestOrigins): boolean {
  if (req.method !== 'OPTIONS') return false;
  reply
    .code(204)
    .headers({
      ...corsHeaders(req, origins),
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': (req.headers['access-control-request-headers'] as string) ?? 'content-type',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    })
    .send();
  return true;
}

interface HandleBody {
  handle?: unknown;
  cookie?: unknown;
}

function resolveSession(req: FastifyRequest, deps: AppDeps) {
  const token = (req.params as { token?: string }).token ?? '';
  if (!SESSION_TOKEN_PATTERN.test(token)) return null;
  const session = deps.sessions.get(token);
  if (!session) return null;
  return session;
}

export async function handleCookieSync(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  origins: RequestOrigins,
): Promise<void> {
  if (corsPreflight(req, reply, origins)) return;

  const session = resolveSession(req, deps);
  if (!session) {
    reply.code(401).headers(corsHeaders(req, origins)).send({ error: 'session-expired' });
    return;
  }

  const body = (req.body ?? {}) as HandleBody;
  if (typeof body.handle !== 'string' || typeof body.cookie !== 'string') {
    reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'invalid-request' });
    return;
  }
  if (body.cookie.length > 8192) {
    reply.code(413).headers(corsHeaders(req, origins)).send({ error: 'too-large' });
    return;
  }

  const verified = verifyDocumentHandle(deps.secret, body.handle, session.token);
  if (!verified) {
    reply.code(403).headers(corsHeaders(req, origins)).send({ error: 'invalid-handle' });
    return;
  }

  const documentUrl = new URL(`https://${verified.host}/`);
  session.jar.setFromDocument(body.cookie, documentUrl);
  reply.headers(corsHeaders(req, origins)).send({ ok: true });
}

interface StorageBody extends HandleBody {
  op?: unknown;
  key?: unknown;
  value?: unknown;
}

export async function handleStorage(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  origins: RequestOrigins,
): Promise<void> {
  if (corsPreflight(req, reply, origins)) return;

  const session = resolveSession(req, deps);
  if (!session) {
    reply.code(401).headers(corsHeaders(req, origins)).send({ error: 'session-expired' });
    return;
  }
  if (!deps.config.enableServerStorage) {
    reply.code(501).headers(corsHeaders(req, origins)).send({ error: 'disabled' });
    return;
  }

  const body = (req.body ?? {}) as StorageBody;
  if (typeof body.handle !== 'string') {
    reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'invalid-request' });
    return;
  }
  const verified = verifyDocumentHandle(deps.secret, body.handle, session.token);
  if (!verified) {
    reply.code(403).headers(corsHeaders(req, origins)).send({ error: 'invalid-handle' });
    return;
  }

  // Handle the session being destroyed between the two lookups above.
  const alive = deps.sessions.get(session.token);
  if (!alive) {
    reply.code(401).headers(corsHeaders(req, origins)).send({ error: 'session-expired' });
    return;
  }

  const host = verified.host;
  const op = body.op;

  if (op === 'get') {
    if (typeof body.key === 'string') {
      reply.headers(corsHeaders(req, origins)).send({ value: deps.storage.get(alive, host, body.key) });
    } else {
      reply.headers(corsHeaders(req, origins)).send({ items: deps.storage.dump(alive, host) });
    }
    return;
  }

  if (op === 'set') {
    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'invalid-request' });
      return;
    }
    if (body.key.length > 512 || body.value.length > 128 * 1024) {
      reply.code(413).headers(corsHeaders(req, origins)).send({ error: 'too-large' });
      return;
    }
    const ok = deps.storage.set(alive, host, body.key, body.value);
    reply.code(ok ? 200 : 507).headers(corsHeaders(req, origins)).send({ ok });
    return;
  }

  if (op === 'remove') {
    if (typeof body.key !== 'string') {
      reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'invalid-request' });
      return;
    }
    deps.storage.delete(alive, host, body.key);
    reply.headers(corsHeaders(req, origins)).send({ ok: true });
    return;
  }

  if (op === 'clear') {
    deps.storage.clearHost(alive, host);
    reply.headers(corsHeaders(req, origins)).send({ ok: true });
    return;
  }

  reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'unknown-op' });
}

/**
 * Synchronous read used by the runtime to bootstrap a localStorage shim when
 * the content iframe is sandboxed into an opaque origin (single-origin mode).
 */
export async function handleStorageRead(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: AppDeps,
  origins: RequestOrigins,
): Promise<void> {
  if (corsPreflight(req, reply, origins)) return;

  const session = resolveSession(req, deps);
  if (!session) {
    reply.code(401).headers(corsHeaders(req, origins)).send({ error: 'session-expired' });
    return;
  }
  if (!deps.config.enableServerStorage) {
    reply.code(501).headers(corsHeaders(req, origins)).send({ error: 'disabled' });
    return;
  }
  const handle = typeof req.query === 'object' && req.query !== null
    ? (req.query as { handle?: unknown }).handle
    : undefined;
  if (typeof handle !== 'string') {
    reply.code(400).headers(corsHeaders(req, origins)).send({ error: 'invalid-request' });
    return;
  }
  const verified = verifyDocumentHandle(deps.secret, handle, session.token);
  if (!verified) {
    reply.code(403).headers(corsHeaders(req, origins)).send({ error: 'invalid-handle' });
    return;
  }
  reply
    .header('cache-control', 'no-store')
    .headers(corsHeaders(req, origins))
    .send({ items: deps.storage.dump(session, verified.host) });
}
