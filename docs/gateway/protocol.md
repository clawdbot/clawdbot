---
summary: "Gateway WebSocket protocol: handshake, frames, versioning"
read_when:
  - Implementing or updating gateway WS clients
  - Debugging protocol mismatches or connect failures
  - Regenerating protocol schema/models
title: "Gateway protocol"
---

The Gateway WS protocol is the single control plane and node transport for
OpenClaw. Operator and node clients (CLI, web UI, macOS app, iOS/Android nodes,
headless nodes) connect over WebSocket and declare a **role** and **scope** at
handshake time.

## Transport and framing

- WebSocket, text frames, JSON payloads.
- First frame **must** be a `connect` request.
- Pre-connect frames are capped at 64 KiB (`MAX_PREAUTH_PAYLOAD_BYTES`). After
  handshake, follow `hello-ok.policy.maxPayload` and
  `hello-ok.policy.maxBufferedBytes`. With diagnostics enabled, oversized
  inbound frames and slow outbound buffers emit `payload.large` events before
  the gateway closes or drops the frame. These events carry `surface`, byte
  sizes, limits, and a safe reason code, never message bodies, attachment
  contents, raw frame bytes, tokens, cookies, or secrets.

Frame shapes:

- Request: `{type:"req", id, method, params}`
- Response: `{type:"res", id, ok, payload|error}`
- Event: `{type:"event", event, payload, seq?, stateVersion?}`

Side-effecting methods require idempotency keys (see schema).

## Handshake

Gateway sends a pre-connect challenge:

```json
{
  "type": "event",
  "event": "connect.challenge",
  "payload": { "nonce": "…", "ts": 1737264000000 }
}
```

Client replies with `connect`:

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
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

Gateway responds with `hello-ok`:

```json
{
  "type": "res",
  "id": "…",
  "ok": true,
  "payload": {
    "type": "hello-ok",
    "protocol": 4,
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

`server`, `features`, `snapshot`, `policy`, and `auth` are all required by
`HelloOkSchema` (`packages/gateway-protocol/src/schema/frames.ts`). `auth`
reports the negotiated role/scopes even when no device token is issued (shape
above). `pluginSurfaceUrls` is optional and maps plugin surface names (e.g.
`canvas`) to scoped hosted URLs; it may expire, so nodes call
`node.pluginSurface.refresh` with `{ "surface": "canvas" }` for a fresh entry.
The deprecated `canvasHostUrl` / `canvasCapability` / `node.canvas.capability.refresh`
path is not supported; use plugin surfaces.

While the gateway is still finishing startup sidecars, `connect` can return a
retryable `UNAVAILABLE` error with `details.reason: "startup-sidecars"` and
`retryAfterMs`. Retry within your connection budget instead of treating it as
a terminal handshake failure.

When a device token is issued, `hello-ok.auth` adds it:

```json
{
  "auth": {
    "deviceToken": "…",
    "role": "operator",
    "scopes": ["operator.read", "operator.write"]
  }
}
```

Built-in QR/setup-code bootstrap is a mobile handoff path. A successful
baseline setup-code connect returns a primary node token plus one bounded
operator token:

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

This operator handoff is bounded on purpose: enough to start the mobile
operator loop and native setup, including `operator.talk.secrets` for Talk
config reads, but no pairing-mutation scopes and no `operator.admin`. Broader
pairing/admin access needs a separate approved pairing or token flow. Persist
`hello-ok.auth.deviceTokens` only when bootstrap auth ran over a trusted
transport (`wss://` or loopback/local pairing).

Trusted same-process backend clients (`client.id: "gateway-client"`,
`client.mode: "backend"`) may omit `device` on direct loopback connections when
authenticating with the shared gateway token/password. This path is reserved
for internal control-plane RPCs (e.g. subagent session updates) and avoids
stale CLI/device pairing baselines blocking local backend work. Remote,
browser-origin, node, and explicit device-token/device-identity clients still
go through normal pairing and scope-upgrade checks.

### Worker role and closed protocol

Cloud workers use a dedicated loopback ingress through the gateway-owned,
host-key-pinned SSH tunnel. It accepts only worker identity and never dispatches
general auth, node events, operator RPCs, or plugin methods. A strict `connect`
verifies a hash-at-rest, short-lived credential bound to the environment, bundle
hash, owner epoch, RPC-set version, expiry, and one nullable session; it
separately checks the current version and feature set. Success returns minimal
`worker-hello-ok`; feature negotiation is independent of the general protocol
version. Frames stay under 64 KiB. The closed allowlist contains
`worker.heartbeat` and `worker.transcript.commit` for ordered semantic message batches. Transcript
commits use owner-epoch fencing, a gateway-owned session binding, base-leaf
compare-and-swap, and durable sequence replay; the gateway generates transcript
entry and parent IDs through the normal session writer. Ownership and expiry are
rechecked on each RPC.

### Client capabilities

Operator clients may advertise optional capabilities in `connect.params.caps`:

- `tool-events`: accepts structured tool lifecycle events.
- `inline-widgets`: can render hosted inline widget tool results.

Client capabilities describe the connected client, not authorization. Agent tools may declare required capabilities; the Gateway omits those tools unless every requirement appears in the originating client's `caps`. Channel-originated runs have no Gateway client capabilities, so capability-gated tools are unavailable even when tool policy explicitly allows them.

### Node connect example

