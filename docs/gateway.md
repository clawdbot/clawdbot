---
summary: "Runbook for the Gateway daemon, lifecycle, and operations"
read_when:
  - Running or debugging the gateway process
---
# Gateway (daemon) runbook

Last updated: 2025-12-09

## What it is
- The always-on process that owns the single Baileys/Telegram connection and the control/event plane.
- Replaces the legacy `gateway` command. CLI entry point: `clawdbot gateway`.
- Runs until stopped; exits non-zero on fatal errors so the supervisor restarts it.

## How to run (local)
```bash
pnpm clawdbot gateway --port 18789
# for full debug/trace logs in stdio:
pnpm clawdbot gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
pnpm clawdbot gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```
- Config hot reload watches `~/.clawdbot/clawdbot.json` (or `CLAWDBOT_CONFIG_PATH`).
  - Default mode: `gateway.reload.mode="hybrid"` (hot-apply safe changes, restart on critical).
  - Hot reload uses in-process restart via **SIGUSR1** when needed.
  - Disable with `gateway.reload.mode="off"`.
- Binds WebSocket control plane to `127.0.0.1:<port>` (default 18789).
- The same port also serves HTTP (control UI, hooks, A2UI). Single-port multiplex.
- Starts a Canvas file server by default on `canvasHost.port` (default `18793`), serving `http://<gateway-host>:18793/__clawdbot__/canvas/` from `~/clawd/canvas`. Disable with `canvasHost.enabled=false` or `CLAWDBOT_SKIP_CANVAS_HOST=1`.
- Logs to stdout; use launchd/systemd to keep it alive and rotate logs.
- Pass `--verbose` to mirror debug logging (handshakes, req/res, events) from the log file into stdio when troubleshooting.
- `--force` uses `lsof` to find listeners on the chosen port, sends SIGTERM, logs what it killed, then starts the gateway (fails fast if `lsof` is missing).
- If you run under a supervisor (launchd/systemd/mac app child-process mode), a stop/restart typically sends **SIGTERM**; older builds may surface this as `pnpm` `ELIFECYCLE` exit code **143** (SIGTERM), which is a normal shutdown, not a crash.
- **SIGUSR1** triggers an in-process restart (no external supervisor required). This is what the `gateway` agent tool uses.
- Optional shared secret: pass `--token <value>` or set `CLAWDBOT_GATEWAY_TOKEN` to require clients to send `connect.params.auth.token`.
- Port precedence: `--port` > `CLAWDBOT_GATEWAY_PORT` > `gateway.port` > default `18789`.

## Remote access
- Tailscale/VPN preferred; otherwise SSH tunnel:
  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```
- Clients then connect to `ws://127.0.0.1:18789` through the tunnel.
- If a token is configured, clients must include it in `connect.params.auth.token` even over the tunnel.

## Multiple gateways (same host)

Supported if you isolate state + config and use unique ports.

### Dev profile (`--dev`)

Fast path: run a fully-isolated dev instance (config/state/workspace) without touching your primary setup.

```bash
clawdbot --dev setup
clawdbot --dev gateway --allow-unconfigured
# then target the dev instance:
clawdbot --dev status
clawdbot --dev health
```

Defaults (can be overridden via env/flags/config):
- `CLAWDBOT_STATE_DIR=~/.clawdbot-dev`
- `CLAWDBOT_CONFIG_PATH=~/.clawdbot-dev/clawdbot.json`
- `CLAWDBOT_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- `bridge.port=19002` (derived: `gateway.port+1`)
- `browser.controlUrl=http://127.0.0.1:19003` (derived: `gateway.port+2`)
- `canvasHost.port=19005` (derived: `gateway.port+4`)
- `agent.workspace` default becomes `~/clawd-dev` when you run `setup`/`onboard` under `--dev`.

