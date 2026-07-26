---
summary: "Read-only exact-head PR convergence audit for GitHub review evidence."
read_when:
  - Auditing whether a PR is merge-ready from GitHub review evidence
  - Debugging empty formal reviews with ClawSweeper comment-stream blockers
  - Running the Option-B convergence audit pilot before merge
title: "PR convergence audit"
sidebarTitle: "PR convergence audit"
---

This page documents the repository-local Option-B pilot for a read-only,
deterministic exact-head PR convergence audit. The audit collects GitHub review
evidence, ties findings to their source surface, and returns exactly one
decision: `READY`, `BLOCKED`, or `UNKNOWN`.

The audit is read-only. It does not request reviews, post comments, merge PRs,
or write to GitHub.

## Evidence surfaces

The audit normalizes a complete evidence bundle for one PR:

- live PR identity and exact head SHA
- formal `reviews[]`
- inline review comments
- ordinary issue/PR comments
- requested reviewers
- check runs for the exact head

Each normalized item preserves:

- source surface
- URL
- author
- timestamp
- body
- review state when available
- `commit_id` or reviewed SHA when available

Issue and PR comments are first-class review evidence. An empty formal
`reviews[]` array is never sufficient by itself.

## Finding detection

The audit scans all evidence surfaces for review signals, including:

- `P0`, `P1`, and `P2`
- `BLOCKED`
- needs proof
- actionable findings
- unchecked findings
- changes requested
- re-review requests
- trusted ClawSweeper verdict markers such as
  `<!-- clawsweeper-verdict:block item=<pr> sha=<head> -->`

Findings stay tied to the evidence item that produced them.

## Decision semantics

The audit returns exactly one structured decision.

### `BLOCKED`

Use `BLOCKED` when the exact current head has unresolved blocking findings or
failed required checks.

Example: formal `reviews[]` is empty, but an exact-head ClawSweeper issue
comment contains a `P0` or `BLOCKED` finding for the live head.

### `UNKNOWN`

Fail closed to `UNKNOWN` when evidence is incomplete or unsafe to trust:

- missing pagination or partial evidence collection
- ambiguous PR identity
- missing or ambiguous reviewed SHAs on actionable evidence
- provider or API errors
- required checks still pending
- stale blocking evidence for an older head
- the PR head changes between the initial and final reads

Stale blocking bot comments must produce `UNKNOWN` with a refresh or re-review
next action. They must never be silently dismissed.

Exact-head or stale re-review requests also fail closed to `UNKNOWN` until fresh
exact-head review evidence is available.

Formal review state alone can never produce `READY`.

### `READY`

Use `READY` only when all of the following are true:

- evidence coverage is complete for every required surface
- the PR head is stable across the audit
- required checks for the exact head are satisfied
- there are zero unresolved current-head blockers
- the decision does not rely on formal `reviews[]` alone

An empty formal `reviews[]` result is never enough for `READY` by itself.

## Required triggers

Run the convergence audit read-only at these points:

1. after PR creation
2. after every push to the PR branch
3. after every PR-body edit
4. immediately before merge

## Implementation

- audit logic: `scripts/pr-convergence-audit.mjs`
- deterministic tests: `test/scripts/pr-convergence-audit.test.ts`

Live GitHub access belongs behind an injected provider. Tests use fixtures only
and do not call GitHub.

## Related

- [Pull request review flow](/reference/pull-request-review-flow)
