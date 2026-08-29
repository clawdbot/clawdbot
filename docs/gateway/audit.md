---
summary: "Metadata-only activity history plus durable run identity and decision receipts"
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

Terminal operator approvals are a separate authoritative source. Run
inspection adapts their existing first-answer-wins rows directly into decision
receipts; it does not copy approvals into the audit ledger or the generic
decision-fact table.

This includes operator-routed native Codex command and file prompts. The Codex
bridge carries the admitted agent, session key, run, tool, context, and
execution binding into the same approval owner, then returns only the approved
native scope. Auto-review, full-access policy, native hook decisions, and
requests rejected before operator routing have no operator-owned row and remain
unsupported as operator-approval evidence; later tool events never manufacture
one.

Shared outbound delivery is another owner-native source. Queue admission and
platform-send start use a lazy progress companion, while terminal message rows
remain in the activity ledger. Run inspection merges both sources directly;
neither is copied into the generic decision-fact table.

Scheduled runs, background tasks, and task flows are owner-native sources too.
After exact run admission, a lazy lifecycle metadata table binds the admitted
context and execution ids to the canonical `cron_run_receipts`, `task_runs`, or
`flow_runs` row. Inspection joins that metadata to the owner row directly and
preserves its status, including skipped, failed, timed-out, cancelled, blocked,
and lost outcomes. A `runId` alone never joins one of these rows to an
execution. Legacy, missing, deleted, corrupt, or mismatched bindings remain
unknown or absent; they never change task behavior and are never copied into
`execution_decision_facts`.

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
SQLite, or persistence. The queue drain initializes schema and HMAC-key state,
pseudonymizes raw references, constructs the immutable context, validates its
canonical bytes, and persists it through the process-owned shared-state
connection. An accepted envelope can therefore be temporarily unavailable to
inspection while queued work finishes.

Persistence remains best-effort. Queue saturation, storage failure, shutdown
timeout, and process crashes can lose evidence; they log only a bounded
operational warning and never abort the run. Normal Gateway and direct-local
CLI shutdown flushes accepted work when the writer lifecycle permits, but
abrupt termination can still lose queued evidence.

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

For a child started through `sessions_spawn`, the child owns a new context; it
never reuses or mutates the parent context. The lineage projection links the
parent context, execution, run, and agent when the exact private parent token
was available. Its delegation reference covers the spawn relation plus the
requester/controller and evaluated local/target policy inputs. Applicable
grants and runtime assurance remain separate evidence categories. This reports
the inputs that could narrow child authority; it does not claim that identity
changed an allow or deny decision.

If the private parent token was unavailable, the child remains inspectable but
the missing parent context, execution, and run evidence is explicit. ACP spawn
itself is observable. Actions performed wholly inside an external ACP runtime
without a callback are reported as unsupported evidence, never inferred from
task or transcript text. After admission, the ACP lifecycle owner records that
receipt when the prompt is submitted, using the exact admitted execution token.
It does not claim that a native side effect occurred; adapter authors must add
an authoritative native-action callback to provide stronger evidence.

Registered plugin runtime calls add bounded facts only after exact run
admission. A `before_tool_call` hook records its own allow or block as an
enforced plugin gate; fail-closed hook errors are denials, while a configured
fail-open error remains unknown. Separate owner-native approval rows remain the
authority when a hook requests approval.

Plugin-owned node actions distinguish the Gateway gate from the action result.
Pairing, live connection, command capability, plugin policy, and active
authority checks are enforced. A node-reported success is attribution-only. If
the plugin policy returns without calling the supplied node callback, the
action is unknown with `node.action_callback` missing; OpenClaw does not infer a
send from the plugin result.

An attached worker records its current credential, bundle/version/features,
owner epoch, and turn-claim admission as one enforced gate. The existing
placement and worker-operation rows stay authoritative; their hashes,
credentials, tokens, environment ids, and session ids are not copied into the
generic receipt. Admission success proves only that the worker may connect, not
that a later worker action succeeded.

The foundation records direct local CLI ingress, Gateway boot-system ingress,
and admitted channel participants at their authoritative producers. For a
channel run, the trusted active registered native plugin produces the remote
participant fact. Core accepts it only across an exact record, registry epoch,
scope, and one-shot handoff; the room, route, account, thread, message, and
transport remain non-principal facts. `boundary-verified` describes that
in-process boundary verification, not an independent core query to Telegram,
Discord, or another remote service. Collected messages retain a person only
when every contribution proves the same participant. Mixed, missing, invalid,
stale, replayed, or unminted evidence is unknown, and an adapter that explicitly
lacks support is unsupported. OpenClaw never reconstructs a participant from
`SenderId`, `From`, session keys, or routing metadata. Plugins cannot publicly
mint or upgrade participant evidence; fake, copied, changed, stale, reused, or
lost host carriers remain unknown.
Other public ingress remains explicitly unknown when its
boundary cannot prove a more specific source. A direct local execution
is `unattributed`: the Gateway cell, local CLI ingress, configured agent, and
runtime binding are present, but no durable invoker principal is supplied at
this boundary. A run becomes
`attribution-only` only when an authoritative ingress supplies an invoker fact.
Neither state means that identity affected an allow or deny decision.

