import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, startFixture, type Fixture, type TestApp } from './helpers.js';

let fixture: Fixture;
let app: TestApp;

const PUBLIC = 'http://public.test';
const CONTENT = 'http://content.test';

async function inject(path: string, host: string, method = 'GET', headers: Record<string, string> = {}) {
  return app.app.inject({ method: method as 'GET', url: path, headers: { host, ...headers } });
}

beforeAll(async () => {
  fixture = await startFixture();
  app = await startApp({ PUBLIC_ORIGIN: PUBLIC, CONTENT_ORIGIN: CONTENT });
});

afterAll(async () => {
  await app?.close();
  await fixture?.close();
});

describe('isolated content origin', () => {
  it('serves the UI on the public host and reports isolated mode', async () => {
    const page = await inject('/', 'public.test');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('id="root"');
    const config = await inject('/api/config', 'public.test');
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ mode: 'isolated', contentOrigin: CONTENT });
    expect(config.headers['content-security-policy']).toContain(`frame-src ${CONTENT}`);
  });

  it('redirects proxy paths from the public host to the content host', async () => {
    const response = await inject('/p/not-a-token/https/example.com/', 'public.test');
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe(`${CONTENT}/p/not-a-token/https/example.com/`);
  });

  it('keeps the API unreachable on the content host and redirects its root', async () => {
    expect((await inject('/api/config', 'content.test')).statusCode).toBe(404);
    const root = await inject('/', 'content.test');
    expect(root.statusCode).toBe(302);
    expect(root.headers.location).toBe(`${PUBLIC}/`);
  });

  it('rejects hostnames that match neither origin', async () => {
    const response = await inject('/', 'unknown.test');
    expect(response.statusCode).toBe(421);
    expect(response.body).toContain('public.test');
    expect(response.body).toContain('content.test');
  });

  it('proxies content with parent and content origins in the bootstrap', async () => {
    const created = await inject('/api/session', 'public.test', 'POST');
    const token = (created.json() as { token: string }).token;
    const target = fixture.origin.replace(/^http:\/\//, '');
    const page = await inject(`/p/${token}/http/${target}/`, 'content.test', 'GET', {
      accept: 'text/html',
    });
    expect(page.statusCode).toBe(200);
    const match = /<script id="__oa-bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(page.body);
    expect(match).toBeTruthy();
    const bootstrap = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(bootstrap).toMatchObject({
      token,
      contentOrigin: CONTENT,
      parentOrigin: PUBLIC,
      mode: 'isolated',
    });
    expect(bootstrap.handle).toMatch(/\./);
    expect(page.body).toContain(`<base href="${CONTENT}/p/${token}/http/${target}/">`);
  });

  it('does not expose HttpOnly cookies in the bootstrap', async () => {
    const created = await inject('/api/session', 'public.test', 'POST');
    const token = (created.json() as { token: string }).token;
    const target = fixture.origin.replace(/^http:\/\//, '');
    const page = await inject(`/p/${token}/http/${target}/`, 'content.test', 'GET', {
      accept: 'text/html',
    });
    const match = /<script id="__oa-bootstrap" type="application\/json">([\s\S]*?)<\/script>/.exec(page.body);
    const bootstrap = JSON.parse(match![1]!) as { cookie: string };
    expect(bootstrap.cookie).toContain('pref=dark');
    expect(bootstrap.cookie).not.toContain('sid=abc123');
  });
});
