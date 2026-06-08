---
title: Gateway Runtime WebSocket Feature Matrix - Protocol Compatibility
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Protocol compatibility
feature_slug: protocol-typing-and-compatibility
---

# Protocol Compatibility

## Summary

OpenClaw has a real TypeBox-centered protocol contract: request, response,
event, connect, and hello-ok shapes are defined in TypeBox, exported as derived
TypeScript types, compiled into runtime validators, and used by Gateway
handshake/method dispatch. The Swift protocol model generation path and native
protocol-level guard show intentional native-client compatibility work, and the
legacy TCP bridge is explicitly documented as removed in favor of the Gateway
WebSocket protocol.

The maturity gap is less about whether a typed contract exists and more about
whether all generated and external-client surfaces are kept consumable and
drift-free. Local docs and scripts still disagree about generated artifact
locations, `dist/protocol.schema.json` is generated but gitignored and absent in
this checkout, `@openclaw/sdk` is private, and archive evidence shows repeated
Swift model drift, protocol-check failures, public SDK/OpenAPI requests, and
protocol/version-skew upgrade pain.

## Features

- Published protocol schema: TypeBox as the protocol source of truth.
- Runtime request validation: Runtime validators for protocol payloads.
- JSON Schema export: Generated JSON Schema for protocol payloads.
- Swift client models: Swift model generation.
- Version negotiation: Current protocol constants and supported protocol range behavior.
- Client transport defaults: Client defaults for request timeouts, reconnect backoff, and tick handling.
- Backward-compatible evolution: Additive evolution discipline for new methods, events, or payload fields.

## Archive Freshness

- `gitcrawl doctor --json`: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `api_supported=false`, `github_token_present=false`, `repository_count=2`.
- `discrawl status --json`: `generated_at=2026-05-30T00:04:12Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage

Score: 72

Label: Partial

Positive signals:

- TypeBox is the documented source of truth for the Gateway WebSocket protocol,
  runtime validation, JSON Schema export, and Swift codegen
  (`docs/concepts/typebox.md:8`, `docs/concepts/typebox.md:54`,
  `docs/concepts/typebox.md:64`).
- The architecture docs describe the Gateway as a typed WS API that validates
  inbound frames against JSON Schema (`docs/concepts/architecture.md:27`,
  `docs/concepts/architecture.md:119`).
- The protocol docs document connect range negotiation, current v4 constants,
  generated schema/model commands, and client defaults for request timeout,
  challenge timeout, reconnect backoff, and tick timeout
  (`docs/gateway/protocol.md:641`, `docs/gateway/protocol.md:652`).
- Runtime schemas cover connect params, hello-ok policy, frame shapes, and
  strict `additionalProperties: false` behavior
  (`src/gateway/protocol/schema/frames.ts:20`,
  `src/gateway/protocol/schema/frames.ts:73`,
  `src/gateway/protocol/schema/frames.ts:138`).
- The Gateway server validates the initial connect request and post-handshake
  request frames before dispatch (`src/gateway/server/ws-connection/message-handler.ts:523`,
  `src/gateway/server/ws-connection/message-handler.ts:1891`).
- Real Gateway/server-flow coverage exists for auth compatibility baselines,
  node version mismatch behavior, and SDK flows over WebSocket
  (`src/gateway/server.auth.compat-baseline.test.ts:96`,
  `src/gateway/server.node-version-mismatch.test.ts:15`,
  `packages/sdk/src/index.e2e.test.ts:566`).
- Unit/contract guards compile exported validators and check native protocol
  constants against the TypeScript source of truth
  (`src/gateway/protocol/index.test.ts:46`,
  `src/gateway/protocol/native-protocol-levels.guard.test.ts:56`).

Negative signals:

- Coverage is still dominated by schema/validator/guard tests, not end-to-end
  flows across every generated client surface and compatibility path.
- The Swift generator currently writes only
  `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift`, while
  `package.json` still checks a non-existent
  `apps/macos/Sources/OpenClawProtocol/GatewayModels.swift` path
  (`scripts/protocol-gen-swift.ts:26`, `package.json:1577`).
- Docs say generated JSON Schema is in the repo at
  `dist/protocol.schema.json`, but `.gitignore` ignores that file and the file
  is absent in the current checkout (`docs/concepts/typebox.md:290`,
  `.gitignore:196`).
- Native compatibility guard checks Swift and Android protocol-level constants,
  but not a generated Kotlin/Android payload model surface
  (`src/gateway/protocol/native-protocol-levels.guard.test.ts:82`,
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt:3`).

