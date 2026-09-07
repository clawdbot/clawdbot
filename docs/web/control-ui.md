---
summary: "Browser-based control UI for the Gateway (chat, activity, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
title: "Control UI"
sidebarTitle: "Control UI"
---

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/openclaw`)

`gateway.controlUi.enabled` hot-applies. Disable it to stop serving dashboard
pages and assets while bots and existing Gateway connections keep running.
Re-enable it to resume serving; missing assets are prepared in the background.
Changing the serving base path or asset root still requires a Gateway restart.

For unmatched HTTP paths, the app-shell fallback respects the request's `Accept` header. An explicit HTML rejection such as `text/html;q=0, */*` overrides the broader wildcard, so the request reaches the startup `503` or final `404` response. Headerless and wildcard-only requests retain the browser navigation fallback.

It speaks **directly to the Gateway WebSocket** on the same port.

While the initial connection or a route loads, shimmer placeholders reserve the chat layout. They respect your theme and reduced-motion preference; Gateway startup progress remains visible when available.

Closed Terminal, Browser, Desktop, and Home/Ask OpenClaw panels initialize when you open them rather than during initial navigation. Panels saved as open still restore after a reload.

## Quick open (local)

If the Gateway is running on the same computer, open [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (or [http://localhost:18789/](http://localhost:18789/)).

If the page fails to load, start the Gateway first: `openclaw gateway`.

<Note>
On native Windows LAN binds, Windows Firewall or organization-managed Group Policy can still block the advertised LAN URL even when `127.0.0.1` works on the Gateway host. Run `openclaw gateway status --deep` on the Windows host; it reports likely-blocked ports, profile mismatches, and local firewall rules that policy may ignore.
</Note>

Auth is supplied during the WebSocket handshake via:

- `connect.params.auth.token`
- `connect.params.auth.password`
- Tailscale Serve identity headers when `gateway.auth.allowTailscale: true`
- trusted-proxy identity headers when `gateway.auth.mode: "trusted-proxy"`

Gateway auth runs before device pairing. A direct loopback connection does not bypass token or password auth. The dashboard settings panel keeps a token for the current browser tab session and selected gateway URL; passwords are not persisted. After pairing, the browser can use its stored per-device token on later connections.

Onboarding usually configures a gateway token for shared-secret auth. If the Gateway starts in token mode without a configured token, it generates an ephemeral runtime token for that process instead. The runtime token is not written to config, so it cannot be recovered and a loopback browser without that token is rejected. Run `openclaw doctor --generate-gateway-token`, restart the Gateway, then run `openclaw gateway auth-token --show` in an interactive terminal and paste the output into Control UI settings. Password auth works instead when `gateway.auth.mode` is `"password"`.

## What each page covers

- [Connect and pair](/web/control-ui/connect-and-pair) — pair a browser or phone, reach the UI over Tailscale, and fix a blank page.
- [Sessions and sidebar](/web/control-ui/sessions-and-sidebar) — sidebar zones, session menus, and the New session page.
- [Chat](/web/control-ui/chat) — composer controls, the session rail, transcript rendering, and hosted embeds.
- [Panels and docks](/web/control-ui/panels) — Ask OpenClaw, the Home dock, the operator terminal, and the browser panel.
- [Settings](/web/control-ui/settings) — identity, appearance, plugins, updates, MCP, activity, and meetings.
- [Feature and RPC reference](/web/control-ui/feature-reference) — every capability with the Gateway RPC behind it.
- [Offline and reconnect](/web/control-ui/offline-and-reconnect) — what survives a dropped connection.
- [Security model](/web/control-ui/security-model) — content security policy, media route auth, and approval links.
- [Build and develop](/web/control-ui/development) — build the UI and run the dev server against a Gateway.

## Related

- [Dashboard](/web/dashboard) — gateway dashboard
- [Health Checks](/gateway/health) — gateway health monitoring
- [TUI](/web/tui) — terminal user interface
- [WebChat](/web/webchat) — browser-based chat interface
