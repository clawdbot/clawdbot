---
title: Gateway Runtime WebSocket Feature Matrix - Nodes and Remote Capabilities
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Nodes and remote capabilities
feature_slug: node-transport-and-capability-relay
---

# Nodes and Remote Capabilities

## Summary

OpenClaw has a real node transport in the Gateway WebSocket control plane. Nodes
connect with `role: "node"`, declare caps/commands/permissions, become visible
through `node.list`/`node.describe`, and receive `node.invoke.request` events
that are completed with `node.invoke.result`. The relay surface covers core
camera/canvas/screen/location/notification/system commands, browser proxy, Talk
PTT, and the bundled file-transfer plugin's node-host commands.

The maturity gap is not the existence of the control plane. It is that broad
capability relay is unevenly proven: core node invoke/list flows have server and
e2e proof, Android capability proof is live/preconditioned, and some offline or
background flows are handler/unit-heavy. Archive evidence also shows repeated
real-world issues around invoke timeouts, pending pairing/work visibility,
command advertisement, and platform-specific capability availability.

## Features

- Node presence: Node presence in the same WS control plane as operator clients.
- Node capabilities: Node capability declaration at connect time.
- Node inventory: `node.list`, `node.describe`, and naming/state visibility.
- Node actions: `node.invoke` and `node.invoke.result`.
- Node events: `node.event`, especially `node.presence.alive`.
- Pending work delivery: Pending work APIs for connected and disconnected nodes.
- Remote device capabilities: Relay of remote capability surfaces such as camera, canvas, screen, location, voice, and browser.
- Remote host commands: Relay of remote host-command capability surfaces.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 84

Label: Yes

Positive signals:

- Docs define node clients as same-port WebSocket clients with `role: "node"`
  and explicit caps/commands, and list camera/canvas/screen/location/voice
  examples in the connect payload (`docs/gateway/protocol.md:180`,
  `docs/gateway/protocol.md:196`, `docs/gateway/protocol.md:198`).
- Gateway architecture docs state that nodes connect to the same WebSocket
  server and expose `canvas.*`, `camera.*`, `screen.record`, and `location.get`
  (`docs/concepts/architecture.md:15`, `docs/concepts/architecture.md:40`).
- Protocol docs enumerate `node.list`, `node.describe`, `node.invoke`,
  `node.invoke.result`, `node.event`, `node.pending.pull`,
  `node.pending.ack`, `node.pending.enqueue`, and `node.pending.drain`
  (`docs/gateway/protocol.md:453`).
- The typed protocol schema covers node capability claims, invoke/result,
  `node.event`, presence-alive payloads, and pending work drain/enqueue shapes
  (`src/gateway/protocol/schema/nodes.ts:23`,
  `src/gateway/protocol/schema/nodes.ts:107`,
  `src/gateway/protocol/schema/nodes.ts:118`,
  `src/gateway/protocol/schema/nodes.ts:138`,
  `src/gateway/protocol/schema/nodes.ts:147`).
- Gateway handlers register the full node method family through lazy core
  handlers (`src/gateway/server-methods.ts:482`, `src/gateway/server-methods.ts:490`,
  `src/gateway/server-methods.ts:501`).
- A real multi-gateway e2e test starts two gateways, connects node clients over
  WS, and waits for `node.list` to show each paired connected node
  (`test/gateway.multi.e2e.test.ts:27`, `test/helpers/gateway-e2e-harness.ts:129`,
  `test/helpers/gateway-e2e-harness.ts:203`).
- Real WS server tests cover command visibility, pairing approval refresh, and
  `node.invoke`/`node.invoke.result` round trips for `canvas.snapshot`
  (`src/gateway/server.roles-allowlist-update.test.ts:437`,
  `src/gateway/server.roles-allowlist-update.test.ts:446`,
  `src/gateway/server.roles-allowlist-update.test.ts:567`).
- The Android live capability suite is preconditioned but real: it connects to a
  live Gateway, calls `node.list`, `node.describe`, and executes advertised
  `node.invoke` commands including `camera.snap` and `location.get`
  (`src/gateway/android-node.capabilities.live.test.ts:161`,
  `src/gateway/android-node.capabilities.live.test.ts:179`,
  `src/gateway/android-node.capabilities.live.test.ts:517`,
  `src/gateway/android-node.capabilities.live.test.ts:541`,
  `src/gateway/android-node.capabilities.live.test.ts:577`).

Negative signals:

- Coverage is strongest for list/pairing/invoke mechanics and weaker for every
  individual capability family as a real Gateway flow.
