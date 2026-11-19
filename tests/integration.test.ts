import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createSession, proxyUrl, startApp, startFixture, type Fixture, type TestApp } from './helpers.js';

let fixture: Fixture;
let app: TestApp;
let token: string;

beforeAll(async () => {
  fixture = await startFixture();
  app = await startApp();
  token = await createSession(app.origin);
});

afterAll(async () => {
  await app?.close();
  await fixture?.close();
});

const base = () => proxyUrl(app.origin, token, `${fixture.origin}/`);
const proxied = (path: string) => `${base()}${path.replace(/^\//, '')}`;

describe('public API', () => {
  it('serves configuration and health without leaking secrets', async () => {
    const config = (await (await fetch(`${app.origin}/api/config`)).json()) as Record<string, unknown>;
    expect(config.mode).toBe('shared');
    expect(config.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(JSON.stringify(config)).not.toContain(token);
    const health = await fetch(`${app.origin}/api/health`);
    expect(health.status).toBe(200);
    for (const asset of ['/theme-init.js', '/manifest.webmanifest', '/favicon.svg', '/og.png']) {
      expect((await fetch(`${app.origin}${asset}`)).status, asset).toBe(200);
    }
    expect(((await health.json()) as { status: string }).status).toBe('ok');
  });

  it('creates, validates and destroys sessions', async () => {
    const created = await fetch(`${app.origin}/api/session`, { method: 'POST', body: '{}' });
    expect(created.status).toBe(200);
    const info = (await created.json()) as { token: string; mode: string };
    expect(info.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const check = await fetch(`${app.origin}/api/session/${info.token}`);
    expect(check.status).toBe(200);
    const removed = await fetch(`${app.origin}/api/session/${info.token}`, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect((await fetch(`${app.origin}/api/session/${info.token}`)).status).toBe(404);
  });

  it('rejects unknown sessions with an explanatory page', async () => {
    const response = await fetch(`${app.origin}/p/${'Z'.repeat(32)}/http/127.0.0.1:1/`, {
      headers: { accept: 'text/html' },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('browsing session has ended');
  });
});

describe('reverse proxy headers', () => {
  it('derives the public origin from X-Forwarded-Host when trusted', async () => {
    const proxied = await startApp();
    try {
      const response = await proxied.app.inject({
        method: 'GET',
        url: '/api/config',
        headers: {
          host: '127.0.0.1:3000',
          'x-forwarded-host': 'openaccess.example',
          'x-forwarded-proto': 'https',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ contentOrigin: 'https://openaccess.example' });
    } finally {
      await proxied.close();
    }
  });
});

describe('HTML proxying', () => {
  let body: string;
  let response: Response;

  beforeAll(async () => {
    response = await fetch(base(), { headers: { accept: 'text/html' } });
    body = await response.text();
  });

  it('returns rewritten HTML with a proxy base and the runtime', () => {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(body).toContain(`<base href="${base()}">`);
    expect(body).toContain('/__oa/runtime.js');
    expect(body).toContain(`/p/${token}/http/${new URL(fixture.origin).host}/style.css`);
  });

  it('strips upstream CSP, frame and cookie headers', () => {
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(body).not.toContain('Content-Security-Policy');
  });

  it('captures cookies into the server-side jar', async () => {
    const echoed = await fetch(proxied('/echo-cookie'));
    expect(await echoed.text()).toBe('cookie=sid=abc123; pref=dark');
  });

  it('does not expose proxied cookies to JavaScript', () => {
    const bootstrap = /<script id="__oa-bootstrap" type="application\/json">(.*?)<\/script>/.exec(body);
    expect(bootstrap).not.toBeNull();
    const parsed = JSON.parse(
      bootstrap![1]!.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'),
    ) as { cookie: string; token: string; handle: string };
    expect(parsed.token).toBe(token);
    expect(parsed.cookie).toBe('pref=dark'); // HttpOnly cookie is withheld
    expect(parsed.cookie).not.toContain('abc123');
    expect(parsed.handle).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('rewrites absolute URLs but leaves relative URLs to the base', () => {
    expect(body).toContain(
      `href="${app.origin}/p/${token}/http/${new URL(fixture.origin).host}/page2.html?x=1"`,
    );
    expect(body).toContain('href="page2.html"');
    expect(body).toContain('src="img.png"');
    expect(body).not.toContain('integrity=');
    expect(body).not.toContain('crossorigin=');
  });

  it('strips security headers from a page that sets them', async () => {
    const page = await fetch(proxied('/headers-page'), { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBeNull();
    expect(page.headers.get('x-frame-options')).toBeNull();
    expect(page.headers.get('strict-transport-security')).toBeNull();
    expect(page.headers.get('set-cookie')).toBeNull();
    expect(await page.text()).toContain('id="headers"');
  });
});

describe('assets, redirects and methods', () => {
  it('rewrites CSS through the proxy', async () => {
    const css = await fetch(`${base()}style.css`);
    const text = await css.text();
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(text).toContain(`${app.origin}/p/${token}/http/${new URL(fixture.origin).host}/img.png`);
    expect(text).toContain('url(rel.png)');
  });

  it('passes binary images through byte-for-byte', async () => {
    const image = await fetch(`${base()}img.png`);
    const bytes = Buffer.from(await image.arrayBuffer());
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  });

  it('returns browser-followable redirects with proxied Location headers', async () => {
    const redirect = await fetch(`${base()}redirect`, { redirect: 'manual', headers: { accept: 'text/html' } });
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get('location');
    expect(location).toBe(
      `${app.origin}/p/${token}/http/${new URL(fixture.origin).host}/final?from=redirect`,
    );

    const followed = await fetch(location!, { headers: { accept: 'text/html' } });
    const text = await followed.text();
    expect(text).toContain('id="final"');
    expect(text).toContain(
      `<base href="${app.origin}/p/${token}/http/${new URL(fixture.origin).host}/final?from=redirect">`,
    );
    expect(text).toContain('href="next.html"');
  });

  it('rewrites absolute redirects across origins', async () => {
    const redirect = await fetch(`${base()}redirect-absolute`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe(`${app.origin}/p/${token}/https/example.org/target`);
  });

  it('forwards POST bodies, cookies and rewritten Origin/Referer', async () => {
    const response = await fetch(`${base()}post`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        referer: `${base()}page2.html`,
        origin: app.origin,
      },
      body: 'q=hello&x=1',
    });
    const text = await response.text();
    expect(text).toContain('method=POST');
    expect(text).toContain('body=q=hello&x=1');
    expect(text).toContain('cookie=sid=abc123; pref=dark');
    expect(text).toContain(`referer=${fixture.origin}/page2.html`);
    expect(text).toContain(`origin=${fixture.origin}`);
  });

  it('does not leak the client cookie or forwarding headers upstream', async () => {
    const response = await fetch(`${base()}echo-headers`, {
      headers: {
        cookie: 'ui_session=secret',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
      },
    });
    const headers = (await response.json()) as Record<string, string>;
    expect(headers.cookie).toContain('sid=abc123');
    expect(headers.cookie).toContain('pref=dark');
    expect(headers.cookie).not.toContain('ui_session');
    expect(headers['x-forwarded-for']).toBeUndefined();
    expect(headers['x-real-ip']).toBeUndefined();
    expect(headers['accept-encoding']).toBe('identity');
  });

  it('decompresses gzip-encoded HTML before rewriting it', async () => {
    const response = await fetch(`${base()}gzip`);
    const text = await response.text();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(text).toContain('id="zipped"');
    expect(text).toContain('__oa/runtime.js');
  });

  it('gzips rewritten HTML when the client accepts gzip', async () => {
    const url = new URL(base());
    const response = await new Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      const req = http.get(
        {
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers: { accept: 'text/html', 'accept-encoding': 'gzip' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        },
      );
      req.on('error', reject);
    });
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toContain('accept-encoding');
    const html = gunzipSync(response.body).toString('utf8');
    expect(html).toContain('<base href=');
    expect(html).toContain('id="__oa-bootstrap"');
  });

  it('keeps an encoding it cannot decode instead of mislabelling the body', async () => {
    const response = await fetch(`${base()}unsupported-encoding`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('zstd');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02]),
    );
  });

  it('passes upstream 304 responses through without injecting a body', async () => {
    const response = await fetch(`${base()}etag`, {
      headers: { accept: 'text/html', 'if-none-match': '"v1"' },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
    expect(response.headers.get('etag')).toBe('"v1"');
  });

  it('streams partial content without rewriting it', async () => {
    const response = await fetch(`${base()}range`);
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10');
    expect(await response.text()).toBe('0123');
  });

  it('passes JSON through unchanged', async () => {
    const response = await fetch(`${base()}json`);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"hello":"world"}');
  });

  it('supports HEAD requests', async () => {
    const response = await fetch(base(), { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('passes destination 404 responses through', async () => {
    const response = await fetch(`${base()}missing`, { headers: { accept: 'text/html' } });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('fixture 404');
  });

  it('answers CORS preflights locally in single-origin mode', async () => {
    const response = await fetch(`${base()}post`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('null');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('internal runtime endpoints', () => {
  const getHandle = async (): Promise<string> => {
    const html = await (await fetch(base(), { headers: { accept: 'text/html' } })).text();
    const match = /<script id="__oa-bootstrap" type="application\/json">(.*?)<\/script>/.exec(html);
    const parsed = JSON.parse(
      match![1]!.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'),
    ) as { handle: string };
    return parsed.handle;
  };

  it('stores and reads per-host values with a signed handle', async () => {
    const handle = await getHandle();
    const set = await fetch(`${app.origin}/p/${token}/__oa/storage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, op: 'set', key: 'token', value: 'abc' }),
    });
    expect(set.status).toBe(200);

    const read = await fetch(
      `${app.origin}/p/${token}/__oa/storage?handle=${encodeURIComponent(handle)}`,
    );
    expect(await read.json()).toEqual({ items: { token: 'abc' } });

    const removed = await fetch(`${app.origin}/p/${token}/__oa/storage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, op: 'remove', key: 'token' }),
    });
    expect(removed.status).toBe(200);
    const empty = await fetch(
      `${app.origin}/p/${token}/__oa/storage?handle=${encodeURIComponent(handle)}`,
    );
    expect(await empty.json()).toEqual({ items: {} });
  });

  it('rejects forged or missing handles', async () => {
    const response = await fetch(`${app.origin}/p/${token}/__oa/storage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'forged.value', op: 'set', key: 'a', value: 'b' }),
    });
    expect(response.status).toBe(403);
  });

  it('applies document.cookie writes to the jar', async () => {
    const handle = await getHandle();
    const response = await fetch(`${app.origin}/p/${token}/__oa/cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, cookie: 'fromjs=1; Path=/' }),
    });
    expect(response.status).toBe(200);
    const echoed = await (await fetch(proxied('/echo-cookie'))).text();
    expect(echoed).toContain('fromjs=1');
  });
});

describe('WebSocket relay', () => {
  it('relays messages and forwards cookies', async () => {
    const target = `${fixture.origin.replace('http', 'ws')}/ws`;
    const url = `ws://127.0.0.1:${new URL(app.origin).port}/p/${token}/__oa/ws?url=${encodeURIComponent(target)}`;
    const messages = await new Promise<string[]>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { origin: 'null' } });
      const received: string[] = [];
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('websocket timeout'));
      }, 5000);
      socket.on('message', (data) => {
        received.push(data.toString());
        if (received.length === 1) socket.send('hello');
        if (received.length === 2) {
          clearTimeout(timer);
          socket.close();
          resolve(received);
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    expect(messages[0]).toMatch(/^welcome:.*sid=abc123/);
    expect(messages[0]).toContain('fromjs=1');
    expect(messages[1]).toBe('echo:hello');
  });

  it('refuses sockets from foreign origins', async () => {
    const target = `${fixture.origin.replace('http', 'ws')}/ws`;
    const url = `ws://127.0.0.1:${new URL(app.origin).port}/p/${token}/__oa/ws?url=${encodeURIComponent(target)}`;
    const error = await new Promise<Error>((resolve) => {
      const socket = new WebSocket(url, { headers: { origin: 'https://evil.example' } });
      socket.on('error', (err) => resolve(err));
      socket.on('open', () => {
        socket.close();
        resolve(new Error('unexpectedly opened'));
      });
    });
    expect(error.message).toMatch(/403|Unexpected server response/i);
  });
});

describe('safety limits', () => {
  it('blocks private destinations when private targets are disabled', async () => {
    const strict = await startApp({ ALLOW_PRIVATE_TARGETS: '0' });
    try {
      const strictToken = await createSession(strict.origin);
      const url = proxyUrl(strict.origin, strictToken, `${fixture.origin}/`);
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('private');
    } finally {
      await strict.close();
    }
  });

  it('blocks cloud metadata addresses', async () => {
    const strict = await startApp({ ALLOW_PRIVATE_TARGETS: '0' });
    try {
      const strictToken = await createSession(strict.origin);
      const response = await fetch(
        `${strict.origin}/p/${strictToken}/http/169.254.169.254/latest/meta-data/`,
        { headers: { accept: 'text/html' } },
      );
      expect(response.status).toBe(403);
      expect(await response.text()).toContain('private');
    } finally {
      await strict.close();
    }
  });

  it('enforces the upload limit', async () => {
    const limited = await startApp({ MAX_UPLOAD_MB: '0.001' });
    try {
      const limitedToken = await createSession(limited.origin);
      const url = `${proxyUrl(limited.origin, limitedToken, `${fixture.origin}/post`)}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(4096),
      });
      expect(response.status).toBe(413);
    } finally {
      await limited.close();
    }
  });

  it('refuses oversized HTML rather than serving broken markup', async () => {
    const limited = await startApp({ MAX_RESPONSE_MB: '0.02' });
    try {
      const limitedToken = await createSession(limited.origin);
      const url = proxyUrl(limited.origin, limitedToken, `${fixture.origin}/large-html`);
      const response = await fetch(url, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(502);
      expect(await response.text()).toContain('too large');
    } finally {
      await limited.close();
    }
  });

  it('sheds load when the global rewrite buffer is exhausted', async () => {
    const small = await startApp({ MAX_BUFFERED_MB: '0.0005' });
    try {
      const smallToken = await createSession(small.origin);
      const response = await fetch(proxyUrl(small.origin, smallToken, `${fixture.origin}/`));
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('3');
      expect(await response.text()).toContain('busy');
      // The reservation must be released after the rejection.
      expect(small.app.server.listening).toBe(true);
    } finally {
      await small.close();
    }
  });

  it('rate limits a session', async () => {
    const limited = await startApp({ RATE_LIMIT_PER_SESSION: '2' });
    try {
      const limitedToken = await createSession(limited.origin);
      const url = proxyUrl(limited.origin, limitedToken, `${fixture.origin}/json`);
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(url)).status).toBe(200);
      const third = await fetch(url);
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
    } finally {
      await limited.close();
    }
  });

  it('stops serving when the hourly egress budget is exhausted', async () => {
    const limited = await startApp({ EGRESS_LIMIT_MB_PER_HOUR: '0.0001' });
    try {
      const limitedToken = await createSession(limited.origin);
      const home = proxyUrl(limited.origin, limitedToken, `${fixture.origin}/`);
      expect((await fetch(home)).status).toBe(200);
      const second = await fetch(proxyUrl(limited.origin, limitedToken, `${fixture.origin}/json`));
      expect(second.status).toBe(503);
    } finally {
      await limited.close();
    }
  });

  it('serves the runtime asset with caching headers and ETag support', async () => {
    const first = await fetch(`${app.origin}/__oa/runtime.js`);
    expect(first.headers.get('content-type')).toContain('javascript');
    const etag = first.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const second = await fetch(`${app.origin}/__oa/runtime.js`, { headers: { 'if-none-match': etag } });
    expect(second.status).toBe(304);
  });
});
