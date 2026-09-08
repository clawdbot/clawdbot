---
summary: "Presence snapshots, node host stats, and broadcast event scoping"
read_when:
  - Rendering node presence or host stats in a client
  - Working out which broadcast events a session receives
title: "Gateway protocol presence and events"
sidebarTitle: "Presence and events"
doc-schema-version: 1
---

How the Gateway reports which nodes are connected, and which server-pushed events reach a given session.

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
The app sends `{ "action": "clear" }` when the user disables activity sharing;
the Gateway clears timestamps only for that exact authenticated node connection.
Gateways that predate this acknowledged action return it as unhandled, so the Mac
node reconnects once and lets disconnect cleanup remove the old connection state.
See [Active computer presence](/nodes/presence) for selection, privacy, model
context, and notification-routing behavior.

### Node host stats

Connected CLI node hosts and the macOS app's shared node-host worker send a
resource snapshot immediately after connecting, then every 60 seconds. They call
`node.event` with `event: "node.host.stats"` and an object `payload` (or its JSON
encoding in `payloadJSON`):

```json
{
  "event": "node.host.stats",
  "payload": {
    "cpuCount": 8,
    "loadAverage": [1.25, 1.1, 0.9],
    "memoryTotalBytes": 17179869184,
    "memoryFreeBytes": 4294967296,
    "diskTotalBytes": 1000000000000,
    "diskAvailableBytes": 250000000000
  }
}
```

`cpuCount` is an integer from 1 to 4096. Optional `loadAverage` contains the
1-, 5-, and 15-minute averages, each finite and between 0 and 100000. Windows
has no load average; hosts omit the field when all three readings are zero.
Memory and disk values are non-negative integer bytes, with free or available
bytes no greater than their total. Disk fields appear together only when the
host can read capacity for the volume containing its home directory, independent
of the worker's current directory.

The Gateway accepts updates only from the current node connection and stamps
`updatedAtMs` with its own receipt time; nodes never send a timestamp. Successful
updates appear as `hostStats` in `node.list` and `node.describe` and broadcast
`node.hostStats` with `{ nodeId, hostStats }` to read-scoped operators, using
`dropIfSlow: true`. Stats are operator-facing and do not update model-visible
node context. When received, the Gateway persists the snapshot as `lastHostStats`
on the paired node record. Disconnecting or reconnecting without a new snapshot
leaves the previous value intact.
`node.list` and `node.describe` use live session stats while connected and
project the saved snapshot as `hostStats` while offline, keeping its original
`updatedAtMs` so clients can show the last-known age.

The structured `node.event` result uses `reason: "updated"`, `"stale_connection"`,
or `"invalid_payload"`. An older Gateway may return `handled: false`; the node
continues at the normal cadence without an immediate retry.

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

`hello-ok.features.capabilities` advertises additive wire contracts. Native clients
send `sessionKey` in `chat.metadata` only when `session-scoped-chat-metadata` is present;
otherwise they retain the agent-only request supported by stable `v2026.7.1-2`.
That older response describes agent-wide availability, not a session's selected
profile. Retire this negotiation only when the minimum supported Gateway contract
guarantees session-scoped metadata. Method or event presence alone is insufficient.
