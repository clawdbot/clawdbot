---
name: openclaw-small-bugfix-sweep
description: Fix only small, high-certainty OpenClaw bugs from a pasted issue/PR list after deep code review.
---

# OpenClaw Small Bugfix Sweep

Batch workflow for pasted OpenClaw issue/PR refs. The user's top-level
conversation is the orchestration-only parent; its bounded collaboration
subagents are hands-on execution owners. The parent coordinates them and
reports their verified results. Workers publish or land only when authorized.

## Mandatory coordinator/worker boundary

- The parent only assigns issue/PR owners and independent validation workers,
  coordinates shared checkout/file ownership and mutation slots, tracks evidence
  and authorization gates, handles genuine owner decisions, and reports results.
- The parent never directly discovers or inspects items; reads affected source,
  dependencies, or sibling `../codex`; diagnoses, edits, reproduces, or tests;
  runs Git/GitHub operations; comments, closes, commits, pushes, watches CI,
  prepares, or lands. Delegate every operational step to collaboration subagents.
- Assign one bounded worker ownership of each item or duplicate/root-cause
  cluster. Use separate workers for independent closure/landing validation and,
  when useful, discovery, source history, dependency contracts, sibling paths,
  regression proof, and CI follow-through. An item worker may spawn a helper
  only after the root explicitly authorizes that specific helper and tracks its
  scope, ownership, capacity, and completion; the item owner remains hands-on
  and personally checks consequential evidence before acting.
- State each worker's execution/verification role, assigned item, file/checkout
  ownership, mutation authority, and reporting obligation in its assignment. A
  delegated worker reading this skill performs its assigned work itself; it does
  not misclassify itself as the orchestration-only parent or recursively
  delegate its entire assignment.
- Assign disjoint writable files/checkouts before parallel implementation.
  Serialize shared checkout/ref/branch changes, overlapping file writes,
  commits, pushes, GitHub mutations, and landing. Do not edit a shared checkout
  while another worker's tests are running. Never create new worktrees without
  explicit user authorization; an explicit full-authority unattended or landing
  request authorizes repo-managed PR worktrees and necessary isolated task-owned
  worktrees. Never stage, stash, discard, or overwrite unrelated dirty changes.
- Bound worker concurrency by available agent slots, including the parent, and
  host/proof capacity. Before replacing a failed or interrupted worker, preserve
  its claimed items, patches, checkout ownership, and evidence; explicitly hand
  them to one replacement without duplicating or discarding unfinished work.
- Classify source trust before execution. Never run untrusted contributor code,
  scripts, config, hooks, tests, or wrappers locally; use the repository's
  sanitized remote-proof path. Route heavy trusted proof to the selected remote
  box unless the documented trusted-backend fallback applies.
- For Codex-backed behavior, every worker making a technical verdict or taking
  a related action must personally inspect the exact sibling `../codex` source
  first and cite the inspected files/lines. The parent may relay those worker
  findings but must not present another agent's inspection as its own verdict.
- Keep workers assigned through reproduction, repair, independent validation,
  exact-head CI, authorized closure/landing, and verified terminal state. A
  pending check or submitted mutation is not completion; delegate follow-up.

This is the collaboration-subagent model used by
`openclaw-autonomous-issue-sweep`, not an invitation to create user-owned Codex
app tasks or to perform sweep work in the parent conversation.

## Scope and authorization gate

Keep this sweep limited to small, high-certainty root-cause repairs. Do not substitute a workaround when a coherent owner-boundary cleanup or refactor is the correct fix; escalate if that repair exceeds the explicitly requested sweep scope.

Default flow when fixing is authorized:

1. Review each issue deeply enough to prove current behavior and root cause.
2. Fix only high-confidence bugs whose owner-boundary repair fits the requested small-sweep scope.
3. Without explicit authorization to publish or land, stop with the dirty diff summary, touched files, and test/gate output for maintainer review.
4. When shipping is authorized, make one commit per accepted fix; put user-facing release-note context in the PR body or commit message. Never edit release-only `CHANGELOG.md`.
5. When authorized, sync for the destination: direct `main` must rebase onto latest `origin/main` without merge commits; PRs follow native landing guards and refresh/rebase only for an actual conflict, failing guard/exact-head check, explicit user request, or demonstrated material stale-base risk, never merely because `main` advanced. Push, comment with proof, and close only authorized fixed or explicitly triaged-closed issues.

An explicit request to autonomously process or resolve a named issue/PR batch,
or to fix and land it, authorizes assigned workers to perform the scoped
root-cause fixes, commits, pushes, PR updates, proof comments, evidence-backed
fixed-on-current-`main` closures, and exact-head landings needed to resolve those
named items. A fix-only request permits local changes and proof, not publishing
or landing; review, triage, or list alone is read-only. Never batch unrelated
fixes into one commit, mutate unrelated items, exceed the requested sweep scope,
or bypass owner, security, trust, authorization, or proof gates. Do not invent
an additional personal-review gate.