Derived ports (rules of thumb):
- Base port = `gateway.port` (or `CLAWDBOT_GATEWAY_PORT` / `--port`)
- `bridge.port = base + 1` (or `CLAWDBOT_BRIDGE_PORT` / config override)
- `browser.controlUrl port = base + 2` (or `CLAWDBOT_BROWSER_CONTROL_URL` / config override)
- `canvasHost.port = base + 4` (or `CLAWDBOT_CANVAS_HOST_PORT` / config override)
- Browser profile CDP ports auto-allocate from `browser.controlPort + 9 .. + 108` (persisted per profile).

Checklist per instance:
- unique `gateway.port`
- unique `CLAWDBOT_CONFIG_PATH`
- unique `CLAWDBOT_STATE_DIR`
- unique `agent.workspace`
- separate WhatsApp numbers (if using WA)

Example:
```bash
CLAWDBOT_CONFIG_PATH=~/.clawdbot/a.json CLAWDBOT_STATE_DIR=~/.clawdbot-a clawdbot gateway --port 19001
CLAWDBOT_CONFIG_PATH=~/.clawdbot/b.json CLAWDBOT_STATE_DIR=~/.clawdbot-b clawdbot gateway --port 19002
```

## Protocol (operator view)
- Mandatory first frame from client: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{name,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId}, caps, auth?, locale?, userAgent? } }`.
- Gateway replies `res {type:"res", id, ok:true, payload:hello-ok }` (or `ok:false` with an error, then closes).
- After handshake:
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Events: `{type:"event", event, payload, seq?, stateVersion?}`
- Structured presence entries: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`.
- `agent` responses are two-stage: first `res` ack `{runId,status:"accepted"}`, then a final `res` `{runId,status:"ok"|"error",summary}` after the run finishes; streamed output arrives as `event:"agent"`.