Integration gaps:

- No full integration proof found that regenerates JSON Schema and Swift models,
  starts a Gateway, and drives both generated/native and JavaScript clients
  through the same compatibility suite.
- No live or e2e proof found for N-1 node protocol/version skew; current server
  flow evidence includes a mismatch rejection path instead
  (`src/gateway/server.node-version-mismatch.test.ts:56`).
- No public third-party SDK or OpenAPI/Swagger generation flow is complete,
  despite archive requests for both.

## Quality

Score: 70

Label: Medium

Gitcrawl reports:

- Query:
  `gitcrawl search issues "gateway websocket client sdk" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned 8 open results. Relevant result: #49178
  `[Feature]: Reusable gateway WebSocket client SDK package`, opened
  2026-03-17, updated 2026-05-24. The thread body says CLI and Control UI
  independently implement the same protocol and requests a shared
  `@openclaw/gateway-client` with handshake, request/response, reconnect,
  event handling, and TypeScript types.
- Query:
  `gitcrawl threads openclaw/openclaw --numbers 49178 --include-closed --json`
  returned issue #49178 open with labels `P2`,
  `clawsweeper:needs-maintainer-review`,
  `clawsweeper:needs-product-decision`, and `impact:security`.
- Query:
  `gitcrawl search issues "gateway protocol version" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned 20 open results. Relevant results: #83736
  `[Bug]: Gateway should tolerate minor node version skew during subordinate node upgrades`,
  #49178 reusable WebSocket SDK, #85966 Android UI/operator WebSocket closes
  silently after node pairing, #74635 heartbeat rejected for unexpected
  property, and several unrelated semantic matches.
- Query:
  `gitcrawl threads openclaw/openclaw --numbers 83736 --include-closed --json`
  returned issue #83736 open. The body reports a 2026.5.12 Gateway rejecting a
  2026.5.7 subordinate node with protocol 3 while the gateway expected protocol
  4, marooning the node until out-of-band repair.
- Query:
  `gitcrawl threads openclaw/openclaw --numbers 85966 --include-closed --json`
  returned issue #85966 open. The body reports Android operator WebSocket
  retries closing with `code=1000 reason=bye` after node pairing, leaving the app
  in a connecting loop.
- Query:
  `gitcrawl search issues "protocol schema swift" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned 2 open results: #87473 and #46664; neither title was directly a
  Swift-model drift issue.
- Query:
  `gitcrawl threads openclaw/openclaw --numbers 41476 --include-closed --json`
  returned closed PR #41476 `build(protocol): regenerate Swift models after
pending node work schemas`, whose body says TypeBox schemas were added without
  running `pnpm protocol:gen:swift`, causing `protocol:check` to fail
  repo-wide.
- Query:
  `gitcrawl search issues "bridge protocol removed" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned `[]`.
- Query:
  `gitcrawl search issues "TypeBox gateway protocol" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned 2 open results: #56068 and #61368; neither title was directly about
  Gateway protocol typing.
- Query:
  `gitcrawl search issues "Swift GatewayModels" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
  returned one open semantic match, #87132, not directly about generated
  GatewayModels.

Discrawl reports:

- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway protocol version"`
  returned 10 messages. Relevant reports included a 2026-05-09
  `#clawtributors` beta update describing gateway restart probes repeatedly
  hitting WebSocket protocol mismatch, a 2026-05-19 Android help report with
  `Gateway error: protocol mismatch`, and a 2026-05-24 maintainer note about an
  additive schema field with `GATEWAY_PROTOCOL_VERSION` unchanged.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "TypeBox gateway protocol"`
  returned 8 messages. Relevant reports included issue #33624 being kept open
  because the project has WebSocket protocol docs and a TypeBox-to-JSON-Schema
  generator but no exposed Swagger/OpenAPI schema, plus user guidance pointing
  custom clients to the TypeBox/protocol docs.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "GatewayModels Swift protocol"`
  returned 10 messages, all materially relevant to generated Swift drift or
  `protocol:check` failures. Messages cited stale `GatewayModels.swift` fields,
  missing regeneration after schema changes, and repeated protocol-check
  failures on unrelated PRs.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "legacy bridge removed gateway websocket"`
  returned one relevant 2026-01-20 message: the `bridge` config was removed,
  docs were out of date, and nodes now use the Gateway WebSocket protocol
  directly.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway websocket client sdk"`
  returned 10 messages. Relevant reports included issue #49178 comments asking
  for a consumable Node/TypeScript WebSocket client, a third-party
  reverse-engineered client, and user examples of direct WS usage.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "protocol:check GatewayModels"`
  returned 10 messages, repeatedly citing `protocol:check` failures caused by
  stale generated Swift models.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "protocol mismatch gateway expected"`
  returned 3 messages, including the 2026-05-09 beta upgrade note where a CLI
  probe used protocol 3 while the gateway expected protocol 4.
