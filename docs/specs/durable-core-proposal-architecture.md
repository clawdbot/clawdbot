---
title: Durable Core Residual-Gap Architecture Proposal
summary: "Proposal anchor for residual durable runtime invariants and boundaries."
read_when:
  - Reviewing the durable runtime residual-gap proposal
  - Checking durable runtime owner boundaries before implementation
  - Auditing recovery, wake, and delivery invariants
---

# Durable Core Residual-Gap Architecture Proposal

This page is an unapproved durable-runtime RFC candidate for official OpenClaw
7.1. It describes the residual gap between existing lifecycle owners and
possible future runtime recovery work. It is not an accepted architecture, not
the durable runtime source of truth, and not a maintainer decision about
ownership or stack order. It does not claim that runtime behavior, external
delivery, replay, worker recovery, schema migration, or CLI/Gateway behavior is
implemented by this document.

## Candidate General Durable Runtime RFC

Durable core would be an owner-first, opt-in cross-owner contract layer beneath
OpenClaw agent, session, subagent, task, channel, and operator surfaces. Its job
would be to define invariants for runtime facts that must survive process
restarts: accepted-work identity, ordered steps and events, parent/child links,
bounded refs, leases, recovery states, wake/attention obligations, delivery
evidence, and read-only inspection state. It would not be a replacement
lifecycle ledger or a general workflow engine.

If maintainers adopt this RFC, the durable runtime layer would build on the
existing local state owners in `openclaw.sqlite`. The target base already
persists audit events, state leases, task and subagent runs, durable delivery
queues, task delivery state, and flow runs. Session, restart, ACP, conversation
binding, audit, and diagnostics also retain their current authority. This RFC
candidate must not become a competing ledger for those owners. It names only
residual contracts needed when facts cross boundaries: stable refs, append-only
event evidence, generic execution checkpoints, wake/attention obligations,
delivery-attempt evidence, uncertainty, inspection, and fail-closed recovery.

The RFC boundary is intentionally conservative:

- record accepted runtime work with stable identities and append-only or
  otherwise auditable lifecycle events;
- keep recovery explicit by separating complete, failed, cancelled, stale,
  interrupted, and owner-decision-needed states;
- expose operator and Gateway read paths that explain state without mutating
  work;
- require opt-in durable runtime and separately gated worker behavior until
  storage, recovery, and live delivery claims have direct proof;
- preserve current synchronous behavior when durable runtime is disabled.

## What Problem This Solves

OpenClaw is no longer only a synchronous chat loop. It now spans long-running
agent turns, subagents, tool calls, channel delivery, local operator inspection,
and process restarts. Existing durable owners already record important parts of
that work in `openclaw.sqlite`, including audit events, leases, task/subagent
state, delivery queue entries, task delivery state, and flow runs.

The remaining architecture question is cross-owner consistency. A task row,
subagent run, delivery queue entry, flow run, and audit event can each be valid
on its own while still leaving unclear whether a parent is waiting on fan-in,
whether a side effect already happened, which handoff was accepted or
acknowledged, or what a restart may safely reclaim. If adopted, durable core
would give those owners shared invariants so OpenClaw can answer what it
accepted, what ran, what is waiting, what failed, what became stale after
restart, and which bounded recovery action is safe to present to an owner or
operator.

## Why The Residual Gap Matters

This residual-gap proposal exists because the suspected remaining failure modes
are cross-cutting rather than isolated to one channel, one prompt, or one UI.
The repeated pattern is not merely "a message did not arrive"; it is that
OpenClaw can accept work, delegate it, defer it, or route it through a channel
without a shared durable obligation that later code can inspect, recover,
acknowledge, or fail closed.

The remaining root causes implementation work must address are:

- **Coordinator silence:** a coordinator can promise later progress or
  completion, then depend on transcript intent and voluntary follow-up instead
  of a durable wake/report-route obligation.
- **Restart and interruption loss:** process exit, gateway restart, tool
  interruption, or provider return can erase process-local knowledge of accepted
  work and leave no safe recovery classification.
- **Stale running work:** rows, sessions, or in-memory markers can appear
  running after the owner is gone unless durable leases, expiry, and stale-state
  diagnostics exist.
- **Parent/child handoff gaps:** subagent completion, fan-in, and result
  delivery can be visible to a child but not durably addressed to the parent or
  human who needs the result.
- **Delivery and attention uncertainty:** a channel send, internal handoff, or
  operator notification may be accepted, attempted, failed, or unknown without
  durable attempt evidence and acknowledgement state.
- **Side-effect uncertainty:** crashes before or after tool dispatch, provider
  return, child spawn, local commit, or channel send can make automatic replay
  unsafe unless idempotency and authority gates prove it.

