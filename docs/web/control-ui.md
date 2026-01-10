---
summary: "Browser-based control UI for the Gateway (chat, nodes, config)"
read_when:
  - You want to operate the Gateway from a browser
  - You want Tailnet access without SSH tunnels
---
# Control UI (browser)

The Control UI is a small **Vite + Lit** single-page app served by the Gateway:

- default: `http://<host>:18789/`
- optional prefix: set `gateway.controlUi.basePath` (e.g. `/clawdbot`)

It speaks **directly to the Gateway WebSocket** on the same port.

## Quick open (local)

If the Gateway is running on the same computer, open:

- http://127.0.0.1:18789/ (or http://localhost:18789/)

If the page fails to load, start the Gateway first: `clawdbot gateway`.

Auth is supplied during the WebSocket handshake via:
- `connect.params.auth.token`
- `connect.params.auth.password`
The dashboard settings panel lets you store a token; passwords are not persisted.

## What it can do (today)
- Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`)
- Stream tool calls + live tool output cards in Chat (agent events)
- Connections: WhatsApp/Telegram status + QR login + Telegram config (`providers.status`, `web.login.*`, `config.set`)
- Instances: presence list + refresh (`system-presence`)
- Sessions: list + per-session thinking/verbose overrides (`sessions.list`, `sessions.patch`)
- Cron jobs: list/add/run/enable/disable + run history (`cron.*`)
- Skills: status, enable/disable, install, API key updates (`skills.*`)
- Nodes: list + caps (`node.list`)
- Config: view/edit `~/.clawdbot/clawdbot.json` (`config.get`, `config.set`)
- Config: apply + restart with validation (`config.apply`) and wake the last active session
- Config schema + form rendering (`config.schema`); Raw JSON editor remains available
- Debug: status/health/models snapshots + event log + manual RPC calls (`status`, `health`, `models.list`)
- Logs: live tail of gateway file logs with filter/export (`logs.tail`)
- Update: run a package/git update + restart (`update.run`) with a restart report

## Chat behavior

- `chat.send` is **non-blocking**: it acks immediately with `{ runId, status: "started" }` and the response streams via `chat` events.
- Re-sending with the same `idempotencyKey` returns `{ status: "in_flight" }` while running, and `{ status: "ok" }` after completion.
- Stop:
  - Click **Stop** (calls `chat.abort`)
  - Type `/stop` (or `stop|esc|abort|wait|exit`) to abort out-of-band
  - `chat.abort` supports `{ sessionKey }` (no `runId`) to abort all active runs for that session

## Tailnet access (recommended)

### Integrated Tailscale Serve (preferred)

Keep the Gateway on loopback and let Tailscale Serve proxy it with HTTPS:

```bash
clawdbot gateway --tailscale serve
```

Open:
- `https://<magicdns>/` (or your configured `gateway.controlUi.basePath`)

By default, the gateway trusts Tailscale identity headers in serve mode. You can still set
`CLAWDBOT_GATEWAY_TOKEN` or `gateway.auth` if you want a shared secret instead.

### Bind to tailnet + token (legacy)

```bash
clawdbot gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Then open:
- `http://<tailscale-ip>:18789/` (or your configured `gateway.controlUi.basePath`)

Paste the token into the UI settings (sent as `connect.params.auth.token`).

## Building the UI

The Gateway serves static files from `dist/control-ui`. Build them with:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Optional absolute base (when you want fixed asset URLs):

```bash
CLAWDBOT_CONTROL_UI_BASE_PATH=/clawdbot/ pnpm ui:build
```

For local development (separate dev server):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Then point the UI at your Gateway WS URL (e.g. `ws://127.0.0.1:18789`).
