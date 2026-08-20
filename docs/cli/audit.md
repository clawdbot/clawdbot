---
summary: "CLI reference for activity records, execution identity, and decision receipts"
read_when:
  - You need to answer who ran an agent or tool, when it ran, and how it ended
  - You need content-free inbound or outbound message lifecycle metadata
  - You need a bounded, redaction-safe activity export
title: "Audit records"
---

# `openclaw audit`

Query the Gateway's metadata-only activity ledger, discover executions that
share a run correlation, or inspect immutable identity context for one exact
agent execution.

Run and tool activity records are on by default. Execution identity is
separately off by default on fresh installs and upgrades. Enable it explicitly:

```bash
openclaw config set logging.audit.executionIdentity true
openclaw gateway restart
```

Identity collection requires `logging.audit.enabled` to remain enabled.
Message records are also separately disabled by default; set
`logging.audit.messages` to `direct` or `all` and restart the Gateway to
record them. Existing records stay queryable until they expire (30 days).

Direct local commands use the same bounded writer lifecycle as the Gateway.
`openclaw agent exec` deletes its temporary state directory by default, so its
audit evidence is intentionally discarded with the rest of that isolated run.
Use `agent exec --state-dir <dir>` when the run state must remain available,
and inspect it through a Gateway using that same state directory.

The ledger is separate from conversation transcripts: it records identity,
ordering, provenance, action, status, and normalized outcome codes, but never
stores content, and message identifiers appear only as installation-local
keyed pseudonyms. [Audit history](/gateway/audit) owns the full data model,
privacy semantics, storage/retention bounds, and coverage limits; this page
covers the command surface.

```bash
openclaw audit
openclaw audit --agent main --status failed
openclaw audit --session "agent:main:main" --after 2026-07-01T00:00:00Z
openclaw audit --run 8c69f72e-8b11-4c54-98d5-1a3dd67450c3
openclaw audit --run 8c69f72e-8b11-4c54-98d5-1a3dd67450c3 --explain
openclaw audit --execution 5da4c4c3-e1c9-4c95-a17d-6e5c10fd45cf --explain
openclaw audit --execution 5da4c4c3-e1c9-4c95-a17d-6e5c10fd45cf --explain --json
openclaw audit --run 8c69f72e-8b11-4c54-98d5-1a3dd67450c3 --explain --json
openclaw audit --kind tool_action --limit 50 --json
openclaw audit --kind message --direction outbound --channel telegram --json
```

## Filters

- `--agent <id>`: exact agent id
- `--session <key>`: exact session key
- `--run <id>`: exact run id; filters activity unless `--explain` is also set
- `--execution <id>`: exact execution id; requires `--explain`
- `--kind <kind>`: `agent_run`, `tool_action`, or `message`
- `--status <status>`: `started`, `succeeded`, `failed`, `cancelled`,
  `timed_out`, `blocked`, or `unknown`
- `--direction <direction>`: message direction, `inbound` or `outbound`
- `--channel <channel>`: exact message channel
- `--after <timestamp>` / `--before <timestamp>`: inclusive ISO timestamp or
  Unix milliseconds
- `--limit <count>`: activity page size from 1 to 500 (default `100`), decision
  page size from 1 to 100, or ambiguous execution-candidate page size from 1
  to 50 with `--explain` (default `50`)
- `--cursor <sequence>`: continue an activity, decision, or ambiguous
  execution-candidate page
- `--explain`: inspect immutable execution identity and run-admission reasoning;
  requires exactly one of `--run` or `--execution` and accepts only `--limit`,
  `--cursor`, and `--json`
- `--json`: print the bounded page as JSON

The CLI queries the versioned activity RPC so one command shows the complete
configured ledger. Text output shows time, kind, direction, channel, status,
agent, run, and action. Missing message provenance renders as `-`; OpenClaw
does not invent agent or run ids. Tool actions also show the tool name. JSON
output includes `nextCursor` when another page exists. Pass that value to
`--cursor` to continue without reordering records that arrive during paging.

