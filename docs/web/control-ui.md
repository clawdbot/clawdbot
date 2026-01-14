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
The onboarding wizard generates a gateway token by default, so paste it here on first connect.

## What it can do (today)
- Chat with the model via Gateway WS (`chat.history`, `chat.send`, `chat.abort`)
- Stream tool calls + live tool output cards in Chat (agent events)
- Connections: WhatsApp/Telegram status + QR login + Telegram config (`channels.status`, `web.login.*`, `config.set`)
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

## Model presets (Config tab)

The Config tab includes **Model presets**: one-click inserts to add common model providers and set a default model:

- **MiniMax M2.1 (Anthropic)** → configures MiniMax via `https://api.minimax.io/anthropic` and `anthropic-messages` (see [/providers/minimax](/providers/minimax))
- **GLM 4.7 (Z.AI)** → adds `ZAI_API_KEY` + sets `zai/glm-4.7` (see [/providers/zai](/providers/zai))
- **Kimi (Moonshot)** → configures Moonshot + sets `moonshot/kimi-k2-0905-preview` (see [/providers/moonshot](/providers/moonshot))

Notes:
- Presets **keep existing API keys and per-model params** when present.
- Use `/model` (see [/tools/slash-commands](/tools/slash-commands)) to switch models from chat without editing config.

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

By default, Serve requests can authenticate via Tailscale identity headers
(`tailscale-user-login`) when `gateway.auth.allowTailscale` is `true`. Clawdbot
only accepts these when the request hits loopback with Tailscale’s
`x-forwarded-*` headers. Set `gateway.auth.allowTailscale: false` (or force
`gateway.auth.mode: "password"`) if you want to require a token/password even
for Serve traffic.

### Bind to tailnet + token

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