- Query:
  `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "openapi schema gateway protocol"`
  returned one relevant GitHub archive mirror message for issue #33624.

Good qualities:

- Clear TypeBox source-of-truth structure with derived TS types
  (`src/gateway/protocol/schema/types.ts:1`).
- Runtime validators are lazy-compiled from TypeBox schemas and exposed as
  reusable validators (`src/gateway/protocol/index.ts:450`).
- Server-side handshake and request validation fail closed on malformed
  frames (`src/gateway/server/ws-connection/message-handler.ts:527`,
  `src/gateway/server/ws-connection/message-handler.ts:1892`).
- Version constants are centralized, and generated native protocol constants
  are present in the Swift model artifact (`src/gateway/protocol/version.ts:1`,
  `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift:1`).
- Client defaults for request timeout, reconnect backoff, and tick handling are
  explicit in code and docs (`src/gateway/client.ts:264`,
  `src/gateway/client.ts:1123`, `src/gateway/client.ts:1152`,
  `docs/gateway/protocol.md:657`).
- Legacy TCP bridge removal is explicit in docs, and the old
  `src/gateway/server-bridge.ts` file is absent in this checkout
  (`docs/gateway/bridge-protocol.md:10`).

Bad qualities:

- Archive evidence shows generated Swift drift has repeatedly broken
  `protocol:check` and unrelated PRs, which lowers certainty in release
  discipline around schema/codegen changes.
- The source tree has stale or contradictory codegen surface references:
  `package.json` checks a non-existent macOS generated path, while the Swift
  generator writes only the shared OpenClawKit path (`package.json:1577`,
  `scripts/protocol-gen-swift.ts:26`).
- The JSON Schema artifact is described as generated and repo-hosted, but it is
  ignored and absent locally, weakening third-party consumption of the protocol
  contract (`docs/concepts/typebox.md:292`, `.gitignore:196`).
- Protocol compatibility is intentionally strict at current v4; archive reports
  show this creates upgrade pain for subordinate nodes and restart probes.
- The reusable SDK exists only as a private `@openclaw/sdk` workspace package,
  not the public, platform-agnostic Gateway client requested by users
  (`packages/sdk/package.json:2`, `packages/sdk/package.json:4`).

## Known Gaps

- Public, reusable, platform-agnostic Gateway WebSocket client SDK remains open
  as #49178; the local SDK package is private. Discrawl `gateway websocket
