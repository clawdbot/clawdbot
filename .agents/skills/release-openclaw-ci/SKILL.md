---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use this with `$release-openclaw-maintainer` and `$openclaw-testing` when a release candidate needs full validation, install/update proof, live provider checks, or CI recovery.

## Guardrails

- No version bump, tag, npm publish, GitHub release, or release promotion without explicit operator approval.
- Hold the release scope once a release branch or Code SHA exists. Validate and
  ship that exact release; do not turn moving `main` into a second work queue.
- Use trusted `main` workflow revisions as immutable dispatch sources. Do not
  adopt newer main code, repair unrelated main CI, wait for broad main health,
  or expand a release fix because the workflow source lives on `main`.
- Touch `main` only for an operator-requested change or the smallest critical
  main-owned blocker that prevents this release and cannot be handled from the
  release branch. If the required main landing policy is blocked by unrelated
  main failures, report that blocker and keep independent release work moving
  instead of healing broader main.
- Validate provider secrets before dispatching expensive full release matrices.
- Do not set GitHub secrets from unvalidated 1Password candidates. If a candidate returns 401/403, leave the existing secret alone and report the exact missing provider.
- Use `$one-password` for secret reads/writes: one persistent tmux session, targeted items only, no secret output.
- Watch one parent run plus compact child summaries. Avoid broad `gh run view` polling loops; REST quota is easy to burn.
- Fetch logs only for failed or currently-blocking jobs. If quota is low, stop polling and wait for reset.
- Treat live-provider flakes separately from code failures: prove key validity, provider HTTP status, retry evidence, and exact failing lane before editing code.
- A model-list response proves authentication, not billing or inference
  entitlement. Mandatory live providers must pass a real completion probe
  before release dispatch. Fix the credential first; do not add an alternate
  auth path merely to bypass a failed release credential.
- Full Release Validation parent monitors fail fast: once a required child job
  fails, the parent cancels the remaining child matrix and prints the failed
  job summary. Inspect that first red job instead of waiting for unrelated
  matrix tails.
- Treat the product-complete pre-changelog commit as the Code SHA. Full product
  validation and performance evidence bind to that SHA. The later Release SHA
  may reuse those results only when it is a descendant whose complete changed
  path set is exactly `CHANGELOG.md`.
- In a sparse worktree or Testbox source sync, first confirm `package.json`,
  `pnpm-lock.yaml`, and every source path the selected check reads. If any are
  absent, that checkout cannot validate a release dependency or Docker lane:
  stop and use the repo remote changed gate or a full task worktree. When the
  inputs are present and a release fix changes `package.json` or
  `pnpm-lock.yaml`, rebuild only the task-owned disposable box with
  `CI=true pnpm install --frozen-lockfile`, then run an explicit
  `require.resolve()` probe before Docker or focused tests. The CI flag permits
  pnpm to recreate a prewarmed modules directory without an interactive
  confirmation. Do not weaken the lockfile or label sparse-checkout failures
  as product/Docker failures.
- If the candidate is rebased or its base SHA changes after warmup, stop the
  task-owned box and warm a fresh one before testing. Testbox source sync is
  relative to the warmed source tree; continuing can mix an old base file with
  a new candidate diff and produce false lockfile or Docker failures.
- Reused Testboxes are provenance-gated after their first successful run.
  Source-only edits may reuse the lease; base, dependency, wrapper, or Testbox
  workflow drift requires a fresh lease. Do not set
  `OPENCLAW_TESTBOX_ALLOW_STALE=1` for release evidence.
- For a committed release candidate, warm the box with
  `blacksmith testbox warmup ... --ref <candidate-branch-or-sha>`. Do not rely
  on source sync to overlay committed branch changes onto the workflow's
  default ref.

## Run identity and retry budget

Record the target SHA, target ref, parent run id, attempt, and effective
workflow SHA before watching or recovering Full Release Validation.

- One target SHA has one active canonical `rerun_group=all` parent run by
  default.
- Use GitHub's failed-job rerun on the same parent when its original inputs
  still select the correct work.
- A new parent for the same target SHA is allowed only when no usable parent
  exists, the existing run cannot consume a required trusted-workflow fix, its
  evidence identity is invalid, or the operator explicitly requests a fresh
  run. The replacement must also use `rerun_group=all`; record which terminal
  parent it supersedes and why.
- A narrow `rerun_group` dispatch is supplemental diagnostic proof only. It
  never supersedes the canonical parent and cannot satisfy publish evidence.
  Run it only after the canonical parent is terminal, then obtain green
  `rerun_group=all` evidence before publish.
- Never keep two parents active for the same SHA. Cancel only the superseded
  task-owned run after the replacement is identified.
- After two unchanged retries of the same failure, stop repeating it. Recheck
  classification and report one precise blocker or the missing evidence needed
  for a different action.

## Preflight

Before full release validation:

```bash
node .agents/skills/release-openclaw-ci/scripts/verify-provider-secrets.mjs --required openai,anthropic,fireworks
gh api rate_limit --jq '.resources.core'
git status --short --branch
git rev-parse HEAD
```

1Password service-account values are the first source for release provider
preflight. Inject those exact targeted keys first, then run the verifier; use
ambient env only when it was already intentionally injected for this release.
The script prints only provider status and HTTP class, never tokens.
The Anthropic check performs a tiny message completion so exhausted or
non-billable credentials fail before the expensive release matrix.

## Dispatch

Start product performance evidence as early as the Code SHA exists, in
parallel with other release work:

```bash
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<code-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression=true
```

- Do not wait for full release validation to start this early perf signal.
- Compare available Kova, gateway startup, and CLI startup metrics with earlier
  release evidence or clawgrit reports before publish/closeout.
