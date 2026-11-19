# OpenAccess

**A browser in your browser.** OpenAccess is a free, open-source web browsing platform that fetches pages on a server, rewrites them, and serves them back into an app-like tabbed interface. It is an independent implementation written in TypeScript and Node.js — not a wrapper around an existing proxy engine and not an iframe mash-up.

- Real server-side proxying: HTML, CSS, scripts, fetch/XHR, forms, redirects, cookies, uploads and WebSockets pass through the proxy.
- A complete browsing shell: address bar with search, back/forward/reload/home, tabs you can restore, bookmarks, history, settings, loading and error states, dark/light themes and a mobile layout.
- Security work is part of the product: SSRF defences with connect-time revalidation, per-session rate limits and cookie isolation, an egress budget, and a strict CSP on the UI.
- No paid APIs, no accounts, no analytics, no third-party JS. One Node process and its own static assets.

[CI](.github/workflows/ci.yml) · [How it works](docs/ARCHITECTURE.md) · [Compatibility](docs/COMPATIBILITY.md) · [Security](docs/SECURITY.md) · [Deploy](docs/DEPLOYMENT.md) · [Research notes](docs/RESEARCH.md)

---

## Honest status

This repository contains a working, tested proxy and UI. It does **not** ship a permanently hosted public instance: a proxy needs a real server process, so it cannot live on GitHub Pages or any static host. GitHub can still host a live URL through **Codespaces** (a real container with a public forwarded HTTPS port), and the fastest permanent path is the free Render blueprint below (about five minutes, no card) or `docker compose up --build` on any machine you control.

Compatibility is documented rather than promised. The automated suite exercises the proxy against a local fixture site — HTML/CSS rewriting, cookies, fetch/XHR/WebSocket relaying, redirects, gzip, binary passthrough and every limit — but no test suite can certify every website. Sites that actively block datacenter traffic, rely on device attestation, or demand cross-origin-isolated browser APIs will break, and [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) says which and why.

## Features

| Area | What is implemented |
| --- | --- |
| Browsing | Server-side HTTP(S) proxy, address bar with search fallback, back/forward/reload/stop/home, up to 12 tabs, session tab restore, full screen |
| Pages | HTML and CSS rewriting, injected runtime, proxied fetch/XHR/WebSocket/sendBeacon, form submissions, file uploads, downloads, redirects, gzip/br/deflate decoding, byte-identical binary streaming, range requests |
| State | Per-session server-side cookie jar, `document.cookie` shim, localStorage/IndexedDB shims for proxied pages, signed per-document handles |
| Interface | Dark/light/system theme, bookmarks, local history, six search engines, configurable home page, confirmations, toasts, keyboard shortcuts, responsive toolbar and mobile tab sheet |
| Safety | SSRF validation at request time and at connect time, port policy, session/ip/creation rate limits, concurrency caps, upload/response size caps, hourly egress budget, optional host blocklists |
| Operations | Health endpoints, redacted access logs, Docker image, Render blueprint, GitHub Actions CI, post-deploy smoke script |

## How it works

```
                    ┌──────────────────────────────────────────────┐
                    │ OpenAccess process (Node.js + Fastify)       │
                    │                                              │
  browser tab       │  /                 UI bundle (React)         │
  ┌───────────┐     │  /api/*            config + session API      │
  │  toolbar  │◄───►│  /p/<token>/...    proxy + injected runtime  │
  │  iframe   │     │  /__oa/runtime.js  page runtime (ES5 bundle) │
  └───────────┘     │                                              │
        │           │   cookie jar   session store   rate limits   │
        │           └───────────────┬──────────────────────────────┘
        │                           │ validated outbound HTTP(S)
        ▼                           ▼
   rewritten page  ◄──────────  destination website
```

A proxied URL is `/p/<session-token>/<scheme>/<host>[:port]<path>`. HTML is parsed with `parse5`, every URL-bearing attribute and inline stylesheet is rewritten, a `<base>` element and a bootstrap payload are injected, and the runtime patches the browser APIs that would otherwise leak the proxy origin or the user's address. Redirects are returned to the browser rather than followed, so the browser's own back/forward and address semantics keep working. Cookies are held in a server-side jar per session and never exposed to JavaScript except through the proxied `document.cookie` interface.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full request lifecycle and code map.

## Quick start

Requirements: Node.js 20.11 or newer (22 LTS recommended) and npm.

```bash
npm install
npm run build
npm start
# open http://localhost:3000
```

Development with a rebuild-on-edit UI and a watching server:

```bash
npm run dev
# rebuild the client in a second terminal after UI edits:
npm run build:client
```

The production server needs the built client and runtime (`dist/client`, `dist/runtime`) as well as `dist/server`. `npm start` only starts the server; run `npm run build` first.

### Tests and checks

```bash
npm run typecheck        # server + client TypeScript
npm test                 # 135 unit, integration, runtime and UI tests
npm run build            # server, client and injected runtime
npm run smoke -- --base http://localhost:3000 --offline
```

The test suite starts its own fixture website (pages, CSS, JS, redirects, gzip, uploads, a WebSocket echo server) on an ephemeral port and runs the real Fastify app against it. `npm test` is self-contained and needs no network access.

The smoke script verifies a running deployment end to end:

```bash
SMOKE_BASE=https://your-deployment.example npm run smoke
# or against a local server with an HTTP fixture:
node scripts/smoke.mjs --base http://localhost:3000 --target http://127.0.0.1:4100/ --unsafe-targets
```

## Deploy a public HTTPS instance

### GitHub Codespaces (hosted by GitHub, temporary)