Configured webhook mapping ids identify only the matched ingress source. They
do not authenticate a person, service, or invoker. Shared hook authentication
and direct `/hooks/agent` requests therefore remain unattributed unless another
authoritative principal producer exists. A mapping transform that suppresses a
request before admission returns its normal HTTP response but creates no run,
execution identity, task, or decision receipt. Restart recovery records system
attribution only after the current durable recovery owner admits the exact
attempt.

Authenticated Gateway attach records immutable audit facts once. Session
creation separately reads the live canonical durable profile id so a profile
link performed after attach cannot orphan session ownership. Ordinary session
provenance retains that id only; it does not retain a profile display label.
When execution identity recording is explicitly enabled, its audit context may
also retain the prepared display label after secret redaction and the
128-character bound. A resolved durable profile, including one established by
verified trusted-proxy or Tailscale identity, supplies a pseudonymized person
invoker. A paired device adds device assurance but never becomes a person.
Shared tokens, passwords, auth-none connections, and other profileless clients
remain unattributed. If authenticated user evidence promises a durable profile
but profile resolution fails, the invoker is `unknown` rather than guessed from
headers, device ids, connection ids, or credentials.

Each present context projects one run-admission receipt. Its outcome
is `not-applicable`, its policy and grant references are empty, and its reason
states that no identity-aware policy or grant evaluation was proven. This is
an explanation of admission evidence, not an enforcement claim.

Admitted channel runs also project a `channel/admission` decision receipt after
their exact context/execution/run tuple is queued. Coverage is `enforced` only
when every contributing ingress decision was participant-aware and
outcome-affecting. Wildcard/open policy and explicit attribution-only adapters
remain `attribution-only`; mixed or missing evidence is `unknown`. Identity and
the corresponding decision share the existing audit-writer FIFO.

An admitted session-tool access denial queues a private `session` decision
through that same FIFO. The access owner supplies the reason, policy inputs,
and missing evidence; the audit writer replaces the target session reference
with an installation-local HMAC before persistence. The raw session key is not
retained. A policy denial that changed the outcome is `enforced`, while an
ownership lookup that cannot supply `session.owner` evidence remains `unknown`.
Public inspection intentionally renders generic facts as an unverified
`decision.record`; it does not expose their private reason or target display.
Calls without the exact admitted execution and its active receipt authority
create no selector or fact.

Run-bound session tools also queue their owner-returned result after the final
await and authority recheck. Create, fork, send, patch, reset, archive, restore,
and delete facts distinguish committed or scheduled work from typed lifecycle
conflicts and definitive no-ops. These mechanics are `attribution-only`; the
public generic display remains unverified rather than presenting their private
reason or target as trusted evidence.

Direct session-sharing methods and `/dock-*` commands do not admit model runs,
so they do not synthesize run selectors. Sharing events preserve a verified
profile actor when one exists; an expected but unresolved profile is reported
as unknown, while omitted principal evidence is unattributed. Neither state is
reconstructed from operator scope, a shared token, session routing, or room
metadata. Member listings use the same distinction: `addedBy` contains only a
real principal id, `addedByState: "unknown"` reports explicit principal-less
evidence, and omission means no actor evidence was supplied. Internal storage
markers are never returned by the Gateway. Beta-only `local-operator` and
`operator.admin` member-attribution values are discarded as absent evidence;
they are not migrated or presented as principals. Docking retains its normal
visible command result and session-route update without run-audit attribution.

For an admitted run with message auditing enabled, run inspection also adapts
the outbound message lifecycle. It deterministically merges the lazy progress
owner with terminal ledger rows and reports `queued`, `platform-started`,
`delivered`, `failed`, `unknown`, and intentionally `suppressed` as distinct
receipts. Queue and transport results are `attribution-only`: they record what
the delivery owner observed but do not prove authorization. The existing
message row keeps its keyed destination reference and `runId`; a lazy companion
retains the host-validated context/execution/run binding. Inspection requires
that exact tuple and never assigns run-only delivery evidence to an execution.
The binding remains diagnostic provenance. Only an exact target-validation,
message-policy, or turn-capability denial that changed the result is
`enforced`. Portable actions and early suppressions without a durable owner
record use the generic fact owner on the same audit-writer FIFO.

