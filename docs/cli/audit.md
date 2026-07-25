---
summary: "CLI reference for metadata-only run, tool, and message lifecycle audit records"
read_when:
  - You need to answer who ran an agent or tool, when it ran, and how it ended
  - You need content-free inbound or outbound message lifecycle metadata
  - You need a bounded, redaction-safe activity export
title: "Audit records"
---

# `openclaw audit`

Query the Gateway's metadata-only audit ledger for agent runs, tool actions, and
opt-in message lifecycle records.

The ledger is on by default for run and tool events. Set
[`audit.enabled: false`](/gateway/configuration-reference#audit) and restart the
Gateway to stop all new event records. Message records are separately disabled by
default; set `audit.messages` to `direct` or `all` and restart the Gateway to
record them. Existing records stay queryable until they expire (30 days).

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
openclaw audit --kind tool_action --limit 50 --json
openclaw audit --kind message --direction outbound --channel telegram --json
```

## Filters

- `--agent <id>`: exact agent id
- `--session <key>`: exact session key
- `--run <id>`: exact run id
- `--kind <kind>`: `agent_run`, `tool_action`, or `message`
- `--status <status>`: `started`, `succeeded`, `failed`, `cancelled`,
  `timed_out`, `blocked`, or `unknown`
- `--direction <direction>`: message direction, `inbound` or `outbound`
- `--channel <channel>`: exact message channel
- `--after <timestamp>` / `--before <timestamp>`: inclusive ISO timestamp or
  Unix milliseconds
- `--limit <count>`: page size from 1 to 500; default `100`
- `--cursor <sequence>`: continue a previous newest-first query
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

## Recorded events

The Gateway projects trusted lifecycle streams into six actions:

- `agent.run.started`
- `agent.run.finished`
- `tool.action.started`
- `tool.action.finished`
- `message.inbound.processed`
- `message.outbound.finished`

Every returned record has a stable event id, a monotonically increasing ledger
sequence, a lifecycle timestamp, actor, action, status, a
`schemaVersion: 1` marker, source sequence, and `redaction: "metadata_only"`.
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
boundary writes one terminal row per original logical reply payload that reaches
shared durable delivery; chunking and adapter fan-out are aggregated in
`resultCount`. Queued retryable or ambiguous sends are recorded only after an
acknowledgement, dead letter, or reconciliation makes the outcome terminal.
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
and outbound-message records.

```bash
openclaw gateway call audit.activity.list --params '{"channel":"telegram","limit":50}'
```

The result is `{ "events": AuditActivityEventV1[], "nextCursor"?: string }`.
Results are newest first and limited to 500 records per request.

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
