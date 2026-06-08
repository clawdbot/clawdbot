---
title: Gateway Runtime WebSocket Feature Matrix - WebSocket Connection
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: WebSocket connection setup
feature_slug: websocket-handshake-and-session-establishment
---

# WebSocket Connection

## Summary

OpenClaw has a well-defined Gateway WebSocket handshake: the server sends
`connect.challenge`, clients must send a first-frame `connect` request,
protocol ranges are negotiated, `hello-ok` carries required discovery,
snapshot, auth, and policy fields, and retryable startup-sidecar failures are
represented as `UNAVAILABLE`. The core connect path has real Gateway/server WS
proof, so coverage is `Yes`.

The main gaps are not the base handshake contract. Coverage gaps remain around
startup-sidecar retry and `pluginSurfaceUrls` refresh in full Gateway/node
flows. Quality gaps are operational and expectation gaps: handshake phase
observability, open device-pairing reports on less common platforms, and the
lack of a public reusable Gateway WS client SDK.

## Features

- WebSocket transport: WebSocket transport with JSON text frames.
- Connect challenge: Mandatory pre-connect `connect.challenge`.
- Connect request: Mandatory first-frame `connect` request.
- Protocol version negotiation: Protocol range negotiation (`minProtocol`/`maxProtocol`).
- hello-ok snapshot: Required `hello-ok` payload structure: server identity, negotiated auth, feature discovery, snapshot, and policy limits.
- Startup retry: Retryable startup-sidecar `UNAVAILABLE` behavior during Gateway startup.
- Session limits: Post-handshake policy advertisement (`maxPayload`, `maxBufferedBytes`, `tickIntervalMs`).
- Plugin surface URLs: Optional `pluginSurfaceUrls` issuance and refresh.

## Archive freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 84

Label: Yes

Positive signals:

- Docs define the WS transport, JSON text frames, mandatory first-frame
  `connect`, 64 KiB pre-connect cap, and post-handshake policy limits in
  `docs/gateway/protocol.md:15`.
- Docs define `connect.challenge`, `connect` params, `hello-ok`, startup
  `UNAVAILABLE`, and optional `pluginSurfaceUrls` in
  `docs/gateway/protocol.md:27`.
- The architecture docs describe control-plane and node clients using the same
  WS server and document the mandatory handshake invariant in
  `docs/concepts/architecture.md:10` and `docs/concepts/architecture.md:76`.
- The protocol schema requires `ConnectParamsSchema` fields, `HelloOkSchema`
  server/features/snapshot/auth/policy fields, optional `pluginSurfaceUrls`, and
  policy limits in `src/gateway/protocol/schema/frames.ts:20` and
  `src/gateway/protocol/schema/frames.ts:73`.
- The server sends the `connect.challenge` nonce immediately after socket open
  in `src/gateway/server/ws-connection.ts:313`.
- The server rejects non-`connect` first frames or invalid connect params in
  `src/gateway/server/ws-connection/message-handler.ts:523`.
- The server returns retryable startup-sidecar `UNAVAILABLE` and closes with the
  startup close code in `src/gateway/server/ws-connection/message-handler.ts:598`.
- The server negotiates protocol ranges and rejects mismatches in
  `src/gateway/server/ws-connection/message-handler.ts:614`.
- The server validates device nonce binding against the challenge nonce in
  `src/gateway/server/ws-connection/message-handler.ts:913`.
- The server builds `pluginSurfaceUrls`, registers the client, raises post-auth
  socket max payload, and sends `hello-ok` with methods/events/snapshot/auth and
  policy in `src/gateway/server/ws-connection/message-handler.ts:1598`,
  `src/gateway/server/ws-connection/message-handler.ts:1651`, and
  `src/gateway/server/ws-connection/message-handler.ts:1790`.
- The client waits for `connect.challenge`, includes nonce-bound device auth in
  `connect`, stores device tokens, adopts `hello-ok.policy.tickIntervalMs`, and
  retries startup-sidecar `UNAVAILABLE` using the advertised retry delay in
  `src/gateway/client.ts:552`, `src/gateway/client.ts:664`,
  `src/gateway/client.ts:997`, and `src/gateway/client.ts:600`.
- Real Gateway/server flow evidence exists: `src/gateway/gateway.test.ts:156`
  starts a Gateway, connects a Gateway client, and sends an agent request over
  WS; `src/gateway/test-helpers.e2e.ts:242` shows that helper starts
  `startGatewayServer` and connects a `GatewayClient` over
  `ws://127.0.0.1:<port>`.
- Real WS helper evidence exists for challenge/nonce flow in
  `src/gateway/test-helpers.e2e.ts:125` and
  `src/gateway/test-helpers.server.ts:956`.
