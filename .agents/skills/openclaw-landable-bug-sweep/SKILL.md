---
name: openclaw-landable-bug-sweep
description: "Find or repair a requested batch of small high-confidence non-SDK-boundary OpenClaw bugfix PRs until they are landable."
---

# OpenClaw Landable Bug Sweep

Autonomous maintainer workflow for producing a requested batch of landable OpenClaw bugfix PR URLs.
Use for broad issue/PR sweeps where the bar is high and the output is PRs, not notes.
Do not use for plugin SDK/API boundary work; those need separate architecture review.

## Mandatory orchestration contract

- Only the original user-facing root conversation is the control plane. It
  decomposes work, assigns explicit issue/PR/file ownership, directly spawns
  bounded collaboration workers and independent verifiers, coordinates safety,
  tracks completion, and reports actual worker-verified terminal outcomes.
- A delegated collaboration subagent is a hands-on execution owner, not another
  user-facing root orchestrator. It performs its assigned work directly; this
  contract must not recursively prevent workers from acting. Nested workers
  require explicit root authorization plus root-tracked capacity, ownership,
  and completion. Do not create separate Codex app tasks or threads.
- Workers perform all discovery, source/dependency/Codex inspection,
  reproductions, issue/PR investigations, edits/refactors, tests/proof/CI,
  GitHub reads/writes, comments, closures, commits, pushes, and any separately
  authorized landing. The acting worker personally verifies dependency
  contracts and inspects sibling `../codex` before making a Codex verdict.
- Root coordinates checkout/file ownership, serializes shared Git/ref/index
  mutations and conflicting test/edit activity, tracks exact heads, and enforces
  authorization, source-trust, security, ownership, and landing gates through
  assigned workers. Root never switches from orchestration to execution because
  a worker stalls, fails, or lacks capacity; reassign the bounded work instead.

## Requested authority

- The default deliverable is verified **landable PR URLs**, not merged PRs. An
  explicitly requested repair-and-prepare sweep authorizes workers to repair,
  refactor, verify, commit, push, and update PRs within its requested scope;
  it does not authorize landing without an explicit landing request.
- `review`, `triage`, `list`, or a `landable-shortlist` alone remains read-only:
  no unsolicited push, public comment, closure, replacement PR, or merge.
- An explicit autonomous `process`, `resolve`, or `fix-and-land` request for
  named items also authorizes workers to close those proven fixed on current
  `main` and land verified fixes through `$openclaw-pr-maintainer` and the
  repo-native `scripts/pr` workflow. Preserve exact-head and ownership gates.
- Explicit full-authority unattended execution is standing approval for all
  evidence-backed work within the named sweep, including necessary task-owned
  or repo-managed PR worktrees, credited PR repair/replacement, proof comments,
  exact-head CI repair, scoped publication, proven current-`main` closures, and
  requested native landing. Never ask routine approval questions or disturb
  unrelated dirty changes; the root stays orchestration-only and workers own
  execution through verified completion. Preserve source-trust, direct acting-
  worker Codex inspection, required exact-head CI/security/owner gates, and
  explicit exact-count/scope approval for more than 50 close/reopen actions.
- Optional unavailable provider/channel live proof may be replaced only when
  the user explicitly relaxes it: use failing/passing focused owner-boundary
  regression, direct producer/caller/sibling/dependency-source evidence,
  independent review, and green exact-head required CI; disclose the missing
  live/rank-up proof. Never waive mandatory external-API, security-sensitive,
  risk-required, or explicitly requested live verification.

## Target

Use `batch_size` from the request, defaulting to `5` and capped at `20`.
Return up to that many qualified PR URLs, each with:

- bug summary
- why the fix is low-risk
- proof: exact-head local/Testbox/live commands or run IDs
- autoreview: clean result on the exact head being shown
- CI green on the exact pushed PR head
- issue/duplicate cleanup done or still pending

The URLs may be existing PRs that were reviewed/fixed, or new PRs created from issues/clusters.
Do not present a PR URL until its exact published head is left-tested, autoreviewed clean, and verified green in live GitHub CI.
Refresh a PR branch only for an actual conflict, failing exact-head check or repo-native guard, explicit user request, or proven material stale-base risk; never rebase merely because `main` advanced.
If production code, tests, or the reviewed head changes after autoreview, rerun autoreview before showing the URL.
Do not pad a batch when the bounded search yields fewer qualified PRs.

## Inputs

- `batch_size`: requested number of landable PRs; default `5`, maximum `20`.
- `source_mode`: `discovery` or `provided-prs`; default `discovery`.
- `provided_prs`: explicit PR refs when `source_mode=provided-prs`.

In `provided-prs` mode, inspect only the supplied PRs plus directly linked duplicate/canonical refs unless broader discovery is required to prove the best fix.

## Companion Skills

Use `$gitcrawl` for discovery/clustering, `$openclaw-pr-maintainer` for live GitHub mutation rules, `$github-author-context` when contributor trust matters, `$openclaw-testing` for proof choice, `$autoreview` before publishing/landing, and `$crabbox` for broad/E2E/live proof.

## Candidate Bar

Accept only when all are true:

- bug or paper cut, not feature/product/support/docs-only
- root cause is proven in current code
- dependency behavior checked via upstream docs/source/types when relevant
- production/runtime diff is small, ideally much smaller than 500 LOC and always below 500 LOC
- production LOC is net-neutral or net-negative when feasible; count tests separately and justify any production increase
- tests may be larger, but focused
- no new dependency
- no new config option
- no backward-incompatible behavior
- no security/product/owner-boundary decision needed
- no plugin SDK, public plugin API, or `src/plugin-sdk/**` boundary change
- any refactor stays within the proven root cause, owner boundary, and small-sweep risk limits
- focused proof is feasible
- existing branch can be safely updated when needed, or an authorized replacement is justified