[Open OpenAccess in Codespaces](https://codespaces.new/MeYashverma/OpenAccess?ref=arena/bc21ad6c-openaccess&quickstart=1)

The devcontainer installs dependencies, builds the client/runtime/server, and starts the proxy on port 3000. GitHub forwards that port as a public HTTPS URL:

- open the **Ports** panel and confirm port 3000 is **Public** (the devcontainer requests public visibility; organisation policies can override it);
- open `https://<codespace-name>-3000.app.github.dev` — that is the real app, backed by the real proxy in the container.

This is genuinely GitHub-hosted compute, not GitHub Pages. It is also not a 24/7 host: free Codespaces have a monthly core-hour quota, stop after the idle timeout, and lose sessions when deleted. The devcontainer sets conservative limits (`MAX_SESSIONS=60`, `MAX_RESPONSE_MB=15`, `EGRESS_LIMIT_MB_PER_HOUR=500`) because a public forwarded port is an open proxy. Stop the codespace when you are done. For a durable deployment, use Render, Docker or a VPS.

### Render (free plan, no card)

[Deploy to Render](https://render.com/deploy?repo=https://github.com/MeYashverma/OpenAccess) · or follow the manual steps:

1. Fork or push this repository to GitHub.
2. In Render, choose **New → Blueprint**, pick the repository, and apply `render.yaml`.
3. Render builds with `npm ci && npm run build`, starts `npm start`, and probes `/healthz` over HTTPS.
4. After the first deploy, copy the assigned `https://<service>.onrender.com` URL into the `PUBLIC_ORIGIN` environment variable and redeploy.

Free instances sleep after a period of inactivity, so the first visit after a pause can take a minute. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for limits, custom domains, separate content origins, Docker, and reverse-proxy configuration.

### Docker anywhere

```bash
docker build -t openaccess .
docker run --rm -p 3000:3000 -e PUBLIC_ORIGIN=https://openaccess.example.com openaccess
```

Or `docker compose up --build` with a `.env` file based on [.env.example](.env.example).

### What cannot host it

| Platform | Why not |
| --- | --- |
| GitHub Pages / Netlify static / Cloudflare Pages | Static file hosts cannot run the Node process, hold cookies, or open upstream sockets. (GitHub Codespaces can run it temporarily — see above.) |
| Cloudflare Workers / Pages Functions | Cloudflare's terms prohibit running a proxy/VPN service on their network, and the runtime cannot offer the same socket and timeout behaviour. |
| Serverless functions (Vercel, Netlify Functions) | Per-request limits break WebSockets, streaming downloads and in-memory sessions; many providers also prohibit proxy services. |

The backend must be a long-lived server process. Any VPS, Render/Koyeb/Fly-style container host, or home server with a TLS reverse proxy works.

## Configuration

Every setting is an environment variable; all are optional. [.env.example](.env.example) lists them with defaults, and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#environment-reference) explains the operational ones. The most important:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | request origin | Canonical UI origin, used for links and host checks |
| `CONTENT_ORIGIN` | same as public | Optional separate origin for proxied pages. Improves site compatibility but weakens cross-site isolation; see [security](docs/SECURITY.md#cross-site-isolation-within-a-session). |
| `TRUST_PROXY` | `1` | Honour `X-Forwarded-Proto` from a reverse proxy |
| `ALLOW_PRIVATE_TARGETS` | `0` | Never enable on a public deployment |
| `MAX_RESPONSE_MB` / `MAX_UPLOAD_MB` | 30 / 10 | Rewrite/collection and upload caps |
| `RATE_LIMIT_PER_SESSION` / `RATE_LIMIT_PER_IP` | 1200 / 2400 | Per-minute request limits |
| `EGRESS_LIMIT_MB_PER_HOUR` | `0` (off) | Hard bandwidth ceiling per process |
| `MAX_SESSIONS` | 2000 | In-memory session capacity |

Sessions, cookies and site storage live in process memory. Restarting the process signs everyone out; scaling to more than one instance requires sticky sessions or a shared session store (not included).

## Limits, privacy and security

- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — what works, what breaks, and the reason.
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, SSRF and abuse controls, deployment checklist, disclosure policy.
- [docs/PRIVACY.md](docs/PRIVACY.md) — what the server sees, what it stores, what it deliberately does not log.
- The UI shows the same limitations in **Menu → About**, so users are not promised more than the implementation delivers.

One more limitation belongs in the headline, not a footnote: all proxied sites in a session share one content origin. A malicious proxied page can attempt to read other proxied pages in that session (cross-document reads are blocked in shared mode, but cross-site `fetch` reads are not). Use a fresh session for anything sensitive and do not mix untrusted pages with logged-in accounts. The full attack and the possible fixes are in [docs/SECURITY.md](docs/SECURITY.md#cross-site-isolation-within-a-session).

OpenAccess is not a VPN and not an anonymity tool. The destination sees the server's address, and the server operator can observe traffic volume and, if they choose to instrument it, much more. For sensitive accounts, use a normal browser. The UI says this too.

## Project layout

```
src/
  server/            Fastify app, proxy, SSRF policy, cookie jar, sessions,
                     storage, rate limits, WebSocket relay, HTML/CSS rewriting
  runtime/           code injected into proxied pages (fetch/XHR/WebSocket,
                     cookie and storage shims, history, messaging)
  client/            React browser shell, styles, icons, PWA assets
  shared/            URL mapping and message contracts used by both sides
tests/               unit, integration, jsdom runtime and UI tests + fixtures
scripts/             build-runtime, dev runner, smoke test
docs/                architecture, compatibility, security, privacy, deployment,
                     research notes
```

## Contributing

Bug reports with a reproducible URL pattern (or a fixture that reproduces it) are the most useful contribution. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, test expectations and the compatibility-report format. Security issues should follow [docs/SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability), not the public issue tracker.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE). If you run a modified OpenAccess as a network service, the AGPL requires you to offer its corresponding source to users.
