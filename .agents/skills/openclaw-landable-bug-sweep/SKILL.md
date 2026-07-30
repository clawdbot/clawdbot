---
name: openclaw-landable-bug-sweep
description: "Find or repair a requested batch of small high-confidence non-SDK-boundary OpenClaw bugfix PRs until they are landable."
---

# OpenClaw Landable Bug Sweep

Autonomous maintainer workflow for producing a requested batch of landable OpenClaw bugfix PR URLs.
Use for broad issue/PR sweeps where the bar is high and the output is PRs, not notes.
Do not use for plugin SDK/API boundary work; those need separate architecture review.

## Target

Use `batch_size` from the request, defaulting to `5` and capped at `20`.
Return up to that many qualified PR URLs, each with:

- bug summary
- why the fix is low-risk
- proof: rebased-head local/Testbox/live commands or run IDs
- autoreview: clean result on the exact head being shown
- CI green on the exact pushed PR head
- issue/duplicate cleanup done or still pending

The URLs may be existing PRs that were reviewed/fixed, or new PRs created from issues/clusters.
Do not present a PR URL to the maintainer until it has been refreshed on current `main`, left-tested, autoreviewed clean, pushed, and verified green in live GitHub CI.
If code, tests, changelog, PR body, or branch base changes after autoreview, rerun autoreview before showing the URL.
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
- PRs whose final head has not passed `$autoreview`
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
   - exclude PRs authored by wide-access maintainers until `created_at` is at least 14 days old; only a named PR or explicit maintainer-work request overrides
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
   - release-note context for user-facing fixes in PR body or commit message; credit human reporter/contributor when known
6. Review, refresh, and publish:
   - rebase or otherwise refresh the PR branch on current `origin/main`
   - resolve drift, including newly exposed CI failures, rather than counting the PR as ready
   - do not add `CHANGELOG.md` during normal sweep PRs; release automation generates it from PRs and commits
   - left-test the rebased head with the smallest meaningful local/Testbox/live command that proves the bug
   - run `$autoreview` until no accepted/actionable findings remain before creating, updating, or presenting the PR URL
   - create/update PR with real body and proof fields
   - push the exact reviewed head
   - verify live GitHub CI is green for that pushed head; do not count pending, red, dirty, conflicting, or externally blocked PRs in the five
7. Hygiene:
   - close duplicates and fixed-on-main issues/PRs with proof as soon as you notice them during the sweep
   - never mutate more than five associated items in one cluster without explicit confirmation
   - comments must be kind, concrete, and include proof/PR/commit links
8. Repeat until `batch_size` landable PR URLs are ready or the bounded qualified queue is exhausted.

## PR Body Proof

Use the repo PR template. Include authored `## What Problem This Solves` and
`## Evidence` sections. Keep the body focused on intent and the most useful
validation evidence; inspect the code, tests, and CI before judging correctness.

## Existing PR Rules

- Review code path beyond the diff before trusting it.
- If PR is good: rebase/refresh on current `main`, fix small issues, left-test, autoreview clean, push, and get CI green before showing or counting it.
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

- the requested number of accepted PR URLs, or the smaller qualified count with the exhausted-search reason
- 2-4 sentence explainer per PR
- proof/CI state per PR
- closed duplicates/fixed-on-main refs
- current branch/status