- `node.pending.enqueue`/`node.pending.drain` and APNs wake behavior are
  primarily handler/unit tested, not full e2e with a disconnected physical node
  (`src/gateway/server-methods/nodes-pending.test.ts:112`,
  `src/gateway/server-methods/nodes.invoke-wake.test.ts:591`).
- Agent and CLI media relay helpers are well tested but mostly through mocked
  gateway calls, so they do not by themselves satisfy coverage-Yes proof for the
  Gateway transport (`src/cli/program.nodes-media.e2e.test.ts:38`,
  `src/agents/openclaw-tools.camera.test.ts:150`).
- Browser proxy and file-transfer relay are implemented through bundled plugins,
  but their evidence is mostly unit/contract coverage plus targeted plugin tests,
  not one end-to-end node-host/browser/file-transfer scenario in this audit.

Integration gaps:

- No single e2e covers node connect -> `node.list`/`node.describe` ->
  `node.invoke` -> `node.invoke.result` across camera/canvas/screen/location,
  browser proxy, Talk PTT, file transfer, and host-command families.
- No e2e proves durable pending work for an offline node reconnecting and
  draining queued work after a wake path.
- Android live proof is conditional on a real connected Android node and does
  not cover iOS/macOS/Windows/Linux parity for the same advertised commands.
- Presence alive is documented and unit-tested, but the durable background
  mobile path is not proven by a live background wake in this slice.

## Quality

Score: 63

Label: Medium

Gitcrawl reports:

- Query: `gitcrawl search openclaw/openclaw --query "node.invoke" --mode keyword --limit 20 --json`
  - Result: 20 hits returned.
  - Notable quality signals: open PR #85916 "fix(gateway): require admin scope
    for browser proxy invoke"; closed issues #58903 "Disconnected Node causes
    false 'Rate Limit' errors (node.invoke timeout misclassified)", #5639
    "iOS app: node.invoke commands timeout", #17356 "node.invoke intermittent
    30s timeout", and feature request #68090 for a configurable
    `node.invoke` timeout; closed PRs #1357, #1607, #78351, #83976, and open
    PR #83980 all point at invoke timeout, late result, reconnect, or node
    stability work.
- Query: `gitcrawl search openclaw/openclaw --query "node.presence.alive" --mode keyword --limit 20 --json`
  - Result: 14 hits returned.
  - Notable quality signals: PR #73373 and #73330 add authenticated presence
    alive beacons; open PR #63123 adds iOS background alive beacon support; PR
    #39796 fixes heartbeat stale-socket behavior related to liveness.
- Query: `gitcrawl search openclaw/openclaw --query "node.pending" --mode keyword --limit 20 --json`
  - Result: 20 hits returned.
  - Notable quality signals: PR #41409 adds pending node work primitives; PR
    #58179 and PR #55653 fix pending-work state leaks; issues #6836, #38124,
    #84642, #17443, #12856, #24998, and #50343 report pending pairing/work
    invisibility, timeouts, or empty pending lists.
- Query: `gitcrawl search openclaw/openclaw --query "node.list node.describe" --mode keyword --limit 20 --json`
  - Result: 20 hits returned.
  - Notable quality signals: open issues #51903 (nodes tool describe schema
    mismatch), #57775 (Windows exec approvals commands not advertised), and
    #61569 (custom node ID not honored); closed issues #58158/#58159 and #59012
    report missing camera/microphone command advertisement.
- Query: `gitcrawl search openclaw/openclaw --query "camera canvas screen location voice browser node" --mode keyword --limit 20 --json`
  - Result: 1 hit returned, mostly noisy (#29416 schema-invalid report that
    mentions nodes capability text).
- Query: `gitcrawl search openclaw/openclaw --query "file.fetch node host protocol" --mode keyword --limit 20 --json`
  - Result: 20 hits returned.
  - Notable quality signal: PR #74134 adds the bundled file-transfer plugin for
    binary file operations on nodes; most other hits were unrelated path/protocol
    noise.

Discrawl reports:

- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.invoke"`
  - Result: 10 hits returned.
  - Notable reports: maintainer discussion on 2026-04-28 proposed `file.fetch`
    / `dir.list` / `dir.fetch` over `node.invoke`; later GitHub mirror messages
    reference #58903, #55258, #42590, #46669, and #43287 around timeout,
    node-targeted exec, browser proxy, and node relay behavior.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.presence.alive"`
  - Result: 3 hits returned.
  - Notable reports: PR #63123 background alive beacon opened/commented/reviewed,
    including review feedback about wall-clock throttling.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.pending"`
  - Result: 10 hits returned.
  - Notable reports: PR #61719 review warns about preserving device-scoped node
    IDs for pending-work flows; PR #58179 discussion covers the pending-work
    memory leak fix and merge proof.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.list node.describe"`
  - Result: 6 hits returned.
  - Notable reports: a "How to best practice for multi agent" thread asks for
    Mission-Control-style node UI behavior and calls out `node.list`,
    `node.describe`, generic `node.invoke`, raw caps/permissions, and common
    canvas/camera/screen/location/system buttons.
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "camera canvas screen location voice browser node"`
  - Result: `null` (0 hits returned).
- Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "camera.snap screen.record location.get"`
  - Result: 1 hit returned.
  - Notable report: user guidance says nodes can run commands, send
    notifications, take camera snapshots/screen recordings, and get location,
    while noting that Discord-only bot use cases usually do not need nodes.

Good qualities:

- The protocol surface is schema-backed and method-registered, not ad hoc JSON
  (`src/gateway/protocol/schema/nodes.ts:107`, `src/gateway/server-methods.ts:490`).
- `NodeRegistry` keeps node sessions, declared/effective caps and commands,
  pending invoke promises, connectivity probes, timeouts, and late-result
  handling centralized (`src/gateway/node-registry.ts:153`,
  `src/gateway/node-registry.ts:397`).
- The Gateway filters effective commands through platform policy and node
  declarations before forwarding, and dangerous defaults require explicit opt-in
  (`src/gateway/node-command-policy.ts:64`, `src/gateway/node-command-policy.ts:316`,
  `src/gateway/node-command-policy.ts:398`).
- Node visibility merges live sessions, device pairing, node pairing, names,
  commands, permissions, connected state, and `lastSeen` metadata in one catalog
  (`src/gateway/node-catalog.ts:90`, `src/gateway/node-catalog.ts:122`).
- Presence alive is authenticated-device-bound, throttled, and persists into
  node/device pairing metadata (`src/gateway/server-node-events.ts:847`).
- Plugin-owned relay surfaces use the same node invoke and policy seams:
  browser registers `browser.proxy` as a node-host command
  (`extensions/browser/plugin-registration.ts:57`), and file transfer registers
  dangerous node-host commands plus a node-invoke policy
  (`extensions/file-transfer/index.ts:41`, `extensions/file-transfer/index.ts:88`).

Bad qualities:

- Archive evidence shows repeated user-visible reliability bugs in `node.invoke`
  timeout/reconnect handling, pending pairing/work visibility, and command
  advertisement.
- `node.pending` has two related concepts: connected-node action pull/ack in
  `src/gateway/server-methods/nodes.ts` and durable pending work drain/enqueue in
  `src/gateway/server-methods/nodes-pending.ts`. The distinction is implemented
  but easy to confuse operationally.
- Pending work types are currently narrow (`status.request` and
  `location.request`), so the API does not yet model arbitrary disconnected
  node commands (`src/gateway/protocol/schema/nodes.ts:4`).
- Browser and file-transfer relay add useful plugin-owned capabilities, but the
  quality posture depends on each plugin's registration, command metadata, and
  local policy staying aligned with Gateway node policy.
- Voice relay is present as Talk PTT events/commands, but the docs make it
  harder to reason about than camera/canvas/screen/location relay.
- Source and archive evidence show expectation gaps around node-tool describe
  semantics, Windows exec-approval command advertisement, custom node ID
  honoring, configurable `node.invoke` timeout behavior, and background
  `node.presence.alive` support.

## Known gaps

- `node.pending` is not a general durable disconnected-command queue. The typed
  durable work API is limited to `status.request` and `location.request`, while
  foreground-restricted command queuing is a separate in-memory action queue.
- There is no one-stop docs/source compatibility matrix that explains relay
  availability by platform across camera, canvas, screen, location, voice/Talk,
  browser, file transfer, and host commands.
- Some platform capabilities remain product-conditional: docs note foreground
  requirements for canvas/camera and platform-dependent `screen.record`
  availability (`docs/nodes/index.md:273`, `docs/nodes/index.md:288`).
- Open archive items indicate remaining product gaps around agent-tool
  `describe`, Windows exec-approval command advertisement, custom node ID
  honoring, configurable `node.invoke` timeouts, and background presence alive.
- The Discord "How to best practice for multi agent" thread asks for node UI
  discovery that gates actions from `hello-ok.features.methods`, shows raw caps
  and permissions, provides generic `node.invoke`, and adds buttons for common
  canvas/camera/screen/location/system commands.

## Evidence

### Docs

