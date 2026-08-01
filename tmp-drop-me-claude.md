# WO1214 lane journal — absorb frozen upstream drift into continuation assembly

Seat: emeric (prince node). Agent: GitHub Copilot CLI in durable tmux.
Issue: https://github.com/karmaterminal/openclaw/issues/1214
Workorder: `openclaw-bootstrap:.specify/workorders/WO1214-drift-absorb.md`

Lane scope: **draft-only preparation**. No assembly motion, no proof transposition,
no deploy, no broad fleet CI, no newer-upstream chase. Certifying Project 86 proofs
(Cael's lane) remain the release priority; this lane must not consume that lane.

Journal discipline per `RUNBOOKS/PR-DRIFT-CURE-GATES-RUNBOOK.md`
("journal-as-declare-done-substrate", figs canon 2026-05-29 post-N+8):
append-only, timestamped section per phase, reasoning over byte-mechanics.
Removed from the final tree in a normal cleanup commit before the draft PR;
history preserved (never squashed, never amended).

---

## Phase 0 — immutable preflight (2026-08-01T19:35Z)

### Exact inputs verified at byte

| Input                                               | Value                                                                   | Verification                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_BOOTSTRAP`                                | `/home/figs/actions-runner/_work/openclaw-bootstrap/openclaw-bootstrap` | repo root, git-clean of lane artifacts                                                                                     |
| OpenClaw canonical clone                            | `/home/figs/flesh_beast_best_beast/source/openclaw`                     | `git worktree list` — shared clone, 5 pre-existing worktrees                                                               |
| Assembly branch                                     | `scribe/20260709/1172-status-row-assembly`                              | `git ls-remote origin` → `a837e2b0fe7adc4f71d0c0f2446a2d18a34e28ee`                                                        |
| Assembly SHA (frozen)                               | `a837e2b0fe7adc4f71d0c0f2446a2d18a34e28ee`                              | matches workorder exactly; `cat-file -t` = commit; `test: isolate compact abort session state` (2026-07-31 20:06:44 -0700) |
| Upstream SHA (frozen)                               | `acf28495b1ae8b911c38a9980eea303709f7a64f`                              | `cat-file -t` = commit; `fix(ci): repair plugin prerelease validation (#117562)` (2026-08-02 03:29:21 +0800)               |
| Frozen upstream is ancestor of live `upstream/main` | yes                                                                     | `git merge-base --is-ancestor` exit 0; live `upstream/main` = `2f92c17db6e3f46e59c979038b1e476bdb2628a2`                   |
| Working branch                                      | `emeric/20260801/1214-absorb-acf28495`                                  | absent locally and on `origin` → no unreviewed work to clobber                                                             |

The assembly ref did **not** move between workorder authorship and dispatch, so no
halt-and-notify was required (workorder Phase 0.5). Recorded explicitly because a
silent rebase-onto-a-moved-assembly is exactly the failure the clause guards.

`upstream` remote did not exist on the shared clone (`origin` = the fork only).
Added `upstream → https://github.com/openclaw/openclaw.git` and fetched. This is a
config-level, purely additive change to the shared clone: no shared worktree's
HEAD, index, or working tree was touched. Fetching upstream directly (never
reasoning against `origin/main`) is the Gate 2.7 discipline canon — the fork mirror
lags upstream.

### Topology metrics at merge-base

- merge-base(assembly, frozen upstream) = `f9207db3ca957d77efe293dddbeaeb8cb122ed40`
  (`fix(bedrock): reject truncated streams and preserve audio results (#116743)`, 2026-07-31 03:10:54 -0700)
- upstream side, `mb..acf28495`: **822 commits**, **3526 changed paths**
- assembly side, `mb..a837e2b0`: **903 commits**, **718 changed paths**
- **candidate-surface intersection (paths touched by BOTH sides): 139**
- textual merge-conflict preview via `git merge-tree --write-tree --name-only`:
  **35 conflicted paths** (exit 1), auto-merge tree `711320007f420a056145d780a2b10b23b3b9cc4a`

Conflict preview is the authoritative pre-merge expectation. The gap between 139
intersection paths and 35 textual conflicts is exactly the surface Gate 2.7 exists
for: 104 shared paths auto-merged with **zero conflicts**, and a clean auto-merge is
not proof of preservation (frozen-tree reverse-clobber class, ENTRYPOINT Failure 9).
Those are inspected in Phase 3, not assumed safe.

START receipt posted to `WEBHOOK_SCRIBE_NOTIFY` (HTTP 204). Webhook value never printed.

### Mandatory reads completed

Bootstrap: `RUNBOOKS/ENTRYPOINT.md`, `PRINCE-CODE-AGENT-RUNBOOK.md`,
`GITNEXUS-RUNBOOK.md`, `FROND-RUNTIME-CODE-ASSEMBLY.md`,
`PR-DRIFT-CURE-GATES-RUNBOOK.md`; plus `.github/copilot-instructions.md`,
`.github/process_bootstrap.xml`, `.specify/AGENTS.md`, root `AGENTS.md`.

OpenClaw side: root `AGENTS.md` (= `CLAUDE.md`, symlink pair) and the scoped
`AGENTS.md` files owning touched paths. Note: OpenClaw has **no**
`.github/copilot-instructions.md` at this SHA — recorded as an absent input rather
than silently skipped.

Operating process for this lane is **GATES**, not legacy SWIM, per workorder.

---

## Phase 1 — isolated branch and GitNexus baseline (2026-08-01T19:44Z)

Worktree `/home/figs/flesh_beast_best_beast/source/WORKTREES/openclaw-1214-absorb`
created from exact assembly SHA with branch `emeric/20260801/1214-absorb-acf28495`.
Clean at creation (`git status --short` empty; HEAD == `a837e2b0fe7…`).

### GitNexus Gate 0 — seat-class precondition

`GITNEXUS-RUNBOOK.md` Gate 0 is a precondition gate, so it was evaluated before
dispatch rather than after a failure.

- seat: **62 GiB** physical (`MemTotal` 65401100 kB), 20 cores, ~51 GiB available
- repo at assembly SHA: **25,099** `.ts/.js/.tsx/.mjs/.cjs/.mts/.cts` tracked files

The runbook's Gate 0 table sizes openclaw-source at 14,812 files (2026-05-29
substrate, Large-class: 64 GB min / 128 GB recommended). The tree has since grown
to 25,099 files, which lands it in the table's **Huge (>20k) class: 128 GB min,
192+ GB recommended**. This seat is below the minimum for both the old and the
current class row, and the runbook itself stars the 64 GB row as
"interpolation, not byte-evidenced … probe-class, not commit-class."

Decision: run the workorder's single sanctioned attempt as an explicitly **bounded
probe**, not as a commit-class dependency — one attempt, `--index-only --skip-git`,
`GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1`, external RSS monitor with hard SIGKILL at 70%
of physical RAM (45,780,770 kB) per Gate 0, plus a 3600s wall-clock bound. The
probe runs in a **separate** detached worktree `/data/wo1214-gn-baseline` at the
exact assembly SHA so that (a) the baseline is a true pre-merge snapshot,
(b) the candidate worktree is never polluted by a `.gitnexus/` artifact
(`.gitnexus/` is **not** in OpenClaw's `.gitignore` at this SHA, so an in-place
index would be an untracked lane artifact one `git add -A` away from the tree),
and (c) merge work proceeds in parallel instead of serializing behind the index.

Existing indexes in `~/.gitnexus/registry.json` were checked first per workorder
("prefer an existing exact-assembly index if it is current"): both entries
(`oc-1205-head`, `oc-1205-head-git`) are 1,936-file **slices** at commit
`4306c319db2e…`, not the exact assembly SHA and not whole-tree. Not current →
not reusable.

Outcome recorded in Phase 1 addendum below.

---

## Deviation record — branch reset before the merge (Phase 1 → Phase 2 seam)

Phases 0+1 of this journal were first committed **on top of** the assembly SHA.
That commit would have become the **first parent** of the back-merge, violating
the workorder's hard requirement that the merge's first parent be exactly
`a837e2b0fe7adc4f71d0c0f2446a2d18a34e28ee`. The branch was unpushed and never
reviewed, so it was reset back to the assembly SHA and the journal was carried
forward as an untracked file, to be committed as a normal **descendant** of the
merge instead. No published history was rewritten; no force-push occurred.

## Phase 1 addendum — GitNexus Gate 0 outcome

The bounded probe (`/data/wo1214-gn-baseline`, pid 2487776, started
2026-08-01T19:44:21Z) was still extracting scopes when the merge, gates, and
local validation completed. It never breached the 70%-RSS SIGKILL cap, but it
also never produced a queryable graph inside this lane's window, so **no
GitNexus impact analysis backs this candidate**. This is the documented
bounded-failure outcome for a 25,099-source-file repo on a 62 GiB seat
(runbook "Huge (>20k)" class ⇒ 128 GB minimum; the 64 GB row is explicitly
probe-class, not commit-class).

Fallback proof substrate actually used, per file touched:

- both parent blobs read in full (`git show <parent>:<path>`) plus a zdiff3
  three-way conflict view;
- provenance for every upstream hunk via `git log -S`/`git log --oneline` to the
  owning upstream PR;
- import/symbol liveness by counting real references outside conflict markers;
- owning-test identification before any behavioural choice;
- whole-tree type resolution (`pnpm tsgo`, `pnpm tsgo:test`) as the call-graph
  oracle GitNexus would otherwise have provided.

## Phase 2 — back-merge and conflict resolution

`git -c merge.conflictstyle=zdiff3 merge --no-ff --no-commit acf28495…` produced
**36 conflicted paths** (35 content + 1 modify/delete); `git merge-tree` had
predicted 35. Every path was resolved by hand under the workorder priority order.

Merge commit: first parent `a837e2b0fe7adc4f71d0c0f2446a2d18a34e28ee`, second
parent `acf28495b1ae8b911c38a9980eea303709f7a64f`. Never amended.

### The "clean auto-merge repair" class

git's 3-way merge produced several **conflict-free** results that silently
dropped a continuation invariant or froze a stale literal. These are the
Gate 2.7 MIXED-CLOBBER class arriving through the front door, and they are the
reason this lane inspected auto-merged neighbours of every conflicted file:

1. `src/agents/openclaw-tools.options.ts` — upstream's `sourceReplyOnly?: boolean`
   landed in an inline options type the fork had extracted to this module; the
   auto-merge left two `options?.sourceReplyOnly` call sites with no declaration.
2. `resolveStreamingReplyText` — upstream's inlined `parseReplyDirectives(...)`
   dropped continuation-signal stripping; re-wrapped in
   `parseFullStreamingReplyText` over upstream's bracket-tail fix.
3. held-partial release in `handlers.messages.ts` — `cleanedText` → `displayText`
   so a pending continuation marker can never be released to the source.
4. `src/tui/embedded-backend.ts` — tool-validation summaries stopped terminalizing
   the run as aborted.
5. `run.overflow-compaction.test.ts` — a sibling assertion kept the stale
   `"test-key"` literal after upstream moved to `"agent:main:test-key"`.

### Post-merge repair commits (normal descendants, never amendments)

- `fix: repair merge fallout from upstream subagent execution canonicalization`
  — upstream #117267 nests `execution:{status,startedAt,endedAt,outcome}`; the
  continuation orphan-reap confidence gate and 16 fork-only continuation tests
  still used the flat fields. `emitChatAborted` (deleted upstream) replaced by
  `projectTerminalOutcome` metadata carrying `aborted` + `toolErrorSummary`.
- `test: regenerate codex dynamic-tools prompt snapshot after back-merge` — the
  two conflicted `codex-runtime-happy-path` fixtures are generated artifacts;
  regenerated from the merged tree with `pnpm prompt:snapshots:gen`.
- `style: oxfmt + oxlint cleanup on back-merge touched files`.
- `fix: reconcile final message_end flush and continuation announce coverage` —
  two behavioural defects the scoped suite caught: the continuation
  "undelivered final directives" branch was _replacing_ the final accumulator
  flush (so upstream #116983's held bracket tail was never released), and the
  continuation trigger/trace announce test relied on a generated-media direct
  fallback that upstream #117085 replaced with the durable session-delivery
  queue.

### `config/env-var-count-budget.txt`

Never hand-merged. Recomputed from the fully-resolved tree with
`collectEnvVarNames()` from `scripts/check-env-var-count.mjs`: **515 distinct
`OPENCLAW_*` names**, which equals upstream's ratchet and is 2 below the
assembly's 517. The ratchet was lowered, never raised;
`node scripts/check-env-var-count.mjs` exits 0 at `515/515`.

## Phase 3 — three-tree review of the cleanly auto-merged intersection

139 intersection paths (touched by both sides since merge base).

- Candidate bytes == assembly while upstream moved: **1** —
  `scripts/prepare-extension-package-boundary-artifacts.mjs`. Deliberate: fork
  commit `d06794344f1` forces `--incremental false`, so no `.tsbuildinfo` is
  emitted and upstream's `removeStaleIncrementalState` cure is unreachable.
- Candidate bytes == upstream while assembly differed: **7** — six are conflicts
  resolved to upstream on the record (`.gitignore`, `docs/docs_map.md`,
  `config/env-var-count-budget.txt`, `extensions/telegram/src/action-runtime.test.ts`,
  and the two regenerated codex prompt snapshots). The seventh,
  `.agents/skills/openclaw-autonomous-issue-sweep/SKILL.md`, is cosmetic: the
  assembly's only delta from base was a single blank line inside a region
  upstream reflowed.

## Phase 4 — gates and bounded local validation

- **Gate 2** (`feature-cores-byte-check.sh … --upstream acf28495…`): 35
  primitive-core invariants — 27 PASS, 5 PASS-UPSTREAM, 2 PASS-TOMBSTONE, 1
  reported FAIL on `src/agents/openclaw-tools.ts`. That FAIL is a mechanical
  false positive: the candidate's delta vs the assembly is _byte-identical_ to
  upstream's delta for that path (6 insertions / 1 deletion, same lines), but the
  gate's projection cannot apply upstream's type-declaration hunk because the
  fork split the options type into `src/agents/openclaw-tools.options.ts`. The
  declaration and its doc comment are present there verbatim. Semantic verdict:
  PASS-UPSTREAM (relocated declaration).
- **Gate 2.7** (`drift-cure-gate.sh acf28495… HEAD`): **PASS**, exit 0. 711 files
  examined — 459 GENUINE, 252 SAFE-NEW, **0 FROZEN-STALE, 0 MIXED-CLOBBER**. Run
  against the frozen SHA, not `upstream/main`, so the gate cannot import drift
  this lane is not allowed to absorb.
- **Gate 2.5** (semantic-conflict enumeration): complete denominator of
  **1312** upstream-touched test/spec/harness files in
  `f9207db3ca9..acf28495b1a`. 16 are absent from the candidate — all verified as
  upstream deletions before the frozen SHA, none lost by this merge. 55 diverge
  from upstream bytes and were executed at HEAD.

Local validation (bounded, no fleet CI dispatched):

- Gate 2.5 first pass: **54 of 55** diverged files green;
  `src/tui/tui-pty-local.e2e.test.ts` failed (15/16). Resolved — see below.
- `pnpm tsgo` (production) — exit 0.
- `pnpm tsgo:test` (core, extensions, test root) — exit 0.
- `pnpm format` + `node scripts/run-oxlint.mjs` on the touched-file list —
  clean. (`pnpm format` over the full merge-changed list exceeds the argv
  limit; use the touched list.)
- Scoped merge-fallout vitest set, 26 files: **797 tests passed**, 0 failed.
- `src/tui/tui-pty-local.e2e.test.ts`: **16/16 passed**.
- `src/tui/embedded-backend.test.ts`: **88/88 passed**.
- `pnpm check`: every gate `ok` except `format`, whose only finding was this
  journal file (removed in the Phase 5 cleanup commit). Notable gates green:
  conflict markers, env-var count ratchet, max-lines ratchet, database-first
  legacy-store guard, runtime sidecar loader guard, npm package-lock guard,
  script declaration contracts, typecheck prod/scripts/test-root, lint.
- `git diff --check` — clean.

## 2026-08-01 — Gate 2.5 semantic conflict: local validation-loop abort

The single Gate 2.5 red was a genuine semantic conflict, not flake, and it was
diagnosed by control experiment rather than by inspection.

Symptom at HEAD: "renders safe validation-loop abort diagnostics through the
real local backend" rendered `run error: Agent run blocked before producing a
usable result.` instead of `run aborted: edit tool validation failed:`, and
then `/exit` never drained the PTY.

Two independent causes.

1. **Diagnostic ranking.** The assembly terminalizes a run as _aborted_ whenever
   a sticky tool-validation summary is present
   (`if (aborted || toolErrorSummary) emitChatAborted(...)`). Upstream replaced
   `emitChatAborted` with `projectTerminalOutcome`, which _classifies_ the
   outcome through `buildAgentRunTerminalOutcome`, where `blocked` outranks
   `aborted`. A validation loop trips the blocked-liveness heuristic, so the
   classified path discards the safe summary. Resolution: port the fork
   invariant onto upstream's API using its explicit `terminalOutcome` escape
   hatch, forcing `{status:"error", stopReason:"aborted"}` when
   `run.toolErrorSummary` is set. Continuation invariant preserved, upstream
   architecture adopted.

2. **PTY-side abort races the validation retry.** Upstream deleted
   `buildLocalValidationTuiScript` and drove the local case with a PTY ESC
   keypress. The assembly had deliberately replaced that keypress, with the
   rationale recorded in-tree: _"A PTY-side abort can race the validation retry
   into another provider turn. Abort through the real local backend after its
   listener records the second tool error; the Gateway case below still covers
   keyboard-driven aborts."_ Under the merged runtime the race is real: the UI
   terminalizes while the local run keeps consuming the unbounded invalid-edit
   mock, so shutdown waits out `TUI_SHUTDOWN_HARD_EXIT_MS` (2 s) plus
   `LOCAL_RUN_SHUTDOWN_GRACE_MS` (120 s) instead of the fixture's 4 s budget.
   Confirmed by widening the budget to 45 s — still no exit, so it is a leak,
   not slow drain.

Control experiments (all on this seat, same runner flags):

- pristine `acf28495b1a` worktree, unmodified: **16/16 pass** → not
  environmental.
- pristine upstream + candidate `src/tui/embedded-backend.ts`: **16/16 pass** →
  the TUI backend port is not the cause and does not leak.
- pristine upstream + candidate `embedded-agent-subscribe.handlers.lifecycle.ts`
  (the `(terminalAborted === true || isError)` widening and the
  delivery-generation guard): **16/16 pass** → not the cause either.
- pristine upstream + the candidate's full subscribe layer: not decidable, the
  fork's `src/auto-reply/continuation/*` tree has no upstream counterpart. The
  cross-tree bisection was stopped there rather than guessed at.

Resolution: restore `buildLocalValidationTuiScript` for the local case and
re-gate the ESC keypress on `mode === "gateway"`, exactly as the assembly had
it, while keeping upstream's fixture refactor (`buildTuiProcessArgs`) for every
other local scenario. Upstream's keyboard-driven abort coverage is retained on
the Gateway case, which is what upstream's own change was reaching for.
Result: **16/16**, and Gate 2.5 is 55/55 green.

## 2026-08-01 — GitNexus Gate 0 final outcome

The bounded probe (detached worktree at the assembly SHA, 70% RAM ceiling,
3600 s bound) was killed without producing a graph; no `.gitnexus/` directory
was ever written. Recorded as a bounded failure, not skipped: the seat has
62 GiB against the runbook's 128 GB minimum for the "Huge (>20k source files)"
class — this tree has 25,099. The runbook's own 64 GB row is labelled
probe-class, not commit-class, so this is the expected outcome and not a new
finding. All impact analysis in this lane therefore used the sanctioned
fallback substrate: `git log -S` provenance, `rg` import-liveness sweeps,
`git ls-tree` three-tree blob comparison, and TypeScript ownership tracing via
`pnpm tsgo` / `pnpm tsgo:test`. The probe worktree has been removed. Proof gap
stated plainly: no call-graph-derived blast radius was available for this
merge; every impact claim rests on the fallback substrate.

## 2026-08-01 — Phase 5 cleanup

Journal removed from the final tree in a normal cleanup commit. No squash, no
amend, no force-push; the merge commit keeps exactly its two required parents
and every repair is a normal descendant commit. Working tree carries no
`.gitnexus/`, no gate output directories, no logs, and no scratch files.