These exports remain sensitive operational metadata even though message bodies
and raw message identity fields are absent. Agent, session, and run ids, timing,
channels, outcomes, and stable HMAC references can correlate activity. Protect
them with the same access controls and retention practices as other operator
records.

The Gateway intentionally exposes retained execution-identity diagnostics to
every client with `operator.read` in its operator domain. That scope is a
trusted read-only boundary, not hostile multi-tenant isolation. Use separate
Gateway trust domains when operators must not share audit identity data.

## Discover and explain executions

Every admitted outer turn receives an opaque `executionId`. `contextId`
identifies its immutable evidence record; the existing `runId` stays a
possibly shared session, routing, or recovery correlation. Use `--run <id>
--explain` to discover retained executions rather than query the best-effort
activity list. One match resolves directly. Multiple matches return
`ambiguous`, list at most 50 candidates, and tell you to select one explicitly:

```bash
openclaw audit --execution <execution-id> --explain
```

OpenClaw never silently selects the first or latest execution. The exact text
view renders these sections:

1. **Identity**: trust domain, invoker, ingress, agent principal, agent
   definition, runtime instance, represented subject, and sponsor.
2. **Authority**: applicable grants and assurance evidence.
3. **Lineage**: parent context or an explicit absent, unknown, or unsupported
   state.
4. **Decisions**: bounded run-admission and authoritative action-decision
   receipts, including terminal operator approvals.
5. **Missing evidence** and **Next steps**.

Every field includes `present`, `absent`, `unknown`, or `unsupported`; the CLI
does not infer a user from a session key, device id, display name, or shared
credential. A direct local run currently shows authoritative `local-cli`
ingress, an absent invoker, and
`unattributed` coverage. Its admission receipt says `not-applicable` because no
identity-aware policy or grant evaluation was proven.

For Gateway runs, a resolved authenticated profile can make the invoker
`present` and coverage `attribution-only`. Paired devices and shared credentials
do not establish a person: without a durable profile the invoker stays absent,
or `unknown` when authenticated user evidence promised a profile that could not
be resolved. Session creation retains the live canonical durable profile id so
profile linking does not orphan ownership, while run inspection consumes the
immutable connection-time audit fact. Ordinary session provenance stores no
display label. An optional bounded, secret-redacted label can be retained only
in execution identity after that audit storage is explicitly enabled.

An admitted channel run can also show a pseudonymized person invoker. The
trusted active registered native plugin produces the remote participant fact;
core verifies its exact record, registry epoch, scope, and one-shot handoff.
The resulting `boundary-verified` assurance describes that in-process boundary,
not an independent core query to the remote service. Identity never comes from
the conversation, room, route, account, thread, message, transport, session
key, or display name. A collected run shows the person only when all queued
inputs carry valid evidence for the same participant; mixed or missing evidence
shows an unknown invoker. Its `channel/admission` receipt is enforced only when
the participant affected every contributing access decision; otherwise it is
attribution-only.

For channel ingress, `unknown` means a supported integration could not supply
valid host-bound evidence; it never means allowed. `unsupported` is reserved
for a named path with no authoritative Phase 0 integration. A plugin-provided
sender or structurally copied resolver result cannot upgrade either state.

A terminal approval receipt shows `allowed` or `denied`, its stable reason
code, enforcement state, authoritative source boundary, policy and grant
references, context fields used, and remediation. Expired and cancelled
approvals are denied non-actions with distinct reason codes. `no-route` is an
enforced denial only when the approval owner recorded that terminal state. A
corrupt approval is `unknown`. The text view labels `operator_approvals` as an
authoritative owner-native SQLite record retained for 30 days; JSON preserves
the same source owner and record reference without lossy reformatting.
`enforced` requires the approval's immutable owner-local binding to match the
selected context, execution, and run exactly. A missing, malformed, or
mismatched binding reports `operator_approval_execution_link_missing`,
`operator_approval_execution_link_malformed`, or
`operator_approval_execution_link_mismatch` with unknown coverage and no grant
references. The inspector never reconstructs that binding from `runId`, session
metadata, timestamps, or the number of retained executions.

Outbound message receipts distinguish the durable lifecycle without treating
transport progress as authorization:

