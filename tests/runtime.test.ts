/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"http://localhost:3000/p/TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT/https/example.com/dir/page"}
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeBootstrap } from '../src/shared/runtime.js';

const TOKEN = 'T'.repeat(32);
const bootstrap: RuntimeBootstrap = {
  token: TOKEN,
  target: 'https://example.com/dir/page',
  contentOrigin: 'http://localhost:3000',
  parentOrigin: 'http://localhost:3000',
  mode: 'isolated',
  cookie: 'seen=1',
  handle: 'payload.signature',
  storage: false,
};

const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
const xhrOpenMock = vi.fn();

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
}

const nativeLocalStorage = window.localStorage;

beforeAll(async () => {
  document.head.innerHTML += `<script id="__oa-bootstrap" type="application/json">${JSON.stringify(
    bootstrap,
  )}</script>`;

  window.fetch = fetchMock as unknown as typeof window.fetch;
  XMLHttpRequest.prototype.open = xhrOpenMock as unknown as typeof XMLHttpRequest.prototype.open;
  (window as unknown as Record<string, unknown>).WebSocket = FakeWebSocket;

  await import('../src/runtime/index.js');
});

describe('injected page runtime', () => {
  it('consumes its bootstrap and removes it from the DOM', () => {
    expect(document.getElementById('__oa-bootstrap')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__openaccess).toMatchObject({
      target: 'https://example.com/dir/page',
      mode: 'isolated',
    });
  });

  it('rewrites fetch() to the proxy', async () => {
    await window.fetch('/api/items');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://localhost:3000/p/${TOKEN}/https/example.com/api/items`,
      undefined,
    );

    await window.fetch('https://other.example/data');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://localhost:3000/p/${TOKEN}/https/other.example/data`,
      undefined,
    );

    await window.fetch('relative.json');
    expect(fetchMock).toHaveBeenLastCalledWith(
      `http://localhost:3000/p/${TOKEN}/https/example.com/dir/relative.json`,
      undefined,
    );

    await window.fetch('data:text/plain,hi');
    expect(fetchMock).toHaveBeenLastCalledWith('data:text/plain,hi', undefined);
  });

  it('rewrites XMLHttpRequest.open()', () => {
    const request = new XMLHttpRequest();
    request.open('GET', '/rpc');
    expect(xhrOpenMock).toHaveBeenLastCalledWith(
      'GET',
      `http://localhost:3000/p/${TOKEN}/https/example.com/rpc`,
    );
  });

  it('routes WebSocket connections through the relay', () => {
    const socket = new (window as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket(
      'wss://chat.example/socket',
    );
    expect(socket.url).toBe(
      `ws://localhost:3000/p/${TOKEN}/__oa/ws?url=${encodeURIComponent('wss://chat.example/socket')}`,
    );
  });

  it('maps history.pushState URLs into proxy space', () => {
    history.pushState({}, '', '/dashboard');
    expect(location.pathname).toBe(`/p/${TOKEN}/https/example.com/dashboard`);

    // Relative history URLs resolve like the browser would: the last path
    // segment is replaced because /dashboard has no trailing slash.
    history.pushState({}, '', 'settings');
    expect(location.pathname).toBe(`/p/${TOKEN}/https/example.com/settings`);
    history.pushState({}, '', 'nested/page');
    expect(location.pathname).toBe(`/p/${TOKEN}/https/example.com/nested/page`);
  });

  it('shims document.cookie with the server-side jar', async () => {
    expect(document.cookie).toBe('seen=1');
    document.cookie = 'added=2; Path=/';
    expect(document.cookie).toContain('added=2');
    document.cookie = 'added=; Max-Age=0';
    expect(document.cookie).not.toContain('added=2');

    const cookieCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith(`/p/${TOKEN}/__oa/cookie`),
    );
    expect(cookieCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(String((cookieCalls[0]![1] as RequestInit).body)) as {
      handle: string;
      cookie: string;
    };
    expect(body.handle).toBe('payload.signature');
    expect(body.cookie).toBe('added=2; Path=/');
  });

  it('namespaces Web Storage per destination site', () => {
    window.localStorage.setItem('theme', 'dark');
    expect(window.localStorage.getItem('theme')).toBe('dark');
    expect(nativeLocalStorage.getItem('oa:example.com:theme')).toBe('dark');
    expect(window.localStorage.length).toBeGreaterThan(0);

    window.sessionStorage.setItem('tabstate', 'x');
    expect(window.sessionStorage.getItem('tabstate')).toBe('x');
    window.localStorage.removeItem('theme');
    expect(window.localStorage.getItem('theme')).toBeNull();
    expect(nativeLocalStorage.getItem('oa:example.com:theme')).toBeNull();
  });

  it('rewrites URL properties set by scripts', () => {
    const image = document.createElement('img');
    image.src = '/picture.png';
    expect(image.getAttribute('src')).toBe(
      `http://localhost:3000/p/${TOKEN}/https/example.com/picture.png`,
    );

    const script = document.createElement('script');
    script.setAttribute('src', 'https://cdn.example/app.js');
    expect(script.getAttribute('src')).toBe(
      `http://localhost:3000/p/${TOKEN}/https/cdn.example/app.js`,
    );

    const link = document.createElement('a');
    link.href = '/docs';
    expect(link.getAttribute('href')).toBe(
      `http://localhost:3000/p/${TOKEN}/https/example.com/docs`,
    );
  });

  it('intercepts clicks that would leave the frame', () => {
    const blank = document.createElement('a');
    blank.href = 'https://other.example/';
    blank.target = '_blank';
    document.body.appendChild(blank);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    blank.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    const sameTab = document.createElement('a');
    sameTab.href = '/local';
    document.body.appendChild(sameTab);
    const normalClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    sameTab.dispatchEvent(normalClick);
    expect(normalClick.defaultPrevented).toBe(false);
  });

  it('replaces window.open with a safe stub', () => {
    const opened = window.open('https://other.example/', '_blank');
    expect(opened).toBeTruthy();
    expect((opened as Window & { closed: boolean }).closed).toBe(false);
    opened?.close();
    expect((opened as Window & { closed: boolean }).closed).toBe(true);
  });
});