Good examples:

- provider parameter mismatch proven against dependency/API contract
- CLI command diverges from adjacent command behavior
- narrow runtime state/serialization bug with failing test
- issue already fixed on current `main`, with proof and closeable duplicates

Reject:

- feature requests, new knobs, migrations, release work, workflow policy, support
- plugin SDK/API boundary changes, including compatibility shims, new SDK methods, SDK exports, or plugin-facing channel/provider seams
- auth/security boundary changes unless explicitly assigned
- bugs requiring unavailable credentials for mandatory external-API, security,
  risk-required, or explicitly requested live verification
- PRs with red CI unless you fix, update the head as needed, push, and recheck them green
- PRs whose changed head was not pushed or whose exact-head CI was not verified live
- PRs whose final head has not passed `$autoreview`
- fixes requiring an out-of-scope product, architecture, or ownership decision
- speculative reports without reproducible/provable cause
- UI/UX changes requiring product judgment

## Sweep Loop

1. Start clean:
   - `git status -sb`
   - update a clean, exclusively owned base checkout with `git pull --ff-only` only when needed and root-authorized
   - never pull, switch, or mutate a shared checkout while sibling workers are active
   - verify branch is expected, usually `main`
2. Build candidate clusters:
   - `gitcrawl` open issues/PRs, neighbors, and search
   - live `gh issue/pr view`
   - include PRs linked from issues and duplicates
3. For each cluster:
   - read issue/PR body, comments, labels, linked refs, current source, adjacent tests
   - exclude PRs authored by wide-access maintainers until `created_at` is at least 14 days old; only a named PR or explicit maintainer-work request overrides
   - identify opener/author and preserve credit
   - decide: `repair-existing-pr`, `create-new-pr`, `fixed-on-main`, `duplicate`, or `reject`; close only when authorized
4. Prove before patching:
   - failing test, focused repro, log/source proof, or dependency contract proof
   - if already fixed on `main`, prove with current source/test/commit; close kindly only when authorized
5. Patch:
   - rewrite/refactor an existing editable PR into the correct owner-boundary fix first, even when its incoming implementation is the wrong shape
   - create an authorized replacement only when the original branch is uneditable or unsafe to update; preserve credit and close the source only after the replacement exists and closure is authorized
   - if no PR exists, create one only when publication is authorized
   - add regression test when it fits
   - release-note context for user-facing fixes in PR body or commit message; credit human reporter/contributor when known
6. Review, verify, and publish:
   - refresh the PR branch only for a real conflict, failing exact-head check or wrapper guard, explicit request, or demonstrated material stale-base risk
   - resolve actual conflicts or CI failures rather than counting the PR as ready
   - do not add `CHANGELOG.md` during normal sweep PRs; release automation generates it from PRs and commits
   - left-test the exact candidate head with the smallest meaningful local/Testbox/live command that proves the bug
   - run `$autoreview` until no accepted/actionable findings remain before creating, updating, or presenting the PR URL
   - create/update PR with real body and proof fields when authorized
   - push the exact reviewed head only when an authorized change requires publication
   - verify live GitHub CI is green for that pushed head; do not count pending, red, dirty, conflicting, or externally blocked PRs in the five
7. Hygiene:
   - close duplicates and fixed-on-main issues/PRs with proof only when closure is authorized; otherwise report the evidence
   - mutate more than five associated items in one cluster only when the explicitly authorized bounded scope includes them; more than 50 close/reopen actions still require separate exact-count/scope approval
   - comments must be kind, concrete, and include proof/PR/commit links
8. Repeat until `batch_size` landable PR URLs are ready or the bounded qualified queue is exhausted.

## PR Body Proof

Use the repo PR template. Include authored `## What Problem This Solves` and
`## Evidence` sections. Keep the body focused on intent and the most useful
validation evidence; inspect the code, tests, and CI before judging correctness.

## Existing PR Rules

- Review code path beyond the diff before trusting it.
- If PR is good: fix concrete issues, left-test and autoreview the exact head, publish authorized changes, and require exact-head green CI before showing it.
- If PR is incomplete or wrong-layer but editable: rewrite/refactor the existing PR at the root-cause owner, preserve author credit, and verify its corrected head.
- If PR is duplicate or fixed on current `main`: comment proof and close only when closure is authorized; otherwise report the evidence.
- If the source branch is uneditable or unsafe to update: create a replacement only when authorized, preserve useful commits/credit, and close the original only after the replacement exists and closure is authorized.
- If CI turns red after local proof, treat that as normal work: inspect the failing job, fix or reject, rerun, and only count the PR once green.

## Output Ledger

Maintain a running ledger:

```text
accepted:
- PR URL:
  source refs:
  bug:
  root cause:
  fix:
  production LOC:
  test LOC:
  risk:
  head/base status:
  left-test:
  autoreview:
  CI:
  credit/thanks:
  cleanup:

rejected:
- ref:
  reason:

closed:
- ref:
  reason:
  proof/comment:
```

Final answer:

- the requested number of accepted PR URLs, or the smaller qualified count with the exhausted-search reason
- 2-4 sentence explainer per PR
- proof/CI state per PR
- closed duplicates/fixed-on-main refs
- current branch/status