- `message_queued`: the shared delivery queue accepted custody.
- `message_platform_started`: the channel adapter began the platform send.
- `message_delivered`: the adapter returned recipient-visible delivery identity.
- `message_delivery_failed_<stage>` or `message_delivery_unknown_<stage>`:
  delivery did not produce a proven success; the suffix identifies `queue`,
  `platform_send`, or an `unknown` stage before retrying.
- `message_suppressed_<reason>`: the owning hook or payload normalizer
  intentionally produced no visible message.

These owner-native records are always `attribution-only`. Queue and
platform-start progress comes from the lazy `outbound_message_progress`
companion; terminal outcomes remain in `audit_events`. Both retain only a
host-validated context/execution/run binding when the admitted turn supplied
one. Inspection requires that exact binding and never assigns run-only delivery
evidence to an execution from `runId`. The binding is diagnostic provenance,
not proof that identity or a grant authorized delivery. Target validation,
message policy, and active-turn capability denials are `enforced` only when
their exact tuple was recorded and the gate changed the outcome.
Portable actions and early suppressions that have no durable delivery record
use the generic decision-fact owner instead of duplicating delivery state.

JSON output is the Gateway result without lossy reformatting. An exact result contains one
bounded V1 context (maximum 16 KiB), up to 100 decision receipts, coverage and
missing-evidence codes, and an optional `nextDecisionCursor`. An ambiguous run
result instead contains at most 50 execution candidates and an optional
`nextExecutionCursor`. Sensitive domain,
runtime, invoker, assurance, ingress-source, and grant references are
installation-local HMAC projections. Configured agent ids and exact run ids
remain visible, as do context and execution ids, so redirected output is still
private operator data.

An older Gateway produces an explicit `unsupported` result with
`gateway_upgrade_required` and an upgrade-and-rerun next step. The CLI never
reconstructs identity from legacy audit rows. A current Gateway distinguishes
an unknown run, an unavailable pre-feature, disabled, or failed context write,
an expired context, and a corrupt context without claiming that missing
best-effort activity proves no execution. A newly admitted run can also be
temporarily unavailable while its bounded identity envelope waits in the audit
writer queue; retry inspection after the run or normal process shutdown.
Admission never waits for writer readiness, schema or HMAC-key initialization,
SQLite, or persistence.

Once a context is older than 30 days, the CLI returns no fields or linked
decisions from it. While bounded cleanup is pending, the result is `unsupported`
with an expiry-and-rerun next step. After cleanup it can become `unknown` if no
separately retained activity remains; this absence does not prove that the run
did not occur. Startup and hourly maintenance prune at most 1,024 identity
contexts per tick and continue when collection is disabled. Queue saturation,
storage failure, cleanup failure, shutdown timeout, or abrupt process termination can lose
best-effort evidence but never block or abort the agent run. Normal Gateway and
direct-local CLI shutdown flushes accepted work when its writer lifecycle
permits.

## Recorded events

The Gateway collects trusted lifecycle streams for eight actions:

- `agent.run.started`
- `agent.run.finished`
- `tool.action.started`
- `tool.action.finished`
- `message.inbound.processed`
- `message.outbound.queued`
- `message.outbound.platform-started`
- `message.outbound.finished`

The activity ledger returns run, tool, inbound-message, and terminal outbound
records. Nonterminal outbound actions use the separate progress owner and are
projected as decision receipts by `--run ... --explain`; they are not placed in
the released-reader-compatible activity ledger. Every returned activity record
has a stable event id, a monotonically increasing ledger sequence, a lifecycle
timestamp, actor, action, status, a `schemaVersion: 1` marker, source sequence,
and `redaction: "metadata_only"`.
Agent/session/run provenance and event-specific fields are present only when
the trusted source provides them. Message records intentionally omit
`sessionKey` and `sessionId`, so `--session` filters run and tool records only.

Terminal run and tool records distinguish success, failure, cancellation,
timeout, and policy blocks with closed status and error codes. `unknown` is an
explicit non-success result when an upstream runtime does not expose an
authoritative terminal outcome. Tool call ids are exported only as stable
fingerprints. Tool names must match the compact model-facing name
contract; other values become `unknown`.