client sdk` results include third-party custom client usage and a
  reverse-engineered client, indicating demand for an official documented
  consumption path.
- Exposed OpenAPI/Swagger schema remains open as #33624; generated JSON Schema
  exists as a script output but is not present as a committed/current repo
  artifact in this checkout.
- Version-skew compatibility for subordinate nodes is not complete; #83736 asks
  for N-1 tolerance or a stable maintenance RPC path.
- Codegen docs/scripts need cleanup around current generated paths and whether
  generated JSON Schema is a committed artifact, build artifact, or published
  artifact.
- Discrawl `protocol:check GatewayModels` results show maintainer/user friction
  from stale generated Swift models blocking unrelated work.

## Evidence

Docs:

- `docs/gateway/protocol.md:10` - Gateway WS protocol is the single control
  plane and node transport.
- `docs/gateway/protocol.md:641` - versioning, protocol range behavior, and
  generation commands.
- `docs/gateway/protocol.md:657` - client constants/defaults table.
- `docs/concepts/architecture.md:27` - typed WS API and JSON Schema validation.
- `docs/concepts/typebox.md:8` - TypeBox drives runtime validation, JSON Schema
  export, and Swift codegen.
- `docs/concepts/typebox.md:263` - Swift codegen behavior and unknown-frame
  forward compatibility.
- `docs/concepts/typebox.md:297` - schema-change workflow.
- `docs/gateway/bridge-protocol.md:10` - legacy TCP bridge removal.

Source:

- `src/gateway/protocol/version.ts:1` - current protocol constants.
- `src/gateway/protocol/schema/frames.ts:20` - `ConnectParamsSchema`.
- `src/gateway/protocol/schema/frames.ts:73` - `HelloOkSchema` and policy
  fields.
- `src/gateway/protocol/schema/frames.ts:138` - request/response/event frame
  schemas.
- `src/gateway/protocol/schema/protocol-schemas.ts:282` - `ProtocolSchemas`
  registry.
- `src/gateway/protocol/schema/types.ts:1` - TypeScript types derived with
  `Static`.
- `src/gateway/protocol/index.ts:450` - lazy TypeBox validator compilation.
- `src/gateway/server/ws-connection/message-handler.ts:523` - initial connect
  frame validation.
- `src/gateway/server/ws-connection/message-handler.ts:614` - protocol range
  negotiation and mismatch handling.
- `src/gateway/server/ws-connection/message-handler.ts:1822` - hello-ok policy
  advertises payload and tick limits.
- `src/gateway/client.ts:298` - request timeout default.
- `src/gateway/client.ts:591` - client stores advertised tick interval from
  hello-ok.
- `src/gateway/client.ts:1123` - reconnect backoff behavior.
- `src/gateway/client.ts:1152` - tick watchdog.
- `scripts/protocol-gen.ts:9` - JSON Schema generation.
- `scripts/protocol-gen-swift.ts:26` - Swift generated output path.
- `apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift:1` -
  generated Swift file.
- `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewayProtocol.kt:3`
  - Android protocol constants.
- `.gitignore:196` - generated JSON Schema is ignored.
- `package.json:1577` - `protocol:check` command and stale macOS generated path.

Integration tests:

- `src/gateway/server.auth.compat-baseline.test.ts:96` - real server auth
  compatibility baseline suite.
- `src/gateway/server.node-version-mismatch.test.ts:15` - server test for local
  node version mismatch guard.
- `packages/sdk/src/index.e2e.test.ts:363` - SDK WebSocket e2e with fake Gateway.
- `packages/sdk/src/index.e2e.test.ts:566` - SDK real Gateway e2e path.

Unit tests:

- `src/gateway/protocol/index.test.ts:46` - exported lazy validators validate and
  retain readable errors.
- `src/gateway/protocol/index.test.ts:73` - all exported protocol validators
  compile.
- `src/gateway/protocol/native-protocol-levels.guard.test.ts:56` - native
  protocol level guard.
- `src/gateway/protocol/channels.schema.test.ts:5` - channel schema compile and
  validation tests.
- `src/gateway/protocol/schema/agent.test.ts:37` - strict TypeBox payload
  validation for agent params.
- `src/gateway/protocol/exec-approvals-validators.test.ts:8` - exec approval
  protocol validators.
- `src/gateway/client.test.ts:930` - JS client advertises the default protocol
  compatibility range.
- `src/gateway/client.test.ts:1524` - JS client stops reconnect loops on
  non-recoverable auth/protocol-style connect failures.

Gitcrawl queries:

- `gitcrawl doctor --json`
- `gitcrawl search issues "gateway websocket client sdk" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
- `gitcrawl threads openclaw/openclaw --numbers 49178 --include-closed --json`
- `gitcrawl search issues "gateway protocol version" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
- `gitcrawl threads openclaw/openclaw --numbers 83736 --include-closed --json`
- `gitcrawl threads openclaw/openclaw --numbers 85966 --include-closed --json`
- `gitcrawl search issues "protocol schema swift" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
- `gitcrawl threads openclaw/openclaw --numbers 41476 --include-closed --json`
- `gitcrawl search issues "bridge protocol removed" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
- `gitcrawl search issues "TypeBox gateway protocol" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`
- `gitcrawl search issues "Swift GatewayModels" -R openclaw/openclaw --state open --json number,title,url,state,createdAt,updatedAt`

Discrawl queries:

- `discrawl status --json`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway protocol version"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "TypeBox gateway protocol"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "GatewayModels Swift protocol"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "legacy bridge removed gateway websocket"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "gateway websocket client sdk"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "protocol:check GatewayModels"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "protocol mismatch gateway expected"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "openapi schema gateway protocol"`