- Server WS tests cover `connect.challenge`, `hello-ok`, protocol mismatch,
  probe compatibility, non-connect first request, nonce-required, nonce-mismatch,
  and invalid connect params in `src/gateway/server.auth.default-token.suite.ts:124`,
  `src/gateway/server.auth.default-token.suite.ts:404`,
  `src/gateway/server.auth.default-token.suite.ts:418`,
  `src/gateway/server.auth.default-token.suite.ts:439`,
  `src/gateway/server.auth.default-token.suite.ts:470`,
  `src/gateway/server.auth.default-token.suite.ts:481`, and
  `src/gateway/server.auth.default-token.suite.ts:524`.
- Preauth payload-limit enforcement is tested with diagnostics in
  `src/gateway/server.preauth-hardening.test.ts:195`.
- Startup-sidecar `UNAVAILABLE` is covered at handler/client-test level in
  `src/gateway/server/ws-connection.startup.test.ts:31` and
  `src/gateway/client.test.ts:600`.

Negative signals:

- Startup-sidecar retry behavior has good source and handler/client tests, but I
  did not find a full Gateway startup integration that holds real sidecars
  pending and proves a live client retries through to `hello-ok`.
- `pluginSurfaceUrls` issuance is threaded through the WS connection path, but
  the refresh path is mainly unit/handler tested in
  `src/gateway/server-methods/nodes.invoke-wake.test.ts:432` and
  `src/gateway/plugin-node-capability.test.ts:141`, not a full node
  handshake-plus-refresh integration.
- `hello-ok` required payload shape is schema-backed and partially asserted in
  integration tests, but there is no single high-level contract test asserting
  the entire documented `hello-ok` object.

Integration gaps:

- Add a full startup-sidecar pending integration that starts a real Gateway in
  the pending state, observes retryable `UNAVAILABLE`, then completes startup and
  confirms the client reaches `hello-ok`.
- Add a full node WS integration that proves `pluginSurfaceUrls` are issued on
  `hello-ok`, expire/refresh through `node.pluginSurface.refresh`, and remain
  scoped to the node session.
- Add a complete `hello-ok` contract assertion in a real server flow so schema,
  docs, and runtime payload drift is caught before client regressions.

## Quality

Score: 76

Label: Medium

Gitcrawl reports:

- `gitcrawl search issues "gateway websocket handshake timeout" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 capped rows, all closed. Relevant reports include #73631
  "WebSocket handshake-timeout on reconnect causes Control UI to stay
  disconnected for minutes", #56254 "CLI handshake timeout when plugins take
  > 3s to load", #54616 "Feature request: configurable WebSocket handshake
  > timeout", #61554 "WebSocket handshake timeout when executing `openclaw cron
list`", #52453 "Gateway WebSocket rejects all inbound client connections with
  > handshake timeout", #48297 "Gateway sends connect.challenge but CLI never
  > replies with signed nonce", and #64911 "Gateway logs ready before websocket
  > control plane is usable".
- `gitcrawl search issues "connect.challenge" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 capped rows. Most were closed handshake/nonce regressions, including
  #50504, #9222, #9225, #49726, #22553, #46560, #52837, #49118, #46218,
  #48297, #49291, #15922, #68944, #50603, and #46885.
