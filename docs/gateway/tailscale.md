---
summary: "Integrated Tailscale Serve/Funnel for the Gateway dashboard"
read_when:
  - Exposing the Gateway Control UI outside localhost
  - Automating tailnet or public dashboard access
title: "Tailscale"
---

OpenClaw can auto-configure Tailscale **Serve** (tailnet) or **Funnel** (public) for the Gateway dashboard and WebSocket port. This keeps the gateway bound to loopback while Tailscale provides HTTPS, routing, and (for Serve) identity headers.

<Note>
Looking for the step-by-step setup? See [Give your Gateway a stable HTTPS URL](/gateway/stable-https-url).
</Note>

## Modes

`gateway.tailscale.mode`:

| Mode            | Behavior                                                                    |
| --------------- | --------------------------------------------------------------------------- |
| `serve`         | Tailnet-only Serve via `tailscale serve`. The gateway stays on `127.0.0.1`. |
| `funnel`        | Public HTTPS via `tailscale funnel`. Requires a shared password.            |
| `off` (default) | No Tailscale automation.                                                    |

Status and audit output use **Tailscale exposure** for this OpenClaw Serve/Funnel mode. `off` means OpenClaw is not managing Serve or Funnel; it does not mean the local Tailscale daemon is stopped or logged out.

## Config examples

### Tailnet-only (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Open: `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

### Tailnet-only (bind to Tailnet IP)

Use this to have the gateway listen directly on the Tailnet IP, with no Serve/Funnel:

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Connect a native or CLI client from another Tailnet device:

- WebSocket: `ws://<tailscale-ip>:18789`

Do not use the direct plain-HTTP address for the browser Control UI. Remote plain HTTP cannot create browser device identity, and token/password auth does not replace it. Use Tailscale Serve for the Control UI.

<Note>
When a bindable Tailnet IPv4 is present, the Gateway also requires `http://127.0.0.1:18789` for authenticated same-host clients. If no Tailnet address is available at startup, it falls back to loopback only; restart after Tailscale becomes available to add direct Tailnet access. Neither path adds LAN or public exposure.
</Note>

### Public internet (Funnel + shared password)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Prefer `OPENCLAW_GATEWAY_PASSWORD` over committing a password to disk.

## CLI examples

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Auth

`gateway.auth.mode` controls the handshake:

| Mode                                                   | Use case                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `none`                                                 | Private ingress only                                                                |
| `token` (default when `OPENCLAW_GATEWAY_TOKEN` is set) | Shared token                                                                        |
| `password`                                             | Shared secret via `OPENCLAW_GATEWAY_PASSWORD` or config                             |
| `trusted-proxy`                                        | Identity-aware reverse proxy; see [Trusted Proxy Auth](/gateway/trusted-proxy-auth) |

### Tailscale identity headers (Serve only)

When `tailscale.mode: "serve"` and `gateway.auth.allowTailscale` is `true`, Control UI/WebSocket auth can use Tailscale identity headers (`tailscale-user-login`) instead of a token/password. OpenClaw verifies the header by resolving the request's `x-forwarded-for` address via the local Tailscale daemon (`tailscale whois`) and matching it to the header login before accepting it. A request only qualifies when it reaches OpenClaw's dedicated managed-Tailscale listener with Tailscale's `x-forwarded-for`, `x-forwarded-proto`, and `x-forwarded-host` headers. Those headers never establish managed Serve provenance or tokenless auth on the ordinary Gateway listener.

This tokenless flow assumes the gateway host is trusted. If untrusted local code may run on the same host, set `gateway.auth.allowTailscale: false` and require token/password auth instead.

Scope of the bypass:

- Applies to the Control UI WebSocket auth surface and read-only `GET`/`HEAD` requests for Control UI profile avatars. Other HTTP API endpoints (`/v1/*`, `/tools/invoke`, `/api/channels/*`, etc.) never use Tailscale identity-header auth; they always follow the gateway's normal HTTP auth mode.
- For Control UI operator sessions that already carry browser device identity, a verified Tailscale identity skips the bootstrap-token/QR pairing round trip.
- It does not bypass device identity itself: device-less clients are still rejected, and node-role connections still go through normal pairing and auth checks.

### Externally managed Serve and Funnel

You can point a native Tailscale Serve or Funnel route at the ordinary Gateway listener when another service owns the route. Configure the route's immediate source narrowly in `gateway.trustedProxies`, and ensure it overwrites or safely rebuilds `X-Forwarded-For`. OpenClaw then treats the request as generic `trusted-proxy` ingress, uses the forwarded client address for rate limits, and applies the configured gateway auth mode normally. Because Funnel is public, Gateway-protected routes reject externally managed Funnel ingress when `gateway.auth.mode` is `none`; configure token, password, or trusted-proxy authentication. The aggregate health, readiness, and startup probes retain their existing unauthenticated responses, without exposing detailed readiness or startup data. See [Health and readiness](/gateway/health).

