---
summary: "WebSocket gateway architecture, components, and client flows"
read_when:
  - Working on gateway protocol, clients, or transports
---
# Gateway Architecture

Last updated: 2026-01-05

## Overview
- A single long-lived **Gateway** process owns all messaging surfaces (WhatsApp via Baileys, Telegram via grammY, Slack via Bolt, Discord via discord.js, Signal via signal-cli, iMessage via imsg, WebChat) and the control/event plane.
- All clients (macOS app, CLI, web UI, automations) connect to the Gateway over one transport: **WebSocket on the configured bind host** (default `127.0.0.1:18789`; tunnel or VPN for remote).
- One Gateway per host; it is the only place that is allowed to open a WhatsApp session. All sends/agent runs go through it.
- By default: the Gateway exposes a Canvas host on `canvasHost.port` (default `18793`), serving `~/clawd/canvas` at `/__clawdbot__/canvas/` with live-reload; disable via `canvasHost.enabled=false` or `CLAWDBOT_SKIP_CANVAS_HOST=1`.

## Implementation snapshot (current code)

### TypeScript Gateway (`src/gateway/server.ts`)
- Single HTTP + WebSocket server (default `18789`); bind policy `loopback|lan|tailnet|auto`. Refuses non-loopback binds without auth; Tailscale serve/funnel requires loopback.
- Handshake: first frame must be a `connect` request; AJV validates request + params against TypeBox schemas; protocol negotiated via `minProtocol`/`maxProtocol`.
- `hello-ok` includes snapshot (presence/health/stateVersion/uptime/configPath/stateDir), features (methods/events), policy (max payload/buffer/tick), and `canvasHostUrl` when available.
- Events emitted: `agent`, `chat`, `presence`, `tick`, `health`, `heartbeat`, `cron`, `talk.mode`, `node.pair.requested`, `node.pair.resolved`, `voicewake.changed`, `shutdown`.
- Idempotency keys are required for `send`, `agent`, `chat.send`, and node invokes; the dedupe cache avoids double-sends on reconnects. Payload sizes are capped per connection.
- Optional node bridge (`src/infra/bridge/server.ts`): TCP JSONL frames (`hello`, `pair-request`, `req/res`, `event`, `invoke`, `ping`). Node connect/disconnect updates presence and flows into the session bus.
- Control UI + Canvas host: HTTP serves Control UI (base path configurable) and can host the A2UI canvas via `src/canvas-host/server.ts` (live reload). Canvas host URL is advertised to nodes + clients.

### iOS node (`apps/ios`)
- Discovery + pairing: `BridgeDiscoveryModel` uses `NWBrowser` Bonjour discovery and reads TXT fields for LAN/tailnet host hints plus gateway/bridge/canvas ports.
- Auto-connect: `BridgeConnectionController` uses stored `node.instanceId` + Keychain token; supports manual host/port; performs `pair-and-hello`.
- Bridge runtime: `BridgeSession` actor owns an `NWConnection`, JSONL frames, `hello`/`hello-ok`, ping/pong, `req/res`, server `event`s, and `invoke` callbacks; stores `canvasHostUrl`.
- Commands: `NodeAppModel` executes `canvas.*`, `canvas.a2ui.*`, `camera.*`, `screen.record`, `location.get`. Canvas/camera/screen are blocked when backgrounded.
- Canvas + actions: `WKWebView` with A2UI action bridge; accepts actions from local-network or trusted file URLs; intercepts `clawdbot://` deep links and forwards `agent.request` to the bridge.
- Voice/talk: voice wake sends `voice.transcript` events and syncs triggers via `voicewake.get` + `voicewake.changed`; Talk Mode attaches to the bridge.

### Android node (`apps/android`)
- Discovery + pairing: `BridgeDiscovery` uses mDNS/NSD to find `_clawdbot-bridge._tcp`, with manual host/port fallback.
- Auto-connect: `NodeRuntime` restores a stored token, performs `pair-and-hello`, and reconnects to the last discovered or manual bridge.
- Bridge runtime: `BridgeSession` owns the TCP JSONL session (`hello`/`hello-ok`, ping/pong, `req/res`, `event`, `invoke`); stores `canvasHostUrl`.
- Commands: `NodeRuntime` executes `canvas.*`, `canvas.a2ui.*`, `camera.*`, and chat/session events; foreground-only for canvas/camera.

