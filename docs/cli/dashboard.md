---
summary: "CLI reference for `openclaw dashboard` (securely open the Control UI)"
read_when:
  - You want to open or re-pair the Control UI from the Gateway host
  - You want to print the URL without launching a browser
title: "Dashboard"
---

# `openclaw dashboard`

Open the Control UI with a short-lived, one-time owner pairing link. A successful handoff gives that
signed browser a durable administrator device credential, so reopening the dashboard does not depend
on the shared Gateway token. Opening a fresh handoff in the same browser can also repair a previously
limited device credential.

```bash
openclaw dashboard
openclaw dashboard --no-open
openclaw dashboard --json
openclaw dashboard --yes
```

- `--no-open`: print the URL but do not launch a browser.
- `--json`: print one machine-readable connection object without opening a browser, using the clipboard, prompting, or starting the Gateway.
- `--yes`: start/install the Gateway without prompting when needed.

## Machine-readable output

Use `--json` for desktop integrations and scripts that need the resolved Control UI URL:

```bash
openclaw dashboard --json
```

The response includes the backward-compatible shared-auth `url`, plus `browserUrl`,
`browserBootstrapExpiresAtMs`, `httpUrl`, `wsUrl`, `port`, and `tokenIncluded`. Browser integrations
should open `browserUrl`; native RPC clients that need the shared Gateway credential can continue to
use `url`. If the Gateway is not ready or a browser handoff cannot be issued, the command returns
`{"ok":false,"reason":"..."}` and exits non-zero. SecretRef-managed shared tokens are never included
in `url`.

Notes:

- Resolves configured `gateway.auth.token` SecretRefs when possible.
- `browserUrl` carries a single-use, ten-minute bootstrap in the URL fragment. The Control UI strips
  it immediately, binds it to the browser's signed device identity, and stores only the resulting
  administrator per-device credential. Another browser profile cannot inherit or replay that grant.
- Follows `gateway.tls.enabled`: TLS-enabled gateways print/open `https://` Control UI URLs and connect over `wss://`.
- For `lan` or a wildcard `custom` bind, same-host launches always use loopback because a wildcard is not a browser destination. Plaintext `tailnet` and `custom` binds also use `127.0.0.1` so the browser has a secure context; TLS-enabled specific hosts keep the configured address so certificate names match.
- Before delivering an authenticated loopback URL for a specific-interface bind, the command probes the configured interface and verifies that it and `127.0.0.1` are owned by the same Gateway process. Ambiguous listener ownership fails closed with status guidance.
- The interactive command prints only the clean base URL; the clipboard/browser launch receives the
  one-time `browserUrl`, never the shared token. SecretRef-managed shared tokens therefore do not leak
  into terminal output, clipboard history, or browser-launch arguments.
- If clipboard/browser delivery fails for a token-authenticated URL, the command logs a safe manual-auth hint naming `OPENCLAW_GATEWAY_TOKEN`, `gateway.auth.token`, and the URL fragment key `token`, without printing the token value.
- If the shared token cannot be placed in a URL and clipboard/browser delivery fails, run
  `openclaw dashboard --json` and open its short-lived `browserUrl` within ten minutes.

## Related

- [CLI reference](/cli)
- [Dashboard](/web/dashboard)
