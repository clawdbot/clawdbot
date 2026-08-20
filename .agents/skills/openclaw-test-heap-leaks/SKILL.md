---
name: openclaw-test-heap-leaks
description: Investigate OpenClaw pnpm test memory growth, Vitest OOMs, RSS spikes, and heap snapshot deltas.
---

# OpenClaw Test Heap Leaks

Use this skill for test-memory investigations. Do not guess from RSS alone when heap snapshots are available. Treat snapshot-name deltas as triage evidence, not proof, until retainers or dominators support the call.

Read `../openclaw-test-performance/SKILL.md` first for the current test-performance commands and proof routing.

For **runtime fixes** (e.g., closure leaks in long-running services like the gateway), see [Validating runtime fixes](#validating-runtime-fixes-not-test-memory) below — that uses a dedicated harness rather than the unit-test profiling workflow.

## Workflow

1. Reproduce the failing shape first.
   - Match the real entrypoint and worker budget. For a broad unit-fast baseline with per-config max RSS and top-file timing, start with:

     ```bash
     pnpm test:perf:groups \
       --config test/vitest/vitest.unit-fast.config.ts \
       --allow-failures \
       --output .artifacts/test-perf/unit-fast-memory.json
     ```

   - For a suspected file, rerun that file with one worker and collect wall/RSS evidence: `/usr/bin/time -l pnpm test <file> --maxWorkers=1 --reporter=verbose`.
   - Current `pnpm test` execution is planned by `scripts/test-projects.mts`. Record the printed Vitest config or shard and preserve that shape when the report is configuration- or worker-budget-specific.

2. Collect the strongest available heap evidence.
   - Run `pnpm test:perf:profile:runner -- --output-dir .artifacts/test-perf/vitest-runner-profile -- <file>` for a CPU profile plus a sampling heap profile of the unit runner. Open the heap profile in DevTools and inspect the largest allocation families.
   - Sampling `.heapprofile` output is not a `.heapsnapshot`; do not pass it to the snapshot delta helper.
   - When a dedicated harness or another known producer emits repeated `.heapsnapshot` files, compare snapshots from the same PID with `.agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs`.
   - If no snapshot or heap profile is available, RSS growth is useful triage evidence, but keep the leak classification inconclusive.

3. Classify the growth before choosing a fix.
   - If growth is dominated by Vite/Vitest transformed source strings, `Module`, `system / Context`, bytecode, descriptor arrays, or property maps, treat it as likely retained module graph growth in long-lived workers.
   - If growth is dominated by app objects, caches, buffers, server handles, timers, mock state, sqlite state, or similar runtime objects, treat it as a likely cleanup or lifecycle leak.
   - If the names are ambiguous, stop short of a confident label and inspect retainers/dominators in DevTools for the top deltas.

4. Fix the right layer.
   - For likely retained transformed-module growth in shared workers:
   - Inspect the owning Vitest config and the process chunking in `scripts/test-projects.test-support.mjs`. Fix process lifetime or project ownership there only when the same-shape evidence shows that shared-worker retention is the cause.
   - `test/vitest/vitest.unit-fast-isolated.config.ts` is for audited stateful tests that need a fresh module graph. Do not use it as a generic memory-hotspot list.
   - For real leaks:
   - Patch the implicated test or runtime cleanup path.
   - Look for missing `afterEach`/`afterAll`, module-reset gaps, retained global state, unreleased DB handles, or listeners/timers that survive the file.

5. Verify with the most direct proof.
   - Re-run the same grouped or scoped command and confirm the max-RSS trend or OOM is reduced.
   - When a dedicated producer emits heap profiles or snapshots, repeat the same producer and compare equivalent artifacts.
   - For routing or config changes, verify the expected Vitest config or shard starts and the affected tests complete.

## Heuristics

- Do not call everything a leak. Growth in a non-isolated shared Vitest project can be a worker-lifetime problem rather than an application object leak.
- `scripts/test-projects.mts`, `scripts/test-group-report.mts`, and `scripts/run-vitest-profile.mts` are the current execution, grouped-RSS, and profile entrypoints.
- The `[test] starting ...` lines identify the Vitest config or shard to reproduce.
- `.artifacts/vitest-shard-timings.json` stores config/shard durations for scheduling. It is not a file-level memory-hotspot or behavior manifest.
- When the same retained object families grow across multiple intervals in the same worker PID, trust the snapshots over intuition, then confirm ambiguous calls with retainer evidence.

## Snapshot Comparison

- Direct comparison:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs before.heapsnapshot after.heapsnapshot`
- Auto-select earliest/latest snapshots per PID within one lane:
  - `node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs --lane-dir <snapshot-directory>`
- Useful flags:
  - `--top 40`
  - `--min-kb 32`
  - `--pid 16133`

Read the top positive deltas first. Large positive growth in module-transform artifacts points to shared-process lifetime or project ownership; large positive growth in runtime objects suggests a real leak. If the names alone do not settle it, open the same snapshot pair in DevTools and inspect retainers/dominators for the top rows before declaring root cause.

## Validating runtime fixes (not test-memory)

The workflow above is for diagnosing Vitest worker memory growth. For
validating that a runtime/closure fix actually releases captured state, use the
dedicated harness:

- `pnpm leak:embedded-run` — runs `scripts/embedded-run-abort-leak.ts`. Loops N
  aborted runs in a function-shaped scope mimicking `runEmbeddedAttempt`,
  writes heap snapshots, and reports a PASS/FAIL verdict on retention growth
  using `FinalizationRegistry` for tracked-instance counting plus RSS delta.

Modes:

- `closure-extracted` (default) — production fix shape (helper at module scope).
- `closure-inline` — pre-fix shape (closure inside the runner scope). Use as a
  sensitivity check: if it passes you've broken the harness, not fixed a bug.
- `synthetic-leak` — deliberately retains via a module-level bucket. Use to
  confirm the harness can detect leaks before trusting a PASS on a real fix.

Snapshots land in `.tmp/embedded-run-abort-leak/`. Diff with the same script
as above:

```
node .agents/skills/openclaw-test-heap-leaks/scripts/heapsnapshot-delta.mjs \
  .tmp/embedded-run-abort-leak/baseline-*.heapsnapshot \
  .tmp/embedded-run-abort-leak/batch-N-*.heapsnapshot --top 30
```

When fixing a different runtime leak, add a new harness alongside this one
rather than retrofitting it. The fixture function should mimic the lexical
scope of the function where the leak lives, not be a generic abort-loop.

## Output Expectations

When using this skill, report:

- The exact reproduce command.
- Which Vitest config or target was reproduced, and which PID was compared when snapshots were available.
- The dominant retained object families from the heap profile or snapshot delta, when available.
- Whether the issue is a likely real leak or likely shared-worker retained module growth, plus whether retainers/dominators confirmed it.
- The concrete fix or impact-reduction patch.
- What you verified, and what snapshot overhead prevented you from verifying.
