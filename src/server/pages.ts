/**
 * Server-rendered pages for the content origin: proxy error states and the
 * "not found" page. They intentionally use the same visual language as the
 * browser shell so a failure inside the iframe does not look like a different
 * product.
 */

export interface ErrorPageOptions {
  status: number;
  title: string;
  message: string;
  host?: string;
  detail?: string;
  retry?: boolean;
  homeOrigin?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderErrorPage(options: ErrorPageOptions): string {
  const { status, title, message, host, detail, retry = true, homeOrigin } = options;
  const homeButton = homeOrigin
    ? `<a class="button secondary" href="${escapeHtml(homeOrigin)}" target="_top">Open OpenAccess</a>`
    : '';
  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · OpenAccess</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0b0d10;
    --panel: #12151a;
    --border: #242a33;
    --text: #e8eaed;
    --muted: #9aa3af;
    --accent: #7aa2ff;
    --danger: #ff8a80;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --border: #e3e6eb;
      --text: #15181d;
      --muted: #5d6672;
      --accent: #2b5bd7;
      --danger: #b3261e;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: grid;
    place-items: center;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: min(560px, 100%);
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 28px;
    box-shadow: 0 24px 60px rgba(0,0,0,0.18);
  }
  .mark {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 20px;
  }
  .mark svg { width: 18px; height: 18px; }
  .code { color: var(--danger); font-size: 12px; font-weight: 600; letter-spacing: 0.06em; }
  h1 { font-size: 21px; line-height: 1.3; margin: 8px 0 10px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 12px; color: var(--muted); }
  .host {
    display: inline-block;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px;
    color: var(--text);
    background: color-mix(in srgb, var(--border) 45%, transparent);
    border: 1px solid var(--border);
    padding: 3px 8px;
    border-radius: 6px;
    margin-bottom: 14px;
    word-break: break-all;
  }
  details { margin: 16px 0 0; }
  summary { cursor: pointer; color: var(--muted); font-size: 13px; }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px;
    font-size: 12px;
    color: var(--muted);
    margin: 10px 0 0;
  }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 22px; }
  .button {
    appearance: none;
    border: 1px solid var(--border);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--text);
    border-radius: 8px;
    padding: 9px 14px;
    font: inherit;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
  }
  .button:hover { border-color: var(--accent); }
  .button.secondary { background: transparent; color: var(--muted); }
  .foot { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <div class="mark">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="9"></circle>
        <path d="M3.5 12h17M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"></path>
      </svg>
      OpenAccess
    </div>
    <div class="code">HTTP ${status}</div>
    <h1>${escapeHtml(title)}</h1>
    ${host ? `<div class="host">${escapeHtml(host)}</div>` : ''}
    <p>${escapeHtml(message)}</p>
    ${detail ? `<details><summary>Technical detail</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}
    <div class="actions">
      ${retry ? `<button class="button" type="button" onclick="location.reload()">Try again</button>` : ''}
      ${homeButton}
    </div>
    <div class="foot">
      OpenAccess never sends your real browsing session to the destination site. If you reached this page while following a link,
      the address may be private, unavailable, or blocked by this deployment's policy.
    </div>
  </main>
</body>
</html>`;
}

export function renderNotFoundPage(homeOrigin?: string): string {
  return renderErrorPage({
    status: 404,
    title: 'This page is not part of OpenAccess',
    message: 'The address does not belong to a proxied browsing session. Open the OpenAccess home page to start browsing.',
    retry: false,
    homeOrigin,
  });
}
