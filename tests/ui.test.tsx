/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url":"http://localhost:3000/"}
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/client/App.js';

const TOKEN = 'T'.repeat(32);

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

const config = {
  version: '1.0.0',
  mode: 'isolated' as const,
  contentOrigin: 'http://localhost:3000',
  features: { websockets: true, serverStorage: true },
  limits: {
    maxUploadMb: 10,
    maxResponseMb: 30,
    sessionIdleMinutes: 120,
    sessionMaxHours: 12,
    rateLimitPerMinute: 1200,
  },
};

beforeEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/config') return jsonResponse(config);
      if (url === '/api/session') {
        return jsonResponse({
          token: TOKEN,
          expiresAt: Date.now() + 3600_000,
          idleExpiresAt: Date.now() + 3600_000,
          mode: 'isolated',
          contentOrigin: 'http://localhost:3000',
        });
      }
      if (url.startsWith('/api/session/')) {
        return jsonResponse({
          valid: true,
          token: TOKEN,
          expiresAt: Date.now() + 3600_000,
          mode: 'isolated',
          contentOrigin: 'http://localhost:3000',
        });
      }
      return jsonResponse({});
    }),
  );
});

describe('browser shell', () => {
  it('boots into a session and shows the new tab page', async () => {
    render(<App />);
    expect(await screen.findByPlaceholderText(/Search with DuckDuckGo/)).toBeTruthy();
    expect(screen.getByLabelText('Address and search bar')).toBeTruthy();
    expect(screen.getByText(/A browser that runs in your browser/)).toBeTruthy();
    expect(localStorage.getItem('oa.session')).toBe(TOKEN);
  });

  it('navigates the active tab through the proxy when an address is entered', async () => {
    const user = userEvent.setup();
    render(<App />);
    const address = await screen.findByLabelText('Address and search bar');
    await user.click(address);
    await user.type(address, 'example.com{Enter}');

    await waitFor(() => {
      const frame = document.querySelector('iframe.page-frame') as HTMLIFrameElement | null;
      expect(frame).toBeTruthy();
      expect(frame!.getAttribute('src')).toBe(`http://localhost:3000/p/${TOKEN}/https/example.com/`);
      expect(frame!.getAttribute('sandbox')).toContain('allow-same-origin');
    });

    expect((address as HTMLInputElement).value).toBe('https://example.com');
  });

  it('opens and closes tabs', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(/Search with DuckDuckGo/);
    expect(screen.getAllByRole('tab')).toHaveLength(1);

    await user.click(screen.getAllByLabelText('New tab')[0]!);
    expect(screen.getAllByRole('tab')).toHaveLength(2);

    await user.click(screen.getAllByLabelText(/^Close /)[0]!);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
  });

  it('adds and removes a bookmark from the address bar', async () => {
    const user = userEvent.setup();
    render(<App />);
    const address = await screen.findByLabelText('Address and search bar');
    await user.click(address);
    await user.type(address, 'https://example.com/page{Enter}');

    const star = await screen.findByLabelText('Bookmark this page');
    await user.click(star);
    expect(await screen.findByText('Bookmark added')).toBeTruthy();

    const stored = JSON.parse(localStorage.getItem('oa.bookmarks') ?? '[]') as Array<{ url: string }>;
    expect(stored[0]?.url).toBe('https://example.com/page');

    await user.click(screen.getByLabelText('Remove bookmark'));
    expect(await screen.findByText('Bookmark removed')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('oa.bookmarks') ?? '[]')).toHaveLength(0);
  });

  it('applies the theme setting and opens panels from the menu', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByPlaceholderText(/Search with DuckDuckGo/);

    await user.click(screen.getByLabelText('Open menu'));
    const menu = screen.getByRole('menu');
    await user.click(within(menu).getByText('Settings'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Appearance')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    const stored = JSON.parse(localStorage.getItem('oa.settings') ?? '{}') as { theme?: string };
    expect(stored.theme).toBe('light');
  });

  it('records visited pages in local history', async () => {
    const user = userEvent.setup();
    render(<App />);
    const address = await screen.findByLabelText('Address and search bar');
    await user.click(address);
    await user.type(address, 'https://example.com/read{Enter}');

    const frame = (await waitFor(() => {
      const element = document.querySelector('iframe.page-frame');
      expect(element).toBeTruthy();
      return element;
    })) as HTMLIFrameElement;

    // Simulate the runtime reporting a completed navigation.
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'http://localhost:3000',
        source: frame.contentWindow,
        data: {
          __oa: true,
          type: 'navigate',
          url: 'https://example.com/read',
          title: 'Reading',
        },
      }),
    );

    await waitFor(() => {
      const history = JSON.parse(localStorage.getItem('oa.history') ?? '[]') as Array<{ url: string }>;
      expect(history[0]?.url).toBe('https://example.com/read');
    });
    expect(document.title).toContain('Reading');
  });
});
