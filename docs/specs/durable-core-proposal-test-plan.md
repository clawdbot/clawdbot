---
title: Durable Core Residual-Gap Compatibility Check Plan
summary: "Candidate compatibility checks for proposed residual durable runtime invariants."
read_when:
  - Planning durable runtime compatibility checks for the residual-gap proposal
  - Auditing durable runtime merge readiness
  - Converting reviewer concerns into candidate checks
---

# Durable Core Residual-Gap Compatibility Check Plan

This plan turns the durable-core residual-gap RFC candidate into possible
compatibility checks for future durable runtime work. It is a review anchor only,
not an accepted proof contract, source of truth, or owner decision. It does not
require runtime proof from docs-only changes that do not alter runtime behavior.

## Scope

The plan covers the opt-in, local-first durable runtime substrate: storage,
runtime facts, recovery diagnostics, wake/attention obligations, internal
handoff, and read-only inspection. It does not require product UI, Workboard or
Task Flow authoring, distributed scheduling, automatic semantic replay, public
owner controls, or external channel delivery.

## Root-Cause Coverage

If maintainers adopt a durable-core boundary, future implementation work should
show how general runtime root causes would be handled as durable facts, not as
product-specific conventions. The architecture proposal defines candidate
coverage for owner review; implementation changes own executable proof.

| Root cause                      | Candidate durable-core response                                                                                                                                   | Primary proof area              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Coordinator silence             | Accepted deferred work creates an inspectable wake, report-route, progress, timeout, or owner-decision obligation instead of relying only on transcript intent    | Wake and owner attention        |
| Restart and interruption loss   | Runtime facts distinguish complete, failed, cancelled, interrupted, stale, and decision-needed work after process exit, gateway restart, tool failure, or handoff | Storage and recovery            |
| Stale running work              | Claims and leases have owners, expiry, stale diagnostics, and fail-closed mutation rules so lost owners cannot keep rewriting or hiding abandoned work            | Leases and worker recovery      |
| Parent/child handoff gaps       | Child spawn, terminal outcome, fan-in, bounded result refs, and parent wake facts are durably linked and deduped before any parent/human completion claim         | Subagent and result handoff     |
| Delivery and attention unknowns | Internal handoff and any claimed external delivery record target, attempt, acknowledgement, failure, no-handler, and unresolved states with bounded inspection    | Delivery and inspection         |
| Side-effect uncertainty         | Automatic replay is denied unless operation authority, input material, side-effect class, idempotency, dedupe/CAS or reconciliation, and retention gates all pass | Replay authority and safeguards |

Reviewers can use these as candidate durable-runtime compatibility checks only
after confirming the relevant owner boundary. A future implementation change may
cover a narrow slice, but it should still name which root-cause rows it covers
and which rows remain deferred.

## Compatibility Check Hygiene

- Run compatibility checks on the change being reviewed, with the same
  configuration that enables the claimed durable behavior.
- Record the command, relevant configuration, data directory setup, and output or
  log path.
- Re-run affected checks after rebases or changes to touched runtime surfaces.
- Docs map and generated artifacts must be regenerated with repo scripts, not
  copied from another worktree.

## Docs-Only Validation Gate

For this PR, the only applicable validation is documentation hygiene and scope
hygiene. The pages do not land runtime behavior, and they do not supersede
TaskFlow, background-task, session, delivery, Gateway, or SQLite ownership.

| Check         | Candidate validation                                                        |
| ------------- | --------------------------------------------------------------------------- |
| Scope hygiene | `git diff --name-status <base>..<head>` shows docs/spec/test-plan only      |
| Docs map      | `node scripts/generate-docs-map.mjs --check` or equivalent docs-map check   |
| Docs syntax   | docs MDX/lint/format checks available in the target branch for touched docs |
| Diff hygiene  | `git diff --check <base>..<head>`                                           |
| Ancestry      | `git merge-base --is-ancestor <base> <head>`                                |

Docs-only changes should state when live proof is not applicable because they
claim no runtime delivery behavior.

## Candidate Compatibility Matrix

| Area                          | Candidate compatibility check                                                                                                                                | Proof surface                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Disabled-path no mutation     | CLI and Gateway inspection reject before SQLite, WAL, SHM, migration, durable tables, worker startup, or eager recovery/owner-graph loading                  | Durable config and inspection     |
| Runtime opt-in                | Durable recording and inspection are inert by default and enabled only by explicit durable runtime config                                                    | Runtime config                    |
| Worker separate gate          | Runtime-enabled startup records only allowed facts; worker recovery requires separate worker opt-in                                                          | Worker recovery                   |
| Future schema fail-closed     | Newer durable schema versions fail before DDL, ALTER, backfill, worker mutation, or projection mutation                                                      | Schema migration                  |
| Terminal immutability         | Terminal runs and steps reject lifecycle rewrites; `acked` and `superseded` wakes reject further transitions except explicit retention metadata              | Storage mutation guards           |
| Identity propagation          | Chat, `agent.run`, user turns, embedded-agent yield, task completion, and status notices carry stable durable refs                                           | Runtime identity                  |
| ACP/manual-spawn preservation | ACP manual-spawn child turn task suppression remains intact; plugin-subagent precedence and CLI fallback still work                                          | Agent and subagent compatibility  |
| Pairing QR regression         | Webchat pairing QR display remains visible without persisting sensitive QR content                                                                           | Adjacent channel compatibility    |
| Wake target resolution        | Owner, parent, peer, scheduled, Task Flow, external route, missing, unauthorized, and ambiguous targets resolve or fail closed with inspectable evidence     | Wake routing                      |
| Wake queue contract           | Wake records include stable ids, target refs, reason, facts refs, dedupe key, attempt fields, ack/failure fields, and lifecycle state                        | Wake storage                      |
| Replay authority              | Automatic replay is denied unless operation registry, input material, idempotency, side-effect class, dedupe/CAS or reconciliation, and retention gates pass | Replay safeguards                 |
| CLI/Gateway inspection        | Read APIs expose runs, facts, wake queue, unresolved obligations, and uncertainty without worker mutation                                                    | Read APIs                         |
| Owner decision boundary       | Initial public API remains read-only; any later decision validates caller authority and source revision, calls the owner API, and records audit evidence     | Owner adapters and audit          |
| Worker no-handler behavior    | Empty registry and no-handler rows fail closed and do not mark unknown side effects as handled                                                               | Worker recovery                   |
| Claim/lease recovery          | Expired claimed run/step rows are inspectable and reclaim only when eligible, with SQLite row evidence                                                       | Lease recovery                    |
| Internal session handoff      | Resolved session targets move through internal delivery handoff with durable evidence and no external transport claim                                        | Internal delivery                 |
| External delivery             | Only claimed if the implementation includes external transport delivery and direct proof                                                                     | External transport implementation |

