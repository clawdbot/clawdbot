# WO-1217 final pre-proof drift absorb `18c9f27e` — lane journal

Governing workorder: `.specify/workorders/WO-1217-ABSORB-18C9F27E-FINAL-GATES.md`
@ bootstrap commit `c78961a6bf22e00125be6641050f20867a45fb37`.

Lane: 🌿 frond-scribe-copilot. Branch `scribe/20260802/1217-final-drift-18c9f27e`.
This file is the runbook journal (PR-DRIFT-CURE-GATES-RUNBOOK "journal-as-declare-done-substrate").
It is deleted in a normal final cleanup commit before product handoff.

---

## §1 — Gate 1 identity (verified 2026-08-02, post re-fetch)

Re-fetched `origin` and `upstream` before any motion.

| Identity | Value | Verdict |
|---|---|---|
| Branch | `scribe/20260802/1217-final-drift-18c9f27e` | ✅ |
| Branch HEAD before merge (exact first parent) | `47c4169ea9294ced5dde6b6278034b1749eb5526` | ✅ exact |
| Accepted tree at first parent | `2597d75c5ce08428667f625e1e411d9053c35584` | ✅ matches WO snapshot |
| Exact upstream second parent | `18c9f27e2de3cb1d3ac6555588a356d56c6fd9bb` | ✅ resolves; ancestor of `upstream/main` |
| merge-base(47c4169, 18c9f27e) | `0ea8d565f2c293890f05ede739348e2900f5e945` | ✅ prior absorb SHA |
| Accepted F1 remote `origin/scribe/20260802/1217-retry-exhaustion-outcome` | `47c4169ea9294ced5dde6b6278034b1749eb5526` | ✅ unchanged |
| Savegame `origin refs/heads/savegame/20260803-0057Z/1217-pre-final-drift-47c4169` | `47c4169ea9294ced5dde6b6278034b1749eb5526` | ✅ re-read via `git ls-remote` |
| Protected presentation `origin/feature/context-pressure-squashed` | `f187917c92bde28943de6d4ba959685bba73490b` | recorded, untouched |
| Presentation `origin/feature/context-pressure` | `3ebac2c217dd0e24fe01f7c4a0d1733f81924166` | recorded, untouched |

Working tree was clean (`git status --short` = 0 lines) before any motion.

### Drift metrics at merge time

| Metric | Value | vs WO snapshot |
|---|---|---|
| Accepted head behind exact upstream | 252 commits | ✅ identical |
| Accepted three-dot feature surface vs exact upstream | **718 paths** | ✅ identical |
| Our side changed paths (`merge-base..47c4169`) | 718 | — |
| Upstream side changed paths (`merge-base..18c9f27e`) | 1303 | — |
| Both-touched intersection (conflict-risk surface) | **75 paths** | — |

### Later upstream movement (recorded, NOT chased)

- WO snapshot fork main `c5ef79f9863578e82a7afd5c8ad65fb27412c6f8` has since advanced:
  `origin/main` is now **exactly `18c9f27e2de3cb1d3ac6555588a356d56c6fd9bb`** — the fork
  mirror caught up to our exact merge input. Fork main is therefore no longer 8 behind.
- `upstream/main` is now `d9669ce72cbe31ff8e1ae66de03f34f2014a4f1e`
  = **3 commits / 22 paths** ahead of exact `18c9f27e`.
- Per WO scope boundary: merge input stays exact `18c9f27e`. The 3-commit / 22-path
  delta is reported for the eventual tiny post-proof drift correction, not absorbed here.

---

## §0 — Gate 0 bounded GitNexus (ONE attempt, banked)

**Result: BANKED-UNUSABLE → direct source/history fallback per WO authority.**

One attempt spent. `gitnexus` binary present (`/home/figs/.local/bin/gitnexus`).
No index exists in this worktree or in `source/openclaw`. The only openclaw-class
index on the seat is at
`source/WORKTREES/openclaw-1144-assembly-review-followups/.gitnexus`:

- `lastCommit` = `2ed7288ffcdca5cccbd07927f4c028a637ab6fa2`, `indexedAt` 2026-07-02T17:39Z
- distance to exact head `47c4169`: **13,520 commits**, **26,157 changed paths**

That is not an exact-head index and cannot answer an exact-head blast-radius question.
Re-indexing at exact head is a ~13min/1.3GB monolithic build whose output would be
discarded at the merge commit; the WO caps Gate 0 at one usable path. Banked as stale;
Gate 0 answered below from direct git history + source read.

### Gate 0 fallback — changed-surface / affected-flow map

F1 + continuation successor direct blast radius (the surface that must survive):

- five #1219 commits `e9b61433042 → 47c4169ea92` touch **17 paths**;
- continuation successor `1152a3745c8` touches 2 paths.

**Finding: 0 of the 17 #1219 paths are touched by upstream in `merge-base..18c9f27e`.**
The F1 correction chain is textually isolated from this drift. The only successor-side
intersection is `1152a`'s `src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts`.

Overlap of the 75 both-touched paths with the WO-named risk domains:

| Domain | Both-touched paths |
|---|---|
| session delivery / dispatch | `embedded-agent-subscribe.handlers.messages{,.test}.ts`, `embedded-agent-subscribe{,.handlers.tools.test,.handlers.types}.ts`, `agent-runner-execute.ts`, `agent-runner-execution{,.types,.test-support}.ts`, `agent-runner-run.ts`, `get-reply-run-execute.ts`, `chat-send-handler.ts`, `chat-send-dispatch-errors.ts`, `session-accessor.ts` |
| gateway startup / lifecycle | `server-lifecycle.ts`, `server-maintenance.ts`, `server-close{,.test}.ts`, `server-chat{,.agent-events.test}.ts`, `chat-abort.ts`, `mcp-http.runtime.ts`, `server-runtime-subscriptions.ts`, `config-reload.test.ts` |
| compaction | `run.overflow-compaction{,.loop}.test.ts`, `commands-compact.ts`, `sessions-compact.ts`, `server.sessions.compaction.test.ts` |
| subagents | `subagent-registry-read.ts`, `subagent-spawn{,.test}.ts`, `spawn-pipeline.ts`, `subagent-registry.{archive.e2e,persistence.resume}.test.ts`, `sessions-spawn-tool.test.ts`, `docs/tools/subagents.md` |
| telemetry / diagnostics | `diagnostic{,.test}.ts`, `diagnostic-stability.ts`, `diagnostic-events.ts` |
| tool registration | `openclaw-tools{,.sessions.test}.ts`, codex `dynamic-tools{,.test}.ts`, `dynamic-tool-build{,.test}.ts`, `side-question{,.test}.ts` |
| TaskFlow | `task-registry.test.ts` |
| prompt snapshots | 5 `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/*` |

### Gate 0 pre-merge conflict prediction

`git merge-tree --write-tree` dry run (no working-tree motion) predicted **15 conflicts**,
none in the 17 #1219 paths. These are the high-risk manual-composition candidates.

---

## §2 — Merge execution and manual resolutions

Merge: `git merge --no-ff 18c9f27e...` (invoked with `-c merge.conflictstyle=zdiff3`
per-invocation so the base side of each conflict was visible; no persistent repo
config mutated, no `rerere` preseeding).

- Merge commit: `b5bc4347c0d63ce574741f4cf2d45bcfab87002b`
- First parent: `47c4169ea9294ced5dde6b6278034b1749eb5526`
- Second parent: `18c9f27e2de3cb1d3ac6555588a356d56c6fd9bb`
- Merge tree: `0567a6eb7d477a1d4fdd92a7eea208c8398a41d9`
- 15 conflicts, all hand-resolved. No `-X ours/theirs`, no wholesale side-accept
  except one file where the wholesale choice is itself the reasoned resolution
  (row 13 below) and is compensated by an explicit re-home.

Scoped `AGENTS.md` read before resolving in each subtree: `src/agents/`,
`src/agents/tools/`, `src/agents/embedded-agent-runner/run/`, `src/gateway/`,
`src/gateway/server-methods/`, `test/`, plus product root `AGENTS.md`.

