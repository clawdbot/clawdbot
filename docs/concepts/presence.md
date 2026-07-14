---
summary: "How OpenClaw presence entries are produced, merged, and displayed"
read_when:
  - Debugging live status on the Control UI Devices page
  - Investigating duplicate or stale instance rows
  - Changing gateway WS connect or system-event beacons
title: "Presence"
---

OpenClaw "presence" is a lightweight, best-effort view of:

- the **Gateway** itself, and
- **user-visible clients connected to the Gateway** (mac app, WebChat, nodes, etc.)

Presence renders live connection metadata in the Control UI **Devices** page
(under **Settings → Devices**) and the macOS app's **Instances** tab.

This page covers the Gateway client roster. To detect the Mac you most recently
used and route node alerts there, see
[Active computer presence](/nodes/presence).

## Presence fields (what shows up)

Presence entries are structured objects with fields like:

- `instanceId` (optional but strongly recommended): stable client identity (usually `connect.client.instanceId`)
- `host`: human-friendly host name
- `ip`: best-effort IP address
- `version`: client version string
- `deviceFamily` / `modelIdentifier`: hardware hints
- `mode`: `ui`, `webchat`, `cli`, `backend`, `node`, `probe`, `test`
- `lastInputSeconds`: seconds since last user input, if known
- `reason`: free-form client-supplied string; the Gateway itself only emits `self`, `connect`, and `disconnect`
- `deviceId`, `roles`, `scopes`: device identity and role/scope hints from the connect handshake
- `ts`: last update timestamp (ms since epoch)

## Producers (where presence comes from)

Presence entries are produced by multiple sources and **merged**.

### 1) Gateway self entry

The Gateway always seeds a "self" entry at startup so UIs show the gateway host
even before any clients connect.

### 2) WebSocket connect

Every WS client begins with a `connect` request. On successful handshake the
Gateway upserts a presence entry for that connection.

#### Why ephemeral control-plane connections do not show up

CLI commands, backend RPC clients, and probes often connect briefly. To avoid
retaining that churn for the full presence TTL, clients in `cli`, `backend`,
or `probe` mode are **not** turned into presence entries. Test-mode clients
stay tracked because test suites use them as stand-ins for real clients.

### 3) `system-event` beacons

Clients can send richer periodic beacons via the `system-event` method. The mac
app uses this to report host name, IP, and `lastInputSeconds`.

### 4) Node connects (role: node)

When a node connects over the Gateway WebSocket with `role: node`, the Gateway
upserts a presence entry for that node (same flow as other WS clients).

## Merge + dedupe rules (why `instanceId` matters)

Presence entries are stored in a single in-memory map, keyed case-insensitively
by the first available of, in order: a paired device id, `connect.client.instanceId`,
or the per-connection id as a last resort.

Ephemeral control-plane clients are excluded from tracking entirely (see
above), so their connection ids never become keys. For every other client, the
connection id fallback means a client that reconnects without a stable
`instanceId` shows up as a **duplicate** row.

## TTL and bounded size

Presence is intentionally ephemeral:

- **TTL:** entries older than 5 minutes are pruned
- **Max entries:** 200 (oldest dropped first)

This keeps the list fresh and avoids unbounded memory growth.

## Remote/tunnel caveat (loopback IPs)

When a client connects over an SSH tunnel / local port forward, the Gateway
may see the remote address as `127.0.0.1`. To avoid recording that tunnel
address as the client's IP, connect handling omits `ip` entirely for
detected-local (loopback) clients rather than writing the loopback address
into the entry.

## Consumers

### Control UI Devices page

The **Devices** page joins `system-presence` with durable pairing and node
records. It pins the Gateway self beacon first and uses matching device or
instance ids for live platform, version, model, and input-recency metadata.

### macOS Instances tab

The macOS app renders the output of `system-presence` and applies a small status
indicator (Active/Idle/Stale) based on the age of the last update.

## Debugging tips

- To see the raw list, call `system-presence` against the Gateway.
- If you see duplicates:
  - confirm clients send a stable `client.instanceId` in the handshake
  - confirm periodic beacons use the same `instanceId`
  - check whether the connection-derived entry is missing `instanceId` (duplicates are expected)

## Related

<CardGroup cols={2}>
  <Card title="Active computer presence" href="/nodes/presence" icon="computer-mouse">
    How physical Mac input selects an active node and routes connection alerts.
  </Card>
  <Card title="Typing indicators" href="/concepts/typing-indicators" icon="ellipsis">
    When typing indicators are sent and how to tune them.
  </Card>
  <Card title="Streaming and chunking" href="/concepts/streaming" icon="bars-staggered">
    Outbound streaming, chunking, and per-channel formatting.
  </Card>
  <Card title="Gateway architecture" href="/concepts/architecture" icon="diagram-project">
    Gateway components and the WebSocket protocol that drives presence updates.
  </Card>
  <Card title="Gateway protocol" href="/gateway/protocol" icon="plug">
    The wire protocol for `connect`, `system-event`, and `system-presence`.
  </Card>
</CardGroup>
