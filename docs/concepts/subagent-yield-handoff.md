---
summary: "Ownership of subagent completion and progress when a requester yields"
read_when:
  - Changing nested subagent completion or sessions_yield behavior
  - Designing progress delivery that outlives a requester turn
title: "Subagent yield handoff"
---

# Subagent yield handoff

The subagent registry owns completion across `sessions_yield`. A yielded
execution ends; the delegated task and its completion audience remain. The
registry's requester settlement batch starts a successor turn after the
children settle. Gateway admission attaches that successor to a paused
subagent when necessary, preserving its original requester.

This design applies equally to an orchestrator spawned from an interactive
session and one spawned from an isolated cron run. Cron owns delivery of the
scheduled result, while the registry owns the nested orchestrator's continuation.

## Ownership through the handoff

| Phase                | Owner                                         | Required handoff                                                                                                                           |
| -------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Executing requester  | Admitted agent turn                           | Children identify the spawning turn with `requesterTurnRunId`. Progress callbacks use this turn's live authority.                          |
| Explicit yield       | Registry requester-yield settlement           | Persist yield intent, freeze the child run IDs, advance the batch generation, and clear the old requester-turn binding.                    |
| Waiting for children | Registry lifecycle and `requesterSettleWake`  | Retain captured completion results and schedule the owed batch. Individual announcements must not start a competing continuation.          |
| Settlement dispatch  | Requester-settle wake delivery                | Validate the current batch and Gateway owner, dispatch an idempotent internal continuation for a nested requester, and record its outcome. |
| Successor admission  | Gateway task tracking and paused-run adoption | Continue the paused task under the newly admitted run ID, preserving requester lineage and its outstanding settlement obligation.          |
| Successor completion | Registry completion delivery                  | Deliver the orchestrator's result to its original requester. Cron's existing continuation and delivery policy own the scheduled output.    |

The implementation owners are `subagent-registry-requester-yield.ts`,
`subagent-announce.requester-settle-wake.ts`, and
`agent-task-tracking.ts`. `adoptPausedSubagentRunForFollowUp` uses the existing
registry replacement operation; it does not create a second delegated task.

Settlement dispatch uses `subagent_settle` input provenance. Individual
announcements and the older descendant-wake path retain `subagent_announce`:
the latter already owns its run replacement after dispatch and must not trigger
paused-run adoption at admission. Provenance classifies the handoff; live
Gateway admission and registry ownership still authorize it.

An explicit yield batch must be eligible at any requester depth. The ordinary
nested-wave exclusion remains: nested runs without a yielded batch use the
existing descendant-settle path. The top-level cron exclusion also remains;
starting an independent requester-settle turn for the cron session would compete
with its scheduler-owned continuation.

## Invariants

- **One completion owner.** Yield transfers ownership before closing the old
  execution. An existing visible-final receipt for the exact turn and child
  batch prevents rearming an already fulfilled obligation. Successful batch
  settlement retires that generation; a repeated callback cannot finalize it again.
- **No revived authority.** Neither a stored run ID nor provenance revives a
  closed execution. The successor passes normal Gateway admission and receives
  fresh execution authority. Adoption preserves task lineage, not old tool,
  approval, channel, or worker callbacks. Cancellation, reset, and owner
  replacement retain their existing admission and cleanup gates.
- **Stable audience.** A nested wake uses internal delivery. A settlement
  continuation targeting a live `sessions_yield`-paused row adopts that row;
  ordinary inter-session messages remain untracked. Explicit plugin follow-ups
  naming a new requester continue to create their own delivery obligation.
- **Deterministic batches.** Frozen run IDs are sorted. Findings use creation
  time, completion time, and child session identity as tie-breakers. Superseded
  child rows are excluded. Batch identity includes requester identity, child
  IDs, and yield generation.
- **Bounded delivery.** Existing limits remain: three attempts, three ambiguous
  transport replays, and ten stale deferrals. Active descendants do not consume
  the stale-deferral budget. Findings are capped at 4,096 characters, individual
  results at 512, and route notices at 1,024. Ambiguous replay reuses its attempt
  key; it does not assert global exactly-once delivery across Gateway restarts.

## Progress after yield

Channel-visible progress across yield remains follow-up work. The old agent
turn closes its admission authority and channel dispatch cleans up its draft.
Keeping those callbacks alive would write through a closed owner.

A future publisher belongs to the registry settlement lifecycle while the
requester is paused, then hands presentation to the admitted successor. It must
bind publications to the current requester, batch generation, and channel
delivery owner; coalesce bounded updates in deterministic child order; reject
stale callbacks after cancellation or reset; and transfer or close a draft once.
It must reuse channel presentation policy without adding channel-specific
behavior to the registry. This repair adds neither that publisher nor a public
harness capability.

Cron's existing observer follows active descendant run IDs and a bounded
synthesis grace period. It does not wait for every registry settlement phase.
A delay between the last worker ending and successor admission can therefore
reach its existing fallback policy. Making cron wait on full task settlement,
and resolving reports of indefinitely pending delivery after a finalized cron
run, require separate scheduler-lifecycle proof; this repair does not redefine
those contracts.

See [Subagents](/tools/subagents#tool-sessions_yield) for tool behavior and
[Progress drafts](/concepts/progress-drafts) for channel presentation.
