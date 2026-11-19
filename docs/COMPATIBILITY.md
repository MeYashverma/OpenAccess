# Compatibility

OpenAccess is a rewriting proxy, not a remote browser. That distinction decides what can work. A remote browser streams pixels, so it is compatible with almost everything but costs 1–2 GB of RAM and several Mbps per session. A rewriting proxy forwards documents and APIs, so it is cheap enough for a free deployment but can only fix the URLs and APIs it knows about.

This page separates three things that are easy to blur together:

- **Verified** — exercised by the automated suite or a documented manual check in this repository.
- **Implemented** — the mechanism exists and is covered by the design, but no test suite can certify every third-party site.
- **Not supported** — there is no working path, and the product says so in the UI.

No claim of universal compatibility is made anywhere in this project. If a site matters to you, test it on your deployment and report the result.

## What is verified automatically

The test suite starts a local fixture server and proxies it with the real application. These are assertions about the proxy, not about any particular public website.

| Behaviour | Test |
| --- | --- |
| Public config, session create/validate/destroy, no secret leakage | `tests/integration.test.ts` |
| Rewritten HTML with `<base>`, runtime injection, escaped bootstrap | `tests/integration.test.ts`, `tests/runtime.test.ts` |
| Upstream CSP, `X-Frame-Options`, HSTS and `Set-Cookie` stripped | `tests/integration.test.ts` |
| HttpOnly cookies withheld from the page's `document.cookie` | `tests/integration.test.ts` |
| Absolute URLs rewritten; relative URLs resolved by `<base>` | `tests/rewrite.test.ts`, `tests/integration.test.ts` |
| CSS `url()`, `@import`, inline styles | `tests/rewrite.test.ts`, `tests/integration.test.ts` |
| Binary images byte-identical; JSON unchanged; gzip decoded | `tests/integration.test.ts` |
| Redirects (relative and cross-origin) returned with rewritten `Location` | `tests/integration.test.ts` |
| POST bodies, cookies, form content types | `tests/integration.test.ts` |
| Client cookies and forwarding headers never reach upstream | `tests/integration.test.ts` |
| `HEAD`, destination 404, CORS preflight | `tests/integration.test.ts` |
| Runtime `fetch`, XHR, WebSocket, `history`, `document.cookie`, Web Storage, URL setters, click interception, `window.open` | `tests/runtime.test.ts` |
| WebSocket relay with cookies and origin checks | `tests/integration.test.ts` |
| SSRF blocks (loopback, private ranges, metadata, DNS/IPv6 normalisation) | `tests/ssrf.test.ts`, `tests/integration.test.ts` |
| Upload cap, response cap, rate limits, egress budget, runtime ETag/304 | `tests/integration.test.ts` |
| Shell boots, navigation, tabs, bookmarks, theme, history | `tests/ui.test.tsx` |
| Isolated content origin: host gate, redirects, bootstrap origins, API isolation | `tests/isolated.test.ts` |
| Full deployment health/config/proxy/limits flow | `scripts/smoke.mjs` |

What is **not** covered by automation: rendering fidelity, per-site JavaScript behaviour, anti-bot decisions, OAuth providers, DRM and real-device mobile behaviour. Those are described as expectations below, not guarantees.

## Capability matrix

