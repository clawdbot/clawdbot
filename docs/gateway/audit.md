---
summary: "Metadata-only audit history for agent runs, tool actions, and opt-in message lifecycles"
read_when:
  - You need a durable record of what the Gateway did without storing content
  - You are deciding whether to enable message lifecycle auditing
  - You need to explain what audit records do and do not prove
title: "Audit history"
---

# Audit history

The Gateway keeps a bounded, metadata-only audit ledger in the shared OpenClaw
state database. It answers operational questions such as "which agent ran,
when, and how did it end", "which tool actions did a run execute", and, when
message auditing is enabled, "did an accepted inbound message reach dispatch"
and "did an outbound message reach a terminal delivery state".

The ledger stores identity, ordering, provenance, action, status, and
normalized outcome codes. It never stores prompts, message bodies, tool
arguments, tool results, attachments, filenames, URLs, command output, or raw
error text.

## Record families

Run and tool events are recorded whenever auditing is enabled (the default).
Message lifecycle events are opt-in and disabled by default.

| Family       | Actions                                                  | Default |
| ------------ | -------------------------------------------------------- | ------- |
| Agent runs   | `agent.run.started`, `agent.run.finished`                | on      |
| Tool actions | `tool.action.started`, `tool.action.finished`            | on      |
| Messages     | `message.inbound.processed`, `message.outbound.finished` | off     |

Every record carries a stable event id, a monotonic ledger sequence, a
lifecycle timestamp, actor, action, status, `schemaVersion: 1`, and
`redaction: "metadata_only"`. See [Audit records](/cli/audit) for the full
field reference and query filters.

## Message lifecycle events

Set [`audit.messages`](/gateway/configuration-reference#audit) to choose what
is recorded, then restart the Gateway:

- `off` (default): no message records.
- `direct`: only messages in direct conversations.
- `all`: direct, group, and channel messages.

Two authoritative boundaries produce message records:

- **Inbound** rows are written when an accepted message reaches core dispatch,
  including duplicate and terminal processing outcomes.
- **Outbound** rows are written when shared durable delivery reaches a
  terminal outcome: sent, suppressed, failed, or an explicit `unknown` for
  crash-ambiguous sends. Queue recovery and dead-letter outcomes are included.
  Each original logical reply payload gets one terminal row; chunking and
  adapter fan-out aggregate into `resultCount`.

### Conversation-kind classification

`direct` mode is a privacy boundary, so a message is classified as a direct
conversation only when destination facts prove it: the sending path declared
the destination conversation kind, or the delivery session route names exactly
the channel and peer being delivered to. Weaker signals, such as policy state
or the originating conversation, can classify a message as `group` (excluding
it from `direct` collection) but can never claim `direct`. Messages that
cannot be proven direct are classified `unknown` and are not recorded in
`direct` mode. Channels that do not declare chat types may therefore record
fewer rows in `direct` mode than they do in `all` mode.

## Privacy model

Message rows never store raw platform identifiers. Account, conversation,
message, and target identifiers, when correlation is available, are exported
only as installation-local keyed pseudonyms
(`hmac-sha256:v1:<keyId>:<digest>`):

- The HMAC key is generated on first use, is domain-separated per identifier
  kind, and lives in the same state database as the ledger.
- Pseudonyms are stable within one installation, so rows about the same
  conversation correlate without revealing the platform identifier.
- This is **correlation, not anonymization**: anyone with read access to the
  state database also has the key and can test candidate raw identifiers
  against the pseudonyms. RPC and CLI exports never include the key.
- If the key material is missing or corrupt while message rows are retained,
  the Gateway fails closed and drops new message records instead of silently
  rotating to a new key, which would split correlation.

Run and tool records retain `sessionKey` and `sessionId` for correlation;
canonical session keys can themselves contain platform account or peer ids.
Message records intentionally omit both.

Audit exports remain sensitive operational metadata even without content:
timing, channels, outcomes, and stable pseudonyms can correlate activity.
Protect exports with the same access controls and retention practices as other
operator records.

## Coverage and proof limits

The ledger is best-effort and deliberately bounded. Treat it as evidence of
what was recorded, not as proof of what happened:

- **Absence of a row proves nothing.** Pre-admission inbound drops, sends from
  CLI processes without a running Gateway recorder, and plugin-local or
  direct-send paths that bypass shared durable delivery leave no record.
- Writes go through a bounded background worker; worker failure or queue
  saturation drops records and logs one operational warning.
- Crash-ambiguous outbound sends are recorded as `unknown` rather than
  invented outcomes.

This ledger supports debugging and operational review. It is not a lossless
compliance archive; if you need one, use an external system fed by
[OpenTelemetry](/gateway/opentelemetry) or channel-level tooling.

## Storage, retention, and migration

Records live in the shared state database (`state/openclaw.sqlite`) and are
written off the delivery hot path. Queries never return records older than 30
days, and the ledger is capped at 100,000 rows; expired rows are pruned during
startup, hourly maintenance, and later writes. Retention maintenance keeps
running even when collection is disabled.

Upgrading from a Gateway with the earlier run/tool-only ledger migrates the
schema automatically at startup (or via `openclaw doctor --fix`); existing
rows and their ledger sequences are preserved.

## Querying

- CLI: [`openclaw audit`](/cli/audit) with filters for agent, session, run,
  kind, status, direction, channel, time bounds, and cursor paging.
- Gateway RPC: `audit.activity.list` (requires `operator.read`) returns the
  versioned V1 activity event union; the shipped `audit.list` RPC is unchanged
  for older run/tool clients. See
  [Gateway protocol](/gateway/protocol#audit-ledger-rpc).

## Related

- [Audit records CLI](/cli/audit)
- [Configuration reference](/gateway/configuration-reference#audit)
- [Gateway protocol](/gateway/protocol#audit-ledger-rpc)
- [OpenTelemetry](/gateway/opentelemetry)
