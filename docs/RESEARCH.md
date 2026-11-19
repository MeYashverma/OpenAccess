# Research notes

These are the sources that shaped OpenAccess, and what each one changed. They are design inputs, not benchmarks; nothing here claims that OpenAccess matches the compatibility of the projects discussed.

Accessed November 2026.

## Prior art: proxy browsers

### Rammerhead

- <https://github.com/binary-person/rammerhead>

Rammerhead is the closest reference point: a server-side proxy browser built on testcafe-hammerhead, with a demo at `browser.rammerhead.org`. It establishes the useful shape — sessions addressed by URL, server-side URL rewriting, cookie and storage synchronisation, multiple tabs, a browser chrome — and demonstrates that a rewriting proxy can browse a surprising amount of the web without a remote desktop.

What OpenAccess took: the session-in-the-path model, the need to sync `document.cookie` and Web Storage both ways, and the lesson that compatibility must be documented per feature.

What it deliberately did not take: the Hammerhead engine, its URL hashing scheme and its client code. OpenAccess is an independent implementation with its own URL format (`/p/<token>/<scheme>/<host><path>`), its own AST rewriting (parse5), its own runtime shims and a smaller surface. Copying Hammerhead's architecture would have made this repository a fork with a maintenance burden we cannot carry, and its compatibility patches are tightly coupled to its client.

### Ultraviolet, Scramjet and SuperNova

- <https://github.com/SuperNova-Network/SuperNova/blob/main/docs/proxy-backend-serviceworker-details.md>
- <https://geonode.com/blog/nebula-proxy>

The modern "web proxy" ecosystem separates a **backend** (bare / epoxy / libcurl) from a **client** that runs in a Service Worker, with Scramjet replacing the retired Ultraviolet. SuperNova's docs describe the role split and the transports; Nebula is a frontend over that stack.

This is a genuinely different architecture from OpenAccess:

- A Service Worker intercepts requests **from its own origin only**. It cannot intercept a top-level navigation to another origin, cannot hold server-side cookies, and cannot bypass CORS for the page's own scripts.
- Those clients pair the SW with a backend that handles transport, but the page still runs on the proxy origin and the same rewriting problems (CORS, worker scope, storage) remain.
- UV's retirement is a reminder that a large client engine is a long-term maintenance commitment.

OpenAccess therefore does not use a Service Worker or a bare transport. It proxies at the HTTP layer and injects a small runtime into each document. The trade-off is compatibility (see [COMPATIBILITY.md](COMPATIBILITY.md)): no SW-only tricks, but a much smaller and auditable codebase with server-side cookie isolation.

## Free hosting

- <https://snapdeploy.dev/state-of-free-hosting>
- <https://hostgage.com/best-free-nodejs-hosting/>

Both surveys describe the same reality: free Node application hosting exists, but nothing free is a 24/7 dedicated server. Instances sleep when idle, cold starts take tens of seconds, CPU is heavily shared, and bandwidth allowances are small relative to a proxy's traffic. Some providers require a card to prevent abuse.

This shaped the deployment documentation rather than the code:

- Render is the recommended free path because it is a normal long-lived Node process with no card, not because it is fast.
- Cold starts and bandwidth are stated plainly in [DEPLOYMENT.md](DEPLOYMENT.md) and the README instead of hiding them.
- `EGRESS_LIMIT_MB_PER_HOUR` exists because a misconfigured or popular free instance can consume a monthly allowance in hours.
- The UI warns that a sleeping deployment will be slow on first visit.

### Why GitHub Pages cannot host this

GitHub Pages serves static files. It cannot accept a proxy request, open an outbound socket, hold a cookie jar, or keep a session in memory. The browser shell is static, but the product **is** the server; publishing only `dist/client` would produce a non-functional mock-up. This was an explicit constraint from the start, so the repository contains no "deploy to Pages" path that would mislead users.

### Cloudflare

- <https://community.cloudflare.com/t/blocking-xray-and-v2ray-traffic/748125>
- <https://agentdeals.dev/vendor/cloudflare-workers>

Cloudflare's community thread records the December 2024 enforcement of its terms against proxy/VPN traffic on its network, and the Workers free tier is 100k requests/day with 10 ms CPU per invocation and 1 GB KV. Workers also cannot run this Node process as-is.

Conclusion: Cloudflare Workers/Pages is not a hosting target, and putting the proxy behind Cloudflare risks a terms violation for the operator. The deployment guide says so and points to a VPS or an application host instead.

## SSRF and open-proxy abuse

- <https://nhimg.org/ssrf-prevention-guide>
- <https://appsecbrief.com/articles/ssrf-prevention-guide/>

Both guides converge on the same controls, which map directly to `src/server/ssrf.ts`:

1. Validate the **resolved IP at connect time**, not only the hostname at parse time. A DNS name can change between validation and connection (rebinding).
2. Block loopback, RFC1918, CGNAT, link-local (including `169.254.169.254`), multicast and reserved ranges, and unwrap IPv4-mapped IPv6 forms.
3. Do not follow redirects blindly; revalidate every hop.
4. Deny unusual ports and non-HTTP schemes, and reject embedded credentials.
5. Pin or re-check the address the socket actually connects to.

OpenAccess implements all five: shape validation, DNS `lookup` with all answers checked, a custom agent `lookup` that re-checks the exact connect address, a port policy, no server-side redirect following, and a refusal to proxy its own listener. The guides also recommend network-level egress filtering; that is called out as an operator responsibility in [SECURITY.md](SECURITY.md), because application-level checks are not a substitute for a network boundary.

The open-proxy side is not solvable with SSRF rules. A free public proxy will be abused. The design uses layered, cheap controls — per-IP and per-session fixed windows, session-creation limits, concurrency caps, upload/response caps, an hourly egress budget and optional host blocklists — and states clearly in the security guide that these are not authentication and that a public deployment needs platform-level DDoS protection and billing alerts.

## Remote browser isolation (why not a real browser)

- <https://blog.send.win/what-is-a-self-hosted-virtual-browser/>
- <https://blog.send.win/kasm-workspaces-complete-guide-2026/>

Remote browser isolation products (Neko, Kasm, commercial RBI) stream a browser's pixels to the user. They are the gold standard for compatibility: the site sees a real browser, JavaScript runs unmodified, and nothing has to be rewritten. The cost is roughly 1–2 CPU cores and 2 GB of RAM per session, plus 3–5 Mbps per viewer.

A free deployment cannot host even one such session comfortably, let alone a public service. OpenAccess therefore chose the rewriting proxy trade-off and documents what it loses. The docs do not pretend that HTML rewriting is equivalent to a remote browser, and they do not claim universal compatibility.

## Resulting decisions

| Research input | Decision in this repository |
| --- | --- |
| Hammerhead/Rammerhead sessions and cookie sync | Session token in the path; server jar; `document.cookie` and storage shims |
| UV/Scramjet service-worker architecture | Not used; no SW, no bare transport; direct HTTP proxy plus injected runtime |
| Free hosts sleep and meter bandwidth | Render blueprint, explicit cold-start/bandwidth warnings, egress budget |
| Static hosts cannot proxy | No GitHub Pages deployment path; documentation says why |
| Cloudflare prohibits proxying | Workers/Pages excluded from supported targets |
| SSRF guides | Shape + DNS + connect-time validation, port policy, no redirect following, loop protection |
| RBI cost | No headless browser; compatibility limits documented rather than simulated |
