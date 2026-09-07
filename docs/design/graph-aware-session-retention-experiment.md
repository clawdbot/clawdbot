---
title: "Graph-aware session retention experiment"
summary: "A measurement-only benchmark comparing session cleanup ordering policies."
read_when:
  - Evaluating changes to session cleanup ordering
  - Reproducing the graph-aware retention benchmark
---

# Graph-aware session retention experiment

## Problem statement

OpenClaw's session maintenance already owns cleanup eligibility, protection, archive planning,
snapshot validation, retries, and the atomic grouping of state that shares an owner. Its current
candidate order does not try to estimate how relationships between eligible sessions affect later
recovery value.

This measurement-only prototype asks how ranking the cleanup planner's already-eligible ownership
groups with lineage, access, generation, fan-out, transcript, and size metadata changes a fixed,
policy-independent evaluation proxy at the same reclaim target.

The experiment is inspired by a relationship-aware principle described in Heming Zeng's FAGR
research: evaluate relationships between stored units before optimizing individual units. It is
not a port of FAGR, uses no FAGR code, and makes no claim of algorithmic or research equivalence.

## Existing safety boundary

The experiment starts after OpenClaw's existing authorities have completed their work:

1. `applySessionEntryMaintenance` applies the canonical active-work, live-reference, recent-entry,
   and other protection rules and produces a maintenance plan.
2. `buildSessionMaintenanceOwnershipGroups` applies the same union-find ownership grouping used by
   maintenance batching. A group is indivisible.
3. The read-only projection loads metadata only for those groups.
4. Experimental policies rank and explain those eligible groups for comparison. They never commit
   or finalize the maintenance plan.

The prototype does not change cleanup ordering, mutations, archive behavior, schema, configuration,
protocols, transactions, or ownership semantics. The production change is a behavior-preserving
export of the existing ownership-group constructor so the benchmark consumes the canonical owner
instead of reproducing it.

## Hypothesis

At a fixed byte-reclamation target, a relationship-aware eviction ordering will preserve more of a
uniform policy-independent evaluation proxy than current planner order in workloads with meaningful
forks, generations, or mixed disk pressure. It should be neutral in unconnected workloads and
should not require schema changes or large in-memory event graphs.

This is an experimental hypothesis. The evaluator is held out from candidate ranking weights, but it
shares the same projected features and normalization. It is a proxy, not observed user recovery
success or empirical ground truth.

## Model and feature definitions

The ranking unit is an existing cleanup ownership group. The SQLite adapter projects session nodes,
generation windows, and bounded transcript aggregates; it never projects transcript event JSON or
archive blobs into JavaScript.

The model uses:

- activity recency: latest valid activity, interaction, or update timestamp;
- access recency: latest valid read or interaction timestamp;
- lineage centrality: count of parent, child, previous-generation, and fork-source group edges;
- direct fan-out: direct child count plus fork fan-out;
- descendant reach: iterative, cycle-safe traversal of child group edges;
- generation continuity: generation count plus `previous_session_id` link count;
- transcript evidence: `log1p(event count) + log1p(parent-linked event count)`;
- estimated recovery cost: a bounded logarithmic combination of event count, reclaimable bytes,
  and generation count;
- estimated reclaimable bytes: SQL-aggregated `SUM(LENGTH(event_json))` plus bounded node, window,
  and event metadata estimates.

Recency comes from session-node timestamps. Generation-window timestamps are lifecycle-write times
and are deliberately excluded from the synthetic recency signal; windows contribute topology and
generation counts instead. This keeps independently created benchmark fixtures deterministic.

`spawned_by` is treated as a parent edge only because its current repository semantics identify the
requesting/spawning session. Fork source fields remain separate edges.

Missing timestamps receive a neutral normalized value of `0.5`; invalid numeric inputs become zero.
Scores are rounded to a fixed precision, contain no random input, and use planner order, then
`updated_at`, then group ID as stable tie-breakers. Least-recently-active falls back in this order:
`last_activity_at`, `last_interaction_at`, `last_read_at`, `updated_at`; a fully missing timestamp is
sorted after known timestamps.

## Policies and formula

The benchmark compares:

- **existing-order:** the exact canonical planner/ownership-group order;
- **least-recently-active:** the documented timestamp fallback, oldest known first;
- **size-first:** estimated reclaimable bytes, largest first;
- **graph-aware:** relationship-forward weights;
- **graph-aware-balanced:** an alternate, more recency-oriented sensitivity set.

The two candidate ranking weight sets sum to 1.0. A third, frozen uniform set is used only for
evaluation and is never passed to `rankRetentionGroups`:

| Feature               | Primary | Alternate | Evaluation |
| --------------------- | ------: | --------: | ---------: |
| Activity recency      |    0.20 |      0.28 |        1/7 |
| Access recency        |    0.10 |      0.16 |        1/7 |
| Lineage centrality    |    0.14 |      0.10 |        1/7 |
| Direct fan-out        |    0.16 |      0.10 |        1/7 |
| Descendant reach      |    0.16 |      0.10 |        1/7 |
| Generation continuity |    0.14 |      0.14 |        1/7 |
| Transcript evidence   |    0.10 |      0.12 |        1/7 |

For each feature `f`, the explanation records raw value, cohort-normalized value, candidate weight,
and `normalized(f) * candidateWeight(f)`. Their sum is the candidate's ranking value. The evaluator
instead uses the arithmetic mean of all seven normalized features. The uniform evaluator was chosen
and frozen before its benchmark output was inspected; no candidate policy can tune or select it.

```text
rankingValue = sum(normalized(f) * candidateWeight(f))
policyIndependentEvaluationValue = sum(normalized(f)) / 7
estimatedRecoveryCost = max(1,
  1 + log1p(eventCount) + log1p(reclaimableBytes) / 8 + log1p(generationCount))

evaluationPriority = policyIndependentEvaluationValue / estimatedRecoveryCost
evictionPriority = normalizedReclaimableBytes / (0.05 + rankingValue)
```

Eviction sorts descending by candidate-specific eviction priority. All reported per-policy
value-preservation, dependency-weighted, and high-value metrics are computed separately with the
uniform evaluation set. The value-by-cost curve characterizes the unchanged workload cohort under
that same evaluator, so it is emitted once as a workload-level baseline rather than repeated inside
each policy result. That separation prevents a candidate from being rewarded with its own weights
or a cohort baseline from being mistaken for a policy outcome. The evaluator remains a synthetic
proxy that shares the feature projection; it is not an independent real-world recovery outcome.
Both ranking and evaluation formulas are internal and are not public configuration.

## Workloads and failure models

All fixtures use production session writers against disposable SQLite stores created by the
benchmark-owned `createDisposableRetentionState`, which uses `fs.mkdtemp`, `os.tmpdir`, and an
isolated `OPENCLAW_STATE_DIR`. State is removed in `finally` blocks.

- **A — isolated stale bulk:** independent old sessions with varied bounded transcript sizes;
- **B — fork fan-out:** fork sources and descendants mixed with similarly old isolated sessions;
- **C — generation chain:** linked current and historical windows, with current protection left to
  the canonical planner;
- **D — spawn tree:** parent/subagent relationships using verified `spawned_by` semantics;
- **E — mixed disk pressure:** small connected groups, large isolated groups, recent and pinned
  entries, stale history, and shared multi-session ownership groups.

Every workload also materializes one stale, unpinned fixture and supplies that exact generated key
as the canonical planner's active session. The active fixture deliberately uses an otherwise
eligible non-primary key: primary `agent:<id>:main` sessions have a separate preservation rule and
would not isolate the active-key boundary. The report fails if the active fixture's key or state IDs
reach either the deletion plan or the projected ranking candidates, and records one materialized
active fixture per workload. A control plan first uses a nonmatching active key and must include the
fixture as a deletion candidate, proving that the exact-key zero-violation result exercises
active-session protection rather than another preservation rule.

Smoke uses about 100 groups and default about 1,000 across the five workloads.

## Run the benchmark

Run the supported package command from the repository root. Both modes write a machine-readable
report to `.artifacts/session-retention-analysis/<mode>.json`; the command exits nonzero if it
observes an active-session planning or ranking violation, protected-group violation,
ownership-group split, or store mutation.

```bash
pnpm sessions:retention:benchmark --mode smoke
pnpm sessions:retention:benchmark --mode default
```

## Default benchmark results

The table is from one representative Node 24.19.0 run. Each policy selects whole ownership groups
until it meets the same per-workload target (25% of estimated eligible bytes). “Independent value”
is the fixed uniform evaluation proxy, not a candidate policy's ranking score. Per-policy runtime and
heap measurements cover only that policy's ranking and evaluation; they exclude the shared
workload-level value-by-cost baseline. Runtime and heap measurements are observational, not CI
thresholds, and are expected to vary in later proof artifacts.