- `docs/gateway/protocol.md:180` - node connect example.
- `docs/gateway/protocol.md:196` - `role: "node"` in connect.
- `docs/gateway/protocol.md:198` - caps/commands/permissions example.
- `docs/gateway/protocol.md:263` - caps/commands/permissions contract.
- `docs/gateway/protocol.md:274` - presence section with `node.list`
  `lastSeenAtMs`/`lastSeenReason`.
- `docs/gateway/protocol.md:283` - `node.presence.alive`.
- `docs/gateway/protocol.md:453` - node pairing/invoke/pending method list.
- `docs/concepts/architecture.md:15` - nodes connect over WebSocket.
- `docs/concepts/architecture.md:40` - nodes share the WS server and expose
  canvas/camera/screen/location.
- `docs/nodes/index.md:10` - nodes use same Gateway WebSocket and `node.invoke`.
- `docs/nodes/index.md:191` - node command policy gates.
- `docs/nodes/index.md:217` - canvas snapshot/control docs.
- `docs/nodes/index.md:254` - camera photo/video docs.
- `docs/nodes/index.md:277` - screen recording docs.
- `docs/nodes/index.md:293` - location docs.
- `docs/nodes/index.md:368` - system.run and exec-node binding notes.
- `docs/nodes/index.md:409` - permissions map in `node.list`/`node.describe`.

### Source

- `src/gateway/protocol/schema/nodes.ts:23` - `node.presence.alive` payload schema.
- `src/gateway/protocol/schema/nodes.ts:47` - node pairing request fields.
- `src/gateway/protocol/schema/nodes.ts:93` - `node.list` params schema.
- `src/gateway/protocol/schema/nodes.ts:102` - `node.describe` params schema.
- `src/gateway/protocol/schema/nodes.ts:107` - `node.invoke` params schema.
- `src/gateway/protocol/schema/nodes.ts:118` - `node.invoke.result` params schema.
- `src/gateway/protocol/schema/nodes.ts:138` - `node.event` params schema.
- `src/gateway/protocol/schema/nodes.ts:147` - `node.pending.drain` params schema.
- `src/gateway/protocol/schema/nodes.ts:176` - `node.pending.enqueue` params schema.
- `src/gateway/server-methods.ts:482` - node method lazy handler registration.
- `src/gateway/server-methods/nodes.ts:916` - `node.list` handler.
- `src/gateway/server-methods/nodes.ts:939` - `node.describe` handler.
- `src/gateway/server-methods/nodes.ts:984` - `node.pending.pull` handler.
- `src/gateway/server-methods/nodes.ts:1019` - `node.pending.ack` handler.
- `src/gateway/server-methods/nodes.ts:1046` - `node.invoke` handler.
- `src/gateway/server-methods/nodes.ts:1346` - `node.event` handler.
- `src/gateway/server-methods/nodes.handlers.invoke-result.ts:25` -
  `node.invoke.result` handler.
- `src/gateway/server-methods/nodes-pending.ts:31` -
  `node.pending.drain`/`node.pending.enqueue` handlers.
- `src/gateway/node-registry.ts:153` - connected node registry.
- `src/gateway/node-registry.ts:397` - node invoke forwarding.
- `src/gateway/node-catalog.ts:122` - list/describe merged node state.
- `src/gateway/server-node-events.ts:847` - presence alive event persistence.
- `src/gateway/node-command-policy.ts:75` - platform command defaults.
- `src/gateway/node-command-policy.ts:398` - command allowlist/declared-command enforcement.
- `extensions/browser/plugin-registration.ts:57` - `browser.proxy` node host command.
- `extensions/browser/src/gateway/browser-request.ts:187` - browser Gateway route invokes a browser node.
- `extensions/file-transfer/index.ts:41` - file-transfer node host commands.
- `extensions/file-transfer/src/tools/file-fetch-tool.ts:52` - file fetch uses
  `node.invoke`.

### Integration tests

- `test/gateway.multi.e2e.test.ts:27` - real multi-gateway e2e with node pairing.
- `test/helpers/gateway-e2e-harness.ts:129` - e2e node connection helper uses
  role `node`, caps, commands, and device identity.
- `test/helpers/gateway-e2e-harness.ts:203` - e2e waits for `node.list`
  connected/paired state.
- `src/gateway/server.node-pairing-authz.test.ts:41` - real WS node client helper.
- `src/gateway/server.node-pairing-authz.test.ts:112` - real WS `node.list`
  command visibility assertion.
- `src/gateway/server.roles-allowlist-update.test.ts:437` - real WS
  `node.invoke` to connected node.
- `src/gateway/server.roles-allowlist-update.test.ts:446` - node sends
  `node.invoke.result`.
- `src/gateway/server.roles-allowlist-update.test.ts:518` - approval refreshes
  live node commands then invoke succeeds.