If accepted and implemented, this foundation would let durable-runtime work
treat those cases as inspectable runtime states instead of as unrelated prompt,
channel, or UI bugs. This page documents the proposed boundary and proof model;
implementation and runtime claims belong to the changes that add and validate
code.

## Ownership And Source-Of-Truth Position

Until maintainers explicitly adopt a durable-core boundary, existing TaskFlow,
background-task, session, delivery, Gateway, and SQLite-backed owners remain the
source of truth for their own behavior. This RFC candidate is only a review
artifact for the residual cross-owner questions those owners may not answer
alone.

If adopted, durable runtime implementation should extend the existing state
owners where they already own the fact, then add shared contracts only for
cross-owner questions those tables cannot answer alone. New records should be
source-backed by a concrete invariant, migration, recovery path, or inspection
need.

Architecture review should check whether each proposed durable fact has a clear
owner, retention posture, privacy posture, disabled-runtime behavior, stale-owner
handling, and read path. If an existing owner can answer the question without a
new shared record, prefer the existing owner.

### Candidate Residual Schema

The candidate schema is deliberately limited to ten residual tables. Existing
owner tables remain canonical and are not mirrored.

| Table                       | Residual fact                                                       |
| --------------------------- | ------------------------------------------------------------------- |
| `durable_execution_records` | Generic accepted execution evidence when no lifecycle owner exists  |
| `durable_event_evidence`    | Ordered execution and recovery evidence                             |
| `durable_execution_steps`   | Generic step, checkpoint, claim, and replay boundaries              |
| `durable_payload_refs`      | Bounded input, output, error, checkpoint, and artifact references   |
| `durable_run_correlations`  | Parent/child and cross-owner correlations                           |
| `durable_timer_obligations` | Generic retry, deadline, and sleep obligations                      |
| `durable_signal_evidence`   | Generic approval, input, and callback evidence                      |
| `wake_obligations`          | Source-backed owner or report-route attention obligations           |
| `delivery_attempt_evidence` | Per-attempt handoff and delivery proof with explicit proof boundary |
| `uncertainty_facts`         | Ambiguous outcomes and facts requiring reconciliation or a decision |

No separate dedupe ledger, result mailbox, mode table, decision table, cleanup
table, or migration ledger is justified while unique keys, existing owner
state, `state_leases`, audit evidence, and `schema_meta` can provide those
contracts. The ten tables would live in the existing shared SQLite file and be
installed only when durable runtime is explicitly enabled. Disabled startup and
read paths must neither open or migrate durable storage nor eagerly load the
recovery and owner-adapter module graph. A future durable schema version must be
rejected by read-only preflight before any DDL, metadata update, or backfill.

## Durable Core Boundary

Durable core is proposed as a local-first runtime substrate, not a product UI
and not a general workflow engine. If maintainers adopt this boundary, it should
record enough state to inspect, explain, and recover agent/session/task work
without requiring external orchestration.

| Area             | Durable core owns                                                                                                  | Existing owner retains                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Channel delivery | Intake correlation, delivery refs, attempt evidence, and diagnostics                                               | Queue lifecycle, formatting, transport policy, notification UX, and channel retries   |
| Agent execution  | Generic evidence only when no lifecycle owner exists; stable cross-owner refs, links, checkpoints, and uncertainty | Session/task/flow/cron/subagent lifecycle, prompt policy, model choice, and tool work |
| Subagents        | Source-backed parent/child correlations, bounded result refs, attention obligations, and attempt evidence          | Spawn, progress, timeout, cleanup, result capture, and final-delivery retry lifecycle |
| Recovery         | Cross-owner stale/lost diagnostics, append-only recovery evidence, and owner attention                             | Lease authority and decisions to retry, resume, abandon, replace, or replay           |
| UX/product       | Read models and explanations over durable facts                                                                    | Workboard grouping, Task Flow authoring, channel UX, and product-specific task states |

Layer separation is mandatory. Substrate facts are persisted in durable tables;
runtime interpretation derives safe state from those facts; projection policy
maps facts into Workboard, Task Flow, or channel views; agent policy decides what
the model or owner should do next.

## Candidate Integration Boundary

An owner front door is the narrow existing API allowed to mutate or deliver for
that lifecycle. Durable code may inspect bounded facts and call that API; it
must not update another owner's lifecycle table directly. Initial adapters
should cover task, subagent, managed flow, and persisted session attention while
reusing delivery queue, restart, ACP, and state-lease front doors.

The generic agent-turn record is an intake/evidence envelope, not a replacement
for session, task, cron, flow, subagent, ACP, or delivery ownership. Every
user-visible acceptance front door should commit the same bounded durable
identity before it reports acceptance or emits success-shaped stream framing:

