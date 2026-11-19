# Deployment

OpenAccess is a single long-lived Node.js process serving both the browser shell and the proxy. There is no database, no build-time API key and no Paid service dependency. That makes deployment simple, but it also excludes every platform that cannot run a persistent server process.

## Requirements

- Node.js 20.11+ (22 LTS recommended), or Docker.
- 256 MB RAM minimum for a small instance; 512 MB–1 GB for a public free-tier deployment.
- A persistent process. Serverless functions are not supported.
- HTTPS in front of it for any public use. Session tokens travel in URLs; plain HTTP exposes them.
- Outbound TCP 80/443 to the public internet.
- **One instance**, unless you add sticky sessions and a shared session store. Sessions, cookies, rate-limit windows and the egress budget are in memory.

## Environment reference

All variables are optional. Defaults are in `src/server/config.ts` and [.env.example](../.env.example).

### Network and origins

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `3000` | Most platforms inject this |
| `PUBLIC_ORIGIN` | derived from request | Canonical UI origin, e.g. `https://openaccess.example.com`. Set it in production: social previews, canonical links and host checks use it. |
| `CONTENT_ORIGIN` | same as public | Optional separate origin for proxied pages, e.g. `https://p.openaccess.example.com`. It gives pages a real origin (better site compatibility) but weakens cross-site isolation inside a session. Leave unset for untrusted public browsing. See [SECURITY.md](SECURITY.md#cross-site-isolation-within-a-session). |
| `TRUST_PROXY` | `1` | Trust `X-Forwarded-*` from the reverse proxy. Set to `0` if the process is directly exposed and no proxy sets those headers. |
| `FORCE_HTTPS` | `0` | Treat requests as HTTPS even without `X-Forwarded-Proto` |
| `ACCESS_LOG` | `0` | One redacted line per request; never includes `/p/` paths |

### Sessions and limits

| Variable | Default | Notes |
| --- | --- | --- |
| `MAX_SESSIONS` | `2000` | LRU eviction at the cap. A 512 MB instance should use a few hundred. |
| `SESSION_IDLE_MINUTES` | `120` | Inactivity timeout |
| `SESSION_MAX_HOURS` | `12` | Absolute session lifetime |
| `MAX_RESPONSE_MB` | `30` | Rewritten HTML/CSS cap; larger returns 502 |
| `MAX_UPLOAD_MB` | `10` | Request body cap |
| `MAX_CONCURRENT_REQUESTS_PER_SESSION` | `12` | Fan-out cap |
| `MAX_BUFFERED_MB` | `128` | Process-wide memory ceiling for HTML/CSS being rewritten; `0` disables it |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Fixed window |
| `RATE_LIMIT_PER_IP` | `2400` | All sessions from one IP |
| `RATE_LIMIT_PER_SESSION` | `1200` | One browsing session |
| `SESSION_CREATES_PER_HOUR` | `60` | Per IP |
| `SESSION_CREATE_WINDOW_MINUTES` | `60` | Window for the above |
| `EGRESS_LIMIT_MB_PER_HOUR` | `0` | `0` disables; otherwise a hard process-wide cut-off |
| `ENABLE_WEBSOCKETS` | `1` | Relay on/off |
| `MAX_WS_MESSAGE_KB` | `512` | Per-frame cap |
| `ENABLE_SERVER_STORAGE` | `1` | Storage shim for proxied pages |
| `MAX_STORAGE_KB_PER_HOST` | `512` | Per host; total is 20× per session |

### Upstream policy

| Variable | Default | Notes |
| --- | --- | --- |
| `ALLOW_PRIVATE_TARGETS` | `0` | **Never enable on a public deployment.** Allows loopback/private/metadata addresses. |
| `ALLOWED_UPSTREAM_PORTS` | unset | Comma list; when set, overrides the default blocked-port policy |
| `BLOCKED_UPSTREAM_PORTS` | built-in list | Comma list of ports to refuse |
| `BLOCKED_HOSTS` | unset | Comma list of exact hosts and subdomains |
| `BLOCKED_HOST_SUFFIXES` | unset | Comma list of suffixes, e.g. `.corp,.internal` |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | TCP connect |
| `UPSTREAM_HEADERS_TIMEOUT_MS` | `20000` | Time to response headers |
| `UPSTREAM_BODY_TIMEOUT_MS` | `120000` | Idle time while reading a body |

## Render (recommended free path)

The repository includes `render.yaml`, a Render Blueprint. You can start from <https://render.com/deploy?repo=https://github.com/MeYashverma/OpenAccess> or follow the steps manually.

1. Push the repository to GitHub.
2. In Render: **New → Blueprint**, select the repository, apply the plan. The free plan does not require a card.
3. Render runs `npm ci && npm run build`, starts `npm start`, and checks `/healthz`.
4. When the first deploy finishes, copy `https://<service>.onrender.com` into the `PUBLIC_ORIGIN` environment variable and redeploy. This is optional for booting but recommended.
5. Optional: isolated mode. Add a custom domain such as `openaccess.example.com`, add a second custom domain `p.openaccess.example.com` to the **same** service, then set:
   - `PUBLIC_ORIGIN=https://openaccess.example.com`
   - `CONTENT_ORIGIN=https://p.openaccess.example.com`

   Both hostnames must resolve to the service and have valid TLS; the host gate returns 421 for unknown hosts. Read [cross-site isolation](SECURITY.md#cross-site-isolation-within-a-session) first: isolated mode improves compatibility but gives every proxied destination the same real origin. For untrusted public browsing, leave `CONTENT_ORIGIN` unset.

### Free-plan realities

Free application hosts sleep after inactivity, give a fraction of a CPU and share bandwidth. Expect:

- a cold start of tens of seconds on the first visit after a pause;
- lower throughput for image-heavy pages;
- a monthly bandwidth allowance that a public proxy can consume quickly;
- no persistent disk (irrelevant: OpenAccess keeps state in memory).

Set `EGRESS_LIMIT_MB_PER_HOUR` and a billing/usage alert. Check the provider's current plan terms rather than relying on numbers in this repository.

## Docker

```bash
docker build -t openaccess .
docker run --rm -p 3000:3000 \
  -e PUBLIC_ORIGIN=https://openaccess.example.com \
  -e CONTENT_ORIGIN=https://p.openaccess.example.com \
  -e TRUST_PROXY=1 \
  -e MAX_SESSIONS=400 \
  openaccess
```

Or copy `.env.example` to `.env`, adjust it, and run `docker compose up --build`. The image runs as a non-root user and has a `HEALTHCHECK` against `/healthz`. The GHCR workflow publishes `ghcr.io/<owner>/<repo>` on pushes to `main` and tags.

## VPS with Caddy

Caddy is the shortest path to HTTPS and WebSockets on a VPS.

```caddyfile
openaccess.example.com, p.openaccess.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000 {
        flush_interval -1
    }
}
```

`flush_interval -1` disables response buffering, which matters for Server-Sent Events and streamed pages. Caddy handles WebSocket upgrades and certificates automatically. Run the app under systemd:

```ini
[Unit]
Description=OpenAccess
After=network.target

[Service]
Type=simple
User=openaccess
WorkingDirectory=/srv/openaccess
Environment=NODE_ENV=production
Environment=PUBLIC_ORIGIN=https://openaccess.example.com
Environment=CONTENT_ORIGIN=https://p.openaccess.example.com
Environment=TRUST_PROXY=1
Environment=MAX_SESSIONS=800
ExecStart=/usr/bin/node dist/server/server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

## Nginx

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name openaccess.example.com p.openaccess.example.com;

    client_max_body_size 12m;          # keep slightly above MAX_UPLOAD_MB
    proxy_read_timeout 3600s;          # WebSockets and slow streaming responses
    proxy_send_timeout 3600s;
    proxy_buffering off;               # SSE / streamed responses

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_request_buffering off;
    }
}
```

Set `TRUST_PROXY=1` so `req.ip` and the scheme come from these headers. If you terminate TLS somewhere else, pass the real scheme in `X-Forwarded-Proto`.

## Platform comparison

| Platform | Can host OpenAccess? | Reason |
| --- | --- | --- |
| Render (free/paid web service) | Yes | Persistent Node process, WebSockets, HTTPS; free plan sleeps |
| Koyeb / Fly.io / Railway-style app hosts | Yes, with a long-lived process | Check current free allowances and cold-start behaviour |
| Any VPS (Hetzner, DigitalOcean, EC2, …) | Yes | Full control; you manage TLS and updates |
| Docker on a home server + tunnel | Yes | Home egress IP is often blocked by bot protection; TLS via Caddy |
| GitHub Pages | **No** | Static files only; no server, no sockets, no cookies |
| Netlify/Vercel static or serverless | **No** | Static hosting cannot proxy; serverless limits break sessions, WebSockets and streaming |
| Cloudflare Pages/Workers | **No** | Workers cannot run this Node process, and Cloudflare's terms prohibit proxy/VPN services on their network |
| AWS Lambda / Cloud Functions | **No** | Per-request isolation, no long-lived sessions or WebSockets; many providers' terms also exclude proxy use |

If a platform advertises "Node hosting" but spins the process down mid-request, streams, WebSockets or large downloads will fail intermittently. A proxy is a long-lived-socket workload.

## Scaling

Do not run multiple instances behind a plain round-robin load balancer. A session created on instance A is unknown to instance B, so pages break at random. To scale you need:

- sticky routing (cookie or IP hash) for the lifetime of a session, and
- a shared session/cookie/storage/rate-limit store, which this repository does not include.

The intended deployment is one process, sized vertically. A 1 GB instance can hold several hundred small sessions; memory grows with concurrent responses and stored site data, not with historical users.

## Operations

- **Health:** `GET /healthz` (plain `ok`) and `GET /api/health` (version, uptime, session count, egress bytes). Both are safe to expose; the API endpoint is read-only and contains no secrets.
- **Restarts:** expected to sign users out. Deploy during low traffic or accept it.
- **Updates:** rebuild (`npm ci && npm run build`) before restarting. The server refuses to start if the runtime bundle is missing.
- **Backups:** none needed for session state; back up your configuration and any local modifications.
- **Monitoring:** watch process memory, event-loop lag, upstream 5xx rate, egress, and 429/503 ratios. Access logs are redacted by design, so use aggregate metrics for capacity planning.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| 421 "configured for …" | Request arrived with a `Host` that matches neither `PUBLIC_ORIGIN` nor `CONTENT_ORIGIN`. Fix DNS or the env vars. |
| Every site returns 403 "not available" | `ALLOW_PRIVATE_TARGETS=0` and the destination resolves to a private address, or a host blocklist is too broad. Check the error details. |
| WebSocket fails immediately (403) | The browser's `Origin` is not the expected content origin. In isolated mode, the page must be served from `CONTENT_ORIGIN`; do not open content directly on the public host. |
| WebSocket upgrade times out behind a proxy | Allow `Upgrade`/`Connection` headers and raise `proxy_read_timeout`. |
| 502 "page is too large" | Raise `MAX_RESPONSE_MB` or accept the limit for very large documents. |
| 429 after a minute | A limit is too low for the site's asset count. Raise `RATE_LIMIT_PER_SESSION`/`RATE_LIMIT_PER_IP`, or increase the window. |
| 503 "bandwidth budget" | `EGRESS_LIMIT_MB_PER_HOUR` reached; wait for the hour rollover or raise it. |
| Pages load but storage fails | `ENABLE_SERVER_STORAGE=0`, or the session storage cap was reached. |
| First request after idle is very slow | Free host cold start. Upgrade the plan or keep the instance warm. |
| Assets 404 after deploy | The client build was not copied (`dist/client`); run the full `npm run build`, not only `build:server`. |

## Legal and policy

You are responsible for what your deployment fetches and serves. Publish terms of use, an abuse contact and a privacy notice; restrict destinations you are not willing to proxy; and comply with local law and the hosting provider's acceptable-use policy. OpenAccess is provided without warranty under the AGPL-3.0-or-later, and running a modified version as a network service obliges you to offer its source to users.
