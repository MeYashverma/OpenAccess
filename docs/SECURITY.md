# Security model

OpenAccess is a public, unauthenticated web proxy. That sentence is the threat model: anyone who can reach the deployment can ask it to fetch an http(s) URL, and the deployment's address is what the destination sees. The design tries to make that safely useful rather than either impossible or an open relay.

This page documents what is defended, how, and what is explicitly out of scope. It is written for operators and for people reviewing the code.

## Trust boundaries

```
user's browser
  ├─ UI origin (PUBLIC_ORIGIN)      trusted shell, strict CSP, no third-party JS
  └─ content origin / sandbox       untrusted third-party documents and scripts
                 │
                 ▼
        OpenAccess process          trusted code, holds cookies and secrets
                 │
                 ▼
        destination sites           untrusted input, untrusted output
```

- The shell and proxied pages are separated by origin in **isolated mode** (`CONTENT_ORIGIN` differs from `PUBLIC_ORIGIN`) or by an opaque-origin sandbox in **shared mode**. Proxied scripts never share a DOM with the shell. The content origin is shared by every destination, which is a separate limitation described below.
- The proxy treats every upstream response as hostile: headers, HTML, scripts, redirect targets, cookies and WebSocket frames are all attacker-controlled.
- The operator is trusted with the deployment and with traffic metadata. OpenAccess does not claim to protect users from the operator.

## SSRF defence

Every outbound connection, HTTP and WebSocket, follows the same path in `src/server/ssrf.ts`.

1. **URL shape** — only `http:`/`https:`; embedded credentials rejected; the hostname is lowercased, IPv6 brackets and trailing dots are normalized.
2. **Port policy** — a default denylist blocks database, mail, management and RPC ports (21, 22, 25, 3306, 5432, 6379, 9200, 27017, 2375, 10250, …). Ports below 1024 other than 80/443 are refused unless an explicit allowlist is configured.
3. **Local names and operator blocks** — `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.lan`, `*.home.arpa`, `metadata.google.internal` and `instance-data` are refused; `BLOCKED_HOSTS` and `BLOCKED_HOST_SUFFIXES` add deployment policy.
4. **Loop protection** — the proxy refuses to fetch its own listener (`host:port` of the configured public/content origins), which prevents request amplification through itself.
5. **Private and reserved addresses** — unless `ALLOW_PRIVATE_TARGETS=1`, loopback, RFC1918, CGNAT, link-local (including 169.254.169.254 cloud metadata), multicast, documentation ranges and IPv6 ULA/link-local/multicast/documentation blocks are rejected. IPv4-mapped IPv6, IPv4-compatible, NAT64 and 6to4 addresses are unwrapped before the check, so `::ffff:127.0.0.1` and friends do not bypass it.
6. **DNS** — names are resolved with `dns.lookup({ all: true })`; every answer must be public. A 30-second cache avoids repeated lookups without pinning an attacker-controlled record for long.
7. **Connect-time revalidation** — the undici dispatcher and the WebSocket agents install a custom `lookup` that checks the exact address the socket is about to connect to. This closes the DNS-rebinding window between validation and connection; a record that flips from a public address to 127.0.0.1 is rejected with `EBLOCKEDTARGET`.
8. **Redirects are not followed server-side** — the browser receives the rewritten 3xx and makes a new request through the proxy, which runs the full policy again. This is both safer and more correct for history.
9. **WebSocket targets** — decoded from the `?url=` parameter and validated identically before a TCP connection is attempted.

### Known SSRF limitations

- DNS rebinding is mitigated at connect time, but the proxy still resolves and connects from the server's network. If the deployment sits inside a privileged network, the port and address policy is the only boundary; do not enable `ALLOW_PRIVATE_TARGETS` on a public instance.
- The proxy can reach any public `http/https` host, including sites that return illegal, abusive or pirated content. That is inherent to a browsing proxy and is a policy problem for the operator, not a bug that can be patched away.
- A destination can make the proxy connect to a host of its choosing (an image URL, a form action, a WebSocket URL). Every such connection is revalidated, so this is not a bypass, but it does mean allowlists must include subresources if you use them.
- `BLOCKED_HOSTS` is a name-based policy. It does not block the same service reached by IP, unless you also block the address or use a network-level egress policy.

## Open-proxy abuse

