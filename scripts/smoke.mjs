#!/usr/bin/env node
/**
 * End-to-end smoke test for a running OpenAccess deployment.
 *
 *   npm run smoke                                   # http://localhost:3000
 *   SMOKE_BASE=https://openaccess.example npm run smoke
 *   SMOKE_TARGET=https://example.org/ npm run smoke
 *
 * Flags:
 *   --base <url>        deployment origin (default: SMOKE_BASE or localhost:3000)
 *   --target <url>      page to fetch through the proxy (default: SMOKE_TARGET
 *                       or https://example.com/)
 *   --unsafe-targets    the deployment sets ALLOW_PRIVATE_TARGETS=1, so skip the
 *                       checks that expect loopback/metadata addresses to be blocked
 *   --offline           only check local endpoints and the UI; do not require
 *                       outbound access to the public web
 *
 * The script only uses global fetch (Node 20+) and exits non-zero if a check
 * fails, so it can run as a post-deploy verification step in CI.
 */
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const base = option('base', process.env.SMOKE_BASE ?? 'http://localhost:3000').replace(/\/$/, '');
const target = option('target', process.env.SMOKE_TARGET ?? 'https://example.com/');
const unsafeTargets = flag('unsafe-targets');
const offline = flag('offline');

let contentBase = base;
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
}

