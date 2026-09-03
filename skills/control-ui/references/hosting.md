# Control UI hosting paths

Classify the connection before troubleshooting. “Native” can mean a browser on
the Gateway host, a direct Gateway connection, or a native client; those paths
do not have identical routing.

## Local or direct Gateway

Prefer `openclaw dashboard` on the Gateway host. It creates a short-lived local
bootstrap URL and binds the browser to durable device identity. Do not paste or
log bootstrap credentials.

For a remote browser, prefer an SSH tunnel or HTTPS ingress. Direct browser
access needs both:

- the Gateway Control UI/WebSocket listener; and
- the separate widget sandbox listener, normally the Gateway port plus one.

When the browser reaches the Gateway host directly, OpenClaw can derive the
sandbox origin by substituting the sandbox port. A custom `mcp.apps.sandboxPort`
changes that listener. The sandbox listener is shared by dashboard HTML frames
and enabled MCP Apps, but it never serves the authenticated Control UI.

## Tailscale-hosted Control UI

Use managed Tailscale Serve for browser access:

```bash
openclaw gateway --tailscale serve
```

Serve keeps the Gateway on loopback and publishes the Control UI and WebSocket
over HTTPS. With `gateway.auth.allowTailscale: true`, OpenClaw can accept a
verified Serve identity for Control UI authentication. The browser still needs
device identity. Externally managed Serve routes are generic trusted-proxy
ingress and do not inherit managed Serve authentication semantics.

The managed Control UI route does **not** publish the widget sandbox listener.
For dashboards with HTML or MCP App frames:

1. publish the sandbox listener at a second HTTPS origin reachable by the same
   browser;
2. route that origin only to the configured sandbox port;
3. set `mcp.apps.sandboxOrigin` to that public origin;
4. restart the Gateway;
5. update or republish the widget to issue a fresh ticketed frame URL;
6. verify the frame in the Tailscale-hosted Control UI.

Example shape:

```json5
{
  mcp: {
    apps: {
      sandboxOrigin: "https://widgets.example.ts.net",
      sandboxPort: 18790,
    },
  },
}
```

The sandbox origin must differ from the Control UI origin. Never host
authenticated or sensitive content on it. Preserve existing Tailscale routes;
inspect them before adding or changing a route.

Do not use `gateway.bind: "tailnet"` with plain HTTP for a browser Control UI.
That direct bind is intended for native or CLI clients. Prefer Tailscale Serve
for a browser. Use Funnel only when public exposure is intentional and protect
it with the required password.

## Other reverse proxies

The same two-origin rule applies to nginx, Caddy, Cloudflare Tunnel, and other
TLS terminators:

- one authenticated origin for the Control UI and WebSocket;
- one unprivileged origin, routed only to the sandbox listener, for widget
  frames;
- `mcp.apps.sandboxOrigin` set to the second origin.

Do not forward arbitrary authentication headers. Follow the trusted-proxy
documentation when a proxy owns identity.

## Diagnose by layer

1. **Gateway:** Control UI and WebSocket reachable; authentication and device
   identity succeed.
2. **Board state:** `dashboard read` returns the expected widget and revision.
3. **Sandbox route:** configured sandbox origin reaches only the sandbox
   listener.
4. **Ticket:** the current frame URL is fresh after restart or republish.
5. **Rendering:** the browser loads the frame and its controls work.

A working Control UI shell with a blank widget usually points to layers 3–5,
not board storage.

Source documentation:

- `docs/web/control-ui.md`
- `docs/web/dashboards.md`
- `docs/web/dashboard-architecture.md`
- `docs/gateway/tailscale.md`
- `docs/cli/mcp.md` (MCP Apps sandbox listener)
