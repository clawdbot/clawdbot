---
name: release-openclaw-ci
description: "Run, watch, debug, and summarize OpenClaw full release CI, release checks, live provider gates, install/update proofs, and release-secret preflights."
---

# OpenClaw Release CI

Use this with `$release-openclaw-maintainer` and `$openclaw-testing` when a release candidate needs full validation, install/update proof, live provider checks, or CI recovery.

## Guardrails

- No version bump, tag, npm publish, GitHub release, or release promotion without explicit operator approval.
- After compaction, resume, or new steering, rewrite the effective goal and
  current phase from the latest explicit operator instruction. Do not merge old
  scope back into the active release.
- Hold the release scope once a release branch or Code SHA exists. Validate and
  ship that exact release; do not turn moving `main` into a second work queue.
- Record every active validation run as the immutable tuple **Validation SHA +
  Tooling SHA + rerun group**. Validation SHA maps to the Code SHA for product validation or
  the Release SHA for changelog-only validation; it is not a third release
  identity. A branch or temporary ref is context and transport.
- Freeze the candidate SHA/ref and Tooling SHA/ref once. Main lineage authorizes
  the initial Tooling SHA selection; it does not authorize replacing that
  tooling after `main` advances.
- Apply a release firebreak after the Code SHA is frozen. Admit only confirmed
  product defects, package/provenance defects in the bytes to publish, security
  defects, or failures that make publication impossible. Queue other findings
  for postpublish confidence or the next beta.
- Use trusted `main` workflow revisions as immutable dispatch sources. Do not
  adopt newer main code, repair unrelated main CI, wait for broad main health,
  or expand a release fix because the workflow source lives on `main`.
- Once publication binds the Tooling SHA to an exact protected lightweight
  `release-publish/<12sha>-<provenance-run>` tag, that live tag-to-SHA mapping
  remains authoritative when `main` advances. The suffix records tag-creation
  provenance; it is not the current parent run id.
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
- Full Release Validation separates exact-child dispatch, Release Decision,
  and Diagnostic Drain. With `fail_fast=false`, it makes zero child
  cancellation calls; Diagnostic Drain follows every selected child to
  terminal unless the collector itself is cancelled or loses GitHub API
  access. With
  `fail_fast=true`, Release Decision may cancel only the exact still-active
  child that owns a blocking failure.
- Continuation recovery requires `fail_fast=false`; Release Decision masks it
  off whenever a continuation payload is present.
- After dispatch, one immutable execution-plan artifact records the original
  parent attempt, exact child tuples and titles, selected coverage, gates, and
  reuse identity. The same bytes are saved under an exact run-ID cache key.
  Decision, Drain, manifest writing, evidence validation, and final verification
  consume the artifact for their current attempt. A collector retry restores
  the cached plan, validates it, re-uploads its artifact, and adopts the same
  children; missing plan state is an orchestration failure, not permission to
  reconstruct the plan or redispatch.
- Reused evidence is not trusted merely because plan sealing found it. Release
  Decision repeats the sealed target SHA, evidence SHA, policy, changed paths,
  selected run, root run, source manifest, trusted tooling identity, and
  exact-child checks before returning `passed`.
- Parent retries select the newest Decision and Drain artifacts independently;
  both must bind the same immutable plan even when their source attempts differ.
- Child retries are part of the same immutable plan only when the child run ID,
  workflow path, ref, Tooling SHA, dispatch title, event, target, candidate, and
  validation inputs remain exact. Newer child attempts replace matching jobs;
  jobs absent from a newer attempt carry forward. A duplicate job identity,
  missing attempt, regressed attempt, or changed tuple fails closed.
- Use `pnpm frv status|continue --failed|verify` for attempt-aware recovery.
  The controller is stateless: the immutable execution plan, exact GitHub run
  attempts, Diagnostic Drain, and final manifest are the only authorities. It
  never writes a tag, package, registry entry, release candidate, or
  publication.
