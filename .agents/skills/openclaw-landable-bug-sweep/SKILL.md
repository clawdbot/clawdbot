---
name: openclaw-landable-bug-sweep
description: "Find or repair small high-confidence non-SDK-boundary OpenClaw bugfix PRs until five are landable."
---

# OpenClaw Landable Bug Sweep

Autonomous maintainer workflow for producing five landable OpenClaw bugfix PR URLs.
Use for broad issue/PR sweeps where the bar is high and the output is PRs, not notes.
Do not use for plugin SDK/API boundary work; those need separate architecture review.

## Target

Return exactly five PR URLs, each with:

- bug summary
- why the fix is low-risk
- proof: rebased-head local/Testbox/live commands or run IDs
- CI green on the exact pushed PR head
- issue/duplicate cleanup done or still pending

The five URLs may be existing PRs that were reviewed/fixed, or new PRs created from issues/clusters.
Do not present a PR as one of the five until it has been refreshed on current `main`, left-tested, pushed, and verified green in live GitHub CI.

## Companion Skills

Use `$gitcrawl` for discovery/clustering, `$openclaw-pr-maintainer` for live GitHub mutation rules, `$github-author-context` when contributor trust matters, `$openclaw-testing` for proof choice, `$autoreview` before publishing/landing, and `$crabbox` for broad/E2E/live proof.

## Candidate Bar

Accept only when all are true:

- bug or paper cut, not feature/product/support/docs-only
- root cause is proven in current code
- dependency behavior checked via upstream docs/source/types when relevant
- production/runtime diff is small, ideally much smaller than 500 LOC and always below 500 LOC
- tests may be larger, but focused
- no new dependency
- no new config option
- no backward-incompatible behavior
- no security/product/owner-boundary decision needed
- no plugin SDK, public plugin API, or `src/plugin-sdk/**` boundary change
- no broad refactor smell
- focused proof is feasible
- branch can be rebased/refreshed and pushed, or a replacement PR can be created

Good examples:

- provider parameter mismatch proven against dependency/API contract
- CLI command diverges from adjacent command behavior
- narrow runtime state/serialization bug with failing test
- issue already fixed on current `main`, with proof and closeable duplicates

Reject:

- feature requests, new knobs, migrations, release work, workflow policy, support
- plugin SDK/API boundary changes, including compatibility shims, new SDK methods, SDK exports, or plugin-facing channel/provider seams
- auth/security boundary changes unless explicitly assigned
- bugs needing live credentials that are unavailable
- PRs with red CI unless you fix, rebase, push, and recheck them green
- PRs you only reviewed locally but did not refresh/push/check live
- fixes whose clean shape is a larger architecture move
- speculative reports without reproducible/provable cause
- UI/UX changes requiring product judgment

## Sweep Loop

1. Start clean:
   - `git status -sb`
   - `git pull --ff-only`
   - verify branch is expected, usually `main`
2. Build candidate clusters:
   - `gitcrawl` open issues/PRs, neighbors, and search
   - live `gh issue/pr view`
   - include PRs linked from issues and duplicates
3. For each cluster:
   - read issue/PR body, comments, labels, linked refs, current source, adjacent tests
   - suppress maintainer-owned queue noise unless it is the best fix path
   - identify opener/author and preserve credit
   - decide: `repair-existing-pr`, `create-new-pr`, `close-fixed-on-main`, `close-duplicate`, or `reject`
4. Prove before patching:
   - failing test, focused repro, log/source proof, or dependency contract proof
   - if already fixed on `main`, prove with current source/test/commit and close kindly
5. Patch:
   - prefer existing PR when good and writable
   - if unwritable or wrong shape, create own PR and preserve useful contributor credit
   - if no PR exists, create one
   - add regression test when it fits
   - changelog for user-facing fixes; thank credited human reporter/contributor
6. Review, refresh, and publish:
   - rebase or otherwise refresh the PR branch on current `origin/main`
   - resolve drift, including newly exposed CI failures, rather than counting the PR as ready
   - left-test the rebased head with the smallest meaningful local/Testbox/live command that proves the bug
   - run `$autoreview` until no accepted/actionable findings remain
   - create/update PR with real body and proof fields
   - push the exact reviewed head
   - verify live GitHub CI is green for that pushed head; do not count pending, red, dirty, conflicting, or externally blocked PRs in the five
7. Hygiene:
   - close duplicates and fixed-on-main issues/PRs with proof as soon as you notice them during the sweep
   - never mutate more than five associated items in one cluster without explicit confirmation
   - comments must be kind, concrete, and include proof/PR/commit links
8. Repeat until five landable PR URLs are ready.

## PR Body Proof

Use the repo PR template. Include these exact labels:

```text
Behavior addressed:
Real environment tested:
Exact steps or command run after this patch:
Evidence after fix:
Observed result after fix:
What was not tested:
```

## Existing PR Rules

- Review code path beyond the diff before trusting it.
- If PR is good: rebase/refresh on current `main`, fix small issues, left-test, autoreview, push, and get CI green before counting it.
- If PR is not good but has a useful idea: recreate locally, co-author when warranted, close original with thanks and explanation.
- If PR is duplicate or fixed on `main`: comment proof, close.
- If maintainer cannot push to contributor branch: create own branch/PR, preserve useful commits or credit.
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
  risk:
  rebase/head:
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

- exactly five accepted PR URLs
- 2-4 sentence explainer per PR
- proof/CI state per PR
- closed duplicates/fixed-on-main refs
- current branch/status