- `gitcrawl search issues "hello-ok" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 capped rows. Relevant rows include #6411 requesting agent identity
  in `hello-ok`, #46560 for missing device identity/challenge signing in A2A WS
  dispatch, #64911 for ready-before-usable startup behavior, and #41652 for
  device-id mismatch errors.
- `gitcrawl search issues "startup-sidecars" -R openclaw/openclaw --state all --json number,title,state,url`
  returned 20 capped rows. Open rows include #85366, #78954, and #84771; closed
  rows include #75051, #73276, #74325, #73555, #73645, #73411, #73353, and
  #82398. These indicate that startup-sidecar timing remains a live pressure
  point for session establishment.
- `gitcrawl search issues "websocket handshake timeout" -R openclaw/openclaw --state open --json number,title,state,url`
  returned 9 rows: #79603 handshake phase logging, #79601 client identity labels,
  #61095 env leakage causing CLI failures, #73602 channel flapping on WSL2,
  #80344 heartbeat timeout/event-loop starvation, #53399 browser control server
  hang, #83366 event-loop starvation, #49599 custom HTTP headers on CLI WS
  connections, and #76562 RPC latency/unstable polling.
- `gitcrawl search issues "connect.challenge" -R openclaw/openclaw --state open --json number,title,state,url`
  returned 7 rows: #47342 reverse-proxy challenge auth, #53599 browser relay
  regression, #86778 Trim OS/TerraMaster device-proof close 1002, #49178
  reusable Gateway WS client SDK, #47826 REST endpoints, #87058 Android node
  connect-nonce retry race, and #65355 remote probe timeout cap.
- `gitcrawl threads openclaw/openclaw --numbers 86778 --json` shows an open
  user report where TCP/WS connects and challenge receipt work, but the signed
  device proof response closes with WS code 1002 on Trim OS/TerraMaster NAS.
- `gitcrawl threads openclaw/openclaw --numbers 78954 --json` shows an open
  request for an explicit `core-ready` startup boundary before channel/plugin
  sidecars can block Gateway/TUI attach.
- `gitcrawl threads openclaw/openclaw --numbers 79603 --json` shows an open
  request for per-phase gateway/ws handshake logging because current failures do
  not show whether TCP accept, WS upgrade, auth validation, session attach, or
  subscription registration stalled.
- `gitcrawl threads openclaw/openclaw --numbers 49178 --json` shows an open
  feature request for a reusable `@openclaw/gateway-client` package covering
  challenge-response handshake, auth, reconnect, request/response, and events.
- `gitcrawl search issues "pluginSurfaceUrls node.pluginSurface.refresh" -R openclaw/openclaw --state all --json number,title,state,url`
  returned `[]`.
- `gitcrawl search issues "node.pluginSurface.refresh" -R openclaw/openclaw --state all --json number,title,state,url`
  returned `[]`.

Discrawl reports:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "connect.challenge"`
  returned 10 rows. The most relevant maintainer note on
  `2026-05-01T08:33:14Z` in `maintainers` listed challenge/nonce timing,
  delayed `connect.challenge`, stale nonce, duplicate challenge,
  response-before-challenge, gateway token rotation while sockets are live, TLS
  fingerprint rotation, and startup auth races as hardening scenarios. Other
  rows were GitHub mirror comments closing fixed 2026.3.13-era handshake
  reports.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "hello-ok"` returned
  10 rows. Relevant rows mentioned `hello-ok.server.version`,
  `hello-ok.auth`, Windows-node retry behavior resetting only after
  `hello-ok`, and schema follow-up PRs to require `hello-ok` auth.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "websocket handshake timeout"`
  returned 10 rows. It included a user VPS support question that suspected WS
  handshake but showed successful `gateway/ws` responses, plus multiple GitHub
  mirror comments closing fixed handshake-timeout reports.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "startup-sidecars"`
  returned 10 rows. Relevant rows mentioned current startup-sidecar fixes,
  commits, PR #69164 for retrying TUI `chat.history` during startup, and a
  sidecar startup ordering contract.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "preauth handshake timeout"`
  returned 10 rows, all GitHub mirror comments for fixed 3s preauth timeout
  reports and timeout configurability requests.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Gateway websocket handlers unavailable"`
  returned 3 rows, including review discussion about not blocking WS attach on
  sidecar startup and ensuring the no-listener 503 path does not consume the
  preauth budget.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "pluginSurfaceUrls"`
  returned no rows.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "node.pluginSurface.refresh"`
  returned no rows.

Good qualities:

- The handshake contract is explicit in docs, schema, server implementation,
  and client behavior.
- The server records close causes and handshake state around failures in
  `src/gateway/server/ws-connection.ts:370`.
- Timeout configuration is centralized through
  `src/gateway/handshake-timeouts.ts:1`, and client/server timeout resolution
  share the same model.
- Payload limits are enforced both before and after auth, with diagnostic
  events for oversized frames and slow outbound buffers.
- Current archive results show many old handshake timeout and missing nonce
  reports closed as implemented, with shipped mitigations such as longer
  preauth/connect-challenge timeouts and client-side challenge handling.

Bad qualities:

- The archive still has open reports adjacent to session establishment:
  #86778 for a device-proof close 1002, #79603 for missing handshake phase
  logging, #49178 for no reusable WS client SDK, and #78954/#85366/#84771 for
  startup-sidecar/event-loop pressure.
- Some failure classes are observable only as final close/error outcomes; open
  #79603 indicates operators still cannot reliably localize the stalled phase.
- The implementation spans several files and has separate Node/browser/native
  clients, so drift pressure remains until a shared client contract exists.

## Known gaps

Coverage gaps:

- Full Gateway startup-sidecar pending-to-ready retry proof.
- Full node `pluginSurfaceUrls` issuance plus refresh proof.
- Single complete `hello-ok` shape proof that guards server, schema, docs, and
  client expectations together.

Operational and expectation gaps:

