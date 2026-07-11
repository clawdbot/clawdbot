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
openclaw dashboard --yes
```

- `--no-open`: print the URL but do not launch a browser.
- `--yes`: start/install the Gateway without prompting when needed.

Notes:

- Resolves configured `gateway.auth.token` SecretRefs when possible.
- Follows `gateway.tls.enabled`: TLS-enabled gateways print/open `https://` Control UI URLs and connect over `wss://`.
- For `lan` or a wildcard `custom` bind, same-host launches always use loopback because a wildcard is not a browser destination. Plaintext `tailnet` and `custom` binds also use `127.0.0.1` so the browser has a secure context; TLS-enabled specific hosts keep the configured address so certificate names match.
- Before delivering an authenticated loopback URL for a specific-interface bind, the command probes the configured interface and verifies that it and `127.0.0.1` are owned by the same Gateway process. Ambiguous listener ownership fails closed with status guidance.
- For SecretRef-managed tokens (resolved or unresolved), the printed/copied/opened URL never includes the token, so external secrets do not leak into terminal output, clipboard history, or browser-launch arguments.
- If `gateway.auth.token` is SecretRef-managed but unresolved, the command prints a non-tokenized URL and remediation guidance instead of an invalid token placeholder.
- If clipboard/browser delivery fails for a token-authenticated URL, the command logs a safe manual-auth hint naming `OPENCLAW_GATEWAY_TOKEN`, `gateway.auth.token`, and the URL fragment key `token`, without printing the token value.

## Related

- [CLI reference](/cli)
- [Dashboard](/web/dashboard)