## Methods (initial set)
- `health` — full health snapshot (same shape as `clawdbot health --json`).
- `status` — short summary.
- `system-presence` — current presence list.
- `system-event` — post a presence/system note (structured).
- `send` — send a message via the active provider(s).
- `agent` — run an agent turn (streams events back on same connection).
- `node.list` — list paired + currently-connected bridge nodes (includes `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, and advertised `commands`).
- `node.describe` — describe a node (capabilities + supported `node.invoke` commands; works for paired nodes and for currently-connected unpaired nodes).
- `node.invoke` — invoke a command on a node (e.g. `canvas.*`, `camera.*`).
- `node.pair.*` — pairing lifecycle (`request`, `list`, `approve`, `reject`, `verify`).

See also: `docs/presence.md` for how presence is produced/deduped and why `instanceId` matters.

## Events
- `agent` — streamed tool/output events from the agent run (seq-tagged).
- `presence` — presence updates (deltas with stateVersion) pushed to all connected clients.
- `tick` — periodic keepalive/no-op to confirm liveness.
- `shutdown` — Gateway is exiting; payload includes `reason` and optional `restartExpectedMs`. Clients should reconnect.

## WebChat integration
- WebChat is a native SwiftUI UI that talks directly to the Gateway WebSocket for history, sends, abort, and events.
- Remote use goes through the same SSH/Tailscale tunnel; if a gateway token is configured, the client includes it during `connect`.
- macOS app connects via a single WS (shared connection); it hydrates presence from the initial snapshot and listens for `presence` events to update the UI.

## Typing and validation
- Server validates every inbound frame with AJV against JSON Schema emitted from the protocol definitions.
- Clients (TS/Swift) consume generated types (TS directly; Swift via the repo’s generator).
- Types live in `src/gateway/protocol/*.ts`; regenerate schemas/models with `pnpm protocol:gen` (writes `dist/protocol.schema.json`) and `pnpm protocol:gen:swift` (writes `apps/macos/Sources/ClawdbotProtocol/GatewayModels.swift`).

## Connection snapshot
- `hello-ok` includes a `snapshot` with `presence`, `health`, `stateVersion`, and `uptimeMs` plus `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` so clients can render immediately without extra requests.
- `health`/`system-presence` remain available for manual refresh, but are not required at connect time.

## Error codes (res.error shape)
- Errors use `{ code, message, details?, retryable?, retryAfterMs? }`.
- Standard codes:
  - `NOT_LINKED` — WhatsApp not authenticated.
  - `AGENT_TIMEOUT` — agent did not respond within the configured deadline.
  - `INVALID_REQUEST` — schema/param validation failed.
  - `UNAVAILABLE` — Gateway is shutting down or a dependency is unavailable.

## Keepalive behavior
- `tick` events (or WS ping/pong) are emitted periodically so clients know the Gateway is alive even when no traffic occurs.
- Send/agent acknowledgements remain separate responses; do not overload ticks for sends.

## Replay / gaps
- Events are not replayed. Clients detect seq gaps and should refresh (`health` + `system-presence`) before continuing. WebChat and macOS clients now auto-refresh on gap.

## Supervision (macOS example)
- Use launchd to keep the daemon alive:
  - Program: path to `clawdbot`
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: file paths or `syslog`
- On failure, launchd restarts; fatal misconfig should keep exiting so the operator notices.
- LaunchAgents are per-user and require a logged-in session; for headless setups use a custom LaunchDaemon (not shipped).

Bundled mac app:
- Clawdbot.app can bundle a bun-compiled gateway binary and install a per-user LaunchAgent labeled `com.clawdbot.gateway`.
- To stop it cleanly, use `clawdbot gateway stop` (or `launchctl bootout gui/$UID/com.clawdbot.gateway`).
- To restart, use `clawdbot gateway restart` (or `launchctl kickstart -k gui/$UID/com.clawdbot.gateway`).

## Supervision (systemd user unit)
Create `~/.config/systemd/user/clawdbot-gateway.service`:
```
[Unit]
Description=Clawdbot Gateway
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/clawdbot gateway --port 18789
Restart=always
RestartSec=5
Environment=CLAWDBOT_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```
Enable lingering (required so the user service survives logout/idle):
```
sudo loginctl enable-linger youruser
```
Onboarding runs this on Linux (may prompt for sudo; writes `/var/lib/systemd/linger`).
Then enable the service:
```
systemctl --user enable --now clawdbot-gateway.service
```

**Alternative (system service)** - for always-on or multi-user servers, you can
install a systemd **system** unit instead of a user unit (no lingering needed).
Create `/etc/systemd/system/clawdbot-gateway.service` (copy the unit above,
switch `WantedBy=multi-user.target`, set `User=` + `WorkingDirectory=`), then:
```
sudo systemctl daemon-reload
sudo systemctl enable --now clawdbot-gateway.service
```

## Supervision (Windows scheduled task)
- Onboarding installs a Scheduled Task named `Clawdbot Gateway` (runs on user logon).
- Requires a logged-in user session; for headless setups use a system service or a task configured to run without a logged-in user (not shipped).

## Operational checks
- Liveness: open WS and send `req:connect` → expect `res` with `payload.type="hello-ok"` (with snapshot).
- Readiness: call `health` → expect `ok: true` and `web.linked=true`.
- Debug: subscribe to `tick` and `presence` events; ensure `status` shows linked/auth age; presence entries show Gateway host and connected clients.

## Safety guarantees
- Only one Gateway per host; all sends/agent calls must go through it.
- No fallback to direct Baileys connections; if the Gateway is down, sends fail fast.
- Non-connect first frames or malformed JSON are rejected and the socket is closed.
- Graceful shutdown: emit `shutdown` event before closing; clients must handle close + reconnect.

## CLI helpers
- `clawdbot gateway health|status` — request health/status over the Gateway WS.
- `clawdbot gateway send --to <num> --message "hi" [--media-url ...]` — send via Gateway (idempotent).
- `clawdbot gateway agent --message "hi" [--to ...]` — run an agent turn (waits for final by default).
- `clawdbot gateway call <method> --params '{"k":"v"}'` — raw method invoker for debugging.
- `clawdbot gateway stop|restart` — stop/restart the supervised gateway service (launchd/systemd/schtasks).
- Gateway helper subcommands assume a running gateway on `--url`; they no longer auto-spawn one.

## Migration guidance
- Retire uses of `clawdbot gateway` and the legacy TCP control port.
- Update clients to speak the WS protocol with mandatory connect and structured presence.