- Public reusable Gateway WebSocket client SDK for third-party, browser, mobile,
  and CLI consumers.
- Stronger handshake phase logs/traces that identify the last completed phase on
  failure.
- A documented operator-facing pairing/proof command or proof payload guide for
  cases like the open Trim OS/TerraMaster report.

User-maintainer requests:

- #49178 requests a reusable Gateway WebSocket client SDK with handshake, auth,
  reconnect, request/response, and event handling.
- #79603 requests handshake phase logging for gateway/ws failures.
- #79601 requests client identity labels on Gateway WebSocket connections.
- #49599 requests custom HTTP headers on CLI WebSocket connections.
- #78954 requests explicit core-ready startup before channel/plugin sidecars.
- #86778 requests documented or CLI-supported Gateway pairing proof behavior for
  a NAS/Trim OS deployment where challenge receipt works but device proof closes
  with code 1002.
- #54616 requested configurable WebSocket handshake timeout; archive results show
  it is closed as implemented.

## Evidence

Docs:

- `docs/gateway/protocol.md:15` - WS text frames, first-frame `connect`, preauth
  cap, post-handshake policy limits, and diagnostics.
- `docs/gateway/protocol.md:27` - `connect.challenge`, `connect`, `hello-ok`,
  startup-sidecar `UNAVAILABLE`, required payload fields, and
  `pluginSurfaceUrls`.
- `docs/gateway/protocol.md:641` - protocol version negotiation and client
  constants.
- `docs/gateway/protocol.md:775` - all connections sign the
  `connect.challenge` nonce.
- `docs/concepts/architecture.md:10` - control-plane and node clients connect
  over WebSocket.
- `docs/concepts/architecture.md:76` - wire protocol summary and mandatory
  `connect` first frame.
- `docs/concepts/architecture.md:143` - handshake mandatory invariant.
- Command run before reading docs: `pnpm docs:list`.

Source:

- `src/gateway/protocol/schema/frames.ts:20` - connect params schema.
- `src/gateway/protocol/schema/frames.ts:73` - `hello-ok` schema.
- `src/gateway/server-constants.ts:1` - post-auth, buffered, and preauth
  payload limits.
- `src/gateway/handshake-timeouts.ts:1` - default preauth/connect-challenge
  timeout model and env/config resolution.
- `src/gateway/server-runtime-state.ts:223` - WS server created before HTTP
  listen with preauth payload cap.
- `src/gateway/server-http.ts:924` - WS upgrade rejects missing handlers and
  enforces preauth budget.
- `src/gateway/server/ws-connection.ts:313` - server sends `connect.challenge`.
- `src/gateway/server/ws-connection.ts:433` - preauth handshake timeout.
- `src/gateway/server/ws-connection/message-handler.ts:481` - preauth payload
  byte cap and diagnostics.
- `src/gateway/server/ws-connection/message-handler.ts:523` - first-frame
  `connect` enforcement.
- `src/gateway/server/ws-connection/message-handler.ts:598` - startup-sidecar
  retryable `UNAVAILABLE`.
- `src/gateway/server/ws-connection/message-handler.ts:614` - protocol
  negotiation.
- `src/gateway/server/ws-connection/message-handler.ts:913` - device nonce
  validation against challenge.
- `src/gateway/server/ws-connection/message-handler.ts:1598` - plugin surface
  URL minting during connect.
- `src/gateway/server/ws-connection/message-handler.ts:1790` - `hello-ok`
  payload assembly and send.
- `src/gateway/client.ts:552` - client sends connect only after challenge nonce.
- `src/gateway/client.ts:600` - client startup-sidecar retry handling.
- `src/gateway/client.ts:664` - client connect params assembly.
- `src/gateway/client.ts:997` - client challenge event handling.

Integration tests:

- `src/gateway/gateway.test.ts:156` - real Gateway e2e connects a WS client and
  issues an agent request.
- `src/gateway/test-helpers.e2e.ts:31` - e2e GatewayClient connect helper.
- `src/gateway/test-helpers.e2e.ts:125` - e2e signed device-auth connect request
  waits for `connect.challenge` and sends nonce-bound device proof.
- `src/gateway/test-helpers.e2e.ts:242` - e2e helper starts a Gateway server and
  connects over `ws://127.0.0.1:<port>`.
- `src/gateway/server.auth.default-token.suite.ts:124` - server WS connect
  returns `hello-ok`.
- `src/gateway/server.auth.default-token.suite.ts:404` - server sends
  `connect.challenge` on open.
- `src/gateway/server.auth.default-token.suite.ts:418` - protocol mismatch
  rejection.
