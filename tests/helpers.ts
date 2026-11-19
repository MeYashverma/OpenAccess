import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type AppConfig } from '../src/server/config.js';
import { createDeps } from '../src/server/deps.js';
import { buildApp } from '../src/server/app.js';

export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export const HOME_HTML = `<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<title>Fixture home</title>
<link rel="stylesheet" href="/style.css" integrity="sha256-abc">
<link rel="preconnect" href="https://cdn.example.net">
<style>.hero{background:url(/img.png)}</style>
</head><body>
<h1 id="title">Fixture home</h1>
<a id="relative" href="page2.html">relative</a>
<a id="absolute" href="/page2.html?x=1">absolute</a>
<a id="external" href="https://example.org/out">external</a>
<img id="img" src="img.png" srcset="img.png 1x, /img2.png 2x" crossorigin="anonymous">
<form id="form" action="/post" method="post"><input name="q" value="hello"><button>Send</button></form>
<script src="/app.js"></script>
</body></html>`;

export interface Fixture {
  origin: string;
  port: number;
  hits: string[];
  close: () => Promise<void>;
}

/** A small site used to prove proxying behaviour end to end. */
export async function startFixture(): Promise<Fixture> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    hits.push(`${req.method} ${url.pathname}`);

    if (url.pathname === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': ['sid=abc123; Path=/; HttpOnly', 'pref=dark; Path=/'],
      });
      res.end(HOME_HTML);
      return;
    }
    if (url.pathname === '/page2.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Page two</title></head><body><p id="two">two</p></body></html>');
      return;
    }
    if (url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('@import "/other.css"; .a{background:url(/img.png)} .b{background:url(rel.png)}');
      return;
    }
    if (url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('window.appLoaded = true;');
      return;
    }
    if (url.pathname === '/img.png' || url.pathname === '/img2.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
      return;
    }
    if (url.pathname === '/echo-cookie') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`cookie=${req.headers.cookie ?? ''}`);
      return;
    }
    if (url.pathname === '/set-cookie') {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'set-cookie': ['token=xyz; Path=/; HttpOnly; SameSite=Lax'],
      });
      res.end('set');
      return;
    }
    if (url.pathname === '/headers-page') {
      res.writeHead(200, {
        'content-type': 'text/html',
        'content-security-policy': "default-src 'none'",
        'x-frame-options': 'DENY',
        'strict-transport-security': 'max-age=31536000',
        'set-cookie': 'hdronly=1; Path=/',
      });
      res.end('<html><head><title>Headers</title></head><body><p id="headers">ok</p></body></html>');
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { location: '/final?from=redirect' });
      res.end();
      return;
    }
    if (url.pathname === '/redirect-absolute') {
      res.writeHead(301, { location: 'https://example.org/target' });
      res.end();
      return;
    }
    if (url.pathname === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (url.pathname === '/final') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>Final</title></head><body><p id="final">final page</p><a href="next.html">next</a></body></html>');
      return;
    }
    if (url.pathname === '/post' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(
          `method=${req.method} body=${body} cookie=${req.headers.cookie ?? ''} referer=${req.headers.referer ?? ''} origin=${req.headers.origin ?? ''}`,
        );
      });
      return;
    }
    if (url.pathname === '/echo-headers') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.headers));
      return;
    }
    if (url.pathname === '/gzip') {
      const out = gzipSync('<html><head><title>Zipped</title></head><body><p id="zipped">gzipped</p></body></html>');
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(out);
      return;
    }
    if (url.pathname === '/large-html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body>${'<p>padding</p>'.repeat(5000)}</body></html>`);
      return;
    }
    if (url.pathname === '/large-binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      for (let index = 0; index < 40; index++) res.write(Buffer.alloc(64 * 1024));
      res.end();
      return;
    }
    if (url.pathname === '/etag') {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"', 'content-type': 'text/html; charset=utf-8' });
        res.end();
      } else {
        res.writeHead(200, { etag: '"v1"', 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>etag</title></head><body>etag body</body></html>');
      }
      return;
    }
    if (url.pathname === '/range') {
      res.writeHead(206, {
        'content-type': 'text/plain',
        'content-range': 'bytes 0-3/10',
        'accept-ranges': 'bytes',
      });
      res.end('0123');
      return;
    }
    if (url.pathname === '/unsupported-encoding') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-encoding': 'zstd',
      });
      res.end(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]));
      return;
    }
    if (url.pathname === '/json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"hello":"world"}');
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('slow');
      }, 800);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body><h1 id="missing">fixture 404</h1></body></html>');
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    socket.send(`welcome:${req.headers.cookie ?? 'none'}`);
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: async () => {
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface TestApp {
  origin: string;
  config: AppConfig;
  app: FastifyInstance;
  close: () => Promise<void>;
}

export async function startApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const config = loadConfig({
    ALLOW_PRIVATE_TARGETS: '1',
    ...overrides,
  });
  const deps = createDeps(config);
  const app = buildApp(deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    config,
    app,
    close: async () => {
      await app.close();
    },
  };
}

export async function createSession(appOrigin: string): Promise<string> {
  const response = await fetch(`${appOrigin}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

export function proxyUrl(appOrigin: string, token: string, target: string, scheme = 'http'): string {
  const url = new URL(target);
  return `${appOrigin}/p/${token}/${scheme}/${url.host}${url.pathname}${url.search}`;
}
