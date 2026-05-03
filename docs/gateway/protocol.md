---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gateway protocol"
---

The Gateway WS protocol is the **single control plane + node transport** for
OpenClaw. All clients (CLI, web UI, macOS app, iOS/Android nodes, headless
nodes) connect over WebSocket and declare their **role** + **scope** at
handshake time.

## Transport

- WebSocket, text frames with JSON payloads.
- First frame **must** be a `connect` request.
- Pre-connect frames are capped at 64 KiB. After a successful handshake, clients
  should follow the `hello-ok.policy.maxPayload` and
  `hello-ok.policy.maxBufferedBytes` limits. With diagnostics enabled,
  oversized inbound frames and slow outbound buffers emit `payload.large` events
  before the gateway closes or drops the affected frame. These events keep
  sizes, limits, surfaces, and safe reason codes. They do not keep the message
  body, attachment contents, raw frame body, tokens, cookies, or secret values.

## Handshake (connect)

Gateway → Client (pre-connect challenge):

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client → Gateway:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "cli",
      "version": "1.2.3",
      "platform": "macos",
      "mode": "operator"
    },
    "role": "operator",
    "scopes": ["operator.read", "operator.write"],
    "caps": [],
    "commands": [],
    "permissions": {},
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-cli/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

Gateway → Client:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 3,
    "server": { "version": "…", "connId": "…" },
    "features": { "methods": ["…"], "events": ["…"] },
    "snapshot": { "…": "…" },
    "auth": {
      "role": "operator",
      "scopes": ["operator.read", "operator.write"]
    },
    "policy": {
      "maxPayload": 26214400,
      "maxBufferedBytes": 52428800,
      "tickIntervalMs": 15000
    }
  }
}
```

While the Gateway is still finishing startup sidecars, the `connect` request can
return a retryable `UNAVAILABLE` error with `details.reason` set to
`"startup-sidecars"` and `retryAfterMs`. Clients should retry that response
within their overall connection budget instead of surfacing it as a terminal
handshake failure.

`server`, `features`, `snapshot`, and `policy` are all required by the schema
(`src/gateway/protocol/schema/frames.ts`). `auth` is also required and reports
the negotiated role/scopes. `canvasHostUrl` is optional.

When no device token is issued, `hello-ok.auth` reports the negotiated
permissions without token fields:

```json
{
  "auth": {
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

Trusted same-process backend clients (`client.id: "gateway-client"`,
`client.mode: "backend"`) may omit `device` on direct loopback connections when
they authenticate with the shared gateway token/password. This path is reserved
for internal control-plane RPCs and keeps stale CLI/device pairing baselines from
blocking local backend work such as subagent session updates. Remote clients,
browser-origin clients, node clients, and explicit device-token/device-identity
clients still use the normal pairing and scope-upgrade checks.

When a device token is issued, `hello-ok` also includes:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

During trusted bootstrap handoff, `hello-ok.auth` may also include additional
bounded role entries in `deviceTokens`:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "node",
    "scopes": [],
    "deviceTokens": [
      {
        "deviceToken": "…",
        "role": "operator",
        "scopes": ["operator.approvals", "operator.read", "operator.talk.secrets", "operator.write"]
      }
    ]
  }
}
```

For the built-in node/operator bootstrap flow, the primary node token stays
`scopes: []` and any handed-off operator token stays bounded to the bootstrap
operator allowlist (`operator.approvals`, `operator.read`,
`operator.talk.secrets`, `operator.write`). Bootstrap scope checks stay
role-prefixed: operator entries only satisfy operator requests, and non-operator
roles still need scopes under their own role prefix.

### Node example

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 3,
    "maxProtocol": 3,
    "client": {
      "id": "ios-node",
      "version": "1.2.3",
      "platform": "ios",
      "mode": "node"
    },
    "role": "node",
    "scopes": [],
    "caps": ["camera", "canvas", "screen", "location", "voice"],
    "commands": ["camera.snap", "canvas.navigate", "screen.record", "location.get"],
    "permissions": { "camera.capture": true, "screen.record": false },
    "auth": { "token": "…" },
    "locale": "en-US",
    "userAgent": "openclaw-ios/1.2.3",
    "device": {
      "id": "device_fingerprint",
      "publicKey": "…",
      "signature": "…",
      "signedAt": 1737264000000,
      "nonce": "…"
    }
  }
}
```

