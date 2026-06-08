---
title: Gateway Runtime Maturity Report
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
---

# Gateway Runtime Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (81%)`
- Quality: `Alpha (69%)`
- Completeness: `Stable (80%)`
- LTS Features: `12/13`

## Summary

This report expands the scorecard surface named "Gateway runtime" from the
published [maturity scorecard](https://gist.github.com/vincentkoc/a21bc88d47f2b2b46cc7f339c7e47039)
into the significant feature families OpenClaw should evaluate under that one
row.

The first version of this report only decomposed the surface. This pass keeps
that decomposition and adds a first-pass rubric so later maturity reviews,
release checks, and scenario studies can separate well-covered Gateway features
from areas that are present in code but still thin in integration proof or
show quality risks in operation.

## Matrix

| Category                                                                    | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Approvals and Remote Execution](approval-and-execution-safety.md)          | ✅  | `Stable (88%)` | `Beta (72%)`   | `Beta (78%)`   | Exec approvals, Plugin approvals, Node exec approvals, Approved node execution, Approval mutation safety, Delivery fallback behavior                                                                                                                                                                                                                                                                                               |
| [HTTP APIs](http-apis.md)                                                   | ✅  | `Stable (88%)` | `Beta (74%)`   | `Beta (72%)`   | OpenAI-compatible APIs, Tool invocation API, Admin API access, Hook ingress                                                                                                                                                                                                                                                                                                                                                        |
| [Hosted Web Surface](hosted-web-surface.md)                                 | ✅  | `Stable (88%)` | `Beta (74%)`   | `Beta (72%)`   | Control UI, WebChat hosting, Plugin web routes, Canvas and A2UI routes                                                                                                                                                                                                                                                                                                                                                             |
| [Gateway RPC APIs and Events](core-rpc-coverage.md)                         | ✅  | `Alpha (68%)`  | `Alpha (57%)`  | `Stable (88%)` | Health APIs, Identity and presence APIs, Model APIs, Usage and memory APIs, Session APIs, Chat APIs, Channel APIs, Web login and wake APIs, Config and secrets APIs, Update and setup APIs, Agent and artifact APIs, Task and automation APIs, Tool and skill APIs, Request and event envelopes, Idempotent side effects, Method discovery, Event discovery, Accepted-then-final results, Event ordering, State refresh after gaps |
| [Device Auth and Pairing](device-identity-auth-and-pairing.md)              | ✅  | `Stable (88%)` | `Beta (72%)`   | `Stable (82%)` | Shared-secret login, Trusted proxy auth, Private ingress mode, Device challenge signing, Device tokens, Setup-code bootstrap, Auth mismatch recovery, Device auth migration, Client pairing, Node pairing                                                                                                                                                                                                                          |
| [Network Access and Discovery](network-exposure-and-transport-selection.md) | ✅  | `Alpha (68%)`  | `Alpha (62%)`  | `Beta (74%)`   | Loopback and LAN access, Tailnet access, SSH tunnels, Endpoint discovery, Saved endpoints, TLS pinning                                                                                                                                                                                                                                                                                                                             |
| [Nodes and Remote Capabilities](node-transport-and-capability-relay.md)     | ❌  | `Stable (84%)` | `Alpha (63%)`  | `Beta (76%)`   | Node presence, Node capabilities, Node inventory, Node actions, Node events, Pending work delivery, Remote device capabilities, Remote host commands                                                                                                                                                                                                                                                                               |
| [Health, Diagnostics, and Repair](observability-health-and-repair.md)       | ✅  | `Alpha (68%)`  | `Alpha (62%)`  | `Beta (78%)`   | Health snapshots, Channel readiness, Stability diagnostics, Payload diagnostics, Diagnostics exports, Doctor checks, Log tailing                                                                                                                                                                                                                                                                                                   |
| [Protocol Compatibility](protocol-typing-and-compatibility.md)              | ✅  | `Beta (72%)`   | `Beta (70%)`   | `Stable (84%)` | Published protocol schema, Runtime request validation, JSON Schema export, Swift client models, Version negotiation, Client transport defaults, Backward-compatible evolution                                                                                                                                                                                                                                                      |
| [Roles and Permissions](roles-scopes-and-operator-policy.md)                | ✅  | `Stable (85%)` | `Alpha (62%)`  | `Stable (80%)` | Role negotiation, Operator permissions, Approval-gated actions, Untrusted node declarations, Event scoping                                                                                                                                                                                                                                                                                                                         |
| [Gateway Lifecycle](runtime-lifecycle-and-supervision.md)                   | ✅  | `Stable (86%)` | `Stable (82%)` | `Stable (88%)` | Foreground startup, Service installation, Restart and stop, Service status, Bind and port settings, Config reload, Multi-gateway isolation                                                                                                                                                                                                                                                                                         |
| [Security Controls](security-and-hardening-posture.md)                      | ✅  | `Stable (84%)` | `Beta (74%)`   | `Stable (80%)` | Non-loopback auth, Trusted proxy exceptions, Gateway and node trust boundaries, Trusted CIDR auto-approval, Fail-closed protocol handling, Remote execution safeguards                                                                                                                                                                                                                                                             |
| [WebSocket Connection](websocket-handshake-and-session-establishment.md)    | ✅  | `Stable (84%)` | `Beta (76%)`   | `Stable (82%)` | WebSocket transport, Connect challenge, Connect request, Protocol version negotiation, hello-ok snapshot, Startup retry, Session limits, Plugin surface URLs                                                                                                                                                                                                                                                                       |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Approvals and Remote Execution

