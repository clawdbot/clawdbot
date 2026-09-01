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
- `ip`: best-effort IP address; the [geolocation plugin](/plugins/geolocation) resolves it to a coarse city where one is available
- `version`: client version string
- `deviceFamily` / `modelIdentifier`: hardware hints
- `timeZone`: self-reported IANA zone (for example `Europe/Vienna`); browsers report it during connect, and it stays useful when the connecting IP is loopback, tunneled, or CGNAT
- `mode`: `ui`, `webchat`, `cli`, `backend`, `node`, `probe`, `test`
- `lastInputSeconds`: seconds since last user input, if known
- `reason`: free-form client-supplied string; the Gateway itself only emits `self`, `connect`, and `disconnect`
- `deviceId`, `roles`, `scopes`: device identity and role/scope hints from the connect handshake
- `ts`: last presence update timestamp (ms since epoch), including heartbeat updates; not a user-activity timestamp
- `onlineSince`: start of an authenticated person's current continuous online period, shared across overlapping connections
- `lastActivityAt`: latest observed accepted interaction during that online period; absent until activity is observed
- `watchedSessions`: session keys the client explicitly declares it is viewing, filtered for the recipient

## Who can see presence

The presence roster is shared with operators who have `operator.read` access;
`operator.write` and `operator.admin` also grant read access. Readers can see other
people's online and activity timing and reported `timeZone`, including people who
are not watching a session. Node connections, pairing-only operators, and other
connections without read access receive an empty presence roster in the connect
snapshot and no `presence` events. The `system-presence` RPC requires the same
operator read access.

Watched-session references are filtered separately for each recipient using the
same visibility rules as `sessions.list`. Hidden or missing sessions are omitted
entirely, without counts or placeholders. This filtering applies to connect
snapshots, `system-presence` responses, and presence events; the person being
viewed does not grant the recipient access to their sessions.

Drafts, incognito sessions, and operator role restrictions follow those list
rules. Missing or deleted references are omitted even for admins. Keys retain
their agent scope, including agent-qualified `global` and `unknown` references.
Non-admin readers awaiting authenticated profile verification receive person
metadata but no watched references; established admin grants retain admin list
visibility. When no references are visible, `watchedSessions` is omitted.
Message subscriptions alone do not declare viewer presence.

This policy does not change which IP addresses are shared between readers and
does not isolate all Gateway metadata. Use separate Gateway trust boundaries
when readers must not see each other's presence or other shared metadata.

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
app uses this to report host name, IP, version, and liveness metadata. Physical
input activity is not part of this generic beacon; the purpose-specific native
node event described in [Active computer presence](/nodes/presence) owns it. The
Mac tags these beacons with `system-presence-clear-last-input`; current Gateways
use that backward-compatible marker to remove any input recency retained from an
older app. The beacon also carries a fixed 30-day value so older Gateways that
ignore the tag overwrite exact recency instead of retaining it. No new activity
is sampled for this compatibility value.

### 4) Node connects (role: node)

When a node connects over the Gateway WebSocket with `role: node`, the Gateway
upserts a presence entry for that node (same flow as other WS clients).

## Connection rows and beacon deduplication

Presence entries are stored in a single in-memory map with case-insensitive keys.
User WebSocket clients have one row per connection, so two tabs watching different
sessions cannot overwrite each other. Node connections use their device id,
then `connect.client.instanceId`, then the connection id.

`system-event` beacons merge by device id or instance id when supplied, otherwise
by parsed host or other beacon metadata. A stable `instanceId` helps consumers
associate rows with the same client; it does not merge separate user WebSocket
connections. Ephemeral control-plane clients are excluded from tracking entirely.

The Control UI groups connection rows by their recorded identity namespace when
displaying people. Connections with the same qualified profile identity share one
person; unqualified connections with the same raw ID form a separate group. A raw
ID matching a profile ID never combines their watched sessions, connection facts,
or viewer counts. The Gateway uses the same namespace boundary for online/activity
timing and collaborative typing counts. Overlapping tabs share timing facts only
within their namespace; later activity stays separate if a raw tab gains profile
qualification. Self exclusion follows the authenticated user's recorded
qualification, using the current connection only when that user is unavailable.
Only a displayed owner with the exact qualified profile identity is deduplicated
from a session's live viewers. The [people card](/concepts/multi-user#people-cards) keeps online duration
and observed activity separate from each entry's heartbeat freshness.

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

- To see the list projected for your connection, call `system-presence` against the Gateway.
- If you see duplicates:
  - confirm clients send a stable `client.instanceId` in the handshake
  - confirm periodic beacons use the same `instanceId`
  - check for multiple tabs or reconnects; separate user connections have separate rows, and old rows expire after the TTL

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