Cron, task, and flow lifecycle receipts are `attribution-only` and have a
`not-applicable` decision outcome. They report what the authoritative lifecycle
owner retained; they do not claim an authorization decision. Their cursors are
opaque and source-specific. Existing numeric cursors and `a:`, `m:`, and `g:`
cursors remain accepted; newer owner stages use `c:`, `t:`, and `f:`.

When the same `runId` has a retained terminal row in `operator_approvals`, the
inspector also reads its owner-local `operator_approval_execution_identities`
binding. Only an exact context, execution, and run tuple projects the approval
as enforced. The receipt names the durable owner and record reference, the
exact stable reason code, the first-answer and terminal policy references, any
grant created by an allow decision, the exact context fields used, and a
bounded next step. It never includes the command, arguments, path, environment,
reviewer device id, resolver id, or approval presentation text.

Approval outcomes map to stable receipt reasons:

| Recorded approval result       | Receipt reason code                                                                       |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Allow once / allow always      | `operator_approval_allowed_once` / `operator_approval_allowed_always`                     |
| Reviewer denial                | `operator_approval_denied_by_reviewer`                                                    |
| Deadline expiry                | `operator_approval_expired`                                                               |
| Run abort / Gateway restart    | `operator_approval_cancelled_run_aborted` / `operator_approval_cancelled_gateway_restart` |
| No approval delivery route     | `operator_approval_denied_no_route`                                                       |
| Malformed approval verdict     | `operator_approval_denied_malformed_verdict`                                              |
| Fail-closed storage state      | `operator_approval_denied_storage_corrupt`                                                |
| Unreadable or inconsistent row | `operator_approval_record_corrupt`                                                        |
| Missing execution binding      | `operator_approval_execution_link_missing`                                                |
| Malformed execution binding    | `operator_approval_execution_link_malformed`                                              |
| Mismatched execution binding   | `operator_approval_execution_link_mismatch`                                               |

Allowed, denied, expired, and cancelled rows are `enforced` because the
recorded human decision or fail-closed owner policy changed whether the action
could proceed. A no-route denial is `enforced` only because the approval owner
records `no-route` as the winning terminal reason before returning the
non-action. An unreadable row is `unknown`, never reconstructed. If a retained
approval names a run but its expected execution context is missing, run
inspection returns `decision_context_link_missing` with `unknown` coverage and
does not invent a receipt context.

Because `runId` is correlation rather than execution identity, it never
substitutes for the owner-local binding. Missing, malformed, or mismatched
binding rows project as `unknown` with no grant references and explicit binding
remediation, even when only one execution context is retained for the run. The
inspector never infers a binding from session metadata, timestamps, or retained
context counts.

Run inspection returns successful typed diagnostics instead of inventing
facts:

- `unknown`: the selected run or execution is not known, or expected context is
  corrupt or unreadable; this also covers a retained decision whose expected
  context link is missing;
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
`executionId` or `runId`. The public result always contains a required
`decisionDisplays` array and never contains the private raw receipt array or a
`decisions` key. The Gateway builds that result from an explicit safe-field
allowlist; clients do not classify receipt prose. Decision pages contain at
most 100 displays;
ambiguous run-discovery pages contain at most 50 candidate executions. Both use
bounded cursors. Approval and message-delivery selectors are minted from the
same owner-query row metadata as their projected receipts, use the
`approval-decision:` and `message-decision:` namespaces, and never derive from
receipt, resolution, or event identifiers.

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

| Family       | Actions                                                                            | Default |
| ------------ | ---------------------------------------------------------------------------------- | ------- |
| Agent runs   | `agent.run.started`, `agent.run.finished`                                          | on      |
| Tool actions | `tool.action.started`, `tool.action.finished`                                      | on      |
| Messages     | `message.inbound.processed`, `message.outbound.{queued,platform-started,finished}` | off     |

Every record carries a stable event id, a monotonic owner sequence, a lifecycle
timestamp, actor, action, status, `schemaVersion: 1`, and
`redaction: "metadata_only"`. The activity ledger contains terminal outbound
rows; run inspection obtains nonterminal outbound progress from its companion.
See [Audit records](/cli/audit) for the full field reference and query filters.

## Message lifecycle events

