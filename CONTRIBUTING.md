# Contributing

Thanks for helping. The most valuable contributions are reproducible compatibility reports, security hardening and tests that fail against a real bug before they pass.

## Setup

```bash
git clone https://github.com/MeYashverma/OpenAccess.git
cd OpenAccess
npm install
npm run build
npm start            # http://localhost:3000
```

For UI work, `npm run dev` starts a watching server and builds the client once; run `npm run build:client` after UI edits to refresh `dist/client`. The server runs TypeScript directly through `tsx` in development, but the injected runtime is always a built artifact (`npm run build:runtime`).

## Before opening a pull request

```bash
npm run typecheck
npm test
npm run build
node scripts/smoke.mjs --base http://localhost:3000 --offline
```

- Add or update tests for behaviour changes. A bug fix without a regression test is likely to be asked for one.
- Keep the injected runtime defensive: wrap optional API patches so one unsupported browser feature cannot abort the rest.
- Do not weaken SSRF, cookie-isolation, rate-limit or CSP controls for compatibility. If a site needs a weaker setting, document the trade-off and make it opt-in, then update [docs/SECURITY.md](docs/SECURITY.md).
- Do not add a dependency that requires a paid API, an account, telemetry or a remote service. The product is intentionally self-contained.
- Update the relevant document when behaviour, limits or deployment steps change. The UI's **About** panel is part of the contract and must stay honest.
- Keep the UI free of emoji icons, glassmorphism and decorative dependency bloat. Icons live in `src/client/icons.tsx`.

## Code conventions

- TypeScript strict mode; no `any` unless unavoidable and commented.
- Server code: small pure helpers where possible, explicit error codes, no request URLs in logs.
- Client code: no `dangerouslySetInnerHTML` for anything derived from page content; validate message payloads.
- URLs that cross the proxy boundary go through `src/shared/url.ts`, not string concatenation.
- Tests use the fixture server in `tests/helpers.ts`; do not point the suite at public websites.

## Reporting a compatibility problem

Open an issue with:

```md
### Destination
https://example.com/some/page

### Deployment
- OpenAccess version:
- Mode: shared / isolated
- PUBLIC_ORIGIN / CONTENT_ORIGIN set? yes/no

### Browser
Chrome 000 / Firefox 000 / Safari 00 on macOS/Windows/Linux/Android/iOS

### Expected


### Actual
- HTTP status (if OpenAccess returned an error page):
- Blank frame / wrong content / console error / failed action:
- Does it reproduce with a fresh session? yes/no

### Minimal reproduction
Steps, and if possible a tiny static fixture that reproduces the failure.
```

Do not include cookies, session tokens, personal data or pages behind a login. For security vulnerabilities use the private advisory flow in [docs/SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability), not an issue.

## Adding compatibility

When adding a rewrite or runtime shim:

1. Add a fixture to `tests/helpers.ts` that exercises the mechanism without a public site.
2. Add an integration test asserting the rewritten output, or a jsdom runtime test asserting the patched API.
3. Update [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — including the **not supported** cases, if the change narrows behaviour.
4. Run the full suite and the build.

## License

By contributing you agree that your contribution is licensed under AGPL-3.0-or-later, the license of this repository.
