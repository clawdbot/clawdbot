---
name: openclaw-small-bugfix-sweep
description: Fix only small, high-certainty OpenClaw bugs from a pasted issue/PR list after deep code review.
---

# OpenClaw Small Bugfix Sweep

Batch workflow for pasted OpenClaw issue/PR refs.
Execute, do not summarize.
Triage does not commit, push, create PRs, comment, close, label, land, or merge.

## Peter Review Gate

Peter always wants to review code before commits.
After local fixes and proof, stop with the diff summary, touched files, and test/gate output.
Do not commit unless Peter writes `commit` in the current instruction for the exact diff being handled.
Do not treat earlier messages, inferred intent, "next", sweep momentum, or bundled publish language as commit permission.
If Peter asks for follow-up work without saying `commit`, keep the files dirty after local fixes and proof.
Do not push, comment, close, label, land, merge, or otherwise publish until Peter explicitly asks for that exact action after the code has been reviewed.
If Peter asks for a bundled action like `commit push close`, first confirm the code has already been reviewed in chat; if not, stop with the dirty diff and ask for review/approval.

## Companion Skills

Use `$gitcrawl` first, `$openclaw-pr-maintainer` for live GitHub hygiene, `$github-deep-review` posture for source tracing, and `$openclaw-testing` for proof.

## Loop

For each ref:

1. Read live target with `gh`.
2. Check `gitcrawl` for related, duplicate, closed, or already-fixed threads.
3. Read body, comments, linked refs, changed files, current code, adjacent tests, and dependency contracts when relevant.
4. Trace the real runtime path.
5. For issues: fix locally only if this is a bug, current code proves root cause, the implicated path is clear, and a narrow patch is cleaner than refactor.
6. For PRs: decide `ready-to-merge`, `needs-fixup`, or `skip`; do not alter PR branches unless explicitly asked.
7. Add focused regression proof when practical for local issue fixes or PR readiness checks.
8. Run the smallest meaningful gate.
9. Continue until every pasted ref is fixed or classified.

No subagents unless explicitly requested.

## Skip If

- not a bug
- config/docs/workflow/release/support/dependency/product work
- repro or root cause is uncertain
- larger refactor or owner-boundary change is cleaner
- already fixed on current `main`
- dependency behavior is guessed
- no focused proof is feasible

Skip with terse reason. Do not pad with low-confidence fixes.

## Fix Rules

- owner module first; generic seam only when required
- existing patterns/helpers/types
- no drive-by refactors
- tests near failing surface
- docs only for changed public behavior
- no commit unless Peter writes `commit` in the current instruction
- no push/create PR/comment/close/label/land/merge unless explicitly asked for that exact action after review

## PR Rules

- `ready-to-merge`: code is good, current head checked, required proof is green or clearly pending only external CI; list for maintainer merge or `@clawsweeper automerge`
- `needs-fixup`: small bug is clear, but PR branch needs changes; list exact files/tests and wait for explicit fix/push/automerge instruction
- `skip`: broad, stale, speculative, config/product/security/release, owner-boundary, or refactor-sized
- if source PR is untrusted/uneditable, do not create a replacement PR during sweep

## Output Shape

Ledger: `fixed-local`, `ready-to-merge`, `needs-fixup`, `skipped`, `needs-human`.
Final: issue files left on disk, PRs ready for merge/automerge, tests/gates, skip reasons.