Set [`logging.audit.messages`](/gateway/configuration-reference#audit) to choose what
is recorded, then restart the Gateway:

- `off` (default): no message records.
- `direct`: only messages in direct conversations.
- `all`: direct, group, and channel messages.

Two authoritative boundaries produce message records:

- **Inbound** rows are written when an accepted message reaches core dispatch,
  including duplicate and terminal processing outcomes.
- **Outbound** progress records are written when shared durable delivery accepts
  queue custody and starts platform delivery. Terminal activity rows record
  sent, suppressed, failed, or an explicit `unknown` for crash-ambiguous sends.
  Queue recovery and dead-letter outcomes are included. Stable queue-derived
  source ids prevent recovery from duplicating a lifecycle row. Each original
  logical reply payload gets one row per reached stage; chunking and adapter
  fan-out aggregate into terminal `resultCount`.

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

Message activity and progress records never store raw platform identifiers.
Account, conversation, message, and target identifiers, when correlation is available, are exported
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
separate HMAC domain. Raw runtime, invoker, ingress-source, assurance, grant,
and child-delegation references exist only in bounded private admission
carriers. The deeply frozen queue payload is capped at 16 KiB and 16 entries
in each bounded evidence array. A structured clone strips prototypes at the
queue boundary. The queue drain replaces raw references with keyed
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
- Writes go through a bounded asynchronous process-owned queue; queue
  saturation, storage failure, or a bounded shutdown timeout can drop records
  and log one operational warning.
- Crash-ambiguous outbound sends are recorded as `unknown` rather than
  invented outcomes.

This ledger supports debugging and operational review. It is not a lossless
compliance archive; if you need one, use an external system fed by
[OpenTelemetry](/gateway/opentelemetry) or channel-level tooling.

## Storage, retention, and migration

Records live in the shared state database (`state/openclaw.sqlite`) and are
written off the delivery hot path. Queries never return records older than 30
days, and the ledger is capped at 100,000 rows; expired rows are pruned during
startup, hourly maintenance, and later writes. Each ledger or progress cleanup
transaction deletes at most 1,024 expired rows and schedules more work until
settled. Retention maintenance keeps running even when collection is disabled.

Outbound `queued` and `platform-started` records live in the narrowly owned
`outbound_message_progress` table. The table is created idempotently only on
the first enabled progress write, remains absent after startup, read-only
inspection, disabled collection, and terminal-only delivery, and does not
advance the state schema version. Missing under read-only inspection means no
retained progress. It is capped at 200,000 rows with the same 30-day retention.
Terminal `message.outbound.finished` rows stay in `audit_events`, so a compatible
older Gateway can open and use the database while ignoring the additive table.
Exact terminal linkage lives in the lazy
`outbound_message_execution_bindings` companion rather than changing the
released `audit_events` shape. It is created only for a host-validated exact
binding; run-only terminal writes leave it absent. Compatible older Gateways
ignore this additive table as well.

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
SQLite persistence happen in the process-owned audit queue drain, never in
agent admission. Lock attempts fail fast and retry asynchronously with bounded
backoff so SQLite contention does not synchronously wait on the Gateway thread.
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

Terminal approvals remain in their owner-native `operator_approvals` table for
30 days. Inspection applies that cutoff even when physical pruning has not run.
The additive `execution_decision_facts` table is reserved for action boundaries
that have no owner-native durable record, including portable message actions,
policy denials, and early intentional suppressions. It is created lazily on
first generic fact write, retains facts for 30 days, caps the table at 250,000
rows, and prunes at most 1,024 rows per write or maintenance tick. Approval
paths never write this table. Its facts and approval rows are authoritative for
their recorded decisions. Delivery to the generic table uses the bounded audit
queue and remains best-effort until persisted; approval-owner writes do not
depend on that queue. The activity ledger cannot recreate either source after
loss.

Every generic decision-fact write rereads the immutable execution context and
requires the full context, execution, and run tuple. Projection validates the
same tuple again; a mismatch is `unknown`, not reassigned by context or run
correlation alone.

## Querying

- CLI: [`openclaw audit`](/cli/audit) with filters for agent, session, run,
  kind, status, direction, channel, time bounds, and cursor paging.
- Gateway RPC: `audit.activity.list` (requires `operator.read`) returns the
  versioned V1 activity event union; the shipped `audit.list` RPC is unchanged
  for older run/tool clients. See
  [Gateway protocol](/gateway/protocol#audit-ledger-rpc).
- Identity RPC: `audit.run.inspect` (requires `operator.read`) accepts one
  `executionId` for exact inspection or one `runId` for bounded discovery. It
  returns the immutable V1 context plus paged safe displays for admission,
  approval, owner-native outbound message, and generic decision records for an
  exact match, or a typed ambiguous candidate page with an empty display array
  when a run has multiple executions. Raw owner receipts remain private to the
  aggregation and storage owners.

## Related

- [Audit records CLI](/cli/audit)
- [Configuration reference](/gateway/configuration-reference#audit)
- [Gateway protocol](/gateway/protocol#audit-ledger-rpc)
- [OpenTelemetry](/gateway/opentelemetry)
