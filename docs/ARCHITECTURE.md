# Architecture

OpenAccess is one Node.js process with three cooperating parts:

1. **Browser shell** (`src/client`, React) — tabs, toolbar, panels and theme. It never renders third-party HTML itself; it embeds a proxied page in a sandboxed iframe.
2. **Proxy server** (`src/server`, Fastify) — fetches destinations, rewrites HTML/CSS, owns cookies and sessions, enforces policy and limits, and relays WebSockets.
3. **Page runtime** (`src/runtime`, bundled to a single IIFE) — injected into every rewritten HTML document. It patches the browser APIs that would otherwise reveal the proxy path or break relative URLs, and talks to the shell with `postMessage`.

Everything the two sides agree on (URL encoding, message protocol, proxy mode) lives in `src/shared`.

## Request lifecycle

```
GET /p/<token>/https/example.com/article
        │
        ├─ host gate (concat PUBLIC_ORIGIN / CONTENT_ORIGIN) 
        ├─ decodeProxyPath → { token, target URL }
        ├─ session lookup (401 if expired)
        ├─ ip + session fixed-window rate limits (429)
        ├─ hourly egress budget (503)
        ├─ assertSafeTarget: scheme, credentials, port, hostname policy, DNS
        ├─ cookie jar → Cookie header; sanitized request headers
        ├─ undici request with connect-time guarded DNS lookup
        ├─ 3xx? rewrite Location, store Set-Cookie, return status to browser
        ├─ HTML? decode charset → parse5 rewrite → runtime injection → gzip
        ├─ CSS? rewrite url()/import → gzip
        └─ anything else: stream bytes unchanged (range, video, downloads)
```

Redirects are deliberately **not** followed server-side. The browser receives the original status and a rewritten absolute `Location`, so its history, address bar, and cookie handling behave like a normal navigation. A redirect loop is therefore visible to the browser and can be stopped there.

### Proxy URL format

```
/p/<32-char-token>/<scheme>/<host>[:port]<path>[?query]
```

- The token is 24 random bytes, base64url-encoded (32 characters). It is the only session identifier; there are no session cookies.
- `host` is lowercased; the scheme must be `http` or `https`.
- The target's own query string is preserved byte-for-byte, including parameters that the proxy also uses.
- Internal endpoints live under `/p/<token>/__oa/`: `cookie`, `storage`, and the WebSocket route `ws`.

`decodeProxyPath` is shared by the HTTP proxy and the WebSocket relay so both surfaces accept exactly the same destinations and enforce the same token format.

## HTML rewriting

`src/server/rewrite/html.ts` parses with parse5, walks the tree (including `<template>` contents) and:

- drops existing `<base>` elements and injects `<base href="<proxy URL of the document>">`;
- rewrites URL attributes for links, images (including `srcset` parsing that tolerates data-URL commas), scripts, iframes, media/source/track/poster, forms/buttons (`action`, `formaction`), objects, embeds, SVG `image`/`use`, citation attributes, and legacy backgrounds;
- removes `integrity` and `crossorigin` from subresources, because a rewritten URL no longer matches the original SRI hash and proxied requests cannot satisfy credential-mode CORS;
- strips `<meta http-equiv="Content-Security-Policy">` (the response header is stripped too) so the injected runtime is not blocked by the destination's own policy;
- removes `ping` attributes, which would otherwise report to a third party outside the proxy;
- rewrites `style` attributes, `<style>` blocks, and CSS `url()`/`@import` references;
- rewrites meta refresh content and injects the runtime script and bootstrap JSON immediately after `<head>` starts.

The bootstrap is JSON with `<` escaped (`\u003c`) so page content cannot terminate the script element:

```json
{
  "token": "…",
  "target": "https://example.com/article",
  "contentOrigin": "https://openaccess.example",
  "parentOrigin": "https://openaccess.example",
  "mode": "shared",
  "cookie": "pref=dark",
  "handle": "<HMAC-signed document handle>",
  "storage": true
}
```

`cookie` contains only cookies JavaScript is allowed to see: HttpOnly cookies stay in the server jar. The script tag is removed from the DOM on startup.

### Character encodings

HTML and CSS are decoded using the response charset (with a small legacy-encoding map), rewritten as JS strings, and served as UTF-8 with a corrected `Content-Type`. The original `<meta charset>` is replaced. Binary responses are never decoded.