This compatibility path does not grant managed Tailscale semantics: `gateway.auth.allowTailscale` cannot provide tokenless auth, OpenClaw does not call `tailscale whois`, and it does not own or clean up the external route. Without an explicitly trusted source and a valid non-loopback forwarded client address, Gateway-authenticated routes fail with `proxy_attribution_required`. If the proxy connects over loopback, adding `127.0.0.1` to `trustedProxies` explicitly trusts same-host processes to supply proxy attribution; keep token or password auth enabled unless every process on the host belongs to the same trust boundary.

## Notes

- Tailscale Serve/Funnel requires the `tailscale` CLI installed and logged in.
- `tailscale.mode: "funnel"` refuses to start unless auth mode is `password`, to avoid public exposure.
- OpenClaw holds Serve/Funnel as a foreground Tailscale claim. Gateway startup succeeds only after the claim is active, and stopping or losing the Gateway releases it automatically.
- Named Tailscale Services are not supported by managed ingress because Tailscale requires them to run as persistent background routes. Existing `gateway.tailscale.serviceName` installs must run `openclaw doctor --fix`; Doctor disables managed ingress and removes the key. Inspect the retained Service route, clear it with `tailscale serve clear <service-name>`, then enable device Serve with `gateway.tailscale.mode: "serve"` if desired.
- Older releases could advertise an externally configured default HTTPS Serve route that targeted a `gateway.bind: "lan"` listener. That route does not automatically gain trusted ingress provenance. Prefer migrating to managed ingress: run `openclaw doctor` to preview an atomic change to `gateway.bind: "loopback"` plus `gateway.tailscale.mode: "serve"`; apply it with `openclaw doctor --fix`, then restart the Gateway. Doctor does not reset Tailscale state or guess how to rewrite custom Serve ports and Tailscale Services. If another service must retain ownership, use the explicit `trustedProxies` compatibility path above.
- `gateway.tailscale.preserveFunnel: true` is a deprecated migration guard. It detects an externally configured `tailscale funnel` route before reapplying Serve. If that route still targets the ordinary Gateway listener, OpenClaw leaves it unchanged and warns because the route is not managed ingress. Gateway-authenticated routes work only through the explicit `trustedProxies` compatibility path above and continue to require the configured auth; plugin-authenticated webhook routes such as Google Chat and SMS keep using their own signature/auth checks. To migrate, first configure a durable `gateway.auth.password` (prefer a SecretRef) or `OPENCLAW_GATEWAY_PASSWORD`, set `gateway.auth.mode` to `password`, run `openclaw config set gateway.tailscale.mode funnel`, then `openclaw config unset gateway.tailscale.preserveFunnel`.
- `gateway.bind: "tailnet"` uses a direct Tailnet bind (no HTTPS, no Serve/Funnel) plus required local `127.0.0.1` when a Tailnet IPv4 is available; otherwise it falls back to loopback only.
- `gateway.bind: "auto"` prefers loopback; use `tailnet` to limit network exposure to the Tailnet while retaining same-host loopback access.
- Serve/Funnel only expose the **Gateway control UI + WS**. Nodes connect over the same Gateway WS endpoint, so Serve works for node access too.

### Tailscale prerequisites and limits

- Serve requires HTTPS enabled for your tailnet; the CLI prompts if it is missing.
- Serve injects Tailscale identity headers; Funnel does not.
- OpenClaw-managed Serve/Funnel proxy to a dedicated `127.0.0.1:<ephemeral-port>` listener while ordinary local clients keep the configured Gateway port. Startup fails closed rather than sharing listener provenance, and the foreground claim releases the route when its Gateway owner disappears.
- Funnel requires Tailscale v1.38.3+, MagicDNS, HTTPS enabled, and a funnel node attribute.
- Funnel only supports ports `443`, `8443`, and `10000` over TLS.
- Funnel on macOS requires the open-source Tailscale app variant.

## Browser control (remote Gateway + local browser)

To run the Gateway on one machine but drive a browser on another, run a **node host** on the browser machine and keep both on the same tailnet. The Gateway proxies browser actions to the node; no separate control server or Serve URL is needed.

Avoid Funnel for browser control; treat node pairing like operator access.

## Learn more

- Tailscale Serve overview: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- `tailscale serve` command: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Tailscale Funnel overview: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- `tailscale funnel` command: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)

## Related

- [Remote access](/gateway/remote)
- [Discovery](/gateway/discovery)
- [Authentication](/gateway/authentication)