- Call out any regression in the release proof. Treat a major regression as a
  release blocker until it is fixed, waived by the operator, or proven to be
  infrastructure noise.
- Full Release Validation records blocking product-performance evidence. The
  early standalone run is for overlap and faster regression discovery, but a
  regression or missing child run blocks the parent validation.

Prefer an immutable trusted-main workflow revision, target the exact Code SHA:

- Keep trusted-workflow checks compatible with frozen release targets. If
  `main` adds a target-owned guard script or package command after the release
  branch cut, make the trusted workflow skip only when that target surface is
  absent. Repair the smallest trusted-workflow compatibility issue only when it
  blocks the release, then rerun validation. Do not port an unrelated runtime
  refactor, heal other main failures, or mutate the release candidate just to
  satisfy a newer `main`-only check.

```bash
node scripts/full-release-validation-at-sha.mjs \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH
```

For immutable workflow proof on a moving `main`, use
`pnpm ci:full-release --sha <code-sha> --target-ref
release/YYYY.M.PATCH`. Its canonical `release-ci/*` ref keeps evidence reuse
enabled after proving the workflow commit is still on trusted `main` lineage.
Pass `-f reuse_evidence=false` only when the operator intentionally needs a
fresh full run.

After the Code SHA is green, commit only `CHANGELOG.md` and run the same helper
against the Release SHA. The parent must report
`policy=changelog-only-release-v1`, `evidenceSha=<code-sha>`, and
`changedPaths=["CHANGELOG.md"]`; it should reuse the product matrix instead of
dispatching child lanes. Npm preflight and package/install acceptance still run
against the exact Release SHA and its new tarball bytes.

The SHA-pinned helper infers `beta` for alpha/beta package versions and `stable`
for stable/correction versions. Pass `release_profile=full` only when the
operator explicitly asks for the broad advisory provider/media matrix. Stable
and full profiles force the release soak; the beta profile may opt in with
`run_release_soak=true`. Use narrow `rerun_group` after focused fixes.
Publish with `openclaw-release-publish.yml` using `release_profile=from-validation`
unless a maintainer intentionally wants to cross-check a specific profile; the
publish workflow reads the effective profile from the full-validation manifest.

## Watch

Use the transition-only summary watcher instead of repeated raw polling:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

For a one-shot snapshot:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id>
```

Stop watchers before ending the turn or switching strategy.

## Failure Triage

1. Confirm parent SHA and child run IDs.
2. List failed jobs only:
   ```bash
   gh run view <child-run-id> --repo openclaw/openclaw --json jobs \
     --jq '.jobs[] | select(.conclusion=="failure" or .conclusion=="timed_out" or .conclusion=="cancelled") | [.databaseId,.name,.conclusion,.url] | @tsv'
   ```
3. Fetch one failed job log. If rate-limited, note reset time and avoid more REST calls.
4. For secret-looking failures, validate a real completion from the same secret source before editing code. A successful model-list request is insufficient.
   Claude CLI subscription credentials are a separate native auth path; prove
   them in a clean-home CLI probe, never as a substitute for a required
   Anthropic API-key lane.
5. For live-cache failures, inspect whether it is missing/invalid key, empty text, provider refusal, timeout, or baseline miss. Do not weaken release gates without clear provider evidence.
6. Classify before editing:
   - product/code failure: fix the release branch, freeze a new Code SHA, run
     focused proof, then obtain green full validation for that new SHA
   - workflow/harness/infrastructure/credential failure: fix the smallest
     owning surface and rerun failed jobs on the current parent when its inputs
     still select the correct work; otherwise supersede the terminal parent once
     with a new `rerun_group=all` parent on the required trusted-workflow
     revision. Keep the same Code SHA; touching `main` still requires the active
     release scope lock
   - changelog/release-note failure: change only `CHANGELOG.md`, keep Code SHA
     evidence, and repeat Release SHA proof
   - publish child/registry selector failure: keep Release SHA and resume the
     failed child; never rebuild an immutable version that already published
7. If a required PR CI run is capacity-stalled with queued jobs and no active
   jobs, do not cancel unrelated work or accept a generic manual dispatch.
   First check the target-owned workflow with `git show
<full-pr-sha>:.github/workflows/ci.yml | rg -q '^  +pr_number:'`. When it
   declares `pr_number`, dispatch the explicit exact-SHA fallback:
   `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f
target_ref=<full-pr-sha> -f pr_number=<pr-number> -f include_android=true -f
release_gate=true`.
   The workflow authenticates that PR's head/base, validates GitHub's current
   synthetic merge tree, and runs the LOC task from that tree. Older workflow
   schemas cannot provide equivalent LOC evidence; update the head to contain the current `pr_number` workflow, then
   restart exact-head proof on the new SHA instead of dispatching them.
   It runs on GitHub-hosted runners and is accepted only when its run title is
   `CI release gate <full-pr-sha>`. Record the stalled Blacksmith run and the
   fallback run in release evidence.
   If `Blacksmith Build Artifacts Testbox` is the only remaining required gate
   and remains queued without a runner, that completed exact fallback may cover
   it because CI's `build-artifacts` job already builds, packages, and smoke
   tests the artifacts. Do not use this coverage after the artifact workflow
   starts or completes non-successfully.

## Evidence

Record:

- Code SHA and Release SHA
- evidence-reuse policy and complete changed-path set
- active full parent run URL, attempt, workflow SHA, and any superseded parent
  with the exact replacement reason
- child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance
- performance comparison result versus earlier releases when available
- targeted local proof commands
- provider-secret preflight result
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
