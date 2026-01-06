---
summary: "Gateway web surfaces: Control UI, bind modes, and security"
read_when:
  - You want to access the Gateway over Tailscale
  - You want the browser Control UI and config editing
---
# Web (Gateway)

The Gateway serves a small **browser Control UI** (Vite + Lit) from the same port as the Gateway WebSocket:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/clawdbot`)

The UI talks directly to the Gateway WS and supports:
- Chat (`chat.history`, `chat.send`, `chat.abort`)
- Chat tool cards (agent tool events)
- Connections (provider status, WhatsApp QR, Telegram config)
- Instances (`system-presence`)
- Sessions (`sessions.list`, `sessions.patch`)
- Cron (`cron.*`)
- Skills (`skills.status`, `skills.update`, `skills.install`)
- Nodes (`node.list`, `node.describe`, `node.invoke`)
- Config (`config.get`, `config.set`) for `~/.clawdbot/clawdbot.json`
- Debug (status/health/models snapshots + manual calls)

## Webhooks

When `hooks.enabled=true`, the Gateway also exposes a small webhook surface on the same HTTP server.
See `docs/configuration.md` → `hooks` for auth + payloads.

## Config (default-on)

The Control UI is **enabled by default** when assets are present (`dist/control-ui`).
You can control it via config:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/clawdbot" } // basePath optional
  }
}
```

## Tailscale access

### Integrated Serve (recommended)

Keep the Gateway on loopback and let Tailscale Serve proxy it:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" }
  }
}
```

Then start the gateway:

```bash
clawdbot gateway
```

Open:
- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

### Tailnet bind + token (legacy)

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true }
  }
}
```

Then start the gateway (token required for non-loopback binds):

```bash
export CLAWDBOT_GATEWAY_TOKEN="…your token…"
clawdbot gateway
```

Open:
- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

### Public internet (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" } // or CLAWDBOT_GATEWAY_PASSWORD
  }
}
```

## Security notes

- Binding the Gateway to a non-loopback address **requires** auth (`CLAWDBOT_GATEWAY_TOKEN` or `gateway.auth`).
- The UI sends `connect.params.auth.token` or `connect.params.auth.password`.
- Use `gateway.auth.allowTailscale: false` to require explicit credentials even in Serve mode.
- `gateway.tailscale.mode: "funnel"` requires `gateway.auth.mode: "password"` (shared password).

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
bun run ui:install
bun run ui:build
```
