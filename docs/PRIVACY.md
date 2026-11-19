# Privacy

OpenAccess is designed to collect as little as possible. It has no accounts, no analytics, no advertising, no third-party scripts and no database. That is a property of the code, not a policy promise: you can verify it in `src/`.

## What the server holds

While a browsing session is active, the server process holds in memory:

| Data | Purpose | Lifetime |
| --- | --- | --- |
| Session token | Identifies the browsing session | Idle and absolute timeouts (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`), or server restart |
| Cookie jar | Sends the right cookies to destinations | Same as the session |
| Site storage | `localStorage`-style values for proxied pages | Same as the session |
| Client IP | Per-IP rate limiting; `createdFrom` on the session record | Until the session is evicted; never written to disk |
| Request counters and bytes | Rate limits, concurrency, egress budget | Rolling windows in memory |

Nothing above is written to disk by OpenAccess. A restart destroys all of it and signs every user out of proxied sites. There is no session database and no backup of session data.

## What the server logs

Access logging is **off** by default.

When an operator sets `ACCESS_LOG=1`, each request produces one line with the timestamp, method, a redacted path, status code and duration. Proxy paths are logged as `/p/<redacted>`, so session tokens, destination URLs, paths and query strings are not written. Error logs contain the error name and a truncated message, not the request URL. `/api/health` exposes only aggregate counts.

The platform that hosts the deployment (Render, a VPS provider, a reverse proxy) may still log the client IP, the public origin, request sizes and timings at the network edge. That is outside OpenAccess's control and is disclosed by the operator's own privacy notice.

## What destinations can see

- The **server's** IP address, TLS fingerprint, user agent header (forwarded from the user's browser) and the request headers the proxy forwards.
- The session's cookies for that destination.
- The `Referer` and `Origin` headers rewritten to the destination origin, so a site sees a normal same-origin request rather than a proxy URL.
- The time of the request.

Destinations do **not** see the user's IP address, the OpenAccess URL, or the browser's real origin. They can still fingerprint the browser with JavaScript (canvas, fonts, WebGL, audio) because the page runs locally; OpenAccess does not normalise or spoof those surfaces.

## What stays in the user's browser

The shell stores these in the browser's `localStorage` for the public origin:

- `oa.session` — the current session token;
- `oa.settings` — theme, search engine, home page and history preference;
- `oa.bookmarks` — bookmarks;
- `oa.history` — visited pages, if history is enabled;
- `oa.introDismissed` — the getting-started card dismissal.

Open tabs are stored in `sessionStorage` so they survive a reload of the shell but not a new browser session. Clearing browsing data in **Menu → Settings → Privacy** removes all of the above, ends the server-side session and starts a new one.

Clearing data in the normal browser's settings for the deployment origin does the same for local state; the server-side session remains until it expires.

## Cookies and third-party requests

The proxied page runs on the deployment's content origin (or an opaque sandbox). Its cookies are held server-side, not in the user's browser cookie store. Requests made by the page are proxied, so destination scripts do not contact the user directly — with two exceptions the proxy cannot prevent:

- **WebRTC** traffic, if a page uses it, can go directly to a peer and reveal the user's address. Camera and microphone permissions are denied by the iframe policy, so calls do not work, but data channels can.
- **Escaping navigations** such as `window.top.location = 'https://example.com'` are blocked by the iframe sandbox; `location.href = 'https://example.com'` in the proxied document loads through the proxy. A new top-level window opened by a link could leave the proxy if a site deliberately constructs an unproxied URL; the runtime rewrites what it can.

## Data sharing

The software shares nothing with the project authors. There is no telemetry endpoint, no update check, no remote configuration and no third-party SDK. Search suggestions and pages are fetched only because the user or the page asked for them.

If an operator adds analytics, error reporting, a CDN or a database, that operator is responsible for disclosing it. This repository does not include such integrations.

## User choices

- Use **Start a new session** to discard cookies, site storage and server state immediately.
- Turn off history in Settings to stop local visit recording.
- Use **Clear browsing data** to remove local bookmarks/history and end the session.
- Do not use OpenAccess for sensitive accounts. The operator can observe traffic volume and timing, and the destination sees a shared server address.

## Children and sensitive data

OpenAccess is a general-purpose browsing tool, not a service with accounts or profiles. It does not knowingly collect personal information beyond the transient data above. Operators who deploy it for a specific audience should publish their own notice covering jurisdiction, retention at the hosting layer, abuse contact and applicable age requirements.

## Changes

If a future change adds storage, logging, analytics or a third-party service, this document and the UI's **About** panel must be updated in the same change. Privacy claims that are not true in the code should be treated as bugs.