## Framing

- **Request**: `{type:"req", id, method, params}`
- **Response**: `{type:"res", id, ok, payload|error}`
- **Event**: `{type:"event", event, payload, seq?, stateVersion?}`

Side-effecting methods require **idempotency keys** (see schema).

## Roles + scopes

For the full operator scope model, approval-time checks, and shared-secret
semantics, see [Operator scopes](/gateway/operator-scopes).

### Roles

- `operator` = control plane client (CLI/UI/automation).
- `node` = capability host (camera/screen/canvas/system.run).

### Scopes (operator)

Common scopes:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`
- `operator.talk.secrets`

`talk.config` with `includeSecrets: true` requires `operator.talk.secrets`
(or `operator.admin`).

Plugin-registered gateway RPC methods may request their own operator scope, but
reserved core admin prefixes (`config.*`, `exec.approvals.*`, `wizard.*`,
`update.*`) always resolve to `operator.admin`.

Method scope is only the first gate. Some slash commands reached through
`chat.send` apply stricter command-level checks on top. For example, persistent
`/config set` and `/config unset` writes require `operator.admin`.

`node.pair.approve` also has an extra approval-time scope check on top of the
base method scope:

- commandless requests: `operator.pairing`
- requests with non-exec node commands: `operator.pairing` + `operator.write`
- requests that include `system.run`, `system.run.prepare`, or `system.which`:
  `operator.pairing` + `operator.admin`

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.

## Presence

- `system-presence` returns entries keyed by device identity.
- Presence entries include `deviceId`, `roles`, and `scopes` so UIs can show a single row per device
  even when it connects as both **operator** and **node**.
- `node.list` includes optional `lastSeenAtMs` and `lastSeenReason` fields. Connected nodes report
  their current connection time as `lastSeenAtMs` with reason `connect`; paired nodes can also report
  durable background presence when a trusted node event updates their pairing metadata.

### Node background alive event

Nodes may call `node.event` with `event: "node.presence.alive"` to record that a paired node was
alive during a background wake without marking it connected.

```json
{
  "event": "node.presence.alive",
  "payloadJSON": "{\"trigger\":\"silent_push\",\"sentAtMs\":1737264000000,\"displayName\":\"Peter's iPhone\",\"version\":\"2026.4.28\",\"platform\":\"iOS 18.4.0\",\"deviceFamily\":\"iPhone\",\"modelIdentifier\":\"iPhone17,1\",\"pushTransport\":\"relay\"}"
}
```

`trigger` is a closed enum: `background`, `silent_push`, `bg_app_refresh`,
`significant_location`, `manual`, or `connect`. Unknown trigger strings are normalized to
`background` by the gateway before persistence. The event is durable only for authenticated node
device sessions; device-less or unpaired sessions return `handled: false`.

Successful gateways return a structured result:

```json
{
  "ok": true,
  "event": "node.presence.alive",
  "handled": true,
  "reason": "persisted"
}
```

Older gateways may still return `{ "ok": true }` for `node.event`; clients should treat that as an
acknowledged RPC, not as durable presence persistence.

## Broadcast event scoping

Server-pushed WebSocket broadcast events are scope-gated so that pairing-scoped or node-only sessions do not passively receive session content.

- **Chat, agent, and tool-result frames** (including streamed `agent` events and tool call results) require at least `operator.read`. Sessions without `operator.read` skip these frames entirely.
- **Plugin-defined `plugin.*` broadcasts** are gated to `operator.write` or `operator.admin`, depending on how the plugin registered them.
- **Status and transport events** (`heartbeat`, `presence`, `tick`, connect/disconnect lifecycle, etc.) remain unrestricted so transport health stays observable to every authenticated session.
- **Unknown broadcast event families** are scope-gated by default (fail-closed) unless a registered handler explicitly relaxes them.

Each client connection keeps its own per-client sequence number so broadcasts preserve monotonic ordering on that socket even when different clients see different scope-filtered subsets of the event stream.

## Common RPC method families

The public WS surface is broader than the handshake/auth examples above. This
is not a generated dump — `hello-ok.features.methods` is a conservative
discovery list built from `src/gateway/server-methods-list.ts` plus loaded
plugin/channel method exports. Treat it as feature discovery, not a full
enumeration of `src/gateway/server-methods/*.ts`.

<AccordionGroup>
  <Accordion title="System and identity">
    - `health` returns the cached or freshly probed gateway health snapshot.
    - `diagnostics.stability` returns the recent bounded diagnostic stability recorder. It keeps operational metadata such as event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, and session ids. It does not keep chat text, webhook bodies, tool outputs, raw request or response bodies, tokens, cookies, or secret values. Operator read scope is required.
    - `status` returns the `/status`-style gateway summary; sensitive fields are included only for admin-scoped operator clients.
    - `gateway.identity.get` returns the gateway device identity used by relay and pairing flows.
    - `system-presence` returns the current presence snapshot for connected operator/node devices.
    - `system-event` appends a system event and can update/broadcast presence context.
    - `last-heartbeat` returns the latest persisted heartbeat event.
    - `set-heartbeats` toggles heartbeat processing on the gateway.

  </Accordion>

  <Accordion title="Models and usage">
    - `models.list` returns the runtime-allowed model catalog. Pass `{ "view": "configured" }` for picker-sized configured models (`agents.defaults.models` first, then `models.providers.*.models`), or `{ "view": "all" }` for the full catalog.
    - `usage.status` returns provider usage windows/remaining quota summaries.
    - `usage.cost` returns aggregated cost usage summaries for a date range.
    - `doctor.memory.status` returns vector-memory / cached embedding readiness for the active default agent workspace. Pass `{ "probe": true }` or `{ "deep": true }` only when the caller explicitly wants a live embedding provider ping.
    - `doctor.memory.remHarness` returns a bounded, read-only REM harness preview for remote control-plane clients. It can include workspace paths, memory snippets, rendered grounded markdown, and deep promotion candidates, so callers need `operator.read`.
    - `sessions.usage` returns per-session usage summaries.
    - `sessions.usage.timeseries` returns timeseries usage for one session.
    - `sessions.usage.logs` returns usage log entries for one session.

  </Accordion>

  <Accordion title="Channels and login helpers">
    - `channels.status` returns built-in + bundled channel/plugin status summaries.
    - `channels.logout` logs out a specific channel/account where the channel supports logout.
    - `web.login.start` starts a QR/web login flow for the current QR-capable web channel provider.
    - `web.login.wait` waits for that QR/web login flow to complete and starts the channel on success.
    - `push.test` sends a test APNs push to a registered iOS node.
    - `voicewake.get` returns the stored wake-word triggers.
    - `voicewake.set` updates wake-word triggers and broadcasts the change.

  </Accordion>

  <Accordion title="Messaging and logs">
    - `send` is the direct outbound-delivery RPC for channel/account/thread-targeted sends outside the chat runner.
    - `logs.tail` returns the configured gateway file-log tail with cursor/limit and max-byte controls.

  </Accordion>

  <Accordion title="Talk and TTS">
    - `talk.config` returns the effective Talk config payload; `includeSecrets` requires `operator.talk.secrets` (or `operator.admin`).
    - `talk.mode` sets/broadcasts the current Talk mode state for WebChat/Control UI clients.
    - `talk.speak` synthesizes speech through the active Talk speech provider.
    - `tts.status` returns TTS enabled state, active provider, fallback providers, and provider config state.
    - `tts.providers` returns the visible TTS provider inventory.
    - `tts.enable` and `tts.disable` toggle TTS prefs state.
    - `tts.setProvider` updates the preferred TTS provider.
    - `tts.convert` runs one-shot text-to-speech conversion.

  </Accordion>

  <Accordion title="Secrets, config, update, and wizard">
    - `secrets.reload` re-resolves active SecretRefs and swaps runtime secret state only on full success.
    - `secrets.resolve` resolves command-target secret assignments for a specific command/target set.
    - `config.get` returns the current config snapshot and hash.
    - `config.set` writes a validated config payload.
    - `config.patch` merges a partial config update.
    - `config.apply` validates + replaces the full config payload.
    - `config.schema` returns the live config schema payload used by Control UI and CLI tooling: schema, `uiHints`, version, and generation metadata, including plugin + channel schema metadata when the runtime can load it. The schema includes field `title` / `description` metadata derived from the same labels and help text used by the UI, including nested object, wildcard, array-item, and `anyOf` / `oneOf` / `allOf` composition branches when matching field documentation exists.
    - `config.schema.lookup` returns a path-scoped lookup payload for one config path: normalized path, a shallow schema node, matched hint + `hintPath`, and immediate child summaries for UI/CLI drill-down. Lookup schema nodes keep the user-facing docs and common validation fields (`title`, `description`, `type`, `enum`, `const`, `format`, `pattern`, numeric/string/array/object bounds, and flags like `additionalProperties`, `deprecated`, `readOnly`, `writeOnly`). Child summaries expose `key`, normalized `path`, `type`, `required`, `hasChildren`, plus the matched `hint` / `hintPath`.
    - `update.run` runs the gateway update flow and schedules a restart only when the update itself succeeded. Package-manager updates force a non-deferred, no-cooldown update restart after the package swap so the old Gateway process does not keep lazy-loading from a replaced `dist` tree.
    - `update.status` returns the latest cached update restart sentinel, including the post-restart running version when available.
    - `wizard.start`, `wizard.next`, `wizard.status`, and `wizard.cancel` expose the onboarding wizard over WS RPC.

  </Accordion>

  <Accordion title="Agent and workspace helpers">
    - `agents.list` returns configured agent entries, including effective model and runtime metadata.
    - `agents.create`, `agents.update`, and `agents.delete` manage agent records and workspace wiring.
    - `agents.files.list`, `agents.files.get`, and `agents.files.set` manage the bootstrap workspace files exposed for an agent.
    - `artifacts.list`, `artifacts.get`, and `artifacts.download` expose transcript-derived artifact summaries and downloads for an explicit `sessionKey`, `runId`, or `taskId` scope. Run and task queries resolve the owning session server-side and only return transcript media with matching provenance; unsafe or local URL sources return unsupported downloads instead of fetching server-side.
    - `agent.identity.get` returns the effective assistant identity for an agent or session.
    - `agent.wait` waits for a run to finish and returns the terminal snapshot when available.

  </Accordion>

  <Accordion title="Session control">
    - `sessions.list` returns the current session index, including per-row `agentRuntime` metadata when an agent runtime backend is configured.
    - `sessions.subscribe` and `sessions.unsubscribe` toggle session change event subscriptions for the current WS client.
    - `sessions.messages.subscribe` and `sessions.messages.unsubscribe` toggle transcript/message event subscriptions for one session.
    - `sessions.preview` returns bounded transcript previews for specific session keys.
    - `sessions.describe` returns one Gateway session row for an exact session key.
    - `sessions.resolve` resolves or canonicalizes a session target.
    - `sessions.create` creates a new session entry.
    - `sessions.send` sends a message into an existing session.
    - `sessions.steer` is the interrupt-and-steer variant for an active session.
    - `sessions.abort` aborts active work for a session. A caller may pass `key` plus optional `runId`, or pass `runId` alone for active runs the Gateway can resolve to a session.
    - `sessions.patch` updates session metadata/overrides and reports the resolved canonical model plus effective `agentRuntime`.
    - `sessions.reset`, `sessions.delete`, and `sessions.compact` perform session maintenance.
    - `sessions.get` returns the full stored session row.
    - Chat execution still uses `chat.history`, `chat.send`, `chat.abort`, and `chat.inject`. `chat.history` is display-normalized for UI clients: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (including `<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks) and leaked ASCII/full-width model control tokens are stripped, pure silent-token assistant rows such as exact `NO_REPLY` / `no_reply` are omitted, and oversized rows can be replaced with placeholders.

  </Accordion>

  <Accordion title="Device pairing and device tokens">
    - `device.pair.list` returns pending and approved paired devices.
    - `device.pair.approve`, `device.pair.reject`, and `device.pair.remove` manage device-pairing records.
    - `device.token.rotate` rotates a paired device token within its approved role and caller scope bounds.
    - `device.token.revoke` revokes a paired device token within its approved role and caller scope bounds.

  </Accordion>

  <Accordion title="Node pairing, invoke, and pending work">
    - `node.pair.request`, `node.pair.list`, `node.pair.approve`, `node.pair.reject`, `node.pair.remove`, and `node.pair.verify` cover node pairing and bootstrap verification.
    - `node.list` and `node.describe` return known/connected node state.
    - `node.rename` updates a paired node label.
    - `node.invoke` forwards a command to a connected node.
    - `node.invoke.result` returns the result for an invoke request.
    - `node.event` carries node-originated events back into the gateway.
    - `node.canvas.capability.refresh` refreshes scoped canvas-capability tokens.
    - `node.pending.pull` and `node.pending.ack` are the connected-node queue APIs.
    - `node.pending.enqueue` and `node.pending.drain` manage durable pending work for offline/disconnected nodes.

  </Accordion>

  <Accordion title="Approval families">
    - `exec.approval.request`, `exec.approval.get`, `exec.approval.list`, and `exec.approval.resolve` cover one-shot exec approval requests plus pending approval lookup/replay.
    - `exec.approval.waitDecision` waits on one pending exec approval and returns the final decision (or `null` on timeout).
    - `exec.approvals.get` and `exec.approvals.set` manage gateway exec approval policy snapshots.
    - `exec.approvals.node.get` and `exec.approvals.node.set` manage node-local exec approval policy via node relay commands.
    - `plugin.approval.request`, `plugin.approval.list`, `plugin.approval.waitDecision`, and `plugin.approval.resolve` cover plugin-defined approval flows.

  </Accordion>

  <Accordion title="Automation, skills, and tools">
    - Automation: `wake` schedules an immediate or next-heartbeat wake text injection; `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` manage scheduled work.
    - Skills and tools: `commands.list`, `skills.*`, `tools.catalog`, `tools.effective`, `tools.invoke`.

  </Accordion>
</AccordionGroup>

### Common event families

- `chat`: UI chat updates such as `chat.inject` and other transcript-only chat
  events.
- `session.message` and `session.tool`: transcript/event-stream updates for a
  subscribed session.
- `sessions.changed`: session index or metadata changed.
- `presence`: system presence snapshot updates.
- `tick`: periodic keepalive / liveness event.
- `health`: gateway health snapshot update.
- `heartbeat`: heartbeat event stream update.
- `cron`: cron run/job change event.
- `shutdown`: gateway shutdown notification.
- `node.pair.requested` / `node.pair.resolved`: node pairing lifecycle.
- `node.invoke.request`: node invoke request broadcast.
- `device.pair.requested` / `device.pair.resolved`: paired-device lifecycle.
- `voicewake.changed`: wake-word trigger config changed.
- `exec.approval.requested` / `exec.approval.resolved`: exec approval
  lifecycle.
- `plugin.approval.requested` / `plugin.approval.resolved`: plugin approval
  lifecycle.

### Node helper methods

- Nodes may call `skills.bins` to fetch the current list of skill executables
  for auto-allow checks.

### Operator helper methods

- Operators may call `commands.list` (`operator.read`) to fetch the runtime
  command inventory for an agent.
  - `agentId` is optional; omit it to read the default agent workspace.
  - `scope` controls which surface the primary `name` targets:
    - `text` returns the primary text command token without the leading `/`
    - `native` and the default `both` path return provider-aware native names
      when available
  - `textAliases` carries exact slash aliases such as `/model` and `/m`.
  - `nativeName` carries the provider-aware native command name when one exists.
  - `provider` is optional and only affects native naming plus native plugin
    command availability.
  - `includeArgs=false` omits serialized argument metadata from the response.
- Operators may call `tools.catalog` (`operator.read`) to fetch the runtime tool catalog for an
  agent. The response includes grouped tools and provenance metadata:
  - `source`: `core` or `plugin`
  - `pluginId`: plugin owner when `source="plugin"`
  - `optional`: whether a plugin tool is optional
- Operators may call `tools.effective` (`operator.read`) to fetch the runtime-effective tool
  inventory for a session.
  - `sessionKey` is required.
  - The gateway derives trusted runtime context from the session server-side instead of accepting
    caller-supplied auth or delivery context.
  - The response is session-scoped and reflects what the active conversation can use right now,
    including core, plugin, and channel tools.
- Operators may call `tools.invoke` (`operator.write`) to invoke one available tool through the
  same gateway policy path as `/tools/invoke`.
  - `name` is required. `args`, `sessionKey`, `agentId`, `confirm`, and
    `idempotencyKey` are optional.
  - If both `sessionKey` and `agentId` are present, the resolved session agent must match
    `agentId`.
  - The response is an SDK-facing envelope with `ok`, `toolName`, optional `output`, and typed
    `error` fields. Approval or policy refusals return `ok:false` in the payload rather than
    bypassing the gateway tool policy pipeline.
- Operators may call `skills.status` (`operator.read`) to fetch the visible
  skill inventory for an agent.
  - `agentId` is optional; omit it to read the default agent workspace.
  - The response includes eligibility, missing requirements, config checks, and
    sanitized install options without exposing raw secret values.
- Operators may call `skills.search` and `skills.detail` (`operator.read`) for
  ClawHub discovery metadata.
- Operators may call `skills.install` (`operator.admin`) in two modes:
  - ClawHub mode: `{ source: "clawhub", slug, version?, force? }` installs a
    skill folder into the default agent workspace `skills/` directory.
  - Gateway installer mode: `{ name, installId, dangerouslyForceUnsafeInstall?, timeoutMs? }`
    runs a declared `metadata.openclaw.install` action on the gateway host.
- Operators may call `skills.update` (`operator.admin`) in two modes:
  - ClawHub mode updates one tracked slug or all tracked ClawHub installs in
    the default agent workspace.
  - Config mode patches `skills.entries.<skillKey>` values such as `enabled`,
    `apiKey`, and `env`.

### `models.list` views

`models.list` accepts an optional `view` parameter:

- Omitted or `"default"`: current runtime behavior. If `agents.defaults.models` is configured, the response is the allowed catalog; otherwise the response is the full Gateway catalog.
- `"configured"`: picker-sized behavior. If `agents.defaults.models` is configured, it still wins. Otherwise the response uses explicit `models.providers.*.models` entries, falling back to the full catalog only when no configured model rows exist.
- `"all"`: full Gateway catalog, bypassing `agents.defaults.models`. Use this for diagnostics and discovery UIs, not normal model pickers.

## Exec approvals

- When an exec request needs approval, the gateway broadcasts `exec.approval.requested`.
- Operator clients resolve by calling `exec.approval.resolve` (requires `operator.approvals` scope).
- For `host=node`, `exec.approval.request` must include `systemRunPlan` (canonical `argv`/`cwd`/`rawCommand`/session metadata). Requests missing `systemRunPlan` are rejected.
- After approval, forwarded `node.invoke system.run` calls reuse that canonical
  `systemRunPlan` as the authoritative command/cwd/session context.
- If a caller mutates `command`, `rawCommand`, `cwd`, `agentId`, or
  `sessionKey` between prepare and the final approved `system.run` forward, the
  gateway rejects the run instead of trusting the mutated payload.

## Agent delivery fallback

- `agent` requests can include `deliver=true` to request outbound delivery.
- `bestEffortDeliver=false` keeps strict behavior: unresolved or internal-only delivery targets return `INVALID_REQUEST`.
- `bestEffortDeliver=true` allows fallback to session-only execution when no external deliverable route can be resolved (for example internal/webchat sessions or ambiguous multi-channel configs).

## Versioning

- `PROTOCOL_VERSION` lives in `src/gateway/protocol/schema/protocol-schemas.ts`.
- Clients send `minProtocol` + `maxProtocol`; the server rejects mismatches.
- Schemas + models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

### Client constants

The reference client in `src/gateway/client.ts` uses these defaults. Values are
stable across protocol v3 and are the expected baseline for third-party clients.

| Constant                                  | Default                                               | Source                                                                                     |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `PROTOCOL_VERSION`                        | `3`                                                   | `src/gateway/protocol/schema/protocol-schemas.ts`                                          |
| Request timeout (per RPC)                 | `30_000` ms                                           | `src/gateway/client.ts` (`requestTimeoutMs`)                                               |
| Preauth / connect-challenge timeout       | `15_000` ms                                           | `src/gateway/handshake-timeouts.ts` (config/env can raise the paired server/client budget) |
| Initial reconnect backoff                 | `1_000` ms                                            | `src/gateway/client.ts` (`backoffMs`)                                                      |
| Max reconnect backoff                     | `30_000` ms                                           | `src/gateway/client.ts` (`scheduleReconnect`)                                              |
| Fast-retry clamp after device-token close | `250` ms                                              | `src/gateway/client.ts`                                                                    |
| Force-stop grace before `terminate()`     | `250` ms                                              | `FORCE_STOP_TERMINATE_GRACE_MS`                                                            |
| `stopAndWait()` default timeout           | `1_000` ms                                            | `STOP_AND_WAIT_TIMEOUT_MS`                                                                 |
| Default tick interval (pre `hello-ok`)    | `30_000` ms                                           | `src/gateway/client.ts`                                                                    |
| Tick-timeout close                        | code `4000` when silence exceeds `tickIntervalMs * 2` | `src/gateway/client.ts`                                                                    |
| `MAX_PAYLOAD_BYTES`                       | `25 * 1024 * 1024` (25 MB)                            | `src/gateway/server-constants.ts`                                                          |

The server advertises the effective `policy.tickIntervalMs`, `policy.maxPayload`,
and `policy.maxBufferedBytes` in `hello-ok`; clients should honor those values
rather than the pre-handshake defaults.

## Auth

- Shared-secret gateway auth uses `connect.params.auth.token` or
  `connect.params.auth.password`, depending on the configured auth mode.
- Identity-bearing modes such as Tailscale Serve
  (`gateway.auth.allowTailscale: true`) or non-loopback
  `gateway.auth.mode: "trusted-proxy"` satisfy the connect auth check from
  request headers instead of `connect.params.auth.*`.
- Private-ingress `gateway.auth.mode: "none"` skips shared-secret connect auth
  entirely; do not expose that mode on public/untrusted ingress.
- After pairing, the Gateway issues a **device token** scoped to the connection
  role + scopes. It is returned in `hello-ok.auth.deviceToken` and should be
  persisted by the client for future connects.
- Clients should persist the primary `hello-ok.auth.deviceToken` after any
  successful connect.
- Reconnecting with that **stored** device token should also reuse the stored
  approved scope set for that token. This preserves read/probe/status access
  that was already granted and avoids silently collapsing reconnects to a
  narrower implicit admin-only scope.
- Client-side connect auth assembly (`selectConnectAuth` in
  `src/gateway/client.ts`):
  - `auth.password` is orthogonal and is always forwarded when set.
  - `auth.token` is populated in priority order: explicit shared token first,
    then an explicit `deviceToken`, then a stored per-device token (keyed by
    `deviceId` + `role`).
  - `auth.bootstrapToken` is sent only when none of the above resolved an
    `auth.token`. A shared token or any resolved device token suppresses it.
  - Auto-promotion of a stored device token on the one-shot
    `AUTH_TOKEN_MISMATCH` retry is gated to **trusted endpoints only** —
    loopback, or `wss://` with a pinned `tlsFingerprint`. Public `wss://`
    without pinning does not qualify.
- Additional `hello-ok.auth.deviceTokens` entries are bootstrap handoff tokens.
  Persist them only when the connect used bootstrap auth on a trusted transport
  such as `wss://` or loopback/local pairing.
- If a client supplies an **explicit** `deviceToken` or explicit `scopes`, that
  caller-requested scope set remains authoritative; cached scopes are only
  reused when the client is reusing the stored per-device token.
- Device tokens can be rotated/revoked via `device.token.rotate` and
  `device.token.revoke` (requires `operator.pairing` scope).
- `device.token.rotate` returns rotation metadata. It echoes the replacement
  bearer token only for same-device calls that are already authenticated with
  that device token, so token-only clients can persist their replacement before
  reconnecting. Shared/admin rotations do not echo the bearer token.
- Token issuance, rotation, and revocation stay bounded to the approved role set
  recorded in that device's pairing entry; token mutation cannot expand or
  target a device role that pairing approval never granted.
- For paired-device token sessions, device management is self-scoped unless the
  caller also has `operator.admin`: non-admin callers can remove/revoke/rotate
  only their **own** device entry.
- `device.token.rotate` and `device.token.revoke` also check the target operator
  token scope set against the caller's current session scopes. Non-admin callers
  cannot rotate or revoke a broader operator token than they already hold.
- Auth failures include `error.details.code` plus recovery hints:
  - `error.details.canRetryWithDeviceToken` (boolean)
  - `error.details.recommendedNextStep` (`retry_with_device_token`, `update_auth_configuration`, `update_auth_credentials`, `wait_then_retry`, `review_auth_configuration`)
- Client behavior for `AUTH_TOKEN_MISMATCH`:
  - Trusted clients may attempt one bounded retry with a cached per-device token.
  - If that retry fails, clients should stop automatic reconnect loops and surface operator action guidance.

## Device identity + pairing

- Nodes should include a stable device identity (`device.id`) derived from a
  keypair fingerprint.
- Gateways issue tokens per device + role.
- Pairing approvals are required for new device IDs unless local auto-approval
  is enabled.
- Pairing auto-approval is centered on direct local loopback connects.
- OpenClaw also has a narrow backend/container-local self-connect path for
  trusted shared-secret helper flows.
- Same-host tailnet or LAN connects are still treated as remote for pairing and
  require approval.
- WS clients normally include `device` identity during `connect` (operator +
  node). The only device-less operator exceptions are explicit trust paths:
  - `gateway.controlUi.allowInsecureAuth=true` for localhost-only insecure HTTP compatibility.
  - successful `gateway.auth.mode: "trusted-proxy"` operator Control UI auth.
  - `gateway.controlUi.dangerouslyDisableDeviceAuth=true` (break-glass, severe security downgrade).
  - direct-loopback `gateway-client` backend RPCs authenticated with the shared
    gateway token/password.
- All connections must sign the server-provided `connect.challenge` nonce.

### Device auth migration diagnostics

For legacy clients that still use pre-challenge signing behavior, `connect` now returns
`DEVICE_AUTH_*` detail codes under `error.details.code` with a stable `error.details.reason`.

Common migration failures:

| Message                     | details.code                     | details.reason           | Meaning                                            |
| --------------------------- | -------------------------------- | ------------------------ | -------------------------------------------------- |
| `device nonce required`     | `DEVICE_AUTH_NONCE_REQUIRED`     | `device-nonce-missing`   | Client omitted `device.nonce` (or sent blank).     |
| `device nonce mismatch`     | `DEVICE_AUTH_NONCE_MISMATCH`     | `device-nonce-mismatch`  | Client signed with a stale/wrong nonce.            |
| `device signature invalid`  | `DEVICE_AUTH_SIGNATURE_INVALID`  | `device-signature`       | Signature payload does not match v2 payload.       |
| `device signature expired`  | `DEVICE_AUTH_SIGNATURE_EXPIRED`  | `device-signature-stale` | Signed timestamp is outside allowed skew.          |
| `device identity mismatch`  | `DEVICE_AUTH_DEVICE_ID_MISMATCH` | `device-id-mismatch`     | `device.id` does not match public key fingerprint. |
| `device public key invalid` | `DEVICE_AUTH_PUBLIC_KEY_INVALID` | `device-public-key`      | Public key format/canonicalization failed.         |

Migration target:

- Always wait for `connect.challenge`.
- Sign the v2 payload that includes the server nonce.
- Send the same nonce in `connect.params.device.nonce`.
- Preferred signature payload is `v3`, which binds `platform` and `deviceFamily`
  in addition to device/client/role/scopes/token/nonce fields.
- Legacy `v2` signatures remain accepted for compatibility, but paired-device
  metadata pinning still controls command policy on reconnect.

## TLS + pinning

- TLS is supported for WS connections.
- Clients may optionally pin the gateway cert fingerprint (see `gateway.tls`
  config plus `gateway.remote.tlsFingerprint` or CLI `--tls-fingerprint`).

## Scope

This protocol exposes the **full gateway API** (status, channels, models, chat,
agent, sessions, nodes, approvals, etc.). The exact surface is defined by the
TypeBox schemas in `src/gateway/protocol/schema.ts`.

## Related

- [Bridge protocol](/gateway/bridge-protocol)
- [Gateway runbook](/gateway)
