---
summary: "Gateway web surfaces: Control UI, bind modes, and security"
read_when:
  - You want to access the Gateway over Tailscale
  - You want the browser Control UI and config editing
title: "Web"
---

The Gateway serves a small **browser Control UI** (Vite + Lit) from the same port as the Gateway WebSocket:

- default: `http://<host>:18789/`
- with `gateway.tls.enabled: true`: `https://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

Capabilities live in [Control UI](/web/control-ui). This page covers bind modes, security, and other web-facing surfaces.

## Config (default-on)

Control UI is **enabled by default** when assets are present (`dist/control-ui`):

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Webhooks

When `hooks.enabled=true`, the Gateway also exposes a webhook endpoint on the same HTTP server. See `hooks` in [Gateway configuration reference](/gateway/configuration-reference#hooks) for auth and payloads.

## Admin HTTP RPC

`POST /api/v1/admin/rpc` exposes selected Gateway control-plane methods over HTTP. Off by default; registered only when the `admin-http-rpc` plugin is enabled. See [Admin HTTP RPC](/plugins/admin-http-rpc) for the auth model, allowed methods, and comparison with the WebSocket API.

## Tailscale access

<Tabs>
  <Tab title="Integrated Serve (recommended)">
    Keep the Gateway on loopback and let Tailscale Serve proxy it:

    ```json5
    {
      gateway: {
        bind: "loopback",
        tailscale: { mode: "serve" },
      },
    }
    ```

    Start the gateway:

    ```bash
    openclaw gateway
    ```

    Open `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`).

  </Tab>
  <Tab title="Tailnet bind + token">
    ```json5
    {
      gateway: {
        bind: "tailnet",
        controlUi: { enabled: true },
        auth: { mode: "token", token: "your-token" },
      },
    }
    ```

    Start the gateway (this non-loopback example uses shared-secret token auth):

    ```bash
    openclaw gateway
    ```

    Open `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`).

  </Tab>
  <Tab title="Public internet (Funnel)">
    ```json5
    {
      gateway: {
        bind: "loopback",
        tailscale: { mode: "funnel" },
        auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
      },
    }
    ```

    `tailscale.mode: "funnel"` requires `gateway.auth.mode: "password"`; Serve and Funnel both require `gateway.bind: "loopback"`.

  </Tab>
</Tabs>

## Security notes

- Gateway auth is required by default: token, password, trusted-proxy, or Tailscale Serve identity headers when enabled.
- Non-loopback binds still **require** gateway auth: token/password auth or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`.
- The onboarding wizard creates shared-secret auth by default and usually generates a gateway token, even on loopback.
- In shared-secret mode, the UI sends `connect.params.auth.token` or `connect.params.auth.password` during the WebSocket handshake.
- With `gateway.tls.enabled: true`, local dashboard/status helpers render `https://` URLs and `wss://` WebSocket URLs.
- In identity-bearing modes (Tailscale Serve, `trusted-proxy`), the WebSocket auth check is satisfied from request headers instead of a shared secret.
- For public non-loopback Control UI deployments, set `gateway.controlUi.allowedOrigins` explicitly (full origins). Private same-origin loads are accepted without it for loopback, RFC1918/link-local, `.local`, `.ts.net`, and Tailscale CGNAT hosts.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true` enables Host-header origin fallback; this is a dangerous security downgrade.
- With Serve, Tailscale identity headers satisfy Control UI/WebSocket auth when `gateway.auth.allowTailscale: true` (no token/password required). HTTP API endpoints do not use Tailscale identity headers; they always follow the gateway's normal HTTP auth mode. Set `gateway.auth.allowTailscale: false` to require explicit credentials even over Serve. This tokenless flow assumes the gateway host itself is trusted. See [Tailscale](/gateway/tailscale) and [Security](/gateway/security).

## Building the UI

The Gateway serves static files from `dist/control-ui`:

```bash
pnpm ui:build
```
