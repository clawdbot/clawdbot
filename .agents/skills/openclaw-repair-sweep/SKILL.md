---
name: openclaw-repair-sweep
description: "Run scoped OpenClaw issue/PR repair campaigns: coordinate workers, prove root causes, and land or close verified work under the requested authority."
---

# OpenClaw Repair Sweep

Use for a multi-item repair campaign. Root `AGENTS.md` owns repair and safety
policy; `$openclaw-pr-maintainer` owns item review, GitHub writes, and landing.
The lead remains hands-on and delegates independent work where useful.

## Scope and authority

- Explicit refs imply a bounded ref campaign. Otherwise discovery defaults to
  five qualified items (maximum twenty per batch); a whole-queue request means
  continuing through that queue. Do not pad low-confidence findings.
- Honor requested workers and focus. Ref/discovery campaigns normally use up to
  eight item owners; a queue campaign can assign up to sixty-four, but actual
  active proof workers must fit host/remote capacity. Start small and scale on
  observed resource health; assigned is not the same as running.
- An explicit autonomous fix-and-land/sweep invocation covers scoped investigation,
  repairs, commits, pushes, PRs, verified landings and proven closures. Review,
  triage, or list wording stays read-only; fix-only stops before publication.
  Never infer release, schema/config/protocol, credential, security, or product
  approval from campaign authority.

Use `$gitcrawl` for available archive discovery, `$openclaw-testing` for proof,
`$autoreview` for independent code review, and `$crabbox` when the proof requires
remote environment or untrusted-source isolation. Author-history research is
conditional on a concrete question, not a campaign prerequisite.

## Coordinate ownership

Assign each item or shared root-cause cluster one owner, a checkout, frozen
source SHA, authorized actions, and a useful stopping condition. Duplicate
symptoms share an owner; repeated defect classes should be repaired in the
canonical owner rather than by parallel near-identical patches.

Use isolated issue/PR worktrees and preserve unrelated files. Serialize shared
fetch/ref/branch/worktree operations, PR preparation, and merges in short slots;
never hold the slot across coding, tests, or a remote wait. Each remote lease has
one owner and one active command. Pause only campaign-owned work under resource
pressure, and preserve patches, claims, proof, and checkpoints before replacement.
The lead may take over stalled work safely; it is not an orchestration-only role.

Read root and scoped guides before acting. Each verdict-bearing worker inspects
its relevant dependency contracts directly, including the root's personal Codex
source requirement. The lead verifies consequential results, not just summaries.
Use independent challenge for nontrivial repairs and closure evidence; one
independent autoreview is enough for the code-review requirement.

## Investigate and repair

Search existing work before creating another fix: current body/comments, related
archive results, live state when it matters, and current source/history. Use bare
PATH `gh` with narrow JSON fields; reuse shared evidence and avoid unnecessary
pagination or repeated item fetches.

Prefer, in order:

1. Prove the original behavior is already fixed on current main and close under
   the authorized scope with the canonical fix and evidence.
2. Finish and verify an existing useful editable PR, preserving human credit.
3. If that PR cannot safely be updated, create a credited replacement before
   closing it. Do not squash a contributor PR after replacing its ancestry.
4. Implement a new high-confidence repair when no suitable fix exists.
5. Record a concrete blocker or product/owner decision. A useful independent
   simplification may land under its own scope, but it does not close the bug.

A candidate needs a demonstrated current defect, an understood owner and
bounded impact, relevant dependency proof, and feasible validation. Repairs
requiring new dependencies/configuration, public-contract changes, security,
persistence design, or product judgment require their root approvals before
implementation or landing as applicable. Preserve useful investigation; do not
work around the gate or count review-required work as an accepted fix.

Repair the invariant at its owner, cover relevant siblings, and remove connected
obsolete paths when justified. Do not add speculative fallback layers or hardcode
the reported example. Prefer simplicity without a LOC quota. Keep release-note
context and credit in the PR; `CHANGELOG.md` remains release-owned. Do not force a
second refactor PR after each completed item.

## Proof and landing

Choose proportional proof through `$openclaw-testing`. Trusted development can
run locally; remote compute needs an environment or isolation reason. Untrusted
repository tooling never runs locally or on a credential-hydrated host. Preserve
explicit live requirements and never describe a mock, skipped test, old head, or
unfinished soak as live proof.

Run `$autoreview` on the completed nontrivial candidate and resolve verified
findings. Re-review substantive changes or unresolved concerns; do not multiply
reviews for mechanical head movement. Address actionable human/bot findings
without a separate Rank-up checklist or score-refresh gate.

Land through the native maintainer workflow only with current required CI and
review evidence. Verify remote merge state and ancestry before counting success.
A timed-out merge request may have succeeded; reconcile it before retrying.
Refresh/rebase for conflicts, failed guards, explicit requests, or material stale
base risk, not merely because main advanced. Delete only owned temporary state.

For broad campaigns, a shared-main failure may justify one separately scoped
repair worker. Check for an existing fix first. Do not duplicate that repair in
every PR or silently expand a bounded ref request to unrelated CI work.

## Closure and reporting

Before closing, prove the reporter's primary outcome and affected surfaces are
fixed, not merely mitigated or diagnosed. Check fix ancestry and containing tags
when version claims matter; dates do not prove inclusion. Seek independent
challenge for uncertain or consequential closure evidence. Disagreement, a still
broken surface, or an owner hold means leave open. Product rejection is a
maintainer decision, never an automatic cleanup conclusion.

Recheck live state before mutation and explain the fixed behavior, canonical
commit/PR, known containing version, and useful proof. If a closure is challenged,
pause the affected closure work and correct the evidence before resuming. No more
than three workers should hold simultaneous closure duty; more than fifty
close/reopen actions require the root's explicit count/scope approval.

Keep a resumable ledger of owner, source/head, outcome, proof/CI state, PR/merge,
credit, blockers, and cleanup. Count verified outcomes, not planned or launched
work. Report meaningful progress and each verified landing with links; summarize
final behavior, proof, remaining limitations, and checkout state in natural prose.