| Capability | Status | Mechanism and caveats |
| --- | --- | --- |
| Static HTML, documentation, news, wikis | Works well | HTML rewriting plus `<base>`. Relative links and assets are resolved by the browser against the proxied document. |
| CSS, fonts, background images | Works | CSS `url()` and `@import` rewritten; font files proxied. |
| Images, SVG, `srcset` | Works | `src`/`srcset`/`poster` rewritten; source sets parsed without splitting data URLs. |
| Client-rendered SPAs | Usually works | `fetch`, XHR and WebSocket are patched; history APIs are mapped; API calls to the same origin are rewritten. |
| Same-origin APIs and JSON | Works | Plain JSON passthrough; cookies attached from the jar. |
| Cross-origin APIs (CORS) | Conditional | The destination must allow the proxied request. The browser's request reaches the destination from the server; its `Origin` is rewritten to the target origin. APIs that allowlist by client IP or require a browser fingerprint can fail. |
| Forms (GET and POST) | Works | `action`/`formaction` rewritten; multipart, urlencoded and JSON bodies forwarded; uploads capped by `MAX_UPLOAD_MB`. |
| Redirects and back/forward | Works | Redirects are returned, not followed, so the browser keeps its own history. The toolbar mirrors the iframe history through the runtime. |
| Cookies and log-in | Usually works | Server-side jar with domain/path/secure/HttpOnly/SameSite handling. Multi-page log-ins work. Sites that require third-party cookies, device binding or WebAuthn may not. |
| HTTP Basic authentication | Partial | The 401 challenge may appear; embedded credentials in URLs are rejected for security. |
| OAuth / SSO pop-ups | Often broken | `window.open` becomes an OpenAccess tab, so the popup→opener relationship (and `postMessage` handshake) is lost. Redirect-based SSO can work. |
| CAPTCHAs and bot checks | Often broken | Datacenter addresses and shared sessions are commonly flagged. OpenAccess does not attempt to defeat bot protection. |
| WebSockets | Works, capped | Relayed frames, binary support, subprotocols, session cookies and origin rewrite. 512 KiB message cap, 16 sockets per session, no compression. |
| Server-Sent Events | Works | Plain streaming response; no proxy buffering of text/event-stream. |
| Large downloads | Works within limits | Binary streaming with range support; the response/egress caps still apply. |
| Video and audio playback | Usually works | Range requests pass through; media URLs are rewritten. HLS/DASH via MSE and blob URLs generally work if the player uses fetch/XHR. |
| DRM video (Widevine, FairPlay) | Not supported | Requires a trusted origin, device attestation and often CORS/COOP/COEP conditions no proxy can satisfy. |
| Service workers | Not supported | A service worker registered under the proxy path would see the wrong URL space and break cache/offline semantics. OpenAccess does not register one for pages. |
| IndexedDB | Limited shim | Only the key/value surface used by the runtime; not a spec-complete implementation. Complex schema/version upgrades can fail. |
| Web Storage | Works with caveats | Namespaced `localStorage` in isolated mode (prefixes avoid collisions, not cross-site reads); server-backed shim in shared mode. 512 KiB per host by default. |
| Web Workers | Usually works | Worker script URLs are rewritten, so relative imports resolve under the proxy path. A worker's `fetch()` is not patched by the page runtime; absolute URLs are safest. |
| SharedArrayBuffer / high-resolution timers | Not supported | Cross-origin isolation headers are not served for proxied content. |
| WebGL, canvas, audio APIs | Usually works | Runs in the local browser. Fingerprinting surfaces remain, though the IP is the server's. |
| WebAuthn / passkeys | Not supported | Requires the RP ID to match the page origin; the page origin is the proxy's. |
| Payment Request, Web Bluetooth, USB, Serial | Not supported | Permissions policy and origin restrictions; the UI does not grant them. |
| Geolocation, mic, camera | Not supported | The shell's permissions policy disables these for the UI and proxied pages. |
| Notifications, clipboard read | Not supported / partial | Clipboard writes are allowed by the iframe policy; permission prompts behave inconsistently and are not relied on. |
| PDF and plain text | Partial | Displayed by the browser inside the frame, but the runtime is not injected, so toolbar history/favicon integration is absent. Downloads work. |
| `srcdoc` iframes | Limited | Kept as-is; relative URLs inside a `srcdoc` document are not proxied because it has no proxy base. |
| Import maps / `import()` from inline modules | Limited | Inline `<script type="module">` text is not rewritten; absolute specifiers and relative ones resolved by `<base>`/document URL usually work. |
| `javascript:` URLs and `blob:` URLs | Left alone | They execute in the proxied document's context. Service workers and some blob-navigation patterns still fail. |
| Pages that navigate the top window | Partial | Programmatic `window.top.location = …` is blocked by the frame sandbox. A real user click on a `target=_top` link is allowed (it may load the proxied page or leave the shell), which is normal browser behaviour. |
| `X-Frame-Options` / `frame-ancestors` | Bypassed | The headers are stripped so the proxied page can be framed by the shell. |
| Upstream CSP | Stripped | Necessary for the injected runtime and inline event handlers. This is a real security trade-off, documented in [SECURITY.md](SECURITY.md). |
| `Content-Security-Policy: sandbox` and COOP/COEP | Stripped | Cross-origin isolation and popup isolation cannot be preserved through a proxy. |