### Exact Schema Gate

When implementation introduces the optional schema, enabled initialization
should create exactly these residual tables in addition to existing owner
tables:

`durable_execution_records`, `durable_event_evidence`,
`durable_execution_steps`, `durable_payload_refs`,
`durable_run_correlations`, `durable_timer_obligations`,
`durable_signal_evidence`, `wake_obligations`,
`delivery_attempt_evidence`, and `uncertainty_facts`.

Tests should reject accidental lifecycle mirrors and extra ledgers, preserve
pre-existing official 7.1 owner rows, prove rollback across the shared-state
transaction boundary, and fail closed on future durable schema metadata before
any mutation.

### Acceptance Front-Door Gate

Runtime integration proof should cover Gateway `agent` RPC,
OpenAI-compatible HTTP, OpenResponses HTTP, local `agent` commands, channel
auto-reply, queued follow-up/heartbeat turns, and isolated cron execution. Each
front door should prove durable intake before its acceptance boundary and one
fenced terminal settlement across success, failure, and cancellation races.

## Candidate Scenarios

### Disabled Paths Never Mutate

- Run CLI durable stats/list/why commands with durable runtime disabled and a
  fresh state directory; assert a non-success guidance result and no state files.
- Call Gateway durable inspection handlers with disabled runtime; assert
  `INVALID_REQUEST`, no result payload, and no SQLite files.
- Repeat with an existing non-durable state DB; disabled inspection must not add
  durable migration or runtime tables.
- Assert disabled Gateway startup does not load the durable startup, recovery,
  worker, or owner-adapter module graph.

### Runtime Opt-In Without Worker Mutation

- With durable runtime enabled and no worker flag, verify inspection can open the
  shared SQLite store and project existing records.
- Seed running/open records, start Gateway/runtime, and assert records remain
  running/open when worker recovery is disabled.
- Assert default prompts do not gain durable orchestration guidance unless
  durable runtime or explicit policy is enabled.

### Wake And Owner Attention

- Seed wake reasons including `child_terminal`, `fan_in_incomplete`,
  `restart_interrupted`, `delivery_unknown`, `side_effect_uncertain`,
  `no_handler`, and `operator_requested`.
- Assert legal transitions from `pending` to `handoff_accepted`, `acked`,
  `failed`, `suspended`, or `superseded`; from `handoff_accepted` to `acked`,
  `failed`, `suspended`, or `superseded`; and from `failed` or `suspended` only
  through their documented retry or decision paths.
- Assert only `acked` and `superseded` are terminal, and queue acceptance is not
  presented as attached-session consumption or external delivery.
- Assert duplicate wake creation from repeated child completion, worker scans,
  Gateway reports, and owner reconciliation dedupes by source revision and key.

### Restart And Side-Effect Uncertainty

- Inject failures before and after tool dispatch, provider return, channel send,
  child spawn, and local commit boundaries.
- Assert recovery appends uncertainty facts such as `unknown_after_side_effect`,
  `interrupted_during_tool`, `lost_after_dispatch`, `delivery_unknown`, or
  `requires_owner_decision`.
- Assert automatic replay is denied while uncertainty is unresolved unless replay
  gates prove authority and idempotency.

### Privacy, Retention, And Compaction

- Default persistence stores refs, hashes, bounded previews, and structured
  metadata, not raw prompts/tasks/tool payloads.
- Full input capture requires explicit opt-in and inspection authorization.
- Compaction preserves enough run, step, event, ref, claim, and recovery data to
  explain state while removing or truncating sensitive previews.

## Live Proof Policy

Runtime changes should include local or remote tests for their touched surface.
Live OpenClaw E proof is relevant only when the change claims runtime, session,
wake, worker, or delivery behavior that local tests cannot prove with
maintainer-grade confidence. Docs-only changes can state that live proof is not
applicable when they claim no runtime behavior. This plan remains subordinate to
maintainer decisions about whether durable core is a shared subsystem at all.

## Related

- [Durable Core Residual-Gap Architecture Proposal](/specs/durable-core-proposal-architecture)