- Post-merge live proof must use the reviewed landed SHA on protected `main`,
  leave accepted green attempts untouched, observe exactly one continuation
  parent, pass final verification, and confirm the deterministic temporary ref
  was deleted. Treat retained-ref cleanup as failure. For fault proof, use the
  landed `loadPlan`, `continuationBranchName`, and `createClient` exports to
  pre-seed the exact task-owned branch at a different trusted-main ancestor;
  require wrong-OID rejection before dispatch, then exact-OID lease deletion.
  Test read retries only through an owner-only task-local `OPENCLAW_GH_BIN`
  wrapper against one exact read endpoint: one `HTTP 502` must recover and four
  must fail nonzero during `status` or `continue --failed --dry-run`. Never
  alter write arguments, expose tokens, weaken ancestry, or run PR-head code
  with write credentials. See
  [Full Release Validation](/reference/full-release-validation#post-merge-continuation-proof).
- Use one release operator, one transition-only watcher, and at most one
  investigator for the current failed surface. Do not build audit-review-plan
  trees around a single workflow transition.
- For regular beta/stable releases, treat the product-complete pre-changelog
  commit as the Code SHA. Full product validation and performance evidence bind
  to that SHA. The later Release SHA may reuse those results only when it is a
  descendant whose complete changed path set is exactly `CHANGELOG.md`.
- Extended-stable validates one exact branch tip; it does not reuse the regular
  Code-SHA/Release-SHA evidence model.
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

Record Validation SHA, Tooling SHA/ref, target context ref, parent run id,
attempt, and phase before watching or recovering Full Release Validation. Keep
Code SHA and Release SHA separately in the lifecycle ledger. Record the
immutable Release Publish parent receipt separately from tag provenance.

For the core and plugin npm mutations enforced by this foundation, re-read the
exact protected lightweight tag and revalidate the exact parent run tuple
immediately before each publish or dist-tag mutation. Reject a missing, moved,
annotated, or wrong-SHA tag; a repository, workflow, run id, attempt, tooling
identity, or parent-state mismatch; and any same-name branch. Never refresh
either identity from current `main`. Treat other privileged writers as blocked
until their dependent enforcement changes land.

- Conceptual phases map to current inputs as follows:
  - `beta-publish`: `release_profile=beta`, `run_release_soak=false`
  - `postpublish-confidence`: published package inputs with
    `run_release_soak=true` or explicit focused groups
  - `stable-publish`: `release_profile=stable`
- Keep at most one active parent for the same Validation SHA + Tooling SHA + rerun
  group. Concurrency does not cancel an older exact child automatically.
- Parent cancellation or timeout leaves adopted identity-checked children
  running. The operator must cancel an exact child explicitly when it is no
  longer useful. Do not infer a child identity from branch, title prefix, or
  latest-run order.
- Recover one failed surface with one diagnosis, one fix when needed, and one
  narrow retry. Then reassess the release decision. Do not automatically
  dispatch `rerun_group=all`.
- For a supported parent, `pnpm frv continue --failed --run <parent-run-id>`
  adopts any active newer child attempt, reruns failed child jobs in parallel,
  leaves green children untouched, then reruns the parent once to restore the
  immutable plan and seal a trusted all-group manifest. It does not start a
  second child retry while an attempt is active.
- Inspect without mutation:

  ```bash
  pnpm frv status --run <parent-run-id>
  pnpm frv verify --run <successful-parent-run-id>
  ```

- A historical parent whose authenticated execution-plan artifact predates
  attempt-aware evidence can be recovered only with an operator-reviewed
  `--legacy-plan <json>` that freezes the source parent tuple,
  source repository, exact child tuples, target SHA, complete candidate
  identity, release profile, soak value, complete validation inputs, and the
  reviewed continuation Tooling SHA. The controller reruns only those child
  run IDs, then dispatches one continuation parent from that frozen Tooling SHA
  with every candidate and child-producing job disabled:

  ```bash
  pnpm frv continue --failed \
    --run <legacy-parent-run-id> \
    --legacy-plan <reviewed-source-plan.json>
  ```

  The continuation parent records the legacy source in its immutable plan and
  emits a normal `rerunGroup=all` manifest. The reviewed JSON must match the
  historical artifact's parent attempt, target, workflow, profile, rerun group,
  and selected child tuples. Attempt-aware artifacts reject legacy mode. A
  historical source manifest is optional only for these pre-support roots. When
  absent, preflight and publication independently
  bind the exact successful root resolver, release-checks child resolver,
  reusable-workflow Inputs group, source workflow-dispatch schema, and package,
  plugin-registry, and Docker candidate artifacts. Blank omitted inputs are
  accepted only when that complete Inputs group omits the key and the exact
  trusted source schema declares an explicitly blank default. Never infer
  missing legacy identity from a skipped reuse job, nearby title, branch, latest
  run, later decision/drain/manifest artifact, or current `main`.

- Controller retries are `ci`, `plugin-prerelease`, `install-smoke`,
  `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`,
  or `performance`. Never use the removed `release-checks` handle. `qa` is
  only a direct-child manual aggregate, not a controller retry API.
- Filtered retries fail closed unless the filter belongs to the selected group.
  Never turn an empty derived filter into an unfiltered broad run.
- A new all-group parent is justified only when shared orchestration changed,
  earlier evidence is invalid for the selected tuple, or the operator explicitly
  requests it. Record the invalidating event.
- Narrow child or group evidence does not by itself become publish
  authorization. Keep it in the evidence ledger for the release owner to judge
  against the current publish gate.

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
# Full Release Validation profile gate: true for stable, false for beta.
fail_on_regression=true
gh workflow run openclaw-performance.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f target_ref=<code-sha> \
  -f profile=release \
  -f repeat=3 \
  -f deep_profile=false \
  -f live_openai_candidate=false \
  -f fail_on_regression="$fail_on_regression"
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
TOOLING_SHA="<exact-main-ancestor-sha>"
node scripts/full-release-validation-at-sha.mjs \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

For regular `release/*` validation, never raw-dispatch the workflow without
`target_context_ref` (the helper's `--target-ref` records it). Canonical
`release/*` and `extended-stable/*` workflow refs remain supported routes, but
their Telegram child must retain the exact parent workflow ref and SHA through
OIDC and attestation. Trusted-workflow release-branch CI passes `target_ref` +
`release_candidate_ref`; never `release_gate` there — it requires workflow head
== target. (The PR-head ci.yml fallback below is a different dispatch and does
use `release_gate=true`.)

The release branch may advance after the Code SHA is frozen. The helper accepts
that frozen SHA only while it remains an ancestor of the canonical release
branch and its package version is either the branch's final version or a
matching beta prerelease. Alpha remains on the Tideclaw path with a matching
alpha branch and exact alpha tag. Extended-stable branches and all tags require
an exact package-version match.
Always pass the previously recorded full Tooling SHA for release-branch runs.
Never replace it with a fresh `main` lookup. The Tooling SHA must declare the
current release-isolation contract; older workflow revisions fail closed.

For immutable workflow proof on a moving `main`, use
`pnpm ci:full-release --sha <code-sha> --target-ref
release/YYYY.M.PATCH --workflow-sha <tooling-sha>`. Its canonical `release-ci/*` ref keeps evidence reuse
enabled after proving the workflow commit is still on trusted `main` lineage.
Pass `-f reuse_evidence=false` only when the operator intentionally needs a
fresh full run.

After the Code SHA is green, commit only `CHANGELOG.md` and run the same helper
against the Release SHA. The parent must report
`policy=changelog-only-release-v1`, `evidenceSha=<code-sha>`, and
`changedPaths=["CHANGELOG.md"]`; it should reuse the product matrix instead of
dispatching child lanes. Npm preflight and package/install acceptance still run
against the exact Release SHA and its new tarball bytes.

The SHA-pinned helper infers `beta` for matching beta release candidates and
exact alpha tags, and `stable` for stable/correction versions, then passes the
Validation SHA + Tooling SHA run identity. `beta` without soak is the bounded
beta-publish gate. Run broad live QA and E2E as postpublish confidence with
`run_release_soak=true` or explicit groups. Stable and full profiles force the
release soak. Use a narrow `rerun_group` after focused fixes; never widen
automatically.
Publish with `openclaw-release-publish.yml` using `release_profile=from-validation`
unless a maintainer intentionally wants to cross-check a specific profile; the
publish workflow reads the effective profile from the full-validation manifest.

### Extended-stable validation

For `.33+`, dispatch from and target the canonical branch. This direct route is
intentional: downstream extended-stable evidence requires the canonical branch
identity, while Telegram still authenticates the exact branch SHA:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
gh workflow run full-release-validation.yml \
  --ref extended-stable/YYYY.M.33 \
  -f ref=extended-stable/YYYY.M.33 \
  -f expected_sha="$RELEASE_SHA" \
  -f release_profile=stable
```

Accept only a complete `rerun_group=all` run whose branch, head/target SHAs,
manifest `workflowRef`, and package versions identify the same commit. Save its
successful `run_attempt` and require the final tag to resolve there. Reject
`release-ci/*`, current-main, narrow, and earlier-attempt evidence.

Product failures need an approved backport. Frozen-target tooling failures need
the smallest behavior-preserving repair. Provider, approval, runner, or log
races keep the candidate unchanged. Record repairs and superseded runs; any
branch change requires a new complete parent. Omit only an explicitly
unsupported frozen-target scenario, never a required behavior or package.

## Watch

Use the transition-only summary watcher instead of repeated raw polling:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id> --watch
```

Do not start this watcher when the SHA-pinned helper is still the foreground
owner. The helper reads the exact Release Decision artifact itself. On
`blocked_diagnostics_running`, it exits nonzero immediately, keeps the temporary
refs, and leaves Diagnostic Drain collecting the remaining terminal evidence.
The watcher behaves the same way for separately dispatched parents: it reports
the Release Decision blocker once and exits while the drain continues.

For a one-shot snapshot:

```bash
node scripts/release-ci-summary.mjs <full-release-run-id>
```

`release-ci-summary` accepts Full Release Validation parent runs only.
Diverged release-branch logs: `--first-parent` plus a bounded count.
Stop watchers before ending the turn or switching strategy.

Interpret state precisely:

- `qualifying`: no decisive blocker yet; selected children are still active.
- `blocked_diagnostics_running`: publication is blocked; Diagnostic Drain is
  still collecting independent failures. Diagnose now, but do not retry until
  the drain is terminal.
- `passed`: all required policy and exact-child evidence passed.
- `blocked_complete`: publication is blocked and all selected diagnostics are
  terminal.
- `orchestration_error`: GitHub API or collector failure prevented a verdict.
  This is not a provenance mismatch. Recover the collector against the same
  exact children; never redispatch tests to repair collection.
- `cancelled_with_children`: the collector was cancelled while exact children
  remained active.

The `full-release-diagnostics-<run-id>-<attempt>` artifact is the terminal
failure and timing manifest. Use it after an early blocker instead of
restarting `all` merely to discover what the still-running children found.
The stable `full-release-execution-plan-<run-id>` artifact is the identity
source within each collector attempt; retry attempts restore its immutable
run-ID-cached bytes first.

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
   - confirmed product/code failure: fix the release branch, freeze a new Code
     SHA, and invalidate product evidence
   - harness/tooling/provenance failure: keep the Code SHA, fix the smallest
     owning surface, and retry only the failed surface with the required Tooling
     SHA
   - infrastructure/credential failure: keep both SHAs, repair the external
     prerequisite, and retry only the failed surface
   - wrapper/monitor failure: keep the child and candidate identities; record
     the wrapper result separately from the child result
   - changelog/release-note failure: change only `CHANGELOG.md`, keep Code SHA
     evidence, and repeat Release SHA proof
   - publish child/registry selector failure: keep Release SHA and resume the
     failed child; never rebuild an immutable version that already published
     Only the first class changes the Code SHA. After one diagnosis/fix/narrow
     retry, reassess instead of starting another all-group cycle.
7. If a required PR CI run is capacity-stalled with queued jobs and no active
   jobs, do not cancel unrelated work or accept a generic manual dispatch.
   First verify the PR head carries the current fallback schema:
   `gh api 'repos/openclaw/openclaw/contents/.github/workflows/ci.yml?ref=<pr-head-branch>'
--jq .content | base64 --decode | rg -q 'pull_request_number:'`. If absent,
   refresh the PR head from `main` and use the new head SHA; let normal CI run
   before considering another fallback.
   From the PR head branch, dispatch the explicit exact-SHA fallback:
   `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f
target_ref=<full-pr-sha> -f pull_request_number=<pr-number> -f
include_android=true -f release_gate=true`.
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

- release lifecycle ledger: Code SHA, Release SHA, and Tooling SHA for regular
  releases; canonical branch, exact SHA, and immutable tag for extended-stable
- evidence-reuse policy and complete changed-path set
- active full parent run URL, attempt, workflow SHA, and any superseded parent
  with the exact replacement reason
- child run IDs and conclusions: CI, Release Checks, Plugin Prerelease, NPM Telegram, Product Performance
- performance comparison result versus earlier releases when available
- targeted local proof commands
- provider-secret preflight result
- frozen-target compatibility repairs or omitted inapplicable scenarios, with
  their source PRs and invariant
- known gaps or unrelated failures

For lessons and recovery patterns, read `references/release-ci-notes.md`.
