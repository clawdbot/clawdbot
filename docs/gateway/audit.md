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

The Gateway also keeps an adjacent execution identity context for newly
admitted agent runs. This context is authoritative for the identity facts it
contains; it does not make the activity ledger lossless and does not turn audit
records into authorization evidence.

## Run identity inspection

Execution identity recording is off by default, including on fresh installs
and upgrades. Enable it explicitly, then restart the Gateway:

```bash
openclaw config set logging.audit.executionIdentity true
openclaw gateway restart
```

Collection requires both `logging.audit.enabled` and
`logging.audit.executionIdentity` to be true. Setting either to `false`
stops new contexts after restart; no environment-variable alias or silent
migration enables the feature. Retained contexts remain inspectable until
their 30-day expiry.

After session work admission succeeds, OpenClaw validates and freezes
one bounded identity envelope, immediately offers it to the existing audit
writer queue, and continues the run without waiting for writer readiness,
SQLite, or persistence. The worker initializes schema and HMAC-key state,
pseudonymizes raw references, constructs the immutable context, validates its
canonical bytes, and persists it. An accepted envelope can therefore be
temporarily unavailable to inspection while queued work finishes.

Persistence remains best-effort. Queue saturation, worker or storage failure,
and process crashes can lose evidence; they log only a bounded operational
warning and never abort the run. Normal Gateway and direct-local CLI shutdown
flushes accepted work when the writer lifecycle permits, but abrupt termination
can still lose queued evidence.

When identity collection is enabled, restart recovery stores only the safe
execution/context/run ids and timestamp with its existing private recovery
owner. A later ambiguous retry references that token instead of rebuilding
identity from the new process. When collection or the audit ledger is disabled,
recovery creates, stores, and propagates no new identity token. If the original
queued context was lost, exact inspection stays explicitly unavailable; the
retry never manufactures replacement evidence. Raw identity references are not
stored in the recovery token.

Each admitted outer turn receives a new opaque `executionId`; `contextId`
identifies its immutable evidence record, while the existing `runId` remains a
possibly shared routing, session, or recovery correlation. Query one exact
execution with `audit.run.inspect` or
[`openclaw audit --execution <id> --explain`](/cli/audit). Use `--run <id>
--explain` to discover executions for a run correlation. One retained match
resolves directly. Multiple matches return `ambiguous` with at most 50
candidate execution ids and require exact selection; OpenClaw never chooses the
first or latest execution silently. The result explicitly states the evidence
state for these fields:

- trust domain, invoker, and ingress;
- agent principal, agent definition, and runtime instance;
- represented subject and sponsor;
- applicable grants and assurance evidence;
- parent or child lineage when available.

The foundation records direct local CLI ingress and Gateway boot-system ingress
at their authoritative producers. Generic public ingress remains explicitly
unknown when its boundary cannot prove a more specific source; OpenClaw never
infers ingress or invoker identity from a session key. A direct local execution
is `unattributed`: the Gateway cell, local CLI ingress, configured agent, and
runtime binding are present, but no durable invoker principal is supplied at
this boundary. A run becomes
`attribution-only` only when an authoritative ingress supplies an invoker fact.
Neither state means that identity affected an allow or deny decision.

Each present context currently projects one run-admission receipt. Its outcome
is `not-applicable`, its policy and grant references are empty, and its reason
states that no identity-aware policy or grant evaluation was proven. This is
an explanation of admission evidence, not an enforcement claim.

Run inspection returns successful typed diagnostics instead of inventing
facts:

- `unknown`: the selected run or execution is not known, or expected context is
  corrupt or unreadable;
- `unsupported`: best-effort activity shows the run, but no context is
  available, as with a pre-feature, disabled, or failed context write. A
  context just beyond retention also uses this state while its bounded cleanup
  is pending, with an explicit expiry remediation;
- `ambiguous`: a `runId` has multiple retained executions; select a candidate
  `executionId` before inspecting identity or decisions;
- `unattributed`: the supported run has no usable invoker principal;
- `attribution-only`: invoker attribution exists but was not evaluated for
  authorization.

