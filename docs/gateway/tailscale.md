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

When `tailscale.mode = "serve"` and `gateway.auth.allowTailscale` is `true`,
valid Serve proxy requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) without supplying a token/password. Clawdbot only
treats a request as Serve when it arrives from loopback with Tailscale’s
`x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host` headers.
To require explicit credentials, set `gateway.auth.allowTailscale: false` or
force `gateway.auth.mode: "password"`.

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
- Serve/Funnel only expose the **Gateway control UI + WS**. Node **bridge** traffic
  uses the separate bridge port (default `18790`) and is **not** proxied by Serve.

## Browser control server (remote Gateway + local browser)

If you run the Gateway on one machine but want to drive a browser on another machine, use a **separate browser control server**
and publish it through Tailscale **Serve** (tailnet-only):

```bash
# on the machine that runs Chrome
clawdbot browser serve --bind 127.0.0.1 --port 18791 --token <token>
tailscale serve https / http://127.0.0.1:18791
```

Then point the Gateway config at the HTTPS URL:

```json5
{
  browser: {
    enabled: true,
    controlUrl: "https://<magicdns>/"
  }
}
```

And authenticate from the Gateway with the same token (prefer env):

```bash
export CLAWDBOT_BROWSER_CONTROL_TOKEN="<token>"
```

Avoid Funnel for browser control endpoints unless you explicitly want public exposure.

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