- `src/gateway/server.auth.default-token.suite.ts:470` - non-connect first
  request rejection.
- `src/gateway/server.auth.default-token.suite.ts:481` - required nonce for
  device auth.
- `src/gateway/server.auth.default-token.suite.ts:524` - invalid connect params
  response and close reason.
- `src/gateway/server.preauth-hardening.test.ts:195` - oversized pre-auth frame
  rejected before application auth response with `payload.large` diagnostics.

Unit tests:

- `src/gateway/client.test.ts:600` - client treats startup-sidecar
  `UNAVAILABLE` as retryable and closes with 1013 without surfacing a terminal
  connect error.
- `src/gateway/server/ws-connection.startup.test.ts:31` - handler returns
  retryable startup `UNAVAILABLE` and logs expected close cause.
- `src/gateway/gateway-misc.test.ts:104` - client WS max payload is 25 MB.
- `src/gateway/gateway-misc.test.ts:640` - outbound buffered-byte limit emits
  `payload.large`.
- `src/gateway/server/ws-connection.test.ts:171` - plugin surface URL context is
  threaded into the handshake handler.
- `src/gateway/server-methods/nodes.invoke-wake.test.ts:432` - generic plugin
  surface capability URL refresh handler.
- `src/gateway/plugin-node-capability.test.ts:141` - client plugin surface URL
  and stored capability refresh.

Gitcrawl queries:

- `gitcrawl doctor --json` - current; see Archive freshness.
- `gitcrawl search issues "gateway websocket handshake timeout" -R openclaw/openclaw --state all --json number,title,state,url`
  - 20 capped rows, all closed; key rows #73631, #56254, #54616, #61554,
    #52453, #48297, #64911.
- `gitcrawl search issues "connect.challenge" -R openclaw/openclaw --state all --json number,title,state,url`
  - 20 capped rows; mostly closed challenge/nonce regressions.
- `gitcrawl search issues "hello-ok" -R openclaw/openclaw --state all --json number,title,state,url`
  - 20 capped rows; relevant rows #6411, #46560, #64911, #41652.
- `gitcrawl search issues "startup-sidecars" -R openclaw/openclaw --state all --json number,title,state,url`
  - 20 capped rows; open rows #85366, #78954, #84771.
- `gitcrawl search issues "websocket handshake timeout" -R openclaw/openclaw --state open --json number,title,state,url`
  - 9 rows; relevant open rows #79603, #79601, #49599.
- `gitcrawl search issues "connect.challenge" -R openclaw/openclaw --state open --json number,title,state,url`
  - 7 rows; relevant open rows #86778, #49178, #87058.
- `gitcrawl search issues "startup-sidecars" -R openclaw/openclaw --state open --json number,title,state,url`
  - 13 rows; relevant open rows #85366, #78954, #84771.
- `gitcrawl search issues "configurable WebSocket handshake timeout" -R openclaw/openclaw --state all --json number,title,state,url`
  - 19 rows; #54616 closed as implemented.
- `gitcrawl search issues "pluginSurfaceUrls node.pluginSurface.refresh" -R openclaw/openclaw --state all --json number,title,state,url`
  - 0 rows.
- `gitcrawl search issues "node.pluginSurface.refresh" -R openclaw/openclaw --state all --json number,title,state,url`
  - 0 rows.
- `gitcrawl threads openclaw/openclaw --numbers 86778 --json` - open Trim OS
  device-proof close 1002 report.
- `gitcrawl threads openclaw/openclaw --numbers 78954 --json` - open
  core-ready-before-sidecars request.
- `gitcrawl threads openclaw/openclaw --numbers 79603 --json` - open handshake
  phase logging request.
- `gitcrawl threads openclaw/openclaw --numbers 49178 --json` - open reusable WS
  client SDK request.

Discrawl queries:

- `discrawl status --json` - current; see Archive freshness.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "connect.challenge"`
  - 10 rows; relevant maintainer hardening-scenario note plus fixed issue
    mirrors.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "hello-ok"`
  - 10 rows; relevant `hello-ok.server.version`, `hello-ok.auth`, and
    Windows-node auth retry discussions.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "websocket handshake timeout"`
  - 10 rows; user support question plus fixed issue mirrors.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "startup-sidecars"`
  - 10 rows; startup retry and sidecar ordering discussions.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "preauth handshake timeout"`
  - 10 rows; fixed 3s preauth timeout and configurability mirrors.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "Gateway websocket handlers unavailable"`
  - 3 rows; review discussion about no-listener WS upgrade behavior and preauth
    budget.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "pluginSurfaceUrls"`
  - 0 rows.
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "node.pluginSurface.refresh"`
  - 0 rows.
