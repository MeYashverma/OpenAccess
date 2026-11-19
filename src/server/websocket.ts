import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { decodeProxyPath, SESSION_TOKEN_PATTERN } from '../shared/url.js';
import { header, resolveOrigins } from './config.js';
import type { AppDeps } from './deps.js';
import { assertSafeTarget, TargetError } from './ssrf.js';

const WS_ROUTE = /^\/p\/([A-Za-z0-9_-]{16,128})\/__oa\/ws$/;
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);

function rejectSocket(socket: Duplex, status: number, message: string): void {
  if (socket.destroyed) return;
  const body = `${status} ${message}`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

function mapCloseCode(code: number): number {
  if (RESERVED_CLOSE_CODES.has(code)) return 1000;
  if (code < 1000 || code > 4999) return 1000;
  return code;
}

/**
 * WebSocket relay.
 *
 * The page's `WebSocket` constructor is patched by the runtime to point here.
 * We validate the destination exactly like an HTTP request (scheme, port, DNS,
 * private addresses), attach the session cookie jar and rewrite Origin, then
 * relay frames between the browser and the destination.
 */
export function attachWebSocketRelay(server: HttpServer, deps: AppDeps): void {
  const { config } = deps;
  if (!config.enableWebSockets) return;

  const negotiatedByRequest = new WeakMap<IncomingMessage, string>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxWsMessageBytes,
    perMessageDeflate: false,
    clientTracking: false,
    handleProtocols: (protocols, request) => {
      const negotiated = negotiatedByRequest.get(request);
      if (negotiated && protocols.has(negotiated)) return negotiated;
      const first = protocols.values().next();
      return first.done ? false : first.value;
    },
  });

  const perSession = new Map<string, number>();

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rawUrl = req.url ?? '';
    const questionMark = rawUrl.indexOf('?');
    const pathname = questionMark === -1 ? rawUrl : rawUrl.slice(0, questionMark);
    const search = questionMark === -1 ? '' : rawUrl.slice(questionMark + 1);

    const match = WS_ROUTE.exec(pathname);
    if (!match) {
      rejectSocket(socket, 404, 'Not Found');
      return;
    }

    const token = match[1]!;
    if (!SESSION_TOKEN_PATTERN.test(token)) {
      rejectSocket(socket, 400, 'Bad Request');
      return;
    }
    const session = deps.sessions.get(token);
    if (!session) {
      rejectSocket(socket, 401, 'Session expired');
      return;
    }

    const base = `http://${header(req.headers, 'host') ?? 'localhost'}${rawUrl}`;
    let target: URL;
    try {
      const parsed = new URL(base);
      const rawTarget = parsed.searchParams.get('url');
      if (!rawTarget) throw new Error('missing url');
      target = new URL(rawTarget);
      if (target.protocol === 'http:') target.protocol = 'ws:';
      else if (target.protocol === 'https:') target.protocol = 'wss:';
      if (target.protocol !== 'ws:' && target.protocol !== 'wss:') throw new Error('bad protocol');
    } catch {
      rejectSocket(socket, 400, 'Bad Request');
      return;
    }

    // Origin allowlist: only our own content origin, or the opaque origin of a
    // sandboxed content iframe in single-origin mode.
    const origin = header(req.headers, 'origin');
    const httpTarget = new URL(target.href);
    httpTarget.protocol = target.protocol === 'wss:' ? 'https:' : 'http:';
    const requestOrigins = resolveOrigins(config, req.headers);
    const isolated = requestOrigins.mode === 'isolated';
    const allowedOrigin = isolated
      ? origin === requestOrigins.contentOrigin
      : origin === 'null' || origin === requestOrigins.contentOrigin || origin === requestOrigins.publicOrigin;
    if (!allowedOrigin) {
      rejectSocket(socket, 403, 'Forbidden origin');
      return;
    }

    const active = perSession.get(token) ?? 0;
    if (active >= 16) {
      rejectSocket(socket, 429, 'Too many sockets');
      return;
    }
    perSession.set(token, active + 1);

    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      const remaining = (perSession.get(token) ?? 1) - 1;
      if (remaining <= 0) perSession.delete(token);
      else perSession.set(token, remaining);
    };

    void (async () => {
      try {
        await assertSafeTarget(httpTarget, config);
      } catch (error) {
        finish();
        rejectSocket(
          socket,
          error instanceof TargetError ? error.status : 403,
          error instanceof Error && error.message.includes('private') ? 'Blocked destination' : 'Forbidden',
        );
        return;
      }
      if (socket.destroyed) {
        finish();
        return;
      }

      const protocols = (header(req.headers, 'sec-websocket-protocol') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      const headers: Record<string, string> = {
        'user-agent': header(req.headers, 'user-agent') ?? 'Mozilla/5.0 (compatible; OpenAccess)',
        origin: httpTarget.origin,
      };
      const cookie = session.jar.headerFor(httpTarget);
      if (cookie) headers.cookie = cookie;

      const upstream = new WebSocket(target.href, protocols, {
        headers,
        handshakeTimeout: config.upstreamConnectTimeoutMs,
        maxPayload: config.maxWsMessageBytes,
        perMessageDeflate: false,
        followRedirects: false,
        agent: target.protocol === 'wss:' ? deps.wsAgents.https : deps.wsAgents.http,
      });

      let settled = false;

      upstream.on('unexpected-response', (_request, response) => {
        if (settled) return;
        settled = true;
        finish();
        rejectSocket(socket, 502, `Upstream ${response.statusCode ?? 'error'}`);
      });

      upstream.on('error', () => {
        if (settled) return;
        settled = true;
        finish();
        rejectSocket(socket, 502, 'Upstream error');
      });

      upstream.on('open', () => {
        if (settled) return;
        settled = true;
        if (socket.destroyed) {
          upstream.close();
          finish();
          return;
        }
        negotiatedByRequest.set(req, upstream.protocol ?? '');
        wss.handleUpgrade(req, socket, head, (client) => {

          let closed = false;
          const shutdown = (): void => {
            if (closed) return;
            closed = true;
            clearInterval(watchdog);
            finish();
          };

          const watchdog = setInterval(() => {
            if (!deps.sessions.get(token, false)) {
              try {
                client.close(1001, 'Session expired');
                upstream.close(1001, 'Session expired');
              } catch {
                /* ignore */
              }
              shutdown();
            }
          }, 60_000);
          watchdog.unref?.();

          client.on('message', (data, isBinary) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data, { binary: isBinary });
            }
          });

          upstream.on('message', (data, isBinary) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(data, { binary: isBinary });
            }
          });

          const closeBoth = (code: number, reason: Buffer | string): void => {
            const reasonText = typeof reason === 'string' ? reason : reason.toString('utf8');
            if (upstream.readyState === WebSocket.OPEN) upstream.close(mapCloseCode(code), reasonText.slice(0, 120));
            if (client.readyState === WebSocket.OPEN) {
              try {
                client.close(mapCloseCode(code), reasonText.slice(0, 120));
              } catch {
                client.terminate();
              }
            }
            shutdown();
          };

          client.on('close', (code, reason) => closeBoth(code, reason));
          upstream.on('close', (code, reason) => closeBoth(code, reason));
          client.on('error', () => closeBoth(1011, 'client error'));
          upstream.on('error', () => closeBoth(1011, 'upstream error'));
        });
      });
    })();
  });

  server.on('close', () => wss.close());
}

export { decodeProxyPath };