Search anchors: gateway runtime and websocket protocol gateway runtime websocket feature matrix: approval and execution safety, gateway runtime websocket feature matrix: approval and execution safety.

Category note: [Approvals and Remote Execution](approval-and-execution-safety.md)

Score decisions:

- Coverage: `Stable (88%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Exec approvals: Exec approval request, lookup, wait, resolve, and policy snapshot APIs.
- Plugin approvals: Plugin approval request, wait, and resolution flows.
- Node exec approvals: Node-local exec approval policy relay through Gateway RPC.
- Approved node execution: Canonical `systemRunPlan` binding for node-host execution.
- Approval mutation safety: Rejection of mutated `command`, `cwd`, `agentId`, or `sessionKey` after approval preparation.
- Delivery fallback behavior: Agent delivery fallback between strict deliverable routes and session-only execution.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/gateway/security/index.md`

Major quality/completeness gaps:

- Linux systemd and Windows Scheduled Task live proof trails macOS.
- Reload modes lack full edit-to-hot-apply or restart-Gateway proof.

### 2. HTTP APIs

Search anchors: gateway http api, openai compatible http api, tools invoke http api, admin http rpc, hook ingress.

Category note: [HTTP APIs](http-apis.md)

Score decisions:

- Coverage: `Stable (88%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- OpenAI-compatible APIs: OpenAI-compatible HTTP APIs (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/embeddings`).
- Tool invocation API: HTTP tools invoke path.
- Admin API access: Optional admin HTTP RPC plugin route.
- Hook ingress: Hook hosting and HTTP ingress routes.

Primary docs:

- `docs/gateway/index.md`
- `docs/gateway/openai-http-api.md`
- `docs/gateway/openresponses-http-api.md`
- `docs/gateway/tools-invoke-http-api.md`
- `docs/automation/hooks.md`
- `docs/web/index.md`

Major quality/completeness gaps:

- No end-to-end discovery-to-connect workflow.
- SSH tunnel, remote topology, and WSS fingerprint-pinning workflows remain
  incomplete.

### 3. Hosted Web Surface

Search anchors: hosted web surface, control ui gateway, webchat gateway, plugin http route gateway, canvas a2ui gateway.

Category note: [Hosted Web Surface](hosted-web-surface.md)

Score decisions:

- Coverage: `Stable (88%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- Control UI: Control UI hosting on the Gateway server.
- WebChat hosting: WebChat hosting.
- Plugin web routes: Canvas and other plugin HTTP surfaces served by the Gateway.
- Canvas and A2UI routes: Canvas documents, A2UI transport, and browser-hosted plugin routes under the Gateway HTTP server.

Primary docs:

- `docs/gateway/index.md`
- `docs/concepts/architecture.md`
- `docs/web/control-ui.md`
- `docs/web/webchat.md`
- `docs/refactor/canvas.md`

Major quality/completeness gaps:

- Startup-sidecar pending-to-ready retry lacks full Gateway-flow proof.
- `pluginSurfaceUrls` refresh and the complete `hello-ok` shape remain
  incomplete at the Gateway-flow level.

### 4. Gateway RPC APIs and Events

Search anchors: core rpc coverage, rpc framing, control-plane semantics, hello-ok.features.methods, hello-ok.features.events, event sequence, idempotencyKey.

Category note: [Gateway RPC APIs and Events](core-rpc-coverage.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (57%)`
- Completeness: `Stable (88%)`
- LTS: ✅

Features:

- Health APIs: `health` and `status` RPCs.
- Identity and presence APIs: `gateway.identity.get`, `system-presence`, `system-event`, and heartbeat RPCs.
- Model APIs: `models.list` RPCs.
- Usage and memory APIs: Usage summaries and memory readiness RPCs.
- Session APIs: `sessions.*` RPCs.
- Chat APIs: `chat.*` and `agent.wait` RPCs.
- Channel APIs: `channels.status` and `channels.logout` RPCs.
- Web login and wake APIs: `web.login.*`, `push.test`, and `voicewake.*` RPCs.
- Config and secrets APIs: `config.*` and `secrets.*` RPCs.
- Update and setup APIs: `update.*` and `wizard.*` RPCs.
- Agent and artifact APIs: `agents.*`, agent files, environments, and artifact RPCs.
- Task and automation APIs: `wake`, `cron.*`, and `tasks.*` RPCs.
- Tool and skill APIs: `commands.list`, `tools.*`, and `skills.*` RPCs.
- Request and event envelopes: Request, response, and event frame shapes.
- Idempotent side effects: Idempotency requirements for side-effecting methods.
- Method discovery: Method discovery via `hello-ok.features.methods`.
- Event discovery: Event discovery via `hello-ok.features.events`.
- Accepted-then-final results: Immediate accepted ack plus later final result.
- Event ordering: Sequence handling and per-client monotonic event ordering.
- State refresh after gaps: No-replay event model and explicit gap recovery via state refresh.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/gateway/index.md`
- `docs/concepts/architecture.md`

Major quality/completeness gaps:

- Broadcast scoping and unknown-event fail-closed behavior need broader
  end-to-end proof.
- Node-claim distrust needs more complete scenario coverage.

### 5. Device Auth and Pairing

Search anchors: gateway runtime and websocket protocol device identity, auth, and pairing, device identity, auth, and pairing.

Category note: [Device Auth and Pairing](device-identity-auth-and-pairing.md)

Score decisions:

- Coverage: `Stable (88%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Shared-secret login: Shared-secret auth by token or password.
- Trusted proxy auth: Trusted-proxy and identity-bearing auth modes.
- Private ingress mode: Private-ingress `gateway.auth.mode: "none"` behavior and its limits.
- Device challenge signing: Device identity signing against the challenge nonce.
- Device tokens: Device token issuance, persistence, reconnect reuse, rotation, and revocation.
- Setup-code bootstrap: Bootstrap setup-code token flows and bounded operator token handoff.
- Auth mismatch recovery: Recovery semantics for `AUTH_TOKEN_MISMATCH` and `AUTH_SCOPE_MISMATCH`.
- Device auth migration: Device-auth migration errors and required v2/v3 signature behavior.
- Client pairing: Device pairing requirements for new clients.
- Node pairing: Node pairing flows, including pending requests, approvals, expiry, and trusted-CIDR or metadata-upgrade auto-approval boundaries.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/gateway/pairing.md`
- `docs/gateway/security/index.md`

Major quality/completeness gaps:

- Remote ingress lifecycles are uneven.
- Auth migration variants and cross-platform pairing/proof UX need more
  complete coverage.

### 6. Network Access and Discovery

Search anchors: gateway runtime and websocket protocol network exposure and transport selection, network exposure and transport selection.

Category note: [Network Access and Discovery](network-exposure-and-transport-selection.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- Loopback and LAN access: Loopback and LAN-facing Gateway exposure.
- Tailnet access: Tailnet-facing Gateway exposure and MagicDNS/Tailscale routing.
- SSH tunnels: SSH tunneling as the fallback remote path.
- Endpoint discovery: Bonjour/DNS-SD discovery, wide-area DNS-SD, and advertised transport hints.
- Saved endpoints: Saved remote Gateway endpoints and route preference order.
- TLS pinning: TLS enablement and optional certificate fingerprint pinning.

Primary docs:

- `docs/gateway/index.md`
- `docs/gateway/discovery.md`
- `docs/gateway/protocol.md`

Major quality/completeness gaps:

- Gap recovery and event discovery drift are not broadly integration-proven.
- Scoped multi-client ordering and generic idempotency remain incomplete.

### 7. Nodes and Remote Capabilities

Search anchors: gateway runtime and websocket protocol node transport and capability relay, node transport and capability relay.

Category note: [Nodes and Remote Capabilities](node-transport-and-capability-relay.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Alpha (63%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Node presence: Node presence in the same WS control plane as operator clients.
- Node capabilities: Node capability declaration at connect time.
- Node inventory: `node.list`, `node.describe`, and naming/state visibility.
- Node actions: `node.invoke` and `node.invoke.result`.
- Node events: `node.event`, especially `node.presence.alive`.
- Pending work delivery: Pending work APIs for connected and disconnected nodes.
- Remote device capabilities: Relay of remote capability surfaces such as camera, canvas, screen, location, voice, and browser.
- Remote host commands: Relay of remote host-command capability surfaces.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/concepts/architecture.md`
- `docs/nodes/index.md`

Major quality/completeness gaps:

- `commands.list`, `skills.*`, `tasks.*`, `cron.*`, `web.login.*`,
  `push.test`, `tools.invoke`, artifacts, and environments need a
  comprehensive Core RPC smoke flow.

### 8. Health, Diagnostics, and Repair

Search anchors: gateway runtime and websocket protocol observability, health, and repair, observability, health, and repair.

Category note: [Health, Diagnostics, and Repair](observability-health-and-repair.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Health snapshots: `health` and `status` snapshots.
- Channel readiness: Channel readiness probing through the running Gateway.
- Stability diagnostics: Stability recorder output.
- Payload diagnostics: `payload.large` diagnostics.
- Diagnostics exports: Diagnostics export contents, privacy model, and CLI/chat triggers.
- Doctor checks: Doctor checks for UI protocol freshness, service drift, auth/pairing drift, port collisions, sandbox/runtime best practices, and source-install issues.
- Log tailing: Log tailing and operational signal visibility.

Primary docs:

- `docs/gateway/index.md`
- `docs/gateway/diagnostics.md`
- `docs/gateway/doctor.md`

Major quality/completeness gaps:

- Offline pending work and wake/drain behavior remain thin.
- Platform parity across camera, canvas, screen, location, voice, browser,
  file-transfer, and host commands remains incomplete.

### 9. Protocol Compatibility

Search anchors: gateway runtime and websocket protocol protocol typing and compatibility, protocol typing and compatibility.

Category note: [Protocol Compatibility](protocol-typing-and-compatibility.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Beta (70%)`
- Completeness: `Stable (84%)`
- LTS: ✅

Features:

- Published protocol schema: TypeBox as the protocol source of truth.
- Runtime request validation: Runtime validators for protocol payloads.
- JSON Schema export: Generated JSON Schema for protocol payloads.
- Swift client models: Swift model generation.
- Version negotiation: Current protocol constants and supported protocol range behavior.
- Client transport defaults: Client defaults for request timeouts, reconnect backoff, and tick handling.
- Backward-compatible evolution: Additive evolution discipline for new methods, events, or payload fields.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/concepts/architecture.md`
- `docs/concepts/typebox.md`
- `docs/gateway/bridge-protocol.md`

Major quality/completeness gaps:

- Plugin approvals and `systemRunPlan` binding breadth need stronger Gateway
  integration proof.
- Node exec policy relay and fallback delivery semantics remain incomplete.

### 10. Roles and Permissions

Search anchors: gateway runtime and websocket protocol gateway runtime websocket feature matrix: roles, scopes, and operator policy, gateway runtime websocket feature matrix: roles, scopes, and operator policy.

Category note: [Roles and Permissions](roles-scopes-and-operator-policy.md)

Score decisions:

- Coverage: `Stable (85%)`
- Quality: `Alpha (62%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Role negotiation: `operator` versus `node` role negotiation.
- Operator permissions: Core operator scopes such as `operator.read`, `operator.write`, `operator.admin`, `operator.approvals`, `operator.pairing`, and `operator.talk.secrets`.
- Approval-gated actions: Extra approval-time scope requirements for pairing and dangerous node commands.
- Untrusted node declarations: Node-declared `caps`, `commands`, and `permissions` as claims rather than trusted truth.
- Event scoping: Broadcast event scoping, including fail-closed behavior for unknown event families.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/gateway/security/index.md`

Major quality/completeness gaps:

- Admin HTTP RPC enabled-plugin flow remains incomplete.
- Canvas/plugin web auth paths and the WebChat static-vs-WS product boundary
  need sharper proof and definition.

### 11. Gateway Lifecycle

Search anchors: gateway runtime and websocket protocol runtime lifecycle and supervision, runtime lifecycle and supervision.

Category note: [Gateway Lifecycle](runtime-lifecycle-and-supervision.md)

Score decisions:

- Coverage: `Stable (86%)`
- Quality: `Stable (82%)`
- Completeness: `Stable (88%)`
- LTS: ✅

Features:

- Foreground startup: Local foreground startup via `openclaw gateway`.
- Service installation: Supervised lifecycle installation on macOS, Linux user/systemd, and native Windows task scheduling.
- Restart and stop: Correct `restart` and `stop` behavior for supervised installs.
- Service status: Status behavior for supervised installs.
- Bind and port settings: Bind and port precedence across CLI flags, env vars, config, and persisted supervisor metadata.
- Config reload: Config reload modes: `off`, `hot`, `restart`, and `hybrid`.
- Multi-gateway isolation: Multiple-gateway isolation on one host, including config/state/workspace separation.

Primary docs:

- `docs/gateway/index.md`
- `docs/concepts/architecture.md`

Major quality/completeness gaps:

- Live diagnostics export, `/diagnostics`, stability persistence, and doctor
  repair loops are missing or incomplete.
- Active tool-schema validation and channel health mismatch proof need stronger
  coverage.

### 12. Security Controls

Search anchors: gateway runtime and websocket protocol security and hardening posture, security and hardening posture.

Category note: [Security Controls](security-and-hardening-posture.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (80%)`
- LTS: ✅

Features:

- Non-loopback auth: Auth-required non-loopback exposure.
- Trusted proxy exceptions: Trusted-proxy and control-plane device-auth exceptions.
- Gateway and node trust boundaries: Gateway/node trust-domain definition.
- Trusted CIDR auto-approval: Trusted-CIDR limits for node auto-approval.
- Fail-closed protocol handling: Fail-fast/fail-closed behavior for protocol violations and unknown event families.
- Remote execution safeguards: Security posture around remote node execution and browser-control relay.

Primary docs:

- `docs/gateway/security/index.md`
- `docs/gateway/protocol.md`
- `docs/gateway/discovery.md`

Major quality/completeness gaps:

- Coverage is mostly schema/guard-based rather than runtime-client proof.
- Generated clients, protocol-version negotiation, and legacy bridge removal
  need more runtime integration proof.

### 13. WebSocket Connection

Search anchors: gateway runtime and websocket protocol websocket handshake and session establishment, websocket handshake and session establishment.

Category note: [WebSocket Connection](websocket-handshake-and-session-establishment.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- WebSocket transport: WebSocket transport with JSON text frames.
- Connect challenge: Mandatory pre-connect `connect.challenge`.
- Connect request: Mandatory first-frame `connect` request.
- Protocol version negotiation: Protocol range negotiation (`minProtocol`/`maxProtocol`).
- hello-ok snapshot: Required `hello-ok` payload structure: server identity, negotiated auth, feature discovery, snapshot, and policy limits.
- Startup retry: Retryable startup-sidecar `UNAVAILABLE` behavior during Gateway startup.
- Session limits: Post-handshake policy advertisement (`maxPayload`, `maxBufferedBytes`, `tickIntervalMs`).
- Plugin surface URLs: Optional `pluginSurfaceUrls` issuance and refresh.

Primary docs:

- `docs/gateway/protocol.md`
- `docs/concepts/architecture.md`

## Recommended scorecard interpretation

For maturity scoring, this surface should not be treated as "the Gateway works"
or "the WebSocket connects." It should be treated as a bundle of control-plane
contracts:

- process reliability
- transport reachability
- handshake and auth correctness
- authorization and scope enforcement
- RPC/event correctness
- node relay correctness
- operational diagnosability
- compatibility and upgrade safety

If the single scorecard row remains too broad, the cleanest future split is:

1. Gateway runtime and operations
2. Gateway protocol and client compatibility
3. Gateway auth, pairing, and security
4. Gateway node relay and approvals

## Out of scope for this surface

These are adjacent to the Gateway, but should not be scored primarily under this
surface:

- Channel-specific product quality such as Telegram, Discord, or Slack behavior.
- Provider-specific model quality or latency.
- Control UI or mobile-app UX quality as standalone app surfaces.
- Talk/voice quality as a product workflow, beyond protocol/control-plane
  correctness.
- Plugin-specific HTTP routes or plugin business logic beyond the Gateway's
  hosting and policy responsibilities.

## Source frame

- `docs/gateway/index.md` for Gateway lifecycle, runtime model, supervision,
  remote access, and operational checks.
- `docs/gateway/protocol.md` for handshake, framing, roles/scopes, method
  families, approvals, auth, pairing, TLS, and versioning.
- `docs/concepts/architecture.md` for Gateway/client/node flow boundaries and
  invariants.
- `docs/gateway/discovery.md` for transport selection, Bonjour/Tailscale/SSH
  discovery, and remote-route policy.
- `docs/gateway/pairing.md` for node pairing, token issuance, auto-approval, and
  trust boundaries.
- `docs/gateway/diagnostics.md` and `docs/gateway/doctor.md` for observability,
  diagnostics export, and repair coverage.
- `docs/gateway/security/index.md` for the Gateway/node trust model and security
  hardening boundaries.
- `.mem/main/specs/25-lts-release-placeholder/reports/openclaw-domain-entity-taxonomy.md`
  for ontology anchors and naming.
