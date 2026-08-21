# Cael pure-continuation upstream 3376 backmerge journal

Append-only decision record for `scribe/20260821/1172-upstream-3376-backmerge-cael`.
All timestamps are UTC.

## 2026-08-21T23:59:23Z - Phase 0 and Gate 1: frozen inputs, graph baseline, savegame

### Frozen inputs

- Pure-continuation root and initial safe-branch HEAD:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Assembly ref `origin/scribe/20260709/1172-status-row-assembly`:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Identical alias `origin/scribe/20260818/1172-upstream-4589-backmerge`:
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69`.
- Frozen `origin/main`:
  `3376c29800166a3151cbca6b8ab204964e97ac39`.
- Forbidden composite ref:
  `46f4d2115700d574501bb3c4763abf6b2ba977fe`.
- `git merge-base --is-ancestor 46f4d211... c3a0e5a...` exited 1, proving
  the forbidden composite is not in the continuation root.
- The protected assembly, alias, presentation, main, and forbidden-composite
  refs were read before and after the work order's single origin fetch. Every
  required SHA matched exactly.

### Count-label correction

`git rev-list --left-right --count
c3a0e5a314ecbf572911d4b2e84595bd06f64d69...3376c29800166a3151cbca6b8ab204964e97ac39`
returned `1113 873`: assembly-only is 1113 and upstream-only is 873. The work
order's prose inverted the ahead/behind labels. The raw sides are authoritative;
there is no greater-than-ten growth in the upstream-only side.

### Gate 1 savegame

- Immutable savegame:
  `savegame/20260821-1959Z/1172-cael-pure-continuation-pre-3376`.
- `git ls-remote origin` returned
  `c3a0e5a314ecbf572911d4b2e84595bd06f64d69` for that exact ref.
- The savegame will not be deleted or moved.

### GitNexus pre-change evidence

- Exact registered worktree:
  `/home/figs/flesh_beast_best_beast/source/WORKTREES/openclaw-1172-upstream-3376-cael`.
- Executing CLI version under the repository Node 22 runtime: `1.6.5`.
- First native-worker analysis aborted after about 70 minutes with
  `double free or corruption (out)`. The CLI-prescribed
  `gitnexus analyze --workers 0` recovery succeeded in 4666.6 seconds.
- Swift parsing was unavailable because `tree-sitter-swift` had no loadable
  native binding. The TypeScript continuation surface was indexed.
- Current index: commit `c3a0e5a`, 751,069 nodes, 1,500,253 edges, 22,068
  clusters, and 300 flows.
- Query:
  `gitnexus query 'continuation tools continue_work continue_delegate request_compaction'
--repo <exact-worktree> --context 'Pure-continuation assembly before
frozen-upstream backmerge' --goal 'Identify owning flows and merge-sensitive
continuation paths' --limit 10`.
  It identified the continuation registration, delegate stores, post-compaction
  dispatch, and request-compaction tool definitions.
- Context:
  `gitnexus context createContinueWorkTool --repo <exact-worktree>
--file src/agents/tools/continue-work-tool.ts`.
  Direct callers are `createOpenClawContinuationTools` and the two
  `continue-work-tool` test factories.
- Impact:
  `gitnexus impact createContinueWorkTool --repo <exact-worktree>
--direction upstream --depth 5 --include-tests --limit 200`.
  It reported six impacted symbols: three direct and three depth-two test/file
  dependents.
- Merge-boundary detection:
  `gitnexus detect-changes --repo <exact-worktree> --scope compare
--base-ref 3376c29800166a3151cbca6b8ab204964e97ac39`.
  It reported 5,908 changed files, 24,110 changed symbols, 151 affected flows,
  and critical risk. This requires complete conflict, auto-resolution,
  intersecting-test, and divergence walks rather than spot checks.

### Deviations and hard stops

- The requested `upstream-divergence-walker` skill is not installed. Its
  discipline will be implemented as an explicit per-file/per-commit semantic
  divergence ledger plus independent divergence review; no gate is waived.
- `.gitnexus/`, `WORKORDER.md`, and the pre-existing untracked `resume.sh` remain
  local and untracked.
- No protected ref, PR #1398 surface, forbidden composite, #121204/#124337
  surface, deployment, service, config, database, or live gateway was touched.