```json
{
  "type": "req",
  "id": "…",
  "method": "connect",
  "params": {
    "minProtocol": 4,
    "maxProtocol": 4,
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

Nodes declare capability claims at connect time:

- `caps`: high-level categories such as `camera`, `canvas`, `screen`,
  `location`, `voice`, `talk`.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The gateway treats these as claims and enforces server-side allowlists.

## Roles and scopes

For the full operator scope model, approval-time checks, and shared-secret
semantics, see [Operator scopes](/gateway/operator-scopes).

Roles:

- `operator`: control-plane client (CLI/UI/automation).
- `node`: capability host (camera/screen/canvas/system.run).
- `worker`: cloud execution host on the dedicated, closed worker protocol.

Operator scopes (`src/gateway/operator-scopes.ts`), the full closed set:

- `operator.read`
- `operator.write`
- `operator.admin`
- `operator.approvals`
- `operator.pairing`
- `operator.talk.secrets`

`talk.config` with `includeSecrets: true` requires `operator.talk.secrets` (or
`operator.admin`). When secrets are included, read the active Talk provider
credential from `talk.resolved.config.apiKey`; `talk.providers.<id>.apiKey`
stays source-shaped and may be a SecretRef object or a redacted string.

Plugin-registered gateway RPC methods may request their own operator scope,
but these reserved core prefixes always resolve to `operator.admin`
(`src/shared/gateway-method-policy.ts`): `config.*`, `exec.approvals.*`,
`wizard.*`, `update.*`.

Method scope is only the first gate. Some slash commands reached through
`chat.send` apply stricter command-level checks: persistent `/config set` and
`/config unset` writes require `operator.admin` even for gateway clients that
already hold a lower operator scope.

`node.pair.approve` has an extra approval-time scope check on top of the base
method scope (`operator.pairing`), based on the pending request's declared
`commands` (`src/infra/node-pairing-authz.ts`):

| Declared commands                                              | Required scopes                       |
| -------------------------------------------------------------- | ------------------------------------- |
| none                                                           | `operator.pairing`                    |
| non-exec commands                                              | `operator.pairing` + `operator.write` |
| includes `system.run`, `system.run.prepare`, or `system.which` | `operator.pairing` + `operator.admin` |

### Caps/commands/permissions (node)

Nodes declare capability claims at connect time:

- `caps`: high-level capability categories such as `camera`, `canvas`, `screen`,
  `location`, `voice`, and `talk`.
- `commands`: command allowlist for invoke.
- `permissions`: granular toggles (e.g. `screen.record`, `camera.capture`).

The Gateway treats these as **claims** and enforces server-side allowlists.
Connected nodes can publish optional agent-visible plugin or MCP tool
descriptors with `node.pluginTools.update` after a successful connect or
reconnect. Headless node hosts restart to apply declarative MCP inventory
changes. This update method is the only publication path; plugin tool descriptors are not accepted in
`connect` params. Each descriptor must use a provider-safe tool `name` and name
a `command` in the node's current command allowlist. The Gateway trusts descriptor
metadata from the paired node, filters descriptors outside the approved command
surface, removes them when the node disconnects, and rejects operator attempts
to mutate another node's catalog. Set `gateway.nodes.pluginTools.enabled: false`
to ignore node-published descriptors.

Connected node hosts publish their complete skill replacement catalog with
`node.skills.update`. This node-role method is the only node skill publication
path; skills are not accepted in `connect` params. Each descriptor contains a
safe name, description, and bounded `SKILL.md` content. The Gateway parses that
content with the normal skills loader, includes it in agent skill snapshots
while the node is connected, and removes it on disconnect. Set
`gateway.nodes.skills.enabled: false` to ignore node-published skills.

## Presence

- `system-presence` returns entries keyed by device identity, including
  `deviceId`, `roles`, and `scopes`, so UIs can show one row per device even
  when it connects as both operator and node.
- `node.list` includes optional `lastSeenAtMs` and `lastSeenReason`. Connected
  nodes report current connection time with reason `connect`; paired nodes can
  also report durable background presence via a trusted node event.

Native macOS nodes can also send authenticated `node.presence.activity` events
with bounded input idle time. The Gateway derives activity timestamps on its
own clock, exposes the freshest connected Mac through `node.list` and
`node.describe`, and broadcasts `node.presence` updates to read-scoped clients.
See [Active computer presence](/nodes/presence) for selection, privacy, model
context, and notification-routing behavior.

### Node background alive event

Nodes call `node.event` with `event: "node.presence.alive"` to record that a
paired node was alive during a background wake, without marking it connected:

```json
{
  "event": "node.presence.alive",
  "payloadJSON": "{\"trigger\":\"silent_push\",\"sentAtMs\":1737264000000,\"displayName\":\"Peter's iPhone\",\"version\":\"2026.4.28\",\"platform\":\"iOS 18.4.0\",\"deviceFamily\":\"iPhone\",\"modelIdentifier\":\"iPhone17,1\",\"pushTransport\":\"relay\"}"
}
```

`trigger` is a closed enum: `background`, `silent_push`, `bg_app_refresh`,
`significant_location`, `manual`, `connect`. Unknown values normalize to
`background` (`src/shared/node-presence.ts`). The event only persists for
authenticated node device sessions; device-less or unpaired sessions return
`handled: false`.

Successful gateways return a structured result:

```json
{
  "ok": true,
  "event": "node.presence.alive",
  "handled": true,
  "reason": "persisted"
}
```

Older gateways may return only `{ "ok": true }` for `node.event`; treat that
as an acknowledged RPC, not durable presence persistence.

## Broadcast event scoping

Server-pushed broadcast events are scope-gated so pairing-scoped or node-only
sessions do not passively receive session content
(`src/gateway/server-broadcast.ts`):

- Chat, agent, and tool-result frames (streamed `agent` events, tool-result
  events) require at least `operator.read`. Sessions without it skip these
  frames entirely.
- Plugin-defined `plugin.*` broadcasts are gated to `operator.write` or
  `operator.admin` by default; explicit entries such as
  `plugin.approval.requested` / `plugin.approval.resolved` use
  `operator.approvals` instead.
- Status/transport events (`heartbeat`, `presence`, `tick`, connect/disconnect
  lifecycle) stay unrestricted so transport health is observable to every
  authenticated session.
- Unknown broadcast event families are scope-gated by default (fail-closed)
  unless a registered handler explicitly relaxes them.

Each client connection keeps its own per-client sequence number, so broadcasts
stay monotonically ordered on that socket even when different clients see
different scope-filtered subsets of the event stream.

## RPC method families

`hello-ok.features.methods` is a conservative discovery list built from
`src/gateway/server-methods-list.ts` plus loaded plugin/channel method
exports — it is not a generated dump of every method, and some methods (for
example `push.test`, `web.login.start`, `web.login.wait`, `sessions.usage`)
are intentionally excluded from discovery even though they are real, callable
methods. Treat this as feature discovery, not a full enumeration of
`src/gateway/server-methods/*.ts`.

<AccordionGroup>
  <Accordion title="System and identity">
    - `health` returns the cached or freshly probed gateway health snapshot.
    - `diagnostics.stability` returns the recent bounded diagnostic stability recorder: event names, counts, byte sizes, memory readings, queue/session state, channel/plugin names, session ids. No chat text, webhook bodies, tool outputs, raw request/response bodies, tokens, cookies, or secrets. Requires `operator.read`.
    - `status` returns the `/status`-style gateway summary; sensitive fields only for admin-scoped operator clients.
    - `gateway.identity.get` returns the gateway device identity used by relay and pairing flows.
    - `system-presence` returns the current presence snapshot for connected operator/node devices.
    - `system-event` appends a system event and can update/broadcast presence context.
    - `last-heartbeat` returns the latest persisted heartbeat event.
    - `set-heartbeats` toggles heartbeat processing on the gateway.
    - `gateway.suspend.prepare` creates a short cooperative-suspension lease only when tracked Gateway work is idle. `gateway.suspend.status` checks that lease, and `gateway.suspend.resume` releases it after thaw or an aborted host operation.

  </Accordion>

  <Accordion title="Models and usage">
    - `models.list` returns the runtime-allowed model catalog. See "`models.list` views" below.
    - `usage.status` returns provider usage windows/remaining quota summaries.
    - `usage.cost` returns aggregated cost usage summaries for a date range. Pass `agentId` for one agent, or `agentScope: "all"` to aggregate configured agents.
    - `doctor.memory.status` returns vector-memory / cached embedding readiness for the active default agent workspace. Pass `{ "probe": true }` or `{ "deep": true }` only for an explicit live embedding provider ping. Pass `{ "agentId": "agent-id" }` to scope Dreaming store stats to one agent workspace; omitting it aggregates configured Dreaming workspaces.
    - `doctor.memory.dreamDiary`, `doctor.memory.backfillDreamDiary`, `doctor.memory.resetDreamDiary`, `doctor.memory.resetGroundedShortTerm`, `doctor.memory.repairDreamingArtifacts`, and `doctor.memory.dedupeDreamDiary` accept optional `{ "agentId": "agent-id" }`; omitted, they operate on the configured default agent workspace.
    - `doctor.memory.remHarness` returns a bounded, read-only REM harness preview for remote control-plane clients, including workspace paths, memory snippets, rendered grounded markdown, and deep promotion candidates. Requires `operator.read`.
    - `sessions.usage` returns per-session usage summaries. Pass `agentId` for one agent, or `agentScope: "all"` to list configured agents together.
      Both usage methods accept `mode: "specific"` with an IANA `timeZone` for DST-aware calendar-day boundaries and buckets. `utcOffset` remains supported for older clients and as a fallback when the Gateway runtime does not recognize the requested zone.
    - `sessions.usage.timeseries` returns timeseries usage for one session.
    - `sessions.usage.logs` returns usage log entries for one session.

  </Accordion>

  <Accordion title="Channels and login helpers">
    - `channels.status` returns built-in + bundled channel/plugin status summaries.
    - `channels.logout` logs out a specific channel/account where the channel supports it.
    - `web.login.start` starts a QR/web login flow for the current QR-capable web channel provider.
    - `web.login.wait` waits for that flow to complete and starts the channel on success.
    - `push.test` sends a test APNs push to a registered iOS node.
    - `voicewake.get` returns the stored wake-word triggers.
    - `voicewake.set` updates wake-word triggers and broadcasts the change.

  </Accordion>

  <Accordion title="Plugin management">
    - `plugins.list` (`operator.read`) returns the installed plugin inventory plus locally curated official picks, diagnostics, and whether the current install mode allows mutations.
    - `plugins.search` (`operator.read`) searches installable ClawHub code-plugin and bundle-plugin families. Pass non-empty `query` and optional `limit` from 1 to 100.
    - `plugins.install` (`operator.admin`) installs either an official catalog entry with `{ source: "official", pluginId }` or a ClawHub package with `{ source: "clawhub", packageName, version?, acknowledgeClawHubRisk? }`. ClawHub installs preserve Gateway trust, integrity, and install-policy checks. Successful installs require a Gateway restart.
    - `plugins.setEnabled` (`operator.admin`) changes one installed plugin's enabled policy with `{ pluginId, enabled }`. The response includes the updated catalog entry, restart metadata, and any slot-selection warnings.
    - `plugins.uninstall` (`operator.admin`) removes one externally installed plugin with `{ pluginId }`: config references, the install record, and managed files. Bundled plugins cannot be uninstalled, only disabled. The response lists the removal actions and always requires a Gateway restart.

  </Accordion>

  <Accordion title="Messaging and logs">
    - `send` is the direct outbound-delivery RPC for channel/account/thread-targeted sends outside the chat runner.
    - `logs.tail` returns the configured gateway file-log tail with cursor/limit and max-byte controls.

  </Accordion>

  <Accordion title="Operator terminal">
    - `terminal.open` starts a host PTY for an explicit `agentId` or the default agent and returns the resolved agent, working directory, shell, and confinement state.
    - `terminal.input`, `terminal.resize`, and `terminal.close` operate only on sessions owned by the calling connection.
    - `terminal.data` and `terminal.exit` events stream only to the connection that owns the session.
    - Sessions whose connection drops are detached, not killed: they stay reattachable for `gateway.terminal.detachedSessionTimeoutSeconds` (default 300; `0` restores kill-on-disconnect) while recent output accumulates in a bounded server-side buffer.
    - `terminal.list` returns attachable sessions; `terminal.attach` rebinds a live-or-detached session to the calling connection and returns the replay buffer (tmux-style take-over — a previous live owner receives `terminal.exit` with reason `detached`); `terminal.text` reads the buffer as plain text without attaching.
    - Every terminal method requires `operator.admin`; `gateway.terminal.enabled` must be explicitly true. Fully sandboxed agents are refused, and an agent policy change closes existing and in-flight PTYs, detached ones included.

  </Accordion>

  <Accordion title="Talk and TTS">
    - `talk.catalog` returns the read-only Talk provider catalog for speech, streaming transcription, and realtime voice: canonical provider ids, registry aliases, labels, configured state, an optional group-level `ready` result, exposed model/voice ids, canonical modes, transports, brain strategies, and realtime audio/capability flags, without returning provider secrets or mutating global config. Current gateways set `ready` after applying runtime provider selection; treat its absence as unverified on older gateways.
    - `talk.config` returns the effective Talk config payload; `includeSecrets` requires `operator.talk.secrets` (or `operator.admin`).
    - `talk.session.create` creates a gateway-owned Talk session for `realtime/gateway-relay`, `transcription/gateway-relay`, or `stt-tts/managed-room`. For `stt-tts/managed-room`, `operator.write` callers that pass `sessionKey` must also pass `spawnedBy` for scoped session-key visibility; unscoped `sessionKey` creation and `brain: "direct-tools"` require `operator.admin`.
    - `talk.session.join` validates a managed-room session token, emits `session.ready` or `session.replaced` as needed, and returns room/session metadata plus recent Talk events, never the plaintext token or its hash.
    - `talk.session.appendAudio` appends base64 PCM input audio to gateway-owned realtime relay and transcription sessions.
    - `talk.session.startTurn`, `talk.session.endTurn`, and `talk.session.cancelTurn` drive managed-room turn lifecycle with stale-turn rejection before state clears.
    - `talk.session.cancelOutput` stops assistant audio output, primarily for VAD-gated barge-in in gateway relay sessions.
    - `talk.session.submitToolResult` completes a provider tool call emitted by a gateway-owned realtime relay session. The request waits for any asynchronous completion signal exposed by the provider bridge; failed submissions keep the linked run active and do not emit a successful tool-result event. Pass `options: { willContinue: true }` for interim tool output or `options: { suppressResponse: true }` when the provider bridge advertises suppression support and the result should not start another response.
    - `talk.session.steer` sends active-run voice control into a gateway-owned agent-backed Talk session: `{ sessionId, text, mode? }`, where `mode` is `status`, `steer`, `cancel`, or `followup`; omitted mode is classified from the spoken text.
    - `talk.session.close` closes a gateway-owned relay, transcription, or managed-room session and emits terminal Talk events.
    - `talk.mode` sets/broadcasts the current Talk mode state for WebChat/Control UI clients.
    - `talk.client.create` creates a client-owned realtime provider session using `webrtc` or `provider-websocket` while the gateway owns config, credentials, instructions, and tool policy.
    - `talk.client.toolCall` lets client-owned realtime transports forward provider tool calls to gateway policy. The first supported tool is `openclaw_agent_consult`; clients get a run id and wait for normal chat lifecycle events before submitting the provider-specific tool result.
    - `talk.client.steer` sends active-run voice control for client-owned realtime transports. The gateway resolves the active embedded run from `sessionKey` and returns a structured accepted/rejected result instead of silently dropping steering.
    - `talk.event` is the single Talk event channel for realtime, transcription, STT/TTS, managed-room, telephony, and meeting adapters.
    - `talk.speak` synthesizes speech through the active Talk speech provider.
    - `tts.status` returns TTS enabled state, active provider, fallback providers, and provider config state.
    - `tts.providers` returns the visible TTS provider inventory.
    - `tts.enable` and `tts.disable` toggle TTS prefs state.
    - `tts.setProvider` updates the preferred TTS provider.
    - `tts.convert` runs one-shot text-to-speech conversion.
    - `tts.speak` (`operator.write`) renders non-empty `text` with the configured general TTS provider chain and returns one whole clip inline as `audioBase64`, plus `provider` and optional `outputFormat`, `mimeType`, and `fileExtension` metadata. Unlike `tts.convert`, it does not return a Gateway-local path; unlike `talk.speak`, it does not require a Talk provider. Text above `messages.tts.maxTextLength` returns `INVALID_REQUEST`; synthesis failures return `UNAVAILABLE`.

  </Accordion>

  <Accordion title="Secrets, config, update, and wizard">
    - `secrets.reload` re-resolves active SecretRefs and swaps runtime secret state only on full success.
    - `secrets.resolve` resolves command-target secret assignments for a specific command/target set.
    - `config.get` returns the current config snapshot and hash.
    - `config.set` writes a validated config payload.
    - `config.patch` merges a partial config update. Destructive array replacement requires the affected path in `replacePaths`; nested arrays under array entries use `[]` paths such as `agents.list[].skills`.
    - `config.apply` validates + replaces the full config payload.
    - `config.schema` returns the live config schema payload used by Control UI and CLI tooling: schema, `uiHints`, version, generation metadata, plugin + channel schema metadata when loadable. It includes `title` / `description` metadata from the same labels/help text as the UI, including nested object, wildcard, array-item, and `anyOf` / `oneOf` / `allOf` composition branches when matching field documentation exists.
    - `config.schema.lookup` returns a path-scoped lookup payload for one config path: normalized path, a shallow schema node, matched hint + `hintPath`, optional `reloadKind`, and immediate child summaries for UI/CLI drill-down. `reloadKind` is one of `restart`, `hot`, or `none` (`src/config/schema.ts`) and mirrors the gateway config reload planner for the requested path. Lookup schema nodes keep the user-facing docs and common validation fields (`title`, `description`, `type`, `enum`, `const`, `format`, `pattern`, numeric/string/array/object bounds, `additionalProperties`, `deprecated`, `readOnly`, `writeOnly`). Child summaries expose `key`, normalized `path`, `type`, `required`, `hasChildren`, optional `reloadKind`, plus the matched `hint` / `hintPath`.
    - `update.run` runs the gateway update flow and schedules a restart only if the update succeeded; callers with a session can include `continuationMessage` so startup resumes one follow-up agent turn through the restart continuation queue. Package-manager updates and supervised git-checkout updates from the control plane use a detached managed-service handoff instead of replacing the package tree or mutating checkout/build output inside the live gateway. A started handoff returns `ok: true` with `result.reason: "managed-service-handoff-started"` and `handoff.status: "started"`; unavailable or failed handoffs return `ok: false` with `managed-service-handoff-unavailable` or `managed-service-handoff-failed`, plus `handoff.command` when a manual shell update is required. Unavailable means OpenClaw lacks a safe supervisor boundary or durable service identity, such as `OPENCLAW_SYSTEMD_UNIT` for systemd. During a started handoff, the restart sentinel may briefly report `stats.reason: "restart-health-pending"`; the continuation is delayed until the CLI verifies the restarted gateway and writes the final `ok` sentinel.
    - `update.status` refreshes and returns the latest update restart sentinel, including the post-restart running version when available.
    - `wizard.start`, `wizard.next`, `wizard.status`, and `wizard.cancel` expose the onboarding wizard over WS RPC.

  </Accordion>

  <Accordion title="Agent and workspace helpers">
    - `agents.list` returns configured agent entries, including effective model and runtime metadata.
    - `agents.create`, `agents.update`, and `agents.delete` manage agent records and workspace wiring.
    - `agents.files.list`, `agents.files.get`, and `agents.files.set` manage the bootstrap workspace files exposed for an agent.
    - `audit.activity.list` returns the versioned metadata-only activity ledger; `audit.list` remains the compatibility-safe run/tool RPC.
    - `agents.workspace.list` and `agents.workspace.get` (`operator.read`) expose read-only, paginated browsing of an agent's workspace directory for clients in the trusted operator domain described in [Operator scopes](/gateway/operator-scopes). Requests accept workspace-relative paths only; reads stay confined to the realpathed workspace root (symlink and hardlink escapes rejected), size-capped, and limited to UTF-8 text plus common image types (base64). Responses do not expose the host workspace path. There are no write operations in this namespace.
    - `tasks.list`, `tasks.get`, and `tasks.cancel` expose the gateway task ledger to SDK and operator clients. See [Task ledger RPCs](#task-ledger-rpcs) below.
    - `artifacts.list`, `artifacts.get`, and `artifacts.download` expose transcript-derived artifact summaries and downloads for an explicit `sessionKey`, `runId`, or `taskId` scope. Run and task queries resolve the owning session server-side and only return transcript media with matching provenance; unsafe or local URL sources return unsupported downloads instead of fetching server-side.
    - `environments.list` and `environments.status` preserve gateway-local and node environment discovery. Configured cloud workers and durable records left by earlier profiles add `worker` metadata with `providerId`, optional `leaseId`, `state`, `ageMs`, optional `idleMs`, and `attachedSessionIds`. Worker lifecycle states are `requested`, `provisioning`, `bootstrapping`, `ready`, `attached`, `idle`, `draining`, `destroying`, `destroyed`, `failed`, and `orphaned`.
    - `environments.create` (`{ profileId, idempotencyKey }`) provisions a worker from a configured plugin provider profile; retries with the same key reuse the durable operation. `environments.destroy` (`{ environmentId }`) requests idempotent teardown of a durable worker environment. Both require `operator.admin`, are control-plane writes, and return the same environment summary shape used by status responses.
    - `agent.identity.get` returns the effective assistant identity for an agent or session.
    - `agent.wait` waits for a run to finish and returns the terminal snapshot when available.

  </Accordion>

  <Accordion title="Session control">
    - `sessions.list` returns the current session index, including per-row `agentRuntime` metadata when an agent runtime backend is configured.
    - `sessions.subscribe` and `sessions.unsubscribe` toggle session change event subscriptions for the current WS client.
    - `sessions.messages.subscribe` and `sessions.messages.unsubscribe` toggle transcript/message event subscriptions for one session. Pass `includeApprovals: true` to also receive sanitized `session.approval` lifecycle events for approvals whose persisted audience includes that exact session and whose reviewer binding authorizes the subscribing client. The subscribe response then includes a bounded pending `approvalReplay`; it is authoritative when `truncated` is false. The opt-in is per subscribe call, not sticky: re-subscribing to the same session without `includeApprovals: true` removes an existing approval subscription. In addition to normal session-read authority, this opt-in requires `operator.admin`, or `operator.approvals` on a paired device.
    - `sessions.preview` returns bounded transcript previews for specific session keys.
    - `sessions.describe` returns one gateway session row for an exact session key.
    - `sessions.resolve` resolves or canonicalizes a session target.
    - `sessions.create` creates a new session entry. `worktree: true` provisions a managed worktree; optional `worktreeBaseRef`/`worktreeName` select the base ref and branch name, and `execNode` (`operator.admin`) binds session exec to a node host. The created worktree is echoed in the result and persisted on the session row (`worktree: { id, branch, repoRoot }`). When the entry is created but its nested initial `chat.send` is rejected, the successful result includes `runStarted: false` and `runError`; clients can preserve the prompt and retry against the returned session key.
    - `sessions.groups.list`, `sessions.groups.put`, `sessions.groups.rename`, and `sessions.groups.delete` manage the gateway-owned custom session group catalog (names + display order). Membership stays on each session's `category` field; rename and delete update member sessions server-side.
    - `sessions.send` sends a message into an existing session.
    - `sessions.steer` is the interrupt-and-steer variant for an active session.
    - `sessions.abort` aborts active work for a session. Pass `key` plus optional `runId`, or `runId` alone for active runs the gateway can resolve to a session.
    - `sessions.patch` updates session metadata/overrides and reports the resolved canonical model plus effective `agentRuntime`.
    - `sessions.reset`, `sessions.delete`, and `sessions.compact` perform session maintenance.
    - `sessions.get` returns the full stored session row.
    - Chat execution still uses `chat.history`, `chat.send`, `chat.abort`, and `chat.inject`. `chat.history` is display-normalized for UI clients: inline directive tags are stripped from visible text, plain-text tool-call XML payloads (`<tool_call>...</tool_call>`, `<function_call>...</function_call>`, `<tool_calls>...</tool_calls>`, `<function_calls>...</function_calls>`, and truncated tool-call blocks) and leaked ASCII/full-width model control tokens are stripped, pure silent-token assistant rows (exact `NO_REPLY` / `no_reply`) are omitted, and oversized rows can be replaced with placeholders.
    - `chat.message.get` is the additive bounded full-message reader for a single visible transcript entry. Pass `sessionKey`, optional `agentId` when session selection is agent-scoped, and a transcript `messageId` previously surfaced through `chat.history`; the gateway returns the same display-normalized projection without the lightweight history truncation cap when the stored entry is still available and not oversized.
    - `chat.toolTitles` returns short purpose titles for tool calls rendered in the Control UI (batched, max 24 items with bounded inputs). The feature is opt-in via `gateway.controlUi.toolTitles` (default off); disabled gateways answer `{ titles: {}, disabled: true }` with no model call so clients stop asking. When enabled, titles use standard utility-model routing: an explicitly configured `utilityModel` (an operator decision that, like all utility tasks, may send bounded task content to the chosen provider), else the session provider's declared small-model default so no new egress destination appears implicitly; an empty `utilityModel` disables them entirely. Titles never fall back to the primary model. Results cache in the per-agent state database keyed by tool name + input, so repeated views never re-bill the same calls.
    - `chat.send` accepts one-turn `fastMode: "auto"` to use fast mode for model calls started before the auto cutoff, then start later retry, fallback, tool-result, or continuation calls without fast mode. The cutoff defaults to 60 seconds (`DEFAULT_FAST_MODE_AUTO_ON_SECONDS`) and can be configured per model with `agents.defaults.models["<provider>/<model>"].params.fastAutoOnSeconds`. A `chat.send` caller can pass one-turn `fastAutoOnSeconds` to override the cutoff for that request.

  </Accordion>

  <Accordion title="Device pairing and device tokens">
    - `device.pair.list` returns pending and approved paired devices.
    - `device.pair.setupCode` creates a mobile setup code and, by default, a PNG QR data URL. It requires `operator.admin` and is intentionally omitted from advertised discovery. The result includes `setupCode`, optional `qrDataUrl`, `gatewayUrl`, the non-secret `auth` label, and `urlSource`.
    - `device.pair.approve`, `device.pair.reject`, and `device.pair.remove` manage device-pairing records.
    - `device.pair.rename` assigns an operator label (`{ deviceId, label }`) that is preferred over the client-reported display name and survives device repair or re-approval.
    - `device.token.rotate` rotates a paired device token within its approved role and caller scope bounds.
    - `device.token.revoke` revokes a paired device token within its approved role and caller scope bounds.

    The setup code embeds a short-lived bootstrap credential. Clients must not
    log or persist it beyond the pairing flow.

  </Accordion>

  <Accordion title="Node pairing, invoke, and pending work">
    - `node.pair.list`, `node.pair.approve`, `node.pair.reject`, and `node.pair.remove` cover node capability approvals. `node.pair.request` and `node.pair.verify` were removed in 2026.7 together with the standalone node pairing store; pending requests are created by the Gateway during node connects.
    - `node.list` and `node.describe` return known/connected node state.
    - `node.rename` updates a paired node label.
    - `node.invoke` forwards a command to a connected node.
    - `node.invoke.result` returns the result for an invoke request.
    - `mcp.tools.call.v1` is the headless node-host command for calling a configured node-local MCP tool. It is carried through `node.invoke`, requires the node to declare the command, and remains subject to pairing approval and `gateway.nodes.denyCommands`.
    - `node.event` carries node-originated events back into the gateway.
    - `node.pluginTools.update` is the only publication path for replacing the connected node's agent-visible plugin/MCP tool descriptors; `connect` params do not carry them.
    - `node.pending.pull` and `node.pending.ack` are the connected-node queue APIs.
    - `node.pending.enqueue` and `node.pending.drain` manage durable pending work for offline/disconnected nodes.

  </Accordion>

  <Accordion title="Approval families">
    - `approval.get` and `approval.resolve` are the kind-agnostic durable approval methods (scope `operator.approvals`). `approval.get` returns a sanitized pending or retained terminal projection with a stable `urlPath`; `approval.resolve` accepts the canonical approval id, an explicit `kind`, and a decision, applies first-answer-wins resolution, and always returns the recorded canonical result.
    - `exec.approval.request`, `exec.approval.get`, `exec.approval.list`, and `exec.approval.resolve` cover one-shot exec approval requests plus pending approval lookup/replay. They are protocol-boundary adapters over the same durable approval registry.
    - `exec.approval.waitDecision` waits on one pending exec approval and returns the final decision (or `null` on timeout).
    - `exec.approvals.get` and `exec.approvals.set` manage gateway exec approval policy snapshots.
    - `exec.approvals.node.get` and `exec.approvals.node.set` manage node-local exec approval policy via node relay commands.
    - `plugin.approval.request`, `plugin.approval.list`, `plugin.approval.waitDecision`, and `plugin.approval.resolve` cover plugin-defined approval flows.

  </Accordion>

  <Accordion title="Automation, skills, and tools">
    - Automation: `wake` schedules an immediate or next-heartbeat wake text injection; `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs` manage scheduled work.
    - `cron.run` remains an enqueue-style RPC for manual runs. Clients that need completion semantics should read the returned `runId` and poll `cron.runs`.
    - `cron.runs` accepts an optional non-empty `runId` filter so clients can follow one queued manual run without racing against other history entries for the same job.
    - Skills and tools: `commands.list`, `skills.*`, `tools.catalog`, `tools.effective`, `tools.invoke`. See [Operator helper methods](#operator-helper-methods) below.

  </Accordion>
</AccordionGroup>

### Common event families

- `chat`: UI chat updates such as `chat.inject` and other transcript-only chat
  events. In protocol v4, delta payloads carry `deltaText`; `message` remains
  the cumulative assistant snapshot. Non-prefix replacements set
  `replace=true` and use `deltaText` as the replacement text.
- `session.message`, `session.operation`, `session.tool`: transcript, in-flight
  session operation, and event-stream updates for a subscribed session.
- `session.approval`: sanitized pending and terminal approval truth for an
  explicitly opted-in exact-session subscriber. Child approvals use the
  persisted ancestor audience; events never mutate transcripts or wake agents.
- `sessions.changed`: session index or metadata changed.
- `presence`: system presence snapshot updates.
- `tick`: periodic keepalive/liveness event.
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

Nodes may call `skills.bins` to fetch the current list of skill executables
for auto-allow checks.

## Audit ledger RPC

`audit.activity.list` gives operator clients a stable newest-first view of agent
run, tool action, and opt-in message lifecycle metadata. It requires
`operator.read`. Queries exclude records older than 30 days, and the shared
SQLite ledger is capped at 100,000 records. Expired rows are deleted during
Gateway startup, hourly maintenance, and later writes. See
[Audit history](/gateway/audit) for the data model and privacy semantics.

- Params: optional exact `agentId`, `sessionKey`, or `runId`; optional `kind`
  (`"agent_run"`, `"tool_action"`, or `"message"`); optional `status`
  (`"started"`, `"succeeded"`, `"failed"`, `"cancelled"`, `"timed_out"`,
  `"blocked"`, or `"unknown"`); optional message `direction` (`"inbound"` or
  `"outbound"`) and exact `channel`; optional inclusive `after` / `before`
  Unix-millisecond bounds; optional `limit` from `1` to `500`; and optional
  string `cursor` from the preceding page.
- Result: `{ "events": AuditActivityEventV1[], "nextCursor"?: string }`.

The named V1 result union has separate agent-run, tool-action, inbound-message,
and outbound-message schemas. The `eventType` discriminator is respectively
`agent_run`, `tool_action`, `inbound_message`, or `outbound_message`; `kind` and
message `direction` remain available for filtering and display. Every event has
integer `schemaVersion: 1`. Message identity references use the exact
`hmac-sha256:v1:<32 hex key id>:<64 hex digest>` format; a channel-sender actor
id uses the same format.

All variants require `eventType`, `schemaVersion`, `eventId`, `sequence`,
`sourceSequence`, `occurredAt`, `kind`, `action`, `status`, `actor`, and
`redaction`. Variant fields are:

| `eventType`        | Required fields                                                   | Optional fields                                                                                                                 |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `agent_run`        | `agentId`, `runId`; `kind: "agent_run"`                           | `sessionKey`, `sessionId`, `errorCode`                                                                                          |
| `tool_action`      | `agentId`, `runId`; `kind: "tool_action"`                         | `sessionKey`, `sessionId`, `toolCallId`, `toolName`, `errorCode`                                                                |
| `inbound_message`  | `direction: "inbound"`, `channel`, `conversationKind`, `outcome`  | `agentId`, `runId`, `durationMs`, `resultCount`, identity references, `reasonCode`, `errorCode`                                 |
| `outbound_message` | `direction: "outbound"`, `channel`, `conversationKind`, `outcome` | `agentId`, `runId`, `durationMs`, `resultCount`, identity references, `reasonCode`, `deliveryKind`, `failureStage`, `errorCode` |

The closed message enums are:

- `conversationKind`: `direct`, `group`, `channel`, or `unknown`.
- Inbound `outcome`: `completed`, `skipped`, or `failed`; optional
  `reasonCode`: `duplicate`, `reply_operation_active`,
  `reply_operation_aborted`, `fast_abort`, `plugin_bound_handled`,
  `plugin_bound_unavailable`, `plugin_bound_declined`, `plugin_bound_error`,
  `before_dispatch_handled`, `acp_dispatch_completed`, `acp_dispatch_failed`,
  `acp_dispatch_empty`, or `acp_dispatch_aborted`.
- Outbound `outcome`: `sent`, `suppressed`, `failed`, or `unknown`; optional
  `reasonCode`: `cancelled_by_message_sending_hook`,
  `cancelled_by_reply_payload_sending_hook`,
  `empty_after_message_sending_hook`, `empty_after_reply_payload_sending_hook`,
  or `no_visible_payload`. An adapter that returns no platform identity is
  `unknown`, because the external side effect cannot be disproved.
- `deliveryKind`: `text`, `media`, or `other`; `failureStage`:
  `platform_send`, `queue`, or `unknown`.

Terminal fields are correlated, not independently optional:

| Variant          | Terminal mapping                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent run        | `started` has no `errorCode`; each non-success finished status requires its matching `run_*` code.                                                                 |
| Tool action      | `started` and succeeded have no `errorCode`; each other finished status requires its matching `tool_*` code.                                                       |
| Inbound message  | succeeded = `completed`; blocked = `skipped`; failed = `failed` plus `message_processing_failed`. `reasonCode`, when present, must belong to that terminal family. |
| Outbound message | succeeded = `sent`; blocked = `suppressed` plus `reasonCode`; failed = `failed` plus `errorCode` and `failureStage`; unknown = `unknown` plus `failureStage`.      |

Each activity event includes a stable event id, monotonic ledger sequence,
source event sequence, timestamp, actor, action, status, integer
`schemaVersion: 1`, and `redaction: "metadata_only"`. Run and tool records
require agent and run provenance and may include session provenance. Message
records may include agent and run ids, but intentionally never include
`sessionKey` or `sessionId`; the `sessionKey` query filter therefore applies to
run and tool rows only. Tool events may include tool call id and tool name.

Message records use `message.inbound.processed` or
`message.outbound.finished` and add direction, channel, conversation kind,
normalized outcome, and optional delivery kind, failure stage, duration,
result count, reason code, and installation-local keyed
account/conversation/message/target pseudonyms. These pseudonyms aid
correlation but are not anonymization: the state database contains their key,
while RPC and CLI exports do not. The ledger does not store prompts, message
bodies, tool arguments, tool results, command output, or raw error text.
Run/tool `sessionKey` values remain raw correlation metadata and can embed
platform account or peer ids; message records omit session keys.

For inbound rows, `durationMs` measures core dispatch through its terminal and
`resultCount` counts finalized queued tool, block, and reply payloads. For
outbound rows, `durationMs` spans delivery ownership through acknowledgement,
dead letter, or reconciliation (including queued wait time), and `resultCount`
counts identified physical platform sends. `deliveryKind`, when present,
describes the effective payload after hooks and rendering; suppressed or
crash-ambiguous rows omit it.

Current message coverage includes accepted inbound messages that reach core
dispatch, including core duplicate/terminal outcomes. Outbound coverage writes
one terminal row per original logical reply payload that reaches shared durable
delivery; chunking and adapter fan-out are aggregated in `resultCount`. Queued
retryable or ambiguous sends are recorded only after acknowledgement, dead
letter, or reconciliation. Plugin-local and direct-send paths that bypass those
shared boundaries are not yet covered. The bounded worker queue is best-effort
and may drop records on failure or saturation, so this surface is not a
lossless compliance archive.

Recording is on by default and controlled by
[`audit.enabled`](/gateway/configuration-reference#audit). Message recording is
separately controlled by `audit.messages` and defaults to `"off"`. When
recording is disabled, `audit.activity.list` keeps serving records written
earlier until they expire.

The shipped `audit.list` request, result, and `AuditEvent` schemas remain
unchanged and return only agent-run and tool-action records. New operator
clients should call `audit.activity.list` when the Gateway advertises it. Older
Gateways may report either `unknown method: audit.activity.list` or, because
authorization preceded method lookup in shipped versions, `missing scope:
operator.admin` to a read-scoped request. Treat the latter as method absence
only when the method was not advertised. A client may then retry `audit.list`
only when its filters do not require message kind, direction, or channel
support.

Use [`openclaw audit`](/cli/audit) for text queries and bounded JSON exports.

## Task ledger RPCs

Operator clients inspect and cancel gateway background task records through
the task ledger RPCs (`packages/gateway-protocol/src/schema/tasks.ts`). These
return sanitized task summaries, not raw runtime state.

- `tasks.list` requires `operator.read`.
  - Params: optional `status` (`"queued"`, `"running"`, `"completed"`,
    `"failed"`, `"cancelled"`, or `"timed_out"`) or an array of those statuses,
    optional `agentId`, optional `sessionKey`, optional `limit` from `1` to
    `500`, and optional string `cursor`.
  - Result: `{ "tasks": TaskSummary[], "nextCursor"?: string }`.
- `tasks.get` requires `operator.read`.
  - Params: `{ "taskId": string }`.
  - Result: `{ "task": TaskSummary }`.
  - Missing task ids return the gateway not-found error shape.
- `tasks.cancel` requires `operator.write`.
  - Params: `{ "taskId": string, "reason"?: string }`.
  - Result: `{ "found": boolean, "cancelled": boolean, "reason"?: string, "task"?: TaskSummary }`.
  - `found` reports whether the ledger had a matching task. `cancelled`
    reports whether the runtime accepted or recorded cancellation.

`TaskSummary` includes `id`, `status`, and optional metadata: `kind`,
`runtime`, `title`, `agentId`, `sessionKey`, `childSessionKey`, `ownerKey`,
`runId`, `taskId`, `flowId`, `parentTaskId`, `sourceId`, timestamps, progress,
terminal summary, and sanitized error text. `agentId` identifies the agent
executing the task; `sessionKey` and `ownerKey` preserve requester and control
context.

## Operator helper methods

- `commands.list` (`operator.read`) fetches the runtime command inventory for
  an agent.
  - `agentId` is optional; omit it to read the default agent workspace.
  - `scope` controls which surface the primary `name` targets: `text` returns
    the primary text command token without the leading `/`; `native` and the
    default `both` path return provider-aware native names when available.
  - `textAliases` carries exact slash aliases such as `/model` and `/m`.
  - `nativeName` carries the provider-aware native command name when one
    exists.
  - `provider` is optional and only affects native naming plus native plugin
    command availability.
  - `includeArgs=false` omits serialized argument metadata from the response.
- `tools.catalog` (`operator.read`) fetches the runtime tool catalog for an
  agent. The response includes grouped tools and provenance metadata:
  - `source`: `core` or `plugin`
  - `pluginId`: plugin owner when `source="plugin"`
  - `optional`: whether a plugin tool is optional
- `tools.effective` (`operator.read`) fetches the runtime-effective tool
  inventory for a session.
  - `sessionKey` is required.
  - The gateway derives trusted runtime context from the session server-side
    instead of accepting caller-supplied auth or delivery context.
  - The response is a session-scoped server-derived projection of the active
    inventory, including core, plugin, channel, and already-discovered MCP
    server tools.
  - `tools.effective` is read-only for MCP: it may project a warm session MCP
    catalog through the final tool policy, but does not create MCP runtimes,
    connect transports, or issue `tools/list`. If no matching warm catalog
    exists, the response may include a notice such as `mcp-not-yet-connected`,
    `mcp-not-yet-listed`, or `mcp-stale-catalog`.
  - Effective tool entries use `source="core"`, `source="plugin"`,
    `source="channel"`, or `source="mcp"`.
- `tools.invoke` (`operator.write`) invokes one available tool through the
  same gateway policy path as `/tools/invoke`.
  - `name` is required. `args`, `sessionKey`, `agentId`, `confirm`, and
    `idempotencyKey` are optional.
  - If both `sessionKey` and `agentId` are present, the resolved session agent
    must match `agentId`.
  - Owner-only core wrappers such as `cron`, `gateway`, and `nodes` require
    owner/admin identity (`operator.admin`) even though `tools.invoke` itself
    is `operator.write`.
  - The response is an SDK-facing envelope with `ok`, `toolName`, optional
    `output`, and typed `error` fields. Approval or policy refusals return
    `ok:false` in the payload rather than bypassing the gateway tool policy
    pipeline.
- `skills.status` (`operator.read`) fetches the visible skill inventory for an
  agent.
  - `agentId` is optional; omit it to read the default agent workspace.
  - The response includes eligibility, missing requirements, config checks,
    and sanitized install options without exposing raw secret values.
- `skills.search` and `skills.detail` (`operator.read`) return ClawHub
  discovery metadata.
- `skills.upload.begin`, `skills.upload.chunk`, and `skills.upload.commit`
  (`operator.admin`) stage a private skill archive before installing it. This
  is a separate admin upload path for trusted clients, not the normal ClawHub
  skill install flow, and is disabled by default unless
  `skills.install.allowUploadedArchives` is enabled.
  - `skills.upload.begin({ kind: "skill-archive", slug, sizeBytes, sha256?, force?, idempotencyKey? })`
    creates an upload bound to that slug and force value.
  - `skills.upload.chunk({ uploadId, offset, dataBase64 })` appends bytes at
    the exact decoded offset.
  - `skills.upload.commit({ uploadId, sha256? })` verifies the final size and
    SHA-256. Commit only finalizes the upload; it does not install the skill.
  - Uploaded skill archives are zip archives containing a `SKILL.md` root. The
    archive's internal directory name never selects the install target.
- `skills.install` (`operator.admin`) has three modes:
  - ClawHub mode: `{ source: "clawhub", slug, version?, force? }` installs a
    skill folder into the default agent workspace `skills/` directory.
  - Upload mode: `{ source: "upload", uploadId, slug, force?, sha256?, timeoutMs? }`
    installs a committed upload into the default agent workspace
    `skills/<slug>` directory. The slug and force value must match the
    original `skills.upload.begin` request. Rejected unless
    `skills.install.allowUploadedArchives` is enabled; the setting does not
    affect ClawHub installs.
  - Gateway installer mode: `{ name, installId, timeoutMs? }` runs a declared
    `metadata.openclaw.install` action on the gateway host. Older clients may
    still send `dangerouslyForceUnsafeInstall`; this field is deprecated,
    accepted only for protocol compatibility, and ignored. Use
    `security.installPolicy` for operator-owned install decisions.
- `skills.update` (`operator.admin`) has two modes:
  - ClawHub mode updates one tracked slug or all tracked ClawHub installs in
    the default agent workspace.
  - Config mode patches `skills.entries.<skillKey>` values such as `enabled`,
    `apiKey`, and `env`.

### `models.list` views

`models.list` accepts an optional `view` parameter
(`src/agents/model-catalog-visibility.ts`):

- Omitted or `"default"`: if `agents.defaults.models` is configured, the
  response is the allowed catalog, including dynamically discovered models
  for `provider/*` entries. Otherwise the response is the full gateway
  catalog.
- `"configured"`: picker-sized behavior. If `agents.defaults.models` is
  configured, it still wins, including provider-scoped discovery for
  `provider/*` entries. Without an allowlist, the response uses explicit
  `models.providers.<provider>.models` entries, falling back to the full
  catalog only when no configured model rows exist.
- `"provider-config"`: source-authored `models.providers.*.models` inventory,
  independent of picker allowlists. Rows include public model capabilities and
  route-aware availability, but omit provider endpoints, auth material, and
  runtime request configuration.
- `"all"`: full gateway catalog, bypassing `agents.defaults.models`. Use for
  diagnostics/discovery UIs, not normal model pickers.

## Exec approvals

- When an exec request needs approval, the gateway broadcasts
  `exec.approval.requested`.
- Operator clients resolve by calling `exec.approval.resolve` (requires
  `operator.approvals`).
- For `host=node`, `exec.approval.request` must include `systemRunPlan`
  (canonical `argv`/`cwd`/`rawCommand`/session metadata). Requests missing
  `systemRunPlan` are rejected.
- After approval, forwarded `node.invoke system.run` calls reuse that
  canonical `systemRunPlan` as the authoritative command/cwd/session context.
- If a caller mutates `command`, `rawCommand`, `cwd`, `agentId`, or
  `sessionKey` between prepare and the final approved `system.run` forward,
  the gateway rejects the run instead of trusting the mutated payload.

## Agent delivery fallback

- `agent` requests can include `deliver=true` to request outbound delivery.
- `bestEffortDeliver=false` (the default) keeps strict behavior: unresolved or
  internal-only delivery targets return `INVALID_REQUEST`.
- `bestEffortDeliver=true` allows fallback to session-only execution when no
  external deliverable route can be resolved (for example internal/webchat
  sessions or ambiguous multi-channel configs).
- Final `agent` results may include `result.deliveryStatus` when delivery was
  requested, using the same `sent`, `suppressed`, `partial_failed`, and
  `failed` statuses documented for
  [`openclaw agent --json --deliver`](/cli/agent#json-delivery-status).

## Versioning

- `PROTOCOL_VERSION`, `MIN_CLIENT_PROTOCOL_VERSION`,
  `MIN_NODE_PROTOCOL_VERSION`, and `MIN_PROBE_PROTOCOL_VERSION` live in
  `packages/gateway-protocol/src/version.ts`.
- Clients send `minProtocol` + `maxProtocol`. Operator and UI clients must
  include the current protocol in that range; current clients and servers run
  protocol v4.
- Authenticated clients with both `role: "node"` and `client.mode: "node"`
  may use the N-1 node protocol (currently v3). Lightweight restart probes use
  the same N-1 window. Device auth, pairing, scopes, command policy, and exec
  approvals are unchanged by this compatibility window. Plugin-owned node
  capabilities and commands are withheld until the node upgrades to the current
  protocol because their hosted surfaces are not part of the N-1 contract.
- Schemas and models are generated from TypeBox definitions:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`
  - `pnpm protocol:check`

### Client constants

The reference client implementation lives in `packages/gateway-client/src/`
(OpenClaw wraps it via the thin `src/gateway/client.ts` facade). These
defaults are stable across protocol v4 and are the expected baseline for
third-party clients.

| Constant                                  | Default                                               | Source                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`                        | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_CLIENT_PROTOCOL_VERSION`             | `4`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_NODE_PROTOCOL_VERSION`               | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| `MIN_PROBE_PROTOCOL_VERSION`              | `3`                                                   | `packages/gateway-protocol/src/version.ts`                                                                                |
| Request timeout (per RPC)                 | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`requestTimeoutMs`)                                                              |
| Preauth / connect-challenge timeout       | `15_000` ms                                           | `packages/gateway-client/src/timeouts.ts` (`OPENCLAW_HANDSHAKE_TIMEOUT_MS` env can raise the paired server/client budget) |
| Initial reconnect backoff                 | `1_000` ms                                            | `packages/gateway-client/src/client.ts` (`backoffMs`)                                                                     |
| Max reconnect backoff                     | `30_000` ms                                           | `packages/gateway-client/src/client.ts` (`scheduleReconnect`)                                                             |
| Fast-retry clamp after device-token close | `250` ms                                              | `packages/gateway-client/src/client.ts`                                                                                   |
| Force-stop grace before `terminate()`     | `250` ms                                              | `FORCE_STOP_TERMINATE_GRACE_MS`                                                                                           |
| `stopAndWait()` default timeout           | `1_000` ms                                            | `STOP_AND_WAIT_TIMEOUT_MS`                                                                                                |
| Default tick interval (pre `hello-ok`)    | `30_000` ms                                           | `packages/gateway-client/src/client.ts`                                                                                   |
| Tick-timeout close                        | code `4000` when silence exceeds `tickIntervalMs * 2` | `packages/gateway-client/src/client.ts`                                                                                   |
| `MAX_PAYLOAD_BYTES`                       | `25 * 1024 * 1024` (25 MB)                            | `src/gateway/server-constants.ts`                                                                                         |

The server advertises the effective `policy.tickIntervalMs`,
`policy.maxPayload`, and `policy.maxBufferedBytes` in `hello-ok`; clients
should honor those values rather than the pre-handshake defaults.

The reference client lets finite requests own their configured deadline when
every pending request has one. An `expectFinal` request without a finite
`timeoutMs`, any request with `timeoutMs: null`, or a mix of finite and
unbounded requests keeps the tick watchdog active. If inbound events and
responses remain silent past the tick-timeout threshold, the client closes the
socket with code `4000`, rejects every pending request, and reconnects. It does
not replay rejected requests after reconnecting.

## Auth

- Shared-secret gateway auth uses `connect.params.auth.token` or
  `connect.params.auth.password`, depending on the configured
  `gateway.auth.mode` (`"none" | "token" | "password" | "trusted-proxy"`).
- Identity-bearing modes such as Tailscale Serve (`gateway.auth.allowTailscale: true`)
  or non-loopback `gateway.auth.mode: "trusted-proxy"` satisfy the connect
  auth check from request headers instead of `connect.params.auth.*`.
- Private-ingress `gateway.auth.mode: "none"` skips shared-secret connect auth
  entirely; do not expose that mode on public/untrusted ingress.
- After pairing, the gateway issues a device token scoped to the connection
  role + scopes, returned in `hello-ok.auth.deviceToken`. Clients should
  persist it after any successful connect.
- Reconnecting with that stored device token should also reuse the stored
  approved scope set for that token. This preserves read/probe/status access
  already granted and avoids silently collapsing reconnects to a narrower
  implicit admin-only scope.
- Client-side connect auth assembly (`selectConnectAuth` in
  `packages/gateway-client/src/client.ts`):
  - `auth.password` is orthogonal and always forwarded when set.
  - `auth.token` is populated in priority order: explicit shared token first,
    then an explicit `deviceToken`, then a stored per-device token (keyed by
    `deviceId` + `role`).
  - `auth.bootstrapToken` is sent only when none of the above resolved
    `auth.token`. A shared token or any resolved device token suppresses it.
  - Auto-promotion of a stored device token on the one-shot
    `AUTH_TOKEN_MISMATCH` retry is gated to trusted endpoints only: loopback,
    or `wss://` with a pinned `tlsFingerprint`. Public `wss://` without pinning
    does not qualify.
- Built-in setup-code bootstrap returns the primary node
  `hello-ok.auth.deviceToken` plus a bounded operator token in
  `hello-ok.auth.deviceTokens` for trusted mobile handoff. The operator token
  includes `operator.talk.secrets` for native Talk configuration reads, but
  excludes pairing-mutation scopes and `operator.admin`.
- While a non-baseline setup-code bootstrap waits for approval,
  `PAIRING_REQUIRED` details include `recommendedNextStep: "wait_then_retry"`,
  `retryable: true`, and `pauseReconnect: false`. Keep reconnecting with the
  same bootstrap token until the request is approved or the token becomes
  invalid.
- Persist `hello-ok.auth.deviceTokens` only when the connect used bootstrap
  auth on a trusted transport such as `wss://` or loopback/local pairing.
- If a client supplies an explicit `deviceToken` or explicit `scopes`, that
  caller-requested scope set remains authoritative; cached scopes are only
  reused when the client is reusing the stored per-device token.
- Device tokens can be rotated/revoked via `device.token.rotate` and
  `device.token.revoke` (requires `operator.pairing`). Rotating or revoking a
  node or other non-operator role also requires `operator.admin`.
- `device.token.rotate` returns rotation metadata. It echoes the replacement
  bearer token only for same-device calls already authenticated with that
  device token, so token-only clients can persist their replacement before
  reconnecting. Shared/admin rotations do not echo the bearer token.
- Token issuance, rotation, and revocation stay bounded to the approved role
  set recorded in that device's pairing entry; token mutation cannot expand or
  target a device role that pairing approval never granted.
- For paired-device token sessions, device management is self-scoped unless
  the caller also has `operator.admin`: non-admin callers can manage only the
  operator token for their own device entry. Node and other non-operator token
  management is admin-only, even for the caller's own device.
- `device.token.rotate` and `device.token.revoke` also check the target
  operator token scope set against the caller's current session scopes.
  Non-admin callers cannot rotate or revoke a broader operator token than they
  already hold.
- Auth failures include `error.details.code` plus recovery hints:
  - `error.details.canRetryWithDeviceToken` (boolean)
  - `error.details.recommendedNextStep`: one of `retry_with_device_token`,
    `update_auth_configuration`, `update_auth_credentials`,
    `wait_then_retry`, `review_auth_configuration`
    (`packages/gateway-protocol/src/connect-error-details.ts`).
- Client behavior for `AUTH_TOKEN_MISMATCH`:
  - Trusted clients may attempt one bounded retry with a cached per-device
    token.
  - If that retry fails, stop automatic reconnect loops and surface operator
    action guidance.
- `AUTH_SCOPE_MISMATCH` means the device token was recognized but does not
  cover the requested role/scopes. Do not present this as a bad token; prompt
  the operator to re-pair or approve the narrower/broader scope contract.

## Device identity and pairing

- Nodes should include a stable device identity (`device.id`) derived from a
  keypair fingerprint.
- Gateways issue tokens per device + role.
- Pairing approvals are required for new device IDs unless local
  auto-approval is enabled.
- Pairing auto-approval is centered on direct local loopback connects.
- OpenClaw also has a narrow backend/container-local self-connect path for
  trusted shared-secret helper flows.
- Same-host tailnet or LAN connects are still treated as remote for pairing
  and require approval.
- WS clients normally include `device` identity during `connect` (operator +
  node). The only device-less operator exceptions are explicit trust paths:
  - `gateway.controlUi.allowInsecureAuth=true` for localhost-only insecure
    HTTP compatibility.
  - successful `gateway.auth.mode: "trusted-proxy"` operator Control UI auth.
  - `gateway.controlUi.dangerouslyDisableDeviceAuth=true` (break-glass, severe
    security downgrade).
  - direct-loopback `gateway-client` backend RPCs on the reserved internal
    helper path.
- Omitting device identity has scope consequences. When a device-less
  operator connection is allowed through an explicit trust path, OpenClaw
  still clears self-declared scopes to an empty set unless that path has a
  named scope-preservation exception. Scope-gated methods then fail with
  `missing scope`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth=true` is a Control UI
  break-glass scope-preservation path. It does not grant scopes to arbitrary
  custom backend or CLI-shaped WebSocket clients.
- The reserved direct-loopback `gateway-client` backend helper path preserves
  scopes only for internal local control-plane RPCs; custom backend IDs do
  not receive this exception.
- All connections must sign the server-provided `connect.challenge` nonce.

### Device auth migration diagnostics

For legacy clients that still use pre-challenge signing behavior, `connect`
returns `DEVICE_AUTH_*` detail codes under `error.details.code` with a stable
`error.details.reason`.

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
- Preferred signature payload is `v3`
  (`buildDeviceAuthPayloadV3` in `packages/gateway-client/src/device-auth.ts`),
  which binds `platform` and `deviceFamily` in addition to
  device/client/role/scopes/token/nonce fields.
- Legacy `v2` signatures remain accepted for compatibility, but paired-device
  metadata pinning still controls command policy on reconnect.

## TLS and pinning

- TLS is supported for WS connections (`gateway.tls` config).
- Clients may optionally pin the gateway cert fingerprint via
  `gateway.remote.tlsFingerprint` or CLI `--tls-fingerprint`.

## Scope

This protocol exposes the full gateway API: status, channels, models, chat,
agent, sessions, nodes, approvals, and more. The exact surface is defined by
the TypeBox schemas re-exported from `packages/gateway-protocol/src/schema.ts`.

## Related

- [Bridge protocol](/gateway/bridge-protocol)
- [Gateway runbook](/gateway)