| Front door                   | Candidate acceptance boundary                              |
| ---------------------------- | ---------------------------------------------------------- |
| Gateway `agent` RPC          | Before the first `status: accepted` response               |
| OpenAI-compatible HTTP       | Before success framing or the first assistant stream chunk |
| OpenResponses HTTP           | Before `response.created` or `response.in_progress`        |
| Local `agent` command        | Before internal runner dispatch                            |
| Channel auto-reply           | Before typing, compaction, or model work                   |
| Queued follow-up / heartbeat | Before each follow-up runner invocation                    |
| Isolated cron execution      | Before the isolated prompt executes                        |

Each accepted turn should settle through one fenced lifecycle path so success,
failure, and cancellation cannot race into contradictory terminal facts.

The first public operational surface should be additive and read-only:

- Gateway methods under `durable.*`, including health, coordination,
  obligations, wakes, uncertainty, and delivery-attempt inspection;
- CLI commands under `openclaw durable`, using the same bounded projections;
- no public acknowledge, retry, resume, abandon, replay, or direct owner
  mutation in the initial stack.

Any later owner-control surface needs a separate authority review with caller
identity, authorization source, owner revision, idempotency key, reason, audit
evidence, and an owner-adapter mutation path.

## Intended User Value

The proposal prioritizes trustworthy inspection and diagnostics first. The core
recovery goal is to persist committed facts and surface attention to the owner
of the work. If a runtime, worker, Gateway request, child run, channel delivery,
or process dies halfway, an accepted durable-core design should record the
facts, expose diagnostics, and surface pending owner/main-agent work. Until that
maintainer decision exists, this page is not a promise that OpenClaw will add a
new durable-core subsystem.

The proposal does not promise:

- automatic arbitrary replay;
- exactly-once external effects;
- full Task Flow barriers;
- Workboard-native recovery UX;
- distributed scheduling;
- semantic resume of model/tool work without explicit contracts;
- external channel delivery unless the implementation PR proves it directly.

## Core Invariants

- Terminal run and step states are immutable except retention or compaction
  metadata.
- Claimed records include an owner and expiry; stale owner writes are rejected.
- Recovery mutations append events and do not silently rewrite history.
- Disabled durable paths do not create databases, tables, or migrations and do
  not eagerly load the recovery or owner-adapter graph.
- Future schema versions fail closed before mutation.
- Every standalone obligation or uncertainty fact is source-backed by an
  existing owner/ref; only a true root generic execution may carry a documented
  root-operation reason instead.
- Public CLI and Gateway inspection is side-effect-free and read-only.
- Unknown metadata is preserved across supported read/modify/write paths.
- Bounded previews are the default. Full input capture is opt-in, hashes are not
  anonymization, and metadata can be sensitive.

## Durable Wake And Attention Obligations

A durable wake is a substrate record that committed runtime facts require
attention from an owner, supervisor, report route, operator, or inspection
surface. Parent wake-up is one subagent/fan-in case; it is not the whole model.

Durable core may record wake-needed events, owner and target refs, bounded
payload refs, delivery-attempt evidence, no-handler diagnostics, and
acknowledgement state. It must not decide whether the owner should retry,
resume, abandon, wait, ask the user, or create new work.

The candidate wake lifecycle uses `pending`, `handoff_accepted`, `acked`,
`failed`, `suspended`, and `superseded`. The term `handoff_accepted` names only
the exact internal owner or queue boundary retained in attempt evidence. It
must not be shortened to `delivered`, because queue acceptance, attached-session
consumption, end-user delivery, and external transport success are different
proof boundaries. Only `acked` and `superseded` are terminal.

Internal session delivery-queue acceptance may prove only the
`handoff_accepted` boundary for a resolved session target. It does not prove
that an attached session consumed the notice or that a user received it.
External channel transport remains a separate delivery claim and must not be
implied by this RFC or by the internal handoff unless implementation work proves
it directly.

## Non Goals

- No runtime code, schema, worker, CLI, Gateway, or transport changes from this
  docs-only RFC.
- No accepted ownership, source-of-truth, or stack-order decision from this
  docs-only RFC.
- No default-on durable runtime behavior.
- No public mutating durable CLI or Gateway controls in the initial stack.
- No product-specific task-card or Workboard policy in durable core.
- No raw prompt, task, or tool-payload persistence by default.
- No replay of side effects without idempotency, retention, and operation
  authority gates.
- No external delivery claim without direct implementation and live or
  maintainer-grade proof.

These contracts remain useful with stronger models and larger context windows:
model capability cannot eliminate process replacement, transport ambiguity,
lease expiry, permission changes, provider outages, or uncertain side effects.

## Related

- [Durable Core Residual-Gap Compatibility Check Plan](/specs/durable-core-proposal-test-plan)