OpenAccess is intentionally free to use without an account. The controls are limits, not authentication:

| Control | Default | Effect |
| --- | --- | --- |
| `RATE_LIMIT_PER_SESSION` | 1200/min | Caps a single browsing session's request rate |
| `RATE_LIMIT_PER_IP` | 2400/min | Caps all sessions from one address behind the same proxy (`req.ip` uses `X-Forwarded-For` only when `TRUST_PROXY=1`; `X-Forwarded-Host` is likewise trusted only then, for the Codespaces-style forwarded origin) |
| `SESSION_CREATES_PER_HOUR` | 60 | Stops token-farming by dropping and recreating sessions |
| `MAX_CONCURRENT_REQUESTS_PER_SESSION` | 12 | Bounds fan-out per session |
| `MAX_UPLOAD_MB` / `MAX_RESPONSE_MB` | 10 / 30 | Bounds per-request memory |
| `MAX_UPSTREAM_HEADER_KB` | 128 | Bounds the upstream response header block per connection (undici's 16 KiB default rejects real sites such as YouTube) |
| `EGRESS_LIMIT_MB_PER_HOUR` | off | Hard stop when a deployment's bandwidth allowance is consumed |
| `MAX_SESSIONS` | 2000 | LRU eviction, then refusal, bounding memory |

These are not a substitute for edge protection. On a public deployment:

- Put the service behind a platform or CDN that can absorb a DDoS, and set a billing alert.
- Set `EGRESS_LIMIT_MB_PER_HOUR` if egress is metered. It is a blunt process-wide valve by design.
- Watch `/api/health` (sessions, egress) and the platform's network graphs.
- Add `BLOCKED_HOSTS`/`BLOCKED_HOST_SUFFIXES` for destinations you are not willing to serve.
- Consider requiring a reverse-proxy access rule (basic auth, SSO) for private/intranet deployments. OpenAccess itself has no user accounts.

**Cloudflare and similar networks:** Cloudflare's terms prohibit running proxy/VPN services on their network. Do not put this proxy behind Cloudflare Workers/Pages, and review the terms of any CDN you place in front of it. A plain VPS or an application host with explicit permission is the intended deployment.

Rate limiting is in-process. Multiple instances behind a load balancer each enforce their own window; enforce global limits at the edge or move the limiters to a shared store.

## Session and cookie isolation

- A session is a 24-byte random token (32 base64url characters) created by `POST /api/session`. Sessions expire after idle and absolute timeouts; a new session starts with an empty cookie jar and empty site storage.
- Cookies are held in a server-side jar per session and are **never** mirrored into the browser's cookie store. `Set-Cookie` is stripped from proxied responses.
- JavaScript sees only non-HttpOnly cookies through the runtime's `document.cookie` shim. HttpOnly cookies can be sent upstream but cannot be read by page scripts.
- Cookie writes from pages are accepted only with an HMAC-signed document handle. The handle binds the session token and the target host, so a page cannot set cookies for, or read storage of, another destination in the same session.
- Handles are minted with a process-random secret; restarting the process invalidates every handle (and every session).
- Tabs share the session cookie jar, like a browser profile. There is no per-tab cookie partition. Starting a new session clears both cookies and site storage.
- The session token appears in proxy URLs. It is a bearer credential for that session: anyone who obtains a `/p/<token>/…` URL can use the session until it expires. The UI uses `Referrer-Policy: no-referrer`, the proxy rewrites or removes `Referer`/`Origin`, and access logs redact the whole `/p/` path. Treat a proxy URL as sensitive and avoid pasting it into third-party tools.

### Cookie parsing limits

Cookies larger than 4 KiB are ignored, and the jar keeps at most 300 cookies per domain and 3000 per session, evicting the oldest. Domain attributes are accepted only when they domain-match the request host; a `Domain=com`-style public suffix is not accepted as a match for an unrelated host.

## Cross-site isolation within a session

This is the most important limitation of every single-origin rewriting proxy, and OpenAccess is honest about it.

Every proxied destination is served from one **content origin** (or, in shared mode, into sandboxed documents created by that origin). Cookies are separated per destination inside the server jar, but the browser has no way to tell destination A's scripts from destination B's scripts when both are proxied.

What that means in practice:

| Mode | DOM/storage reads between proxied sites | `fetch`/XHR reads between proxied sites |
| --- | --- | --- |
| **Shared** (no `CONTENT_ORIGIN`) | Blocked: each sandboxed document has an opaque origin, so `window.frames[...]` and `localStorage` access across documents is denied. | **Possible**: a page can request another proxied URL and read the response because the proxy grants `Access-Control-Allow-Origin: null` to opaque origins, and the session jar attaches the destination's cookies. |
| **Isolated** (`CONTENT_ORIGIN` set) | **Possible**: documents are same-origin, so a page can read another proxied document's DOM, non-HttpOnly `document.cookie` values and namespaced storage. | **Possible**, without even needing CORS. |

A malicious page could therefore try to read another site that the same session is logged into. The risk is highest when you keep a valuable account open in one tab and visit an untrusted page in another tab of the same session.

Fixes that a future version could implement: per-destination origins with wildcard DNS/TLS, per-tab cookie jars plus a request capability, or a full remote browser. None of these is included today, and none is free of compatibility cost. OpenAccess does not pretend that the `isolated` mode name means isolation between destinations — it only means the content does not share an origin with the UI.

Practical mitigations for users and operators:

- Start a new session (**Menu → Start a new session**) for a sensitive site, then clear it when done. Do not mix untrusted pages into that session.
- Do not use OpenAccess for banking, primary email or other high-value accounts. The UI says this.
- Restrict destinations with `BLOCKED_HOSTS`/`BLOCKED_HOST_SUFFIXES` and treat the deployment as a reading/research tool.
- For a private, trusted set of destinations, isolated mode's real origin gives better site compatibility; for untrusted public browsing, shared mode blocks cross-document reads but not cross-site `fetch` reads.
- A deployment intended for anonymous public use should assume that any page can observe anything the same session can fetch, and size/limit it accordingly.

## Cross-site scripting and the UI

The shell is a normal React application:

- strict CSP on every UI response: `default-src 'self'`, `script-src 'self'`, no `unsafe-inline` scripts, no `unsafe-eval`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`;
- `X-Frame-Options: DENY`, `nosniff`, a restrictive `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`;
- no third-party scripts, fonts, analytics or remote images;
- all user-supplied strings rendered through React, which escapes them; URLs are validated before being placed in `src`/`href`.

Proxied documents are not allowed to script the shell:

- **isolated mode** — different origin; the browser enforces the boundary; `postMessage` is checked against the expected content origin and the expected iframe's `contentWindow`.
- **shared mode** — the iframe is sandboxed without `allow-same-origin`, so its scripts run in an opaque origin. It can `postMessage` with origin `"null"`; the shell accepts `"null"` only in this mode and still requires the message to come from the known frame. URLs in messages are parsed and only `http:`/`https:` destinations are opened.
- The shell never evaluates page-provided HTML, CSS or JavaScript.

Stripping the destination's CSP is a deliberate compatibility trade-off: without it, the injected runtime and most sites' inline scripts would not run. The cost is that a destination's own XSS protections do not apply inside the proxied page. That is contained to the content origin, which is why isolated mode is recommended for public deployments.

## Header and content policy

Proxied response headers are rebuilt from an allowlist perspective: hop-by-hop headers, `Set-Cookie`, CSP (including report-only), `X-Frame-Options`, HSTS, `Public-Key-Pins`, `Alt-Svc`, reporting headers, `Clear-Site-Data`, COOP/COEP/CORP, `Content-Length` (for rewritten bodies) and proxy/CDN noise are removed. `Content-Encoding` is removed only when the proxy decoded it; an encoding it cannot decode is passed through with its header intact. HTML responses are `no-store`.

- `Location` on 3xx is rewritten to an absolute proxy URL; the status is preserved.
- `integrity` and `crossorigin` are removed from subresource tags because rewritten URLs cannot satisfy the original hashes or CORS mode.
- `ping` attributes are removed.
- CORS headers are added only for the opaque-origin case (`Origin: null`), with `Access-Control-Allow-Origin: null`, credentials allowed, and `Vary: Origin`. This is what makes server-backed storage work from a sandboxed iframe. It does **not** grant cross-origin access to arbitrary websites; a browser sends `Origin: null` only for opaque origins.
- Rewritten HTML/CSS is gzipped only for clients that advertise gzip, with `Vary: Accept-Encoding`.

## Request smuggling and header handling

- No inbound body is forwarded without being read to a bounded buffer; `Content-Length` and `Transfer-Encoding` from the client are not copied upstream. undici sets the correct length for buffered bodies.
- Upstream responses are read through undici, which rejects conflicting framing; the proxy does not re-emit ambiguous lengths.
- Hop-by-hop headers (`Connection`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`, `Proxy-*`, HTTP/2 settings) are stripped in both directions.
- `Host`, `Forwarded`, `X-Forwarded-*`, `CF-Connecting-IP`, `True-Client-IP` and `X-OpenAccess-*` from the client are never forwarded upstream.
- An upstream 204/304 is returned without a body and never rewritten. Partial content (206) is streamed and not rewritten.
- Response splitting is prevented by using Node's header APIs and by constructing `Location` from `URL` objects rather than string concatenation.