| Workload         | Policy               | Bytes selected | Independent value | Runtime (ms) | Heap delta (bytes) |
| ---------------- | -------------------- | -------------: | ----------------: | -----------: | -----------------: |
| isolated         | existing             |         89,049 |           79.6896 |        7.295 |          2,325,344 |
| isolated         | LRA                  |         89,049 |           79.6896 |        4.690 |          2,225,024 |
| isolated         | size-first           |         88,254 |           79.0982 |        5.057 |          2,251,016 |
| isolated         | graph-aware          |         89,057 |           80.2112 |        4.447 |          2,256,936 |
| isolated         | graph-aware-balanced |         88,193 |           80.8171 |        3.174 |          2,204,840 |
| fork fan-out     | existing             |         79,537 |           54.2841 |        6.147 |          2,174,792 |
| fork fan-out     | LRA                  |         78,990 |           58.6894 |        5.861 |          2,200,728 |
| fork fan-out     | size-first           |         80,475 |           58.8729 |        5.444 |          2,177,360 |
| fork fan-out     | graph-aware          |         79,387 |           60.5180 |        3.283 |          2,150,336 |
| fork fan-out     | graph-aware-balanced |         80,770 |           60.5313 |        3.271 |          2,156,264 |
| generation chain | existing             |        125,770 |           73.4577 |        4.004 |          2,493,944 |
| generation chain | LRA                  |        125,770 |           73.4577 |        3.183 |          1,379,792 |
| generation chain | size-first           |        125,652 |           74.3149 |        3.718 |          2,163,248 |
| generation chain | graph-aware          |        127,408 |           74.6903 |        2.938 |          2,178,024 |
| generation chain | graph-aware-balanced |        127,088 |           74.7363 |        2.899 |          2,179,600 |
| spawn tree       | existing             |         73,389 |           63.3110 |        6.731 |          2,146,016 |
| spawn tree       | LRA                  |         74,113 |           67.3563 |        5.978 |          2,167,280 |
| spawn tree       | size-first           |         72,816 |           60.5135 |        4.732 |          2,147,288 |
| spawn tree       | graph-aware          |         72,816 |           60.5568 |        4.394 |          2,150,688 |
| spawn tree       | graph-aware-balanced |         72,816 |           60.5568 |        3.084 |          2,149,360 |
| mixed pressure   | existing             |         84,467 |           38.3405 |        2.430 |          1,457,008 |
| mixed pressure   | LRA                  |         83,770 |           35.5690 |        2.221 |          1,474,104 |
| mixed pressure   | size-first           |         83,701 |           36.8575 |        2.172 |          1,456,576 |
| mixed pressure   | graph-aware          |         83,826 |           39.6483 |        2.323 |          1,467,008 |
| mixed pressure   | graph-aware-balanced |         83,806 |           39.4713 |        2.257 |          1,472,760 |

Negative heap deltas reflect garbage collection between `heapUsed` observations, not negative memory
allocation.

## Computer cost observations

Default projection, the shared workload baseline, and all five policy evaluations completed in tens
of milliseconds per workload. The workload-level `analysisRuntimeMs` includes all three phases;
each policy's `runtimeMs` covers only its own ranking and evaluation, so the five policy timings do
not sum to total analysis time. Positive post-analysis heap deltas were in the tens of megabytes;
garbage collection made one workload delta negative.
Each 200-group workload used four SQL queries, except generation chains (seven); mixed pressure
projected 140 eligible groups from 220 sessions in four queries.

Both smoke and default reports recorded zero active-session planning or ranking violations, zero
protected-group violations, zero ownership-group splits, and zero store mutations. Generated JSON
is written under the ignored
`.artifacts/session-retention-analysis/` directory and includes the repository commit, Node version,
fixture version, policies, candidate ranking weight sets, the separate evaluation weight set, input
counts, outputs, timings, and invariants.

## Limitations

- The policy-independent evaluator is a uniform proxy over the same projected features. It is held
  out from candidate weights but is not an observed recovery outcome or empirical ground truth.
- Cohort min/max normalization makes scores comparative within one cleanup plan.
- Estimated reclaimable bytes include metadata constants rather than exact SQLite page recovery.
- Descendant traversal is iterative, but worst-case dense graphs need further complexity
  measurement.
- Post-analysis `heapUsed` deltas are sensitive to garbage collection and are not peak RSS.
- The spawn-tree loss shows that the eviction formula can overvalue byte yield relative to connected
  structure; the feature model should not be promoted unchanged.
- Synthetic workloads exercise production storage APIs but cannot establish real-world prevalence or
  user value.

## Decision and proposed next step

The evidence supports a narrow follow-up because two candidate ranking sets retain more of the fixed
policy-independent proxy in relationship-heavy fork, generation, and mixed workloads without schema
changes or safety violations. It does not establish real recovery value or support changing
production cleanup order: the spawn-tree regression, synthetic proxy, and computational cost require
more evidence.

The next step should be a maintainer RFC or opt-in dry-run explanation that samples anonymized
aggregate shapes and validates the proxy against recovery tasks. A recovery-ordering or disk-budget
ranking experiment could follow only after that review. No public CLI, configuration, or cleanup
mutation change belongs in this prototype.