## Components and flows
- **Gateway (daemon)**  
  - Maintains WhatsApp (Baileys), Telegram (grammY), Slack (Bolt), Discord (discord.js), Signal (signal-cli), and iMessage (imsg) connections.  
  - Exposes a typed WS API (req/resp + server push events).  
  - Validates every inbound frame against JSON Schema; rejects anything before a mandatory `connect`.
- **Clients (mac app / CLI / web admin)**  
  - One WS connection per client.  
  - Send requests (`health`, `status`, `send`, `agent`, `system-presence`, toggles) and subscribe to events (`tick`, `agent`, `presence`, `shutdown`).
  - On macOS, the app can also be invoked via deep links (`clawdbot://agent?...`) which translate into the same Gateway `agent` request path (see `docs/macos.md`).
- **Agent process (Pi)**  
  - Spawned by the Gateway on demand for `agent` calls; streams events back over the same WS connection.
- **WebChat**  
  - Serves static assets locally.  
  - Holds a single WS connection to the Gateway for control/data; all sends/agent runs go through the Gateway WS.  
  - Remote use goes through the same SSH/Tailscale tunnel as other clients.

## Connection lifecycle (single client)
```
Client                    Gateway
  |                          |
  |---- req:connect -------->|
  |<------ res (ok) ---------|   (or res error + close)
  |   (payload=hello-ok carries snapshot: presence + health) 
  |                          |
  |<------ event:presence ---|   (deltas)
  |<------ event:tick -------|   (keepalive/no-op)
  |                          |
  |------- req:agent ------->|
  |<------ res:agent --------|   (ack: {runId,status:"accepted"})
  |<------ event:agent ------|   (streaming)
  |<------ res:agent --------|   (final: {runId,status,summary})
  |                          |
```
## Wire protocol (summary)
- Transport: WebSocket, text frames with JSON payloads.
- First frame must be `req {type:"req", id, method:"connect", params:{minProtocol, maxProtocol, client:{name,version,platform,mode,instanceId}, caps, auth?, locale?, userAgent? } }`.
- Server replies `res {type:"res", id, ok:true, payload: hello-ok }` or `ok:false` then closes.
- After handshake:  
  - Requests: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`  
  - Events: `{type:"event", event:"agent"|"presence"|"tick"|"shutdown", payload, seq?, stateVersion?}`
- If `CLAWDBOT_GATEWAY_TOKEN` (or `--token`) is set, `connect.params.auth.token` must match; otherwise the socket closes with policy violation.
- Presence payload is structured, not free text: `{host, ip, version, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }`.
- Agent runs are acked `{runId,status:"accepted"}` then complete with a final res `{runId,status,summary}`; streamed output arrives as `event:"agent"`.
- Protocol versions are bumped on breaking changes; clients must match `minClient`; Gateway chooses within client’s min/max.
- Idempotency keys are required for side-effecting methods (`send`, `agent`) to safely retry; server keeps a short-lived dedupe cache.
- Policy in `hello-ok` communicates payload/queue limits and tick interval.

## Type system and codegen
- Source of truth: TypeBox (or ArkType) definitions in `protocol/` on the server.
- Build step emits JSON Schema.  
- Clients:
  - TypeScript: uses the same TypeBox types directly.
  - Swift: generated `Codable` models via quicktype from the JSON Schema.
- Validation: AJV on the server for every inbound frame; optional client-side validation for defensive programming.

## Invariants
- Exactly one Gateway controls a single Baileys session per host. No fallbacks to ad-hoc direct Baileys sends.
- Handshake is mandatory; any non-JSON or non-connect first frame is a hard close.
- All methods and events are versioned; new fields are additive; breaking changes increment `protocol`.
- No event replay: on seq gaps, clients must refresh (`health` + `system-presence`) and continue; presence is bounded via TTL/max entries.

## Remote access
- Preferred: Tailscale or VPN; alternate: SSH tunnel `ssh -N -L 18789:127.0.0.1:18789 user@host`.
- Same protocol over the tunnel; same handshake. If a shared token is configured, clients must send it in `connect.params.auth.token` even over the tunnel.
- Same protocol over the tunnel; same handshake. If a shared token is configured, clients must send it in `connect.params.auth.token` even over the tunnel.

## Operations snapshot
- Start: `clawdbot gateway` (foreground, logs to stdout).  
  Supervise with launchd/systemd for restarts.  
- Health: request `health` over WS; also surfaced in `hello-ok.health`.  
- Metrics/logging: keep outside this spec; gateway should expose Prometheus text or structured logs separately.

## Migration notes
- This architecture supersedes the legacy stdin RPC and the ad-hoc TCP control port. New clients should speak only the WS protocol. Legacy compatibility is intentionally dropped.