async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    record(name, true, `${detail ?? 'ok'} (${Date.now() - started}ms)`);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    return await fetch(`${base}${path}`, { redirect: 'manual', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Content-origin request. In isolated mode the UI origin 307s /p/ paths. */
async function contentRequest(path, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    return await fetch(`${contentBase}${path}`, { redirect: 'manual', ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const session = { token: null, handle: null };

await check('health endpoint', async () => {
  const res = await request('/healthz');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const text = await res.text();
  assert(text.trim() === 'ok', `unexpected body: ${text.slice(0, 40)}`);
  return '200 ok';
});

let config = null;
await check('public config', async () => {
  const res = await request('/api/config');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  config = await res.json();
  assert(typeof config.version === 'string', 'missing version');
  assert(config.mode === 'shared' || config.mode === 'isolated', `unexpected mode ${config.mode}`);
  assert(typeof config.contentOrigin === 'string', 'missing contentOrigin');
  contentBase = config.contentOrigin.replace(/\/$/, '');
  return `v${config.version}, ${config.mode} mode`;
});

await check('browser shell', async () => {
  const res = await request('/');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const html = await res.text();
  assert(html.includes('id="root"'), 'root element missing');
  assert(html.includes('OpenAccess'), 'branding missing');
  assert(!html.includes('%OA_PUBLIC_ORIGIN%'), 'origin placeholder was not substituted');
  assert(!/http:\/\/localhost/.test(html) || base.includes('localhost'), 'social preview points at localhost');
  return `${html.length} bytes of HTML`;
});

await check('robots.txt', async () => {
  const res = await request('/robots.txt');
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert((await res.text()).includes('Disallow: /'), 'expected a full disallow');
  return 'disallow all';
});

await check('session creation', async () => {
  const res = await request('/api/session', { method: 'POST' });
  assert(res.status === 200, `expected 200, got ${res.status} (are sessions rate limited?)`);
  const body = await res.json();
  assert(/^[A-Za-z0-9_-]{32}$/.test(body.token ?? ''), 'token has an unexpected shape');
  assert(body.mode === config.mode, 'session mode does not match config');
  session.token = body.token;
  return `token ${body.token.slice(0, 6)}…`;
});

await check('session validation', async () => {
  assert(session.token, 'no session token');
  const res = await request(`/api/session/${session.token}`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.valid === true, 'session not reported valid');
  return 'valid';
});

await check('malformed proxy path', async () => {
  const res = await contentRequest('/p/not-a-token/nonsense');
  assert(res.status === 400, `expected 400, got ${res.status}`);
  assert(res.headers.get('x-openaccess-error') === '400', 'missing branded error header');
  return '400 branded error';
});

await check('runtime asset + etag', async () => {
  const first = await contentRequest('/__oa/runtime.js');
  assert(first.status === 200, `expected 200, got ${first.status}`);
  const etag = first.headers.get('etag');
  assert(etag, 'missing ETag');
  assert((first.headers.get('content-type') ?? '').includes('javascript'), 'wrong content type');
  await first.text();
  const second = await contentRequest('/__oa/runtime.js', { headers: { 'if-none-match': etag } });
  assert(second.status === 304, `expected 304, got ${second.status}`);
  return '200 → 304';
});

await check('private addresses are blocked', async () => {
  if (unsafeTargets) return 'skipped (ALLOW_PRIVATE_TARGETS=1)';
  assert(session.token, 'no session token');
  for (const address of [
    `http://169.254.169.254/latest/meta-data/`,
    `http://127.0.0.1:22/`,
    `http://[::1]/`,
  ]) {
    const res = await contentRequest(`/p/${session.token}/http/${address.replace(/^http:\/\//, '')}`, {
      headers: { accept: 'text/html' },
    });
    assert(res.status === 403, `${address} returned ${res.status}, expected 403`);
  }
  return 'metadata + loopback rejected';
});

await check('forged runtime handle is rejected', async () => {
  assert(session.token, 'no session token');
  const res = await contentRequest(`/p/${session.token}/__oa/storage?handle=forged`, {
    headers: { origin: 'null' },
  });
  assert(res.status === 403, `expected 403, got ${res.status}`);
  return '403 invalid-handle';
});

if (!offline) {
  await check('proxy fetches and rewrites a live page', async () => {
    assert(session.token, 'no session token');
    const parsed = new URL(target);
    const path = `/p/${session.token}/${parsed.protocol.replace(':', '')}/${parsed.host}${parsed.pathname}${parsed.search}`;
    const res = await contentRequest(path, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert(res.status === 200, `expected 200, got ${res.status} (outbound access may be blocked)`);
    const html = await res.text();
    assert(html.includes('__oa-bootstrap'), 'no bootstrap payload — page was not rewritten');
    const match = /<script id="__oa-bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
    assert(match, 'bootstrap script tag missing');
    const bootstrap = JSON.parse(match[1]);
    assert(bootstrap.token === session.token, 'bootstrap token mismatch');
    assert(bootstrap.target === parsed.href, `bootstrap target ${bootstrap.target} !== ${parsed.href}`);
    assert(typeof bootstrap.parentOrigin === 'string', 'missing parent origin');
    assert(bootstrap.mode === config.mode, 'bootstrap mode mismatch');
    assert(html.includes('<base href='), 'no base element');
    session.handle = bootstrap.handle;
    return `${html.length} bytes from ${parsed.host}`;
  });

  await check('site storage round-trips for the document', async () => {
    if (!session.handle) return 'skipped (no document handle)';
    const key = `smoke-${Date.now()}`;
    const write = await contentRequest(`/p/${session.token}/__oa/storage`, {
      method: 'POST',
      headers: { origin: 'null', 'content-type': 'application/json' },
      body: JSON.stringify({ handle: session.handle, op: 'set', key, value: 'ok' }),
    });
    assert(write.status === 200, `storage write returned ${write.status}`);
    const read = await contentRequest(
      `/p/${session.token}/__oa/storage?handle=${encodeURIComponent(session.handle)}`,
      { headers: { origin: 'null' } },
    );
    assert(read.ok, `expected 2xx, got ${read.status}`);
    const body = await read.json();
    assert(body.items && body.items[key] === 'ok', 'stored value missing from snapshot');
    return 'write + read';
  });
}

const width = Math.max(...results.map((row) => row.name.length));
for (const row of results) {
  const mark = row.ok ? 'PASS' : 'FAIL';
  process.stdout.write(`${mark}  ${row.name.padEnd(width)}  ${row.detail}\n`);
}
process.stdout.write(
  `\n${results.length - failed}/${results.length} checks passed against ${base}` +
    `${contentBase !== base ? ` (content origin ${contentBase})` : ''}${offline ? ' (offline mode)' : ''}\n`,
);
process.exit(failed === 0 ? 0 : 1);