## Resource exhaustion

- Uploads are capped while streaming; a 413 is returned and the rest of the body is not buffered.
- Rewritten HTML and CSS are capped at `MAX_RESPONSE_MB`; exceeding it returns 502 rather than truncated markup. Decompression happens inside the capped collector, so a compression bomb is bounded by the decoded byte count.
- A process-wide `MAX_BUFFERED_MB` reservation caps all decoded HTML/CSS held at once; requests are rejected with 503 and `Retry-After` instead of growing the heap until the process is killed. Reservations are released in a `finally` path.
- Non-rewritten responses are streamed and counted; the connection is destroyed past the cap.
- Upstream connect/headers/body timeouts are configurable (10s / 20s / 120s by default).
- WebSocket frames are capped at `MAX_WS_MESSAGE_KB` (512 KiB) with no per-message compression; at most 16 sockets per session.
- Sessions are capped and LRU-evicted; rate-limiter maps and the DNS cache are swept and bounded.
- The server sets socket header, request and keep-alive timeouts to limit slow-client attacks.

## Logging and monitoring

- Access logging is **off** by default. When `ACCESS_LOG=1`, one line per request is written with the method, path, status and duration. The path is replaced with `/p/<redacted>` for proxy traffic: session tokens, destination URLs and search terms never appear in access logs.
- Error logging writes the error name and a truncated message, never the request URL.
- `/api/health` and `/healthz` expose status, version, uptime, session count and egress volume. They contain no tokens or destinations.
- Metrics/tracing are not included. Scrape `/api/health` or the platform's metrics if you need more.

