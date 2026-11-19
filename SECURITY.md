# Security policy

The full threat model, controls and deployment checklist are in [docs/SECURITY.md](docs/SECURITY.md).

## Reporting a vulnerability

Please use GitHub's private **Security → Report a vulnerability** advisory flow for this repository. Do not open a public issue, and do not test against deployments you do not own.

Include the affected version, deployment mode (`shared` or `isolated`), reproduction steps and impact. Do not include real credentials, session tokens or personal data.

## Scope

In scope: SSRF bypasses, cookie or storage isolation escapes between sessions or hosts, proxy header/smuggling issues, XSS in the shell, WebSocket relay origin or policy bypasses, denial-of-service with a practical impact, and secret leakage in logs or responses.

Out of scope: anonymity against destinations, defeating CAPTCHAs or bot protection, content legality, the deployment operator's own instrumentation, browser/Node/OpenSSL vulnerabilities, and compatibility breakage that is already documented in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).