The method requires `operator.read`. Requests are closed and select exactly one
`executionId` or `runId`. Decision pages contain at most 100 receipts;
ambiguous run-discovery pages contain at most 50 candidate executions. Both use
bounded cursors.

Every client with `operator.read` in the same Gateway operator domain may
receive this retained identity category. This is intentional: the scope already
covers logs and session reads, collection is explicit opt-in, retained
references are bounded and pseudonymized, and optional display labels are
secret-redacted. `operator.read` is not a hostile multi-tenant isolation
boundary; use separate Gateway trust domains when operators must not share this
diagnostic data.

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

Set [`logging.audit.messages`](/gateway/configuration-reference#audit) to choose what
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

Execution identity contexts use the same installation-local key owner with a
separate HMAC domain. Raw runtime, invoker, ingress-source, assurance, and grant
references exist only in a deeply frozen, in-process worker message capped at
16 KiB and 16 entries in each grant/assurance array. The worker replaces them with keyed
pseudonyms before persistence; they are never stored, exported, inspected, or
logged. Configured agent ids plus context, execution, and run ids remain
operator-visible.
Contexts never contain prompt or message text, command bodies, arguments,
paths, credentials, environment values, or arbitrary plugin payloads. Each
encoded context is also capped at 16 KiB.

Audit exports remain sensitive operational metadata even without content:
timing, channels, outcomes, and stable pseudonyms can correlate activity.
Protect exports with the same access controls and retention practices as other
operator records.

## Coverage and proof limits

The ledger is best-effort and deliberately bounded. Treat it as evidence of
what was recorded, not as proof of what happened:

- **Absence of a row proves nothing.** Pre-admission inbound drops, sends from
  plugin-local or direct-send paths that bypass shared durable delivery, a
  dropped admission envelope, and crash-lost queued work can leave no record.
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

Execution identity contexts also live in the shared state database. Canonical
rows are keyed by unique execution and context ids; `runId` is a non-unique,
indexed correlation. Their
additive table is created lazily on first use without a schema-version bump.
Fresh and upgraded installations do not populate identity contexts until an
operator enables collection.
First-use schema creation, HMAC-key access, canonical context construction, and
all SQLite work happen in the audit worker, never in agent admission.
Contexts are retained for 30 days and capped at 100,000 rows. Exact-execution
inspection and run discovery never return a context, candidate, or admission
decision after that context is older than 30 days, even if physical cleanup
has not run. Expired
rows are pruned during Gateway startup, hourly audit maintenance, and later
context writes, with at most 1,024 identity-context rows removed per write or
maintenance tick. Maintenance continues when collection is disabled. An older
build ignores this table.

Immediately after expiry, inspection can report the run as `unsupported` while
the expired row still proves only that its identity context became unavailable;
no expired fields or decisions are returned. After bounded cleanup, the same
lookup can become `unknown` if no separately retained best-effort activity
remains. That transition does not prove the run did not occur. These limits
make the inspector an operational diagnostic surface, not a compliance
archive.

## Querying

- CLI: [`openclaw audit`](/cli/audit) with filters for agent, session, run,
  kind, status, direction, channel, time bounds, and cursor paging.
- Gateway RPC: `audit.activity.list` (requires `operator.read`) returns the
  versioned V1 activity event union; the shipped `audit.list` RPC is unchanged
  for older run/tool clients. See
  [Gateway protocol](/gateway/protocol#audit-ledger-rpc).
- Identity RPC: `audit.run.inspect` (requires `operator.read`) accepts one
  `executionId` for exact inspection or one `runId` for bounded discovery. It
  returns the immutable V1 context and admission receipt for an exact match, or
  a typed ambiguous candidate page when a run has multiple executions.

## Related

- [Audit records CLI](/cli/audit)
- [Configuration reference](/gateway/configuration-reference#audit)
- [Gateway protocol](/gateway/protocol#audit-ledger-rpc)
- [OpenTelemetry](/gateway/opentelemetry)