### Manual-resolution table

| # | Path | Conflict class | Resolution | Both behaviors preserved? |
|---|---|---|---|---|
| 1 | `src/agents/subagent-registry-read.ts` | import move vs our added import | upstream module path `infra/agent-run-registry.js` for `getAgentRunContext` + kept our `deriveContinuationDelegateChildRunId` | yes — verified `agent-events.ts` no longer re-exports the registry symbols |
| 2 | `src/agents/tools/media-generate-background-shared.ts` | same import move | upstream path for `clear/registerAgentRunContext` + kept our `formatActiveContinuationTraceparent` | yes |
| 3 | `src/auto-reply/reply/agent-runner-execute.ts` | both sides added a distinct interface field | union; alphabetical order preserved | yes |
| 4 | `src/agents/openclaw-tools.sessions.test.ts` | disjoint import additions | union (gateway-work-admission + our agent-db closer) | yes |
| 5 | `src/agents/spawn-pipeline.ts` | our `summarizeSpawnError` extraction vs upstream `SpawnPipelineParams<TState>` refactor | adopted upstream type refactor; kept our re-export from `./spawn-error.js`; dropped upstream's inline duplicate definition | yes — bodies byte-identical, so upstream behavior intact and no duplicate export |
| 6 | `src/agents/subagent-spawn.ts` | upstream added `reservation` to admission object; we renamed `childIdem`→`resolvedChildIdem` | union of both | yes — both symbols verified present in merged file |
| 7 | `src/gateway/server-methods/sessions-compact.ts` (hunk 1) | disjoint import additions | union | see §3 fallout — over-preserved `clearSessionQueues`, corrected in `cafe55e4075` |
| 8 | `src/gateway/server-methods/sessions-compact.ts` (hunk 2) | disjoint import additions | union (`createSubsystemLogger` + `getCommandLaneSnapshot`) | yes |
| 9 | `src/logging/diagnostic.ts` | both sides added a distinct guard condition | union of all four conditions | yes — `hasPersistentDegradation` + `hasContinuationQueueWarn` both present |
| 10 | `src/agents/embedded-agent-subscribe.handlers.messages.ts` | our helper extraction vs upstream's new inline reset line | kept `resetMessageEndStreamingState(ctx)` **and folded upstream's `ctx.state.thinkingTagStream = createThinkingTagStreamState()` into the helper** | yes — see semantic note below |
| 11 | `src/tasks/task-registry.test.ts` | upstream registry import move vs our `heartbeat-wake-contracts` type split | union of both refactors | yes |
| 12 | `src/gateway/config-reload.test.ts` | upstream added a hot-path matrix; we added two no-op paths | union, in upstream's flat `it.each` style to match the common trailing region | pending Gate 2.5 empirical confirmation |
| 13 | `src/agents/embedded-agent-runner/run.overflow-compaction.loop.test.ts` | upstream replaced the file (#118184) | resolved to **exact upstream blob** + re-homed our 2 feature assertions | yes — see decision note below |
| 14-16 | 3 × `test/fixtures/.../codex-runtime-happy-path/*.md` | generated counts moved on both sides | recomputed merged values | yes — derivation validated on all three sides |

### Semantic note — row 10 (upstream fix would have been silently dropped)

Three-side walk: merge-base and our head have **one** message-end reset block;
upstream has the same block inside its `finalizeMessageEnd` closure and added
exactly one new line to it (`70876c9790e`, #118192 streaming hot-path rescans).
Our branch had extracted that block into `resetMessageEndStreamingState`.

Taking our side verbatim would have kept the extraction and **dropped upstream's
new `thinkingTagStream` reset entirely** — a zero-conflict silent revert of an
upstream fix, i.e. exactly the frozen-wall class. Resolution folds the upstream
line into the helper, so it fires at every reset site.

### Decision note — row 13 (the crux of this merge)

Upstream `a6ad60a2470` (#118184, "replace broad overflow loop coverage")
deliberately shrank this file 1384 → 141 lines, redistributing into 5 new files
(`run.attempt-normalization.direct`, `run.overflow-compaction.misc-owners`,
`run.overflow-context-recovery`, `run.session-prompt-state`, `run.terminal-timeout`)
— all five land cleanly in the merge as new files. It also **removed this path
from `config/max-lines-baseline.txt`**, and that removal auto-merged.

Measured, not assumed:
- 38 of 39 merge-base `it()` titles do not survive anywhere in upstream — the
  split is a genuine rewrite, not a 1:1 move.
- Our branch's entire delta on this file is **+20 lines / 2 additions** (1152a).
- The file's already-merged prefix (lines 1-48) is upstream's new content, so
  keeping our hunks would have produced an incoherent file (upstream imports over
  our old bodies, referencing file-local helpers no longer imported).
- Keeping our 1404-line body while accepting the baseline removal would fail the
  max-lines ratchet.

Resolution: take the exact upstream blob (verified `4a502addbb55…` ==
`18c9f27e:<path>`) and **re-home both feature assertions** into the surviving
owner `run.overflow-compaction.test.ts`, which is still baselined and already
uses the same `overflowBaseRunParams` / `mockOverflowRetrySuccess` / harness
surface our old file imported (`overflowBaseRunParams as baseParams`). The
file-local `expectLogIncludes` / `expectLogExcludes` helpers were re-added there
verbatim. Owning proof is the Gate 2.5 run of that file.

### Note — rows 14-16 (generated snapshot counts)

Neither side's number is correct for the merged tree. The owning tool-snapshot
JSON merged cleanly and its deltas are exactly additive (base 5405 → ours +71,
upstream +34, merged +105). Validated on all three sides of all three fixtures:
`roughTokens = ceil(chars/4)` and `total = totalTextOnly + dynamicToolsJson + 2`.
Merged `dynamicToolsJson.chars = base + 67 + 34`. Values applied:
discord 61557/15390 + 89753/22439; telegram-direct 61249/15313 + 87965/21992;
telegram-heartbeat 62783/15696 + 89915/22479. Authoritative verifier is
`prompt:snapshots:check` at Gate 3.

---

## §Gate 2 — primitive-core preservation

Canonical walker `tools/feature-cores-byte-check.sh`, PR head `47c4169…`,
candidate `b5bc4347c0d`, upstream `18c9f27e…`, 35-entry canonical cores list.

**34/35 preserved**: 30 PASS · 2 PASS-UPSTREAM (`src/agents/openclaw-tools.ts`,
`ui/src/lib/config/index.ts`) · 2 PASS-TOMBSTONE · 1 FAIL.

The single FAIL is `run.overflow-compaction.loop.test.ts` — the row-13 file. It
is not a mechanical waiver: it takes the runbook's explicit
manual-semantic-review-with-owning-proof path, per the decision note above.
Artifact: `gate-2-primitive-cores.txt`.

Surfaced for cohort: the cores list still names this path, but upstream has
gutted it. Updating `tools/drift-cure-gate.primitive-cores.txt` requires
PR-with-cohort-cosign and is outside this lane's authority.

---

## §Gate 2.7 — frozen-wall classifier

`tools/drift-cure-gate.sh 18c9f27e… HEAD "" /tmp/wo1217/gate-out` → **exit 0**.

- files examined: **717**
- GENUINE 459 · SAFE-NEW 258
- **FROZEN-STALE 0 · MIXED-CLOBBER 0 → zero unresolved rows** ✅

Full reclassification done as required (the prior 713-row receipt used only as
comparison substrate; this is 717 rows against exact current upstream, +4).

Count reconciliation, byte-checked:
- pre-merge three-dot feature surface `18c9f27e…47c4169` = **718**
- post-merge candidate vs exact upstream = **717**
- exactly one path drops out: `run.overflow-compaction.loop.test.ts` (now
  byte-identical to upstream)
- **zero newly-appearing paths** — the merge introduced no feature-surface expansion