## Deployment checklist

- [ ] HTTPS only, with `PUBLIC_ORIGIN` set to the final origin and `TRUST_PROXY=1` only when a known reverse proxy terminates TLS.
- [ ] `CONTENT_ORIGIN` set to a separate hostname for isolated mode (recommended).
- [ ] `ALLOW_PRIVATE_TARGETS` unset or `0`.
- [ ] `EGRESS_LIMIT_MB_PER_HOUR` and platform billing alerts configured.
- [ ] `MAX_SESSIONS`, `MAX_RESPONSE_MB`, `MAX_UPLOAD_MB` sized for the host (a 512 MB free instance cannot hold 2000 large sessions comfortably; 200–400 is realistic).
- [ ] A single instance, or sticky sessions plus a shared session store (not included).
- [ ] `BLOCKED_HOSTS`/`BLOCKED_HOST_SUFFIXES` reviewed for your jurisdiction and policy.
- [ ] Logs, error reports and analytics checked for `/p/` URLs before being enabled.
- [ ] Terms, privacy notice and abuse contact published for your deployment. The AGPL also requires offering source to network users if you modify the software.

## Reporting a vulnerability

Please use GitHub's private **Security → Report a vulnerability** advisory flow on this repository rather than a public issue. Include the affected version, deployment mode (`shared` or `isolated`), reproduction steps and impact. You can expect an acknowledgement and a coordinated disclosure timeline. Do not test against other people's deployments without permission, do not use real credentials, and do not run denial-of-service tests.

## Out of scope

- Protecting users from the deployment operator.
- Anonymity against the destination (the server's IP and TLS fingerprint are visible).
- Defeating CAPTCHAs, bot detection or paywalls.
- Content policy, legality of destinations, or copyright of proxied material.
- Multi-tenant isolation between different users of the same deployment beyond the session boundary described above.
- Browser 0-days, TLS implementation flaws in Node/OpenSSL, or platform-level compromises.
