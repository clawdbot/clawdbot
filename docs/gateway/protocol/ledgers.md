---
summary: "Audit ledger and task ledger RPCs, their scopes, cursors, and payloads"
read_when:
  - Reading the audit ledger over the Gateway protocol
  - Listing or watching task ledger entries from a client
title: "Gateway protocol ledger RPCs"
sidebarTitle: "Ledger RPCs"
doc-schema-version: 1
---

The two append-only ledgers a client can read over the protocol: the audit ledger and the task ledger.

## Audit ledger RPC

`audit.activity.list` gives operator clients a stable newest-first view of agent
run, tool action, inbound-message, and terminal outbound-message metadata. It requires
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

The activity ledger returns `message.inbound.processed` and
`message.outbound.finished` records and adds
direction, channel, conversation kind,
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
replay-safe queue and platform-start records to a lazy owner-native companion
and one terminal activity row per original logical reply payload that reaches
shared durable delivery; run inspection merges those sources. Chunking and
adapter fan-out are aggregated in terminal `resultCount`. Ambiguous sends reach
a terminal only after acknowledgement, dead
letter, or reconciliation. Plugin-local and direct-send paths that bypass those
shared boundaries are not yet covered. The bounded process-owned async queue is
best-effort and may drop records on saturation, terminal persistence failure,
or shutdown timeout, so this surface is not a lossless compliance archive.

Recording is on by default and controlled by
[`logging.audit.enabled`](/gateway/config-observability#audit). Message
recording is separately controlled by `logging.audit.messages` and defaults to
`"off"`. When
recording is disabled, `audit.activity.list` keeps serving records written
earlier until they expire.

`audit.run.inspect` also requires `operator.read`. Its closed request selects
exactly one `executionId` for exact inspection or one `runId` for bounded
execution discovery. One run match resolves directly; multiple matches return
an explicit `ambiguous` result with at most 50 candidates and require exact
execution selection. Decision pages contain at most 100 receipts. Execution
identity collection is separately off by default and requires
`logging.audit.executionIdentity: true` plus an enabled audit ledger after
Gateway restart. Missing best-effort evidence never proves that a run did not
occur.

For a selected run, decision receipts merge terminal outbound activity with
owner-native `queued` and `platform_started` progress. Progress is
attribution-only, lives in the lazy companion store, and is not part of the
`audit.activity.list` result schema.

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
    `500`, optional string `cursor`, and optional `sortBy` (`"updatedAt"` or
    `"endedAt"`). Ordering is descending; omitted `sortBy` uses last activity.
    Use `"endedAt"` with terminal status filters when page membership must
    reflect completion order. Legacy terminal rows without a stored `endedAt`
    use their recorded terminal activity time, then creation time, as the
    canonical completion timestamp before pagination.
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