### Compression

Upstream `Content-Encoding` is decoded (`gzip`, `deflate`, `br`) before rewriting and the encoding header is dropped. Encodings the proxy cannot decode are passed through byte-for-byte with their header intact, so the browser receives exactly what the destination sent. Rewritten HTML/CSS is gzipped for clients over 1 KiB when the browser advertises gzip. Other responses stream unchanged with their original length and encoding.

## Page runtime

`src/runtime/index.ts` is compiled to a single self-contained IIFE (no imports at runtime) and served from `/__oa/runtime.js` with an ETag. It is intentionally defensive: every patch is wrapped so one unsupported API cannot abort the rest.

| Browser API | What changes |
| --- | --- |
| `fetch` | Relative URLs are resolved against the document, then rewritten to the proxy path. `Request` objects, `Headers`, signal/abort and body types are preserved. |
| `XMLHttpRequest.open` | Same URL rewriting; response is unaffected. |
| `WebSocket` | Replaced with a socket to `/p/<token>/__oa/ws?url=…`; binary frames, subprotocols and close codes pass through the relay. |
| `navigator.sendBeacon` | Destination rewritten. |
| `document.cookie` | Getter returns the server snapshot; setter posts a cookie string to `/__oa/cookie` with the signed handle. HttpOnly cookies never leak. |
| `localStorage` / `sessionStorage` | In isolated mode, native storage is namespaced with an `oa:<host>:` prefix for collision avoidance (not as a security boundary). In sandboxed same-origin mode, a server-backed shim is used because no native storage exists for an opaque origin. |
| `indexedDB` | A small key/value shim over the same server storage (not a full IndexedDB implementation). |
| `history.pushState` / `replaceState` | URLs are mapped into proxy space; commands from the shell use the same mapping. |
| `window.open` | Opens a new OpenAccess tab through the shell instead of a bare popup (the returned handle is a minimal stub). |
| Clicks and `target=_blank` | Intercepted and reported to the shell; modifier keys and same-tab links keep native behaviour. |
| `window.onerror` | Reported to the shell as a non-fatal script error badge. |
| Messages | Reports ready/navigate/title/favicon/loading/link hover to the parent, and accepts back/forward/reload/stop/navigate/focus. |

The runtime also rewrites URL properties on anchors, areas, images (including `srcset`), scripts, links, iframes, media elements and forms where the browser exposes configurable accessors. This fixes the common script pattern `img.src = '/avatar.png'` that would otherwise resolve against the proxy path on the wrong host.

### Messaging and trust

The shell accepts messages only from the content iframe's `contentWindow` and from the expected content origin (`event.origin`), then validates the message type and every URL. It never injects message data into HTML without escaping. Commands are sent to the iframe with an explicit `targetOrigin`.

