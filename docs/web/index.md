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

Capabilities live in [Control UI](/web/control-ui). The rest of this page focuses on bind modes, security, and web-facing surfaces.

## Webhooks

When `hooks.enabled=true`, the Gateway also exposes a small webhook endpoint on the same HTTP server.
See [Gateway configuration](/gateway/configuration) → `hooks` for auth + payloads.

## Config (default-on)

The Control UI is **enabled by default** when assets are present (`dist/control-ui`).
You can control it via config:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Tailscale access

### Integrated Serve (recommended)

Keep the Gateway on loopback and let Tailscale Serve proxy it:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Then start the gateway:

```bash
openclaw gateway
```

Open:

- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

### Tailnet bind + token

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Then start the gateway (this non-loopback example uses shared-secret token
auth):

```bash
openclaw gateway
```

Open:

- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

### Public internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Security notes

- Gateway auth is required by default (token, password, trusted-proxy, or Tailscale Serve identity headers when enabled).
- Non-loopback binds still **require** gateway auth. In practice that means token/password auth or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`.
- The wizard creates shared-secret auth by default and usually generates a
  gateway token (even on loopback).
- In shared-secret mode, the UI sends `connect.params.auth.token` or
  `connect.params.auth.password`.
- When `gateway.tls.enabled: true`, local dashboard and status helpers render
  `https://` dashboard URLs and `wss://` WebSocket URLs.
- In identity-bearing modes such as Tailscale Serve or `trusted-proxy`, the
  WebSocket auth check is satisfied from request headers instead.
- For non-loopback Control UI deployments, set `gateway.controlUi.allowedOrigins`
  explicitly (full origins). Without it, gateway startup is refused by default.
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true` enables
  Host-header origin fallback mode, but is a dangerous security downgrade.
- With Serve, Tailscale identity headers can satisfy Control UI/WebSocket auth
  when `gateway.auth.allowTailscale` is `true` (no token/password required).
  HTTP API endpoints do not use those Tailscale identity headers; they follow
  the gateway's normal HTTP auth mode instead. Set
  `gateway.auth.allowTailscale: false` to require explicit credentials. See
  [Tailscale](/gateway/tailscale) and [Security](/gateway/security). This
  tokenless flow assumes the gateway host is trusted.
- `gateway.tailscale.mode: "funnel"` requires `gateway.auth.mode: "password"` (shared password).

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build
```