- `src/gateway/android-node.capabilities.live.test.ts:506` - live Android node
  capability suite.
- `src/gateway/android-node.capabilities.live.test.ts:517` - live `node.list`.
- `src/gateway/android-node.capabilities.live.test.ts:541` - live `node.describe`.
- `src/gateway/android-node.capabilities.live.test.ts:577` - live advertised
  command execution loop.

### Unit tests

- `src/gateway/server-node-events.test.ts:1269` - presence alive persistence.
- `src/gateway/server-node-events.test.ts:1295` - presence alive rejects missing
  authenticated device identity.
- `src/gateway/server-node-events.test.ts:1352` - presence alive throttling.
- `src/gateway/node-pending-work.test.ts:15` - baseline status pending work.
- `src/gateway/node-pending-work.test.ts:26` - dedupe and acknowledge.
- `src/gateway/node-pending-work.test.ts:67` - pending state pruning.
- `src/gateway/server-methods/nodes-pending.test.ts:62` - pending drain handler.
- `src/gateway/server-methods/nodes-pending.test.ts:112` - enqueue and wake
  disconnected node.
- `src/gateway/server-methods/nodes.invoke-wake.test.ts:506` - unavailable wake
  path keeps not-connected response.
- `src/gateway/server-methods/nodes.invoke-wake.test.ts:591` - APNs wake then
  retry invoke.
- `src/gateway/server-methods/nodes.invoke-wake.test.ts:633` - Talk PTT command
  broadcasts canonical `talk.event`.
- `src/gateway/node-command-policy.test.ts:40` - platform/default command policy.
- `src/gateway/node-registry.test.ts:557` - registry update preserves declared
  commands.
- `src/agents/openclaw-tools.camera.test.ts:195` - agent camera tool issues
  `camera.snap`.
- `src/agents/openclaw-tools.camera.test.ts:530` - agent location tool issues
  `location.get`.
- `extensions/browser/src/gateway/browser-request.profile-from-body.test.ts:103`
  - browser proxy request invokes `browser.proxy`.
- `extensions/file-transfer/src/shared/lazy-node-invoke-policy.test.ts:38` -
  file-transfer policy commands.

### Gitcrawl queries

- `gitcrawl doctor --json`
  - `last_sync_at=2026-05-28T05:29:12.208862Z`,
    `thread_count=87334`, `open_thread_count=7657`,
    `cluster_count=18605`.
- `gitcrawl search openclaw/openclaw --query "node.invoke" --mode keyword --limit 20 --json`
  - 20 hits; notable #85916 open PR, #58903, #5639, #17356, #68090, #1357,
    #1607, #78351, #83976, #83980.
- `gitcrawl search openclaw/openclaw --query "node.presence.alive" --mode keyword --limit 20 --json`
  - 14 hits; notable #73373, #63123, #73330, #39796.
- `gitcrawl search openclaw/openclaw --query "node.pending" --mode keyword --limit 20 --json`
  - 20 hits; notable #41409, #58179, #55653, #6836, #38124, #84642, #17443,
    #12856, #24998, #50343.
- `gitcrawl search openclaw/openclaw --query "node.list node.describe" --mode keyword --limit 20 --json`
  - 20 hits; notable #51903, #57775, #61569, #58158, #58159, #59012.
- `gitcrawl search openclaw/openclaw --query "camera canvas screen location voice browser node" --mode keyword --limit 20 --json`
  - 1 hit; #29416, mostly noisy.
- `gitcrawl search openclaw/openclaw --query "file.fetch node host protocol" --mode keyword --limit 20 --json`
  - 20 hits; notable #74134.

### Discrawl queries

- `discrawl status --json`
  - `generated_at=2026-05-28T05:47:35Z`, `state=current`,
    `last_sync_at=2026-05-28T00:14:43Z`, `messages=1483985`.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.invoke"`
  - 10 hits; notable 2026-04-28 maintainer discussion for file fetch/list/fetch
    node commands, plus GitHub mirror reports for #58903, #55258, #42590,
    #46669, and #43287.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.presence.alive"`
  - 3 hits; PR #63123 opened/commented/reviewed.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.pending"`
  - 10 hits; PR #61719 pending-work identity review and PR #58179 pending-work
    memory leak discussion.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "node.list node.describe"`
  - 6 hits; user guidance / request thread for node UI list/describe/invoke.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "camera canvas screen location voice browser node"`
  - `null` result, treated as 0 hits.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search --limit 10 "camera.snap screen.record location.get"`
  - 1 hit; user guidance listing camera snapshot, screen recording, and location
    node capability examples.