In **isolated** mode the content origin differs from the UI origin, so the iframe is same-origin with its own documents and another origin to the shell; every destination still shares that content origin. In **shared** mode the iframe is sandboxed without `allow-same-origin`, which gives it an opaque origin; storage then must be server-backed. The bootstrap advertises the mode so the runtime chooses the correct path. Neither mode isolates destinations from each other at the browser level; see [SECURITY.md](SECURITY.md#cross-site-isolation-within-a-session).

## Cookies

`src/server/cookies.ts` is a small RFC 6265 jar:

- host-only and domain cookies, public-suffix-ish rejection for a domain that does not match the request host, path matching, `Secure`, `HttpOnly`, `SameSite`, `Max-Age`, `Expires`;
- 4 KiB per cookie, 300 cookies per domain, 3000 per session; oldest cookies are evicted first;
- `Set-Cookie` is never forwarded to the browser;
- `Cookie` request headers are built from the jar, so redirects, subresources and WebSocket handshakes all see the same state;
- the `document.cookie` shim updates the same jar, subject to `HttpOnly` and domain rules; the handle binds a write to the host whose document made it.

Cookie isolation is per browsing session, not per tab. Tabs share one jar, like a browser profile. Starting a new session destroys the jar and site storage.

## Sessions and site storage

`SessionStore` holds sessions in memory: random token, creation/seen timestamps, cookie jar, storage maps, inflight counter. Sessions expire after `SESSION_IDLE_MINUTES` and hard-expire after `SESSION_MAX_HOURS`; a sweeper runs every minute. At capacity the least-recently-used session is evicted instead of refusing all new visitors.

Site storage is bounded: `MAX_STORAGE_KB_PER_HOST` per key/value namespace, with a total cap of 20× that per session. Writes are rejected with a quota-style failure past the cap.

The HMAC handle (`src/server/handle.ts`) is generated per document with a process-random secret and contains the session token and target host. It is required for `document.cookie` writes and storage reads/writes, so a page cannot read another host's bucket even if it learns the session token from its own bootstrap.

## WebSockets

The HTTP server's `upgrade` event is handled by `src/server/websocket.ts`:

- path, token, session and `Origin` are validated before any upstream connection;
- the target is decoded from `?url=`, validated with the same SSRF policy, and connected with a guarded DNS lookup;
- the session jar supplies cookies and `Origin` is rewritten to the destination origin;
- frames are relayed in both directions with the configured 512 KiB message cap and no compression;
- close codes are normalized (reserved codes are mapped to 1000) and a watchdog closes sockets when the session expires;
- at most 16 concurrent sockets per session.

## Limits and backpressure

| Control | Where |
| --- | --- |
| Upload cap while reading the request body | `readRequestBody` in `proxy.ts` |
| Response cap for rewritten HTML (`502` past the cap) | `collectBody` |
| Streaming cap for non-rewritten bodies | proxy stream counter |
| Concurrent upstream requests per session (12) | proxy entry |
| Rate limits: ip, session, session creation | `rate-limit.ts` |
| Hourly egress bytes | `HourlyBudget` |
| Decoded HTML/CSS held in memory | `MAX_BUFFERED_MB` reservation in `proxy.ts` |
| HTML/CSS rewrite only under `MAX_RESPONSE_MB` | proxy |

The egress budget counts bytes received from upstream. It is a blunt safety valve for deployments that pay for bandwidth, not a per-user fair-use system.

## Error surfaces

- **UI boot failure** — a static error screen with a retry action.
- **Proxy errors** — branded HTML page for navigations (with technical detail), compact fallback for subresources. Status codes are preserved and a `x-openaccess-error` header is set so the shell and smoke tests can detect them.
- **Expired session** — 401 page plus a shell modal offering a new session.
- **Script errors** — non-blocking badge in the shell; the page keeps running.
- **Slow or refused navigation** — the tab keeps its loading bar, the stop button stops the injected document when there is one, and the destination's or proxy's error page replaces the frame content. The shell does not fabricate content for a page that never arrived.

## Why this design

- **No iframe wrapper of the real site** — an iframe to the destination would be blocked by `X-Frame-Options`/frame-ancestors and would expose the user's IP and browser. All HTML here is fetched and served by the proxy.
- **No Service Worker proxy** — service workers only see requests from their own origin and cannot proxy a top-level navigation of another origin; they also cannot hold the session cookie jar server-side or bypass CORS. They are not used.
- **No headless browser** — a real browser per session costs 1–2 GB of RAM and several Mbps per viewer, which is incompatible with a free deployment. The trade-off is the compatibility list in [COMPATIBILITY.md](COMPATIBILITY.md).
- **Redirects pass through** — preserving browser semantics is worth more than hiding hops, and it avoids server-side redirect loops.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/server/index.ts` | boot, listen, graceful shutdown, WebSocket attach |
| `src/server/app.ts` | Fastify app, host gate, security headers, routes, static assets |
| `src/server/proxy.ts` | proxy request handling, header policy, rewriting, streaming |
| `src/server/ssrf.ts` | target policy, DNS validation, guarded lookup agents |
| `src/server/cookies.ts` | cookie jar |
| `src/server/sessions.ts` | sessions + storage |
| `src/server/handle.ts` | signed document handles |
| `src/server/websocket.ts` | WebSocket relay |
| `src/server/rewrite/html.ts` / `css.ts` | markup and stylesheet rewriting |
| `src/server/internal.ts` | `/__oa/cookie` and `/__oa/storage` |
| `src/server/pages.ts` | branded error pages |
| `src/runtime/index.ts` | injected API shims and messaging |
| `src/shared/url.ts` | proxy URL encode/decode, address parsing, search engines |
| `src/client/App.tsx` | shell state machine, tabs, messaging, keyboard shortcuts |
| `src/client/components/*` | toolbar, tab strip, new tab page, panels, menu |
