---
summary: "CLI reference for `openclaw dashboard` (open the Control UI)"
read_when:
  - You want to open the Control UI with your current token
  - You want to print the URL without launching a browser
title: "Dashboard"
---

# `openclaw dashboard`

Open the Control UI using your current auth.

```bash
openclaw dashboard
openclaw dashboard --no-open
```

Notes:

- `dashboard` resolves configured `gateway.auth.token` SecretRefs when possible.
- `dashboard` follows `gateway.tls.enabled`: TLS-enabled gateways print/open
  `https://` Control UI URLs and connect over `wss://`.
- For SecretRef-managed tokens (resolved or unresolved), `dashboard` prints/copies/opens a non-tokenized URL to avoid exposing external secrets in terminal output, clipboard history, or browser-launch arguments.
- If `gateway.auth.token` is SecretRef-managed but unresolved in this command path, the command prints a non-tokenized URL and explicit remediation guidance instead of embedding an invalid token placeholder.

## Related

- [CLI reference](/cli)
- [Dashboard](/web/dashboard)