Message records add direction, channel, conversation kind, outcome, and
optional delivery kind, failure stage, duration, result count, normalized
reason code, and keyed account/conversation/message/target pseudonyms. The
current inbound boundary covers accepted messages that reach core dispatch,
including core duplicate and terminal processing outcomes. The outbound
boundary writes replay-safe `queued` and `platform_started` progress records to
its lazy companion plus one terminal activity row per original logical reply
payload that reaches shared durable delivery. Chunking and adapter fan-out are
aggregated in terminal `resultCount`.
A terminal is `sent`, `suppressed`, `failed`, or `unknown` after acknowledgement,
dead letter, or reconciliation makes that outcome known.
Plugin-local and direct-send paths that bypass those shared boundaries are not
yet covered; absence of a row does not prove that no message existed.

The audit ledger does not replace transcripts, task history, cron run history,
or logs. It provides a small cross-run index for operator questions without
copying conversation content into another store.

For inbound rows, `durationMs` measures core dispatch and `resultCount` counts
finalized queued tool, block, and reply payloads. For outbound rows,
`durationMs` includes delivery ownership through its terminal (and therefore
queued wait time), while `resultCount` counts identified physical platform
sends. `deliveryKind`, when present, describes the effective post-hook,
post-render payload; suppressed and crash-ambiguous rows omit it.

## Gateway RPC

`audit.activity.list` requires `operator.read` and accepts the same filters. It
returns the named V1 activity event union, including run, tool, inbound-message,
and terminal outbound-message records.

```bash
openclaw gateway call audit.activity.list --params '{"channel":"telegram","limit":50}'
```

The result is `{ "events": AuditActivityEventV1[], "nextCursor"?: string }`.
Results are newest first and limited to 500 records per request.

`audit.run.inspect` also requires `operator.read`:

```bash
openclaw gateway call audit.run.inspect \
  --params '{"runId":"8c69f72e-8b11-4c54-98d5-1a3dd67450c3","decisionLimit":50}'

openclaw gateway call audit.run.inspect \
  --params '{"executionId":"5da4c4c3-e1c9-4c95-a17d-6e5c10fd45cf","decisionLimit":50}'
```

Its result is `{ "schemaVersion": 1, "run": ..., "identity": ..., "decisions":
..., "coverage": ..., "nextDecisionCursor"?: ..., "nextExecutionCursor"?: ... }`.
The closed request accepts exactly one of `executionId` or `runId`.
`decisionLimit` is 1–100 and `decisionCursor` is optional. Run discovery also
accepts `executionLimit` from 1–50 and an optional `executionCursor`. A run
with multiple retained executions returns the typed `ambiguous` identity state
and no identity context or decisions until the caller selects an execution id.
For one selected context, receipt paging starts with admission, then reads
owner-native terminal approvals, merges outbound progress and terminal records,
and finally reads generic facts for boundaries without a native durable record.
The merge is deterministic across restart and rejects a cursor whose exact
owner row has expired.
Approval and delivery inspection never write generic duplicates. Generic fact
writes and projections also require the full context, execution, and run tuple
to match the immutable execution context.

The activity ledger remains best-effort. By contrast, a returned approval
receipt comes from the authoritative first-answer-wins approval row, and a
returned generic receipt comes from the additive immutable decision-fact
table. All three surfaces use 30-day retention, but absence from the activity
ledger cannot prove that an approval or action did not occur. Generic fact
delivery is also best-effort until its bounded queue write persists the row;
owner-native approval persistence does not use that queue.

The shipped `audit.list` RPC remains unchanged for older run/tool clients. When
`audit.activity.list` is unavailable on an older Gateway, the CLI retries
`audit.list` only if every requested filter is supported by that legacy method. `--kind message`,
`--direction`, and `--channel` fail with an upgrade message on an older Gateway
instead of being silently discarded.

## Related

- [Audit history](/gateway/audit)
- [Gateway protocol](/gateway/protocol#audit-ledger-rpc)
- [Sessions](/cli/sessions)
- [Tasks](/cli/tasks)
- [Cron jobs](/automation/cron-jobs)
