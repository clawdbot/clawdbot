---
summary: "Integrated Tailscale Serve/Funnel for the Gateway dashboard"
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
---
# Tailscale (Gateway dashboard)

Clawdbot can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the
Gateway dashboard and WebSocket port. This keeps the Gateway bound to loopback while
Tailscale provides HTTPS, routing, and (for Serve) identity headers.

## Modes

- `serve`: Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`.
- `funnel`: Public HTTPS via `tailscale funnel`. Clawdbot requires a shared password.
- `off`: Default (no Tailscale automation).

## Auth

Set `gateway.auth.mode` to control the handshake:

- `token` (default when `CLAWDBOT_GATEWAY_TOKEN` is set)
- `password` (shared secret via `CLAWDBOT_GATEWAY_PASSWORD` or config)

When `tailscale.mode = "serve"`, the gateway trusts Tailscale identity headers by
default unless you force `gateway.auth.mode` to `password` or set
`gateway.auth.allowTailscale: false`.

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" }
  }
}
```

Open: `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

### Public internet (Funnel + shared password)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" }
  }
}
```

Prefer `CLAWDBOT_GATEWAY_PASSWORD` over committing a password to disk.

## CLI examples

```bash
clawdbot gateway --tailscale serve
clawdbot gateway --tailscale funnel --auth password
```

## Notes

- Tailscale Serve/Funnel requires the `tailscale` CLI to be installed and logged in.
- `tailscale.mode: "funnel"` refuses to start unless auth mode is `password` to avoid public exposure.
- Set `gateway.tailscale.resetOnExit` if you want Clawdbot to undo `tailscale serve`
  or `tailscale funnel` configuration on shutdown.

## Tailscale prerequisites + limits

- Serve requires HTTPS enabled for your tailnet; the CLI prompts if it is missing.
- Serve injects Tailscale identity headers; Funnel does not.
- Funnel requires Tailscale v1.38.3+, MagicDNS, HTTPS enabled, and a funnel node attribute.
- Funnel only supports ports `443`, `8443`, and `10000` over TLS.
- Funnel on macOS requires the open-source Tailscale app variant.

## Learn more

- Tailscale Serve overview: https://tailscale.com/kb/1312/serve
- `tailscale serve` command: https://tailscale.com/kb/1242/tailscale-serve
- Tailscale Funnel overview: https://tailscale.com/kb/1223/tailscale-funnel
- `tailscale funnel` command: https://tailscale.com/kb/1311/tailscale-funnel