Explicit full-authority unattended execution is standing approval for assigned
workers to complete all evidence-backed, task-scoped investigation, repair,
credited PR rewrite/replacement, proof comments, CI diagnosis/fixes/reruns,
task-owned publication/worktrees, proven current-`main` closures, requested
native landing, and terminal remote verification. Resolve routine decisions
without asking the unavailable user; recover safely from transient failures
and locks. Preserve unrelated edits, exact-head required CI, source trust,
acting-worker direct Codex inspection, contributor credit, security/owner
gates, and separate exact-count/scope approval for more than 50 closures.
Only when the user explicitly relaxes unavailable **optional** provider/channel
live proof may focused failing/passing owner-boundary regression, direct
producer/caller/sibling/dependency evidence, independent review, and exact-head
green CI substitute; disclose the missing live/rank-up proof. Mandatory
external-API, security-sensitive, risk-required, or requested live proof is
never waived. Report only genuine credential, capability, or explicit safety
blockers without waiting for the user.

## Companion Skills

Use `$gitcrawl` first, `$openclaw-pr-maintainer` for live GitHub hygiene, `$github-deep-review` posture for source tracing, and `$openclaw-testing` for proof.

## Loop

For each ref, the assigned worker performs the operational loop; the parent only
coordinates its progress and receives evidence:

1. Read live target with `gh`.
2. Check `gitcrawl` for related, duplicate, closed, or already-fixed threads.
3. Read body, comments, linked refs, changed files, current code, adjacent tests, and dependency contracts when relevant.
4. Trace the real runtime path.
5. If current `main` already fixes the claimed defect, prove current source/tests and the canonical commit/PR. Classify it `fixed-on-main`; comment with proof and close only when authorized.
6. For confirmed open issues, repair the violated invariant at its owner; include a small coherent cleanup/refactor when it is the cleanest root-cause fix.
7. For PRs, independently verify the defect, owner-boundary fix, sibling paths, and exact-head checks. Rewrite an inadequate editable PR when repair/landing is authorized; otherwise report the needed fixup.
8. Add focused regression proof when practical for local issue fixes or PR readiness checks.
9. Run the smallest meaningful gate.
10. Continue until every pasted ref is fixed, proven already resolved, landed, or classified with a concrete blocker.

An independent worker challenges proposed fixed-on-main closures and
nontrivial repair/landing proof before an authorized item owner performs the
final mutation. Missing agreement or applicable source/dependency proof,
exact-head CI, trust routing, ownership approval, or authorization is a concrete
blocker, not permission for the parent to take over the work.

## Skip If

- not a bug
- config/docs/workflow/release/support/dependency/product work
- repro or root cause is uncertain
- the correct coherent root-cause repair exceeds the explicitly requested small-sweep scope; classify as `needs-human` or record a named follow-up instead of landing a workaround
- dependency behavior is guessed
- no focused proof is feasible

Skip with terse reason. Do not pad with low-confidence fixes.

## Fix Rules

- owner module first; generic seam only when required
- existing patterns/helpers/types
- coherent owner-boundary cleanup/refactoring; no unrelated drive-by refactors
- prefer net-neutral or net-negative production LOC; count tests separately and add useful regression coverage
- tests near failing surface
- docs only for changed public behavior
- no commit during review/prove-only work
- when shipping is authorized, one commit per accepted fix; capture user-facing release-note context in the PR body or commit message, never `CHANGELOG.md`
- no push/create PR/comment/close/label/land/merge without authorization for that action

## PR Rules

- `ready-to-merge`: the root-cause fix is clean, current head is verified, and required exact-head checks are green; use the repo-native landing workflow only when merging is authorized
- `needs-ci`: proof is sound but required exact-head checks remain pending or unavailable; for an authorized land request, monitor those checks and finish landing if they pass, or report the concrete external blocker
- `needs-fixup`: repair/rewrite an editable PR when authorized; otherwise list exact files/tests and the missing authorization
- `skip`: stale, speculative, explicitly out of scope, or requiring unavailable product/security/release approval
- if a useful source PR is unsafe or uneditable, create a replacement only when explicitly authorized; preserve contributor credit and close the source only after the replacement exists

## Output Shape

Ledger: `fixed-local`, `fixed-on-main`, `closed-fixed-on-main`, `ready-to-merge`, `needs-fixup`, `needs-ci`, `landed`, `skipped`, `needs-human`.
Track each item's assigned worker, independent verifier, owned files/checkout,
evidence, exact head, authorization, and terminal state.
Final: worker-verified local or landed fixes, proven already-fixed items,
production/test LOC deltas, tests/gates, and concrete blockers or skip reasons.