## Authentication in detail

Most consumer log-ins are ordinary form posts or same-site redirects and work through the cookie jar. The failure modes are specific:

1. **Popup OAuth** (a provider opens a popup and posts a token to `window.opener`). OpenAccess opens a tab, not a popup, and the opener is null. Redirect-mode OAuth is more likely to work.
2. **Device-bound sessions** (passkeys, platform authenticators, TLS client certificates, hardware keys). The page origin is the proxy origin, so the relying party ID does not match.
3. **Third-party cookie requirements** (an identity provider embedded in an iframe on another site). Browsers are phasing these out, and OpenAccess does not implement a cross-site cookie layer.
4. **Bot and risk checks** (CAPTCHA, Cloudflare challenges, "unusual traffic" pages). The destination sees the proxy's IP and a session that may be shared by many tabs. These are intentionally not circumvented.
5. **IP allowlists and geo-fencing**. The destination sees the server's address and location, not the user's.

When a site rejects a proxied login, the UI cannot fix it. Use your normal browser for that account; OpenAccess is for reading, research and public information, not for high-value accounts.

## Streaming and media

- **Server-Sent Events** stream through because non-HTML responses are piped, not buffered. Note that the egress budget is charged as bytes arrive.
- **Range requests** (`Range`, `If-Range`, `206`, `Content-Range`) are forwarded and returned unchanged, which is what video seeking needs.
- **HLS/DASH** players that fetch segments with `fetch`/XHR work. Players that rely on a native media stack and absolute segment URLs usually still work because segment URLs are rewritten.
- **DRM** requires EME, which needs a secure, attested origin; it is out of scope.
- **WebRTC** is not tunnelled. Data channels can work, but camera/microphone capture is blocked by the iframe permission policy, so calls do not. Any RTC traffic that does occur goes directly between the browser and the peer, outside the proxy, and would reveal the user's address. The UI does not advertise WebRTC as anonymous.

## JavaScript-heavy sites

The runtime patches the APIs that most applications use, but it cannot patch everything:

- `window.location.href = '/next'` is a real navigation. The browser resolves it against the current document URL, which is already a proxy URL, so same-origin paths keep working. A full external URL set on `location` is resolved as an absolute URL and leaves the proxy; this is a known escape, not a feature.
- `document.domain`, `window.parent` assumptions, cross-origin frames, `postMessage` target origins, and code that reads `location.origin` will observe proxy origins. Some applications build absolute URLs at runtime; most still work because the paths remain valid under the proxy.
- Inline scripts and `eval` run normally because CSP is stripped. Minified bundles are not rewritten, so a URL composed at runtime is only as good as the document base and the patched constructors.
- `import()` of absolute third-party modules works if CORS allows it; relative modules resolve against the proxied document.

## Mobile and browser support

The shell targets current Chrome, Edge, Firefox and Safari. It uses standard React/DOM APIs, a responsive layout, a mobile tab sheet and `viewport-fit=cover`. The injected runtime is a single IIFE targeting Chrome 100, Firefox 100 and Safari 15. It still assumes the patched DOM APIs exist and fails soft when one is missing. There is no support for Internet Explorer.

## Reporting a compatibility problem

A report is actionable when it includes:

- the destination URL (or a minimal public reproduction),
- the deployment origin and `PUBLIC_ORIGIN`/`CONTENT_ORIGIN` mode,
- what you expected and what happened,
- the browser and version,
- whether the failure is a 4xx/5xx from OpenAccess, a blank frame, a console error, or wrong page behaviour.

Open an issue using the format in [CONTRIBUTING.md](../CONTRIBUTING.md). Do not include cookies, session tokens or personal data from a logged-in page.
