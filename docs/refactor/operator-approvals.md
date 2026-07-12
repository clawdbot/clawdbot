---
summary: "Design for durable, deep-linkable approvals across Control UI, native apps, channels, and parent sessions"
read_when:
  - Changing exec or plugin approval lifecycle, storage, protocol, or authorization
  - Adding approval links or native approval controls to a channel
  - Projecting child-session approvals into parent or orchestrator views
title: "Multi-surface operator approvals"
---

# Multi-surface operator approvals

This design tracks [#103505](https://github.com/openclaw/openclaw/issues/103505). It replaces process-local approval authority with one Gateway-owned, SQLite-backed lifecycle. Every Gateway-owned exec or plugin/tool approval gets one stable ID, one authenticated Control UI route, atomic first-answer-wins resolution, and operator-only projections to its source and ancestor session streams.

Inline actions and deep links coexist. There is no approval-mode toggle.

## Goals

- One durable approval object for exec and plugin/tool gates.
- Stable `${controlUiBasePath}/approve/{approvalId}` route.
- Resolution from any authorized Control UI, native app, or channel surface.
- Atomic first-answer-wins behavior across concurrent surfaces.
- Idempotent identical retries; conflicting late answers cannot overwrite the winner.
- Timeout, malformed trusted verdicts, missing routes, cancellation, and restart fail closed.
- Requested and terminal events reach the source session and all relevant parent/orchestrator owners.
- Channels receive typed approval and navigation actions; transport callback data remains channel-private.
- Existing exec/plugin Gateway methods remain compatible while their implementation converges on one service.

## Non-goals

- Persisting or resuming the blocked tool execution itself across Gateway restart.
- Making an approval ID or URL a bearer credential.
- Appending approval prompts to model-visible transcripts or waking parent agents.
- Moving approval policy, product commands, or reviewer authorization into channel plugins.
- Cloning approval state per channel, device, or ancestor.
- Redesigning exec allowlists, plugin policy composition, or `allow-always` persistence except where required to make terminal outcomes unambiguous.
- Making a gatewayless embedded TUI remotely reachable in the first increment. It remains local-only and must fail closed when no reviewer exists.

## Existing system and evidence map

| Surface           | Current entry point and owner                                                                                                                                   | Current behavior and gap                                                                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent exec        | `src/agents/bash-tools.exec-approval-request.ts`, `src/agents/bash-tools.exec-host-shared.ts`                                                                   | Two-phase `exec.approval.*` registration prevents an early `/approve` race, but timeout can still become allow through `askFallback`.                                                        |
| Plugin tool gate  | `src/agents/agent-tools.before-tool-call.ts`                                                                                                                    | Requests `plugin.approval.*`; `timeoutBehavior: "allow"` can approve a timed-out gate. Embedded mode has separate process-local authority in `src/infra/embedded-plugin-approval-broker.ts`. |
| Plugin node gate  | `src/gateway/node-invoke-plugin-policy.ts`                                                                                                                      | Creates and broadcasts directly through the plugin manager, duplicating part of the server-method lifecycle.                                                                                 |
| Gateway authority | `src/gateway/server-aux-handlers.ts`, `src/gateway/exec-approval-manager.ts`, `src/gateway/server-methods/approval-shared.ts`                                   | Separate exec and plugin managers use process-local maps. Terminal entries survive for 15 seconds. First-answer-wins holds only inside one process.                                          |
| Gateway protocol  | `packages/gateway-protocol/src/schema/exec-approvals.ts`, `packages/gateway-protocol/src/schema/plugin-approvals.ts`, `src/gateway/methods/core-descriptors.ts` | Exec has pending-only `get`; plugin has no `get`; no kind-agnostic terminal lookup exists for a deep link.                                                                                   |
| Delivery          | `src/infra/exec-approval-channel-runtime.ts`, `src/infra/approval-native-runtime.ts`, `src/infra/approval-handler-runtime.ts`                                   | Supports origin routing, approver DMs, pending replay, native handlers, and in-process terminal cleanup. PR 5 adds durable terminal reconciliation.                                          |
| Portable actions  | `src/interactive/payload.ts`, `src/plugin-sdk/interactive-runtime.ts`, `src/plugin-sdk/approval-reply-runtime.ts`                                               | Approval buttons are command actions containing `/approve ...`; URL and Web App targets are untyped button fields.                                                                           |
| Telegram          | `extensions/telegram/src/approval-handler.runtime.ts`, `extensions/telegram/src/button-types.ts`                                                                | The renderer parses command text to recognize approval semantics before producing private callback data.                                                                                     |
| Control UI        | `ui/src/app/exec-approval.ts`, `ui/src/app/overlays.ts`, `ui/src/components/exec-approval.ts`                                                                   | Approval UI is a global modal. `ui/src/app-route-paths.ts` and `ui/src/app-routes.ts` use exact routes and rewrite unknown paths to Chat.                                                    |
| Session ownership | `src/agents/subagent-registry.types.ts`, `src/agents/subagent-registry-read.ts`, `src/config/sessions/types.ts`                                                 | Controller, requester, explicit parent, and legacy spawn ownership exist, but approval events are not projected to those session streams.                                                    |
| Shared state      | `src/state/openclaw-state-schema.sql`, `src/state/openclaw-state-db.ts`                                                                                         | Existing immediate transactions and Kysely conditional updates support durable compare-and-set in `state/openclaw.sqlite`.                                                                   |

Representative current tests include `src/gateway/exec-approval-manager.test.ts`, `src/gateway/server-methods/approval-shared.test.ts`, `src/agents/bash-tools.exec-gateway-approval.e2e.test.ts`, `extensions/telegram/src/approval-handler.runtime.test.ts`, and `ui/src/e2e/approval-flow.e2e.test.ts`.

The plugin SDK remains the only channel/plugin boundary. Approval runtime and presentation changes must be exported through the existing `src/plugin-sdk/approval-*.ts` and `src/plugin-sdk/interactive-runtime.ts` subpaths; plugin production code must not import Gateway internals.

## Prior art

Omnigent provides useful UX and failure semantics:

- [`approval.py`](https://github.com/omnigent-ai/omnigent/blob/46e3cd9754c3b8567f7b09f4d19b6249dabe0e80/omnigent/runtime/policies/approval.py) parks ASK, applies per-policy timeouts, and treats only an exact accept as approval.
- [`sessions.py`](https://github.com/omnigent-ai/omnigent/blob/46e3cd9754c3b8567f7b09f4d19b6249dabe0e80/omnigent/server/routes/sessions.py) contains the server-side native harness gate and ancestor request/resolution projection.
- [`ApprovePage.tsx`](https://github.com/omnigent-ai/omnigent/blob/46e3cd9754c3b8567f7b09f4d19b6249dabe0e80/web/src/pages/ApprovePage.tsx) provides the standalone mobile approval page.

Do not copy its storage claim uncritically. Current active pending state is process-local in [`_elicitation_registry.py`](https://github.com/omnigent-ai/omnigent/blob/46e3cd9754c3b8567f7b09f4d19b6249dabe0e80/omnigent/server/_elicitation_registry.py), and the unused pending table is removed by [`e3b1f2a4c9d7_drop_pending_tool_calls_table.py`](https://github.com/omnigent-ai/omnigent/blob/46e3cd9754c3b8567f7b09f4d19b6249dabe0e80/omnigent/db/migrations/versions/e3b1f2a4c9d7_drop_pending_tool_calls_table.py). OpenClaw deliberately goes further: SQLite is authoritative and every terminal transition is a database compare-and-set.

## Architecture and ownership

The Gateway owns the lifecycle:

1. An agent, plugin hook, or node policy supplies a kind-specific request and process-local execution binding.
2. The Gateway validates it and builds a sanitized reviewer projection.
3. The approval service computes a source/owner audience, inserts the canonical row, then registers the in-process waiter.
4. After durable insert, the Gateway publishes existing approval events, session projections, channel notifications, and native push.
5. Every surface resolves through the same service.
6. The service commits one terminal transition, wakes the runtime waiter, and publishes terminal projections.
7. A failed event delivery never rolls back the committed decision; clients recover through `approval.get` or list replay.

Ownership boundaries:

- `src/gateway/`: approval service, authorization, RPC adapters, URL construction, waiter lifecycle, and event publication.
- `src/state/`: shared schema and generated Kysely types.
- `src/infra/`: sanitized approval view models and portable presentation construction.
- `src/agents/`: request, wait, and apply the returned verdict; no persistence.
- `src/channels/` and `extensions/*`: render typed actions, authorize channel users, encode private callbacks, and update delivered controls.
- `src/plugin-sdk/`: public approval and presentation contracts only.
- `ui/`: standalone page and existing queue/modal clients.

The in-process waiter is a notification mechanism, not authority. Registration inserts the row and installs the waiter synchronously before publishing the request, so a resolver cannot interleave between those steps. Every later resolver commits through SQLite before settling that waiter.

## Persistent record

Add one `operator_approvals` table to the shared state database.

| Column                                             | Purpose                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval_id`                                      | Globally unique canonical ID. Keep existing exec IDs and `plugin:` IDs for protocol compatibility, but never infer kind from the prefix.      |
| `resolution_ref`                                   | Unique full SHA-256 base64url locator for transport callbacks that cannot carry the canonical ID. It is not authorization or a public URL ID. |
| `kind`                                             | Closed `exec \| plugin` discriminator.                                                                                                        |
| `status`                                           | Closed `pending \| allowed \| denied \| expired \| cancelled` state.                                                                          |
| `presentation_json`                                | Validated, kind-tagged reviewer projection. Raw runtime requests, command bindings, and callback payloads remain process-local.               |
| `source_agent_id`, `source_session_key`            | Source identity and session projection anchor. Session key is durable; rotating session UUID is not.                                          |
| `audience_session_keys_json`                       | Ordered, de-duplicated JSON array produced by the bounded breadth-first ownership walk. Requested and terminal events use this same snapshot. |
| `requested_by_device_id`, `requested_by_client_id` | Durable requester/audit metadata. Connection ID stays in memory and is not a cross-surface principal.                                         |
| `reviewer_device_ids_json`                         | Optional explicitly targeted reviewer devices supplied only by the trusted approval runtime.                                                  |
| `runtime_epoch`                                    | Process epoch that owns the parked execution; used to cancel orphaned rows after restart.                                                     |
| `created_at_ms`, `expires_at_ms`, `updated_at_ms`  | Authoritative timing.                                                                                                                         |
| `decision`                                         | Explicit user decision when one exists.                                                                                                       |
| `terminal_reason`                                  | Closed reason such as `user`, `timeout`, `malformed-verdict`, `no-route`, `run-aborted`, or `gateway-restart`.                                |
| `resolved_at_ms`, `resolver_kind`, `resolver_id`   | Winner and audit identity retained server-side. Reviewer projections omit raw resolver identifiers.                                           |
| `consumed_at_ms`, `consumed_by`                    | Separate replay guard for `allow-once`; consuming must not erase the recorded decision.                                                       |

Required indexes:

- unique `(resolution_ref)`; inserts also reject cross-column `approval_id`/`resolution_ref` ambiguity
- `(status, expires_at_ms)`
- `(source_session_key, created_at_ms DESC)`
- `(resolved_at_ms)` for retention pruning

Audience arrays are small and bounded. Session-filtered replay first selects visible pending rows through Kysely, then decodes and filters the bounded audience arrays in application code; it does not use string matching or raw SQL JSON queries.

Retain terminal rows for 30 days, aligned with metadata audit retention in `src/audit/audit-event-store.ts`. Pruning is fixed maintenance policy, not a new config surface. The database is private local control-plane state, but reviewer APIs must never expose the full stored request or runtime binding.

## State machine and compare-and-set

Only these transitions are valid:

- `pending -> allowed`: explicit `allow-once` or `allow-always`.
- `pending -> denied`: explicit deny, trusted malformed terminal verdict, or no delivery route.
- `pending -> expired`: authoritative deadline reached.
- `pending -> cancelled`: run abort, graceful shutdown, or restart orphan recovery.

Every non-allowed terminal state has effective verdict deny.

Resolution uses one immediate SQLite transaction and a Kysely conditional update equivalent to:

```sql
UPDATE operator_approvals
SET status = ?, decision = ?, terminal_reason = ?, resolved_at_ms = ?
WHERE approval_id = ?
  AND status = 'pending'
  AND expires_at_ms > ?;
```

If the update affects no row, the same transaction reads the record:

- Missing or unauthorized: return not found; do not reveal existence.
- Still pending but deadline reached: compare-and-set it to `expired`, then return that terminal row.
- Same recorded decision: return idempotent success with the recorded winner.
- Different decision: the unified API returns `applied: false` with the recorded winner; legacy adapters retain `APPROVAL_ALREADY_RESOLVED` where required by their shipped contract.
- Any terminal state: never mutate it.

`now == expires_at_ms` is expired. Gateway time is authoritative.

`allow-once` execution uses a second CAS over `consumed_at_ms IS NULL`, bound to the existing exact command/system-run context. The approval row remains an audit record after consumption.

Malformed HTTP/RPC input that cannot be authenticated or identify an approval is rejected without mutation and can never approve. A malformed terminal verdict received from a trusted harness/waiter for a known approval transitions to `denied`.

## Gateway API

Add kind-agnostic reviewer methods:

| Method                                    | Contract                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval.get { id }`                     | Returns a visible pending or retained terminal projection.                                                                                                                                                          |
| `approval.resolve { id, kind, decision }` | Accepts the canonical ID or fixed-size transport reference, then runs authorization, kind and allowed-decision validation, deadline reconciliation, and terminal CAS. The response always carries the canonical ID. |

Kind-specific request validation remains in `exec.approval.request` and `plugin.approval.request`. Existing `exec.approval.get/list/waitDecision/resolve` and `plugin.approval.list/waitDecision/resolve` become protocol-boundary adapters to the canonical service because they are shipped Gateway API. Internal callers migrate to the service in the same change.

A reviewer projection is a tagged union:

```ts
type OperatorApproval = {
  id: string;
  status: OperatorApprovalStatus;
  presentation:
    | { kind: "exec"; commandText: string /* safe exec preview */ }
    | { kind: "plugin"; title: string; description: string /* safe plugin preview */ };
  // common lifecycle fields
};
```

The stable path is derived, not persisted. `approval.get` returns `urlPath`; surfaces that know an approved public origin may also receive an absolute `url`. Reviewer snapshots omit source and audience session keys. The Gateway keeps those routing keys server-side for the separate `session.approval` projection.

## Events and portable actions

PR 1 preserves the shipped event names, payloads, and existing record-level recipient filters:

- `exec.approval.requested`
- `exec.approval.resolved`
- `plugin.approval.requested`
- `plugin.approval.resolved`

Those legacy events can contain the full runtime request, so they must not be fanned out to every approval-scoped client. PR 5 adds tagged lifecycle fields (`status`, `sourceSessionKey`, `urlPath`, terminal metadata, and a presentation-level `kind`) through the sanitized lifecycle projection instead of widening legacy event delivery.

Add an approval-scoped `session.approval` projection event. Publish the canonical event once with the persisted audience keys; exact-session subscribers receive the same event for each matching key:

- `sessionKey`: stream receiving the projection.
- `sourceSessionKey`: child/source that raised the gate.
- `phase`: `requested \| terminal`.
- one safe `OperatorApproval` projection.

Register the event under `operator.approvals` in `src/gateway/server-broadcast.ts`. Session subscription alone never grants approval visibility.

Extend `MessagePresentationAction` in `src/interactive/payload.ts`:

```ts
type MessagePresentationAction =
  | { type: "command"; command: string }
  | { type: "callback"; value: string }
  | {
      type: "approval";
      approvalId: string;
      approvalKind: "exec" | "plugin";
      decision: ExecApprovalDecision;
    }
  | { type: "url"; url: string }
  | { type: "web-app"; url: string };
```

Core builds typed decision actions and a separate Review link when an approved absolute Control UI origin is available. Channels encode an approval action into their own callback format and send resolution to the canonical service. A callback uses the exact canonical ID when it fits; otherwise it uses the row's unique full-digest `resolution_ref`. The reference is only a compact lookup key: normal Gateway authentication, record authorization, explicit kind, allowed-decision validation, deadline reconciliation, and first-answer CAS still apply. Channels must not truncate IDs, resolve hash prefixes, parse `/approve` text, or infer kind from an ID prefix.

Keep `button.url`, `button.webApp`, and command-backed approval controls as deprecated plugin SDK compatibility inputs. Normalize them at the SDK boundary; migrate every bundled internal caller in the same PR. `/approve {id} {decision}` remains a text fallback and CLI/chat command, not the button semantic contract.

## Control UI

The route is `${basePath}/approve/{approvalId}`. The ID is the only path parameter; source session identity comes from the record.

Because the current router has exact static routes and rewrites unknown paths to Chat, detect this deep link in `ui/src/app/bootstrap.ts` before normal route normalization. Reuse normal Gateway/auth setup, but render a standalone approval page outside the sidebar shell and global modal.

Page states:

- loading
- authentication required
- pending
- resolving
- approved or denied here
- resolved elsewhere
- expired
- cancelled
- forbidden/not found
- connection error with retry

The page calls Gateway RPC, not a second unauthenticated REST API. A browser refresh re-reads durable state. It never places Gateway credentials in the URL, query, or fragment.

## Authorization and privacy

The URL is a locator, not authority. Resolution requires:

1. authenticated Gateway connection;
2. `operator.approvals` or `operator.admin`;
3. record-level reviewer authorization.

Record-level rules:

- `operator.admin` may review.
- `reviewer_device_ids` is authoritative when present. Only a listed paired
  `operator.approvals` device may review; the requesting device has no implicit
  access unless it is also listed.
- Without an explicit reviewer list, the requesting paired
  `operator.approvals` device may review its own record.
- Genuinely legacy records with no requester or reviewer binding retain broad
  paired-device visibility so upgrades do not strand already-pending work.
- Device-less internal runtimes may resolve, but not read, through the scoped
  approval-runtime connection. That authority comes only from the
  server-authenticated runtime token; public `approval.resolve` fields cannot
  mint it.
- Live requester connection ownership remains valid for legacy adapters; it is
  never inferred from a matching client name.
- Audience membership changes presentation only. It never widens authorization.

`approval.get` exposes only the sanitized reviewer projection and omits internal source/audience routing keys. The PR 5 `session.approval` event carries its one destination `sessionKey` plus `sourceSessionKey` after the Gateway applies the persisted audience snapshot server-side. Existing exec/plugin events keep their historical payload and restricted recipients until consumers migrate. The executable request, command binding, and continuation remain only in the process-local waiter. The durable row contains the safe presentation plus lifecycle, routing, and audit metadata; it never stores raw environment values, credentials, auth headers, or channel callback data.

## Audience projection

Compute the audience once before insert and persist the ordered snapshot. Ownership is a graph, not always a single parent chain: a child may have both a current controller and an original requester, and those owners can lead to different roots.

Use a deterministic breadth-first walk:

1. Seed the queue with the source session key.
2. For each dequeued key, read the latest subagent registry row and enqueue both distinct ownership edges in fixed order: `controllerSessionKey`, then `requesterSessionKey`.
3. When a usable registry row exists, do not also follow session-entry lineage that may be stale after steering. Otherwise enqueue the single current fallback edge `parentSessionKey ?? spawnedBy`.
4. Normalize and de-duplicate on enqueue so the first, shortest path wins.
5. Stop at 64 unique keys; this audience-size cap also bounds traversal depth.

The registry source is `src/agents/subagent-registry-read.ts`; ownership fields are defined in `src/agents/subagent-registry.types.ts`. Session fallback fields are defined in `src/config/sessions/types.ts`.

Requested and terminal projections use the same persisted audience even if focus/controller ownership changes while the approval is pending. This guarantees that every surface that displayed the request receives terminal cleanup. Resolution always targets the source approval ID; audience sessions never receive cloned approval state.

Do not write transcript messages, inject system prompts, start owner turns, or emit `sessions.changed` solely for an approval.

## Delivered-surface convergence

Native approval handlers already retain their delivered message entries long enough to replace or retire active controls. Generic forwarded approval messages currently discard the `MessageReceipt`, so a decision on another surface can leave their old controls looking pending. PR 5 closes that gap with an `operator_approval_deliveries` child table in the shared state database.

Each row stores the approval ID, a unique delivery ID, channel/account/exact route, a bounded JSON-validated channel-private message locator, delivery timestamps, and terminalization state. It never stores callback data, decision tokens, or raw approval requests. The channel owns locator encoding and message mutation; core owns canonical status, target selection, retry policy, and fallback terminal text.

Delivery registration and terminal resolution race safely:

1. After a pending send returns its receipt, insert the delivery locator and read the parent approval status in one transaction.
2. If the parent is already terminal, schedule immediate terminalization instead of leaving the late delivery pending.
3. Every committed terminal transition separately schedules all unfinalized delivery rows; droppable broadcasts are not the trigger.
4. A channel terminalizer reports `replaced`, `retired`, or `unsupported`. Replaced suppresses a duplicate terminal message; retired sends the existing terminal follow-up; unsupported or failure falls back without rolling back the approval CAS.
5. Startup retries terminal approvals with unfinished deliveries, making cleanup resilient to Gateway restart.

This transport lifecycle is an optional delivery adapter hook, not a renderer or model-facing message action. QQ C2C/group messages currently have no edit, delete, or keyboard-clear API; that adapter remains unsupported and can only show canonical truth after a later click until the transport gains a mutation API.

## Restart, timeout, and route semantics

SQLite persistence does not imply execution resumption. Command/tool bindings remain in memory because they can contain security-sensitive runtime facts and are not a resumable job contract.

On Gateway startup:

- generate a new runtime epoch;
- atomically transition pending rows from older epochs to `cancelled` with reason `gateway-restart`;
- retain rows so their URLs explain what happened;
- never execute a later approval against a missing runtime binding.

Timers are wake-up optimizations. Deadline authority is stored `expires_at_ms`; reads, waits, and resolves all run expiry reconciliation.

Final strict behavior:

- timeout -> `expired`, deny;
- no route -> `denied`, deny;
- run abort -> `cancelled`, deny;
- malformed trusted verdict -> `denied`, deny;
- only an allowed explicit allow decision -> `allowed`.

Current shipped behavior conflicts with this contract:

- `src/agents/bash-tools.exec-host-shared.ts` may apply `askFallback`.
- `src/agents/agent-tools.before-tool-call.ts` may honor `timeoutBehavior: "allow"`.
- `docs/tools/exec-approvals.md`, `docs/cli/approvals.md`, and `docs/plugins/plugin-permission-requests.md` document those surfaces.

Do not silently change them in the storage PR. The strict-semantics PR must update code, types, docs, tests, and changelog together, with explicit owner/security review. `askFallback` may continue to describe pre-gate policy selection during migration, but it must not turn a created pending record's timeout into approval.

## Compatibility plan

- Additive Gateway protocol; no protocol version bump.
- Preserve existing exec/plugin methods and events at the external boundary.
- Keep existing IDs, including `plugin:` prefixes, but stop using prefixes as type information.
- Keep `/approve` text command behavior.
- Keep legacy button URL/Web App fields and command actions as plugin SDK compatibility input; new core output is typed.
- Migrate all bundled channels and internal callers in the same typed-action change.
- Add a changelog entry for the new URL/page and for the later timeout behavior change.
- Do not add an elicitation-mode setting.

## Rollout

### PR 1: durable lifecycle

- This design note.
- Shared SQLite schema, Kysely generation, store, and 30-day pruning.
- Gateway approval service, runtime waiter bridge, and restart orphan handling.
- Unified `approval.get/resolve`.
- Exec/plugin method adapters.
- First-answer-wins, idempotency, expiry, authorization, and consumption tests.
- No UI or channel behavior change yet.

### PR 2: typed actions and channel callbacks

- Typed approval, URL, and Web App actions.
- Core presentation builders and plugin SDK exports.
- Transport-private callback encoding with explicit owner kind.
- Durable fixed-size callback references for canonical IDs beyond transport limits.
- Bundled channel migration away from command-text and approval-ID inference.
- Canonical first-answer truth on the clicked surface and best-effort active-native terminal updates; durable reconciliation stays in PR 5.
- SDK and bundled-channel tests.

### PR 3: Control UI deep link

- Standalone authenticated approval page and base-path-aware startup routing.
- Gateway-authored URL payload and pending-state polling until lifecycle events ship.
- Mobile-width, reconnect, competing-answer, reload, and mounted-path proof.

### PR 4: native clients

- iOS, watchOS, and Android review surfaces use kind-aware `approval.get/resolve`.
- Canonical first-answer terminal truth replaces local attempted-decision state.
- Native unit, build, and platform proof.

### PR 5: propagation and fail-closed behavior

- `session.approval` request/terminal delivery from the audience snapshot persisted in PR 1.
- Durable forwarded-delivery locators and canonical terminal cleanup across every delivered surface, including restart replay.
- Migrate `node-invoke-plugin-policy.ts` and the embedded plugin broker away from duplicate authority.
- Strict timeout/malformed/no-route semantics and compatibility docs.
- Multi-surface and nested-subagent end-to-end proof.

## Tests

Required focused coverage:

- SQLite reopen preserves pending and terminal projections.
- Two concurrent resolvers produce exactly one CAS winner.
- Same-decision retry succeeds idempotently; conflicting retry returns the recorded winner.
- Resolve at or after deadline cannot approve.
- `allow-once` is consumable exactly once without erasing terminal audit state.
- Startup cancels older runtime epochs.
- Unauthorized lookup and resolution do not reveal record existence.
- Explicit reviewer allowlist and general paired `operator.approvals` behavior.
- Exec and plugin legacy methods share the same store.
- Gateway request/list/get/resolve schemas and additive event payloads.
- Typed-action normalization, fallback rendering, SDK exports, and bundled channel switches.
- Telegram callback encoding contains transport-private data and no command-string inference.
- Direct child, branched controller/requester owners, nested owners, reassignment, session-field fallback, cycle, and audience-size cap.
- Requested and terminal audience arrays are identical.
- Owner projections cause no transcript mutation or agent wake.
- Control UI route works at `/` and a configured base path; refresh shows pending or terminal truth.
- Simultaneous Control UI and Telegram answers show one winner and "resolved elsewhere" on the loser.
- User-path proof through Testbox/Crabbox, including a mobile-width approval page and Telegram action cleanup.

## Observability

Emit structured, content-free transition logs with approval ID, kind, source session key, status, reason, and latency. Never log the preview or raw binding.

Track:

- requested count by kind;
- terminal count by kind/status/reason;
- pending gauge;
- request-to-terminal latency;
- resolution race outcomes: winner, idempotent retry, conflict, expired;
- delivery route count and no-route denials;
- startup-orphan cancellations;
- audience size.

A committed transition is success even if later event delivery fails. Delivery failure is logged separately; PR 5 repairs remote state through durable delivery replay and canonical lookup.

## Open decisions

1. **Externally reachable Control UI origin.** Every snapshot carries the stable relative `urlPath`. An absolute URL may be advertised only from a cached Tailscale Serve/Funnel location after Gateway exposure succeeds; `allowedOrigins`, request Host headers, `gateway.remote.url`, and display-only loopback/LAN candidates are not canonical origins. Telegram can use its authenticated Mini App wrapper to retain the approval path through bootstrap. Arbitrary reverse proxies remain relative-only until a separately reviewed explicit public-URL contract exists. Never let a channel guess the origin.
2. **Strict timeout compatibility cutover.** The target is fail-closed, but `askFallback` and plugin `timeoutBehavior: "allow"` are shipped contracts. Recommended: make the behavior change in PR 5 with explicit owner/security approval, changelog, docs, and a migration/deprecation decision rather than hiding it in PR 1.
3. **Gatewayless embedded mode.** Recommended: keep it local-only initially, then make it a client of the canonical service when a Gateway exists. Do not advertise a deep link that no server can resolve.
