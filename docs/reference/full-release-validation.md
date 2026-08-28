---
doc-schema-version: 1
summary: "Full Release Validation stages, child workflows, release profiles, rerun handles, and evidence"
title: "Full release validation"
read_when:
  - Running or rerunning Full Release Validation
  - Comparing stable and full release validation profiles
  - Debugging release validation stage failures
---

`Full Release Validation` is the release product-validation umbrella. Most work
happens in child workflows so a failed box can be rerun without restarting the
whole release. Run release preparation before freezing the Code SHA; it
refreshes Control UI locale output when the background bot has not landed it
yet, then enforces the same strict zero-fallback check used by release CI.

Freeze the product-complete pre-changelog commit and its target context as the
**Code SHA/ref**, and select one trusted workflow commit and context as the
**Tooling SHA/ref**, then run:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

Record the candidate SHA/ref and Tooling SHA/ref once for the release and reuse
them for later Code-SHA, Release-SHA, and focused reruns. Main lineage
authorizes the initial Tooling SHA selection; it does not authorize refreshing
the tooling from moving `main`.

`provider` also accepts `anthropic` or `minimax` for cross-OS onboarding and the
end-to-end agent turn. Regular `release/*` targets accept only the branch's final
package version or a matching beta prerelease. Tideclaw alpha validation uses
its exact alpha tag and matching alpha branch. The helper maps beta releases and
exact alpha tags to the `beta` profile and final versions to `stable`. Pass
alternate workflow inputs with `-f key=value`; use `-f release_profile=full`
only for the broad advisory sweep.
`fail_fast` defaults to `false`, so dispatched child workflows finish and expose
independent failures together. In that mode, the parent makes no child
cancellation calls. Pass `-f fail_fast=true` only when the shorter
first-failure path is preferable; Release Decision then cancels only the exact
still-active child that owns the blocking failure.
Same-parent continuation requires the original root to have been dispatched
with `fail_fast=false`. The controller verifies that exact logged input before
any rerun mutation.

After dispatch, the parent writes one immutable
`full-release-execution-plan-<run-id>` artifact and preserves the same bytes in
an exact run-ID Actions cache. It records selected and
required coverage, gate results, reuse identity, the original parent attempt,
the fresh candidate request and producer evidence when preparation ran, and
every exact child run ID, attempt, title, workflow ref, and Tooling SHA.
Decision, Drain, manifest generation, evidence verification, and the final
verifier consume the artifact for their current attempt. Collector retries
use the exact run-ID cache as an acceleration. If that cache is unavailable,
they restore the same immutable plan from the parent-run artifact, validate it,
and upload the artifact again for the retry; they never rebuild the plan or
redispatch tests. A missing or invalid artifact fails closed, so start a new
validation instead of retrying that stale parent.
Release Decision also repeats canonical reuse-chain validation before a reused
run can pass. The sealed target SHA, evidence SHA, policy, changed-path set,
selected run, root run, source manifest, trusted tooling identity, and child
tuple must all still match.

On a parent retry, final verification selects the newest available Release
Decision and Diagnostic Drain artifacts independently. Both must bind the same
immutable plan and exact child tuple; their source attempts remain recorded in
the artifacts and may differ when only one collector needed a retry.

## Continue failed child jobs

Full Release Validation can adopt monotonically newer attempts of the exact
child runs recorded in its immutable plan. A newer attempt is accepted only
when the run ID, workflow path, workflow ref, Tooling SHA, dispatch title, and
event are unchanged. For each logical job, the newest observed attempt wins,
including a newer failure; a job absent from a newer attempt carries forward
from the last attempt that included it. Duplicate job names within one attempt,
missing attempts, or provenance drift fail closed.

Inspect or continue an existing parent:

```bash
pnpm frv status --run <parent-run-id>
pnpm frv continue --failed --run <parent-run-id>
pnpm frv verify --run <successful-parent-run-id>
```

`continue --failed` waits for active child attempts instead of starting a
duplicate. Once every active attempt is terminal, it reruns failed child jobs
in parallel, leaves green child workflows untouched, and reruns the parent
once. The parent restores its immutable execution plan, observes the effective
child attempts, and writes the final all-group manifest. The manifest records
the planned and effective attempt, accepted attempt for every logical job, and
a digest of the composite job evidence.

The command stores no continuation ledger or local journal. GitHub run
attempts, the immutable execution plan, Decision/Drain artifacts, and the final
manifest are the complete state model. It never tags, publishes, changes a
registry, or prepares a new candidate.

Parents whose immutable plan predates attempt-aware evidence cannot be
continued. Start a fresh all-group Full Release Validation instead; the
controller never reconstructs old state or dispatches a replacement parent.

The helper creates a temporary `release-ci/*` ref pinned to the Tooling SHA,
passes the Validation SHA as both the candidate ref and `expected_sha`, and
deletes the temporary ref after successful validation and strict evidence
verification. The helper reads Release Decision artifacts while the parent is
active so blockers can surface while Diagnostic Drain collects failures. It
waits 15 minutes between run-discovery attempts and between parent polling
iterations. One parent iteration may perform status, decision-artifact, and
progress-job reads together; the delay limits repeated polling cycles rather
than spacing every GitHub call. Run discovery makes one immediate check and one
delayed retry before failing. A not-yet-created artifact remains an unavailable
polling result; terminal handling and temporary-ref cleanup wait for the parent
to complete with a conclusion. Failed validations retain both refs for reruns
and diagnosis. The
Validation SHA equals the Code SHA for product validation or the Release SHA
for changelog-only validation; it is not a third release identity. The workflow
rejects malformed or mismatched expected SHAs before child dispatch. Every
child must report the same Tooling SHA. Pass
`-f reuse_evidence=false` to force a fresh run. Regular release-branch runs
require `--workflow-sha` with the recorded full SHA, which must remain reachable
from current `origin/main`. The helper rejects a pinned Tooling SHA that does
not declare the current release-isolation contract or the `expected_sha`
dispatch input; it never silently substitutes newer tooling. The workflow never
creates or updates repository refs itself.

### Post-merge continuation proof

Use the non-release `FRV Proof Broker` and `FRV Proof Fixture` workflows only
after the reviewed SHA lands on protected `main`. The fixture contains one
fixed no-op job that intentionally fails on attempt one and passes on attempt
two. The broker validates the exact maintainer, pull request head, protected
main SHA, fixture workflow, and run tuple before rerunning only that failed job.

Accept the hosted mutation proof only when the exact fixture run advances to
attempt two and passes. The broker emits a receipt and must create no release
candidate, release artifact, publication, repository ref, replacement parent,
or other workflow mutation. This proves the GitHub failed-job rerun boundary;
the focused controller tests prove plan eligibility, green-attempt
preservation, same-parent collection, and strict-verifier invocation. Do not
use a real Full Release Validation run for this proof.

The main-lineage requirement above applies to the initial validation tooling
selection. Once release publication binds that Tooling SHA to an exact protected
lightweight `release-publish/<12sha>-<provenance-run>` tag, the live tag-to-SHA
mapping remains authoritative even when `main` advances. The suffix records
tag-creation provenance, not the current parent run id. Publication must re-read
that exact tag and revalidate the exact parent run tuple immediately before each
core or plugin npm publish or dist-tag mutation. A missing, moved, annotated, or
wrong-SHA tag, parent mismatch, or disallowed parent state fails closed. Other
privileged writers require their dependent enforcement changes before the
protected-tag publication route is globally complete.

## Extended-stable exception

Extended-stable publish requires a run whose workflow and target are both the
canonical branch:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
gh workflow run full-release-validation.yml \
  --ref extended-stable/YYYY.M.33 \
  -f ref=extended-stable/YYYY.M.33 \
  -f expected_sha="$RELEASE_SHA" \
  -f release_profile=stable
```

Do not use `pnpm ci:full-release` or `release-ci/*`. Publish binds the run's
branch, head/target SHA, manifest `workflowRef`, ID, and attempt to the canonical
branch and release commit.

Backport product failures; make the smallest behavior-preserving repair for
frozen-target tooling; retry provider, approval, or runner failures without a
source change. Any branch change needs a complete new run. Do not omit required
package, installer, update, channel, or live behavior because the target is old.

For a regular release, when the Code SHA is green, generate and commit only
`CHANGELOG.md`. This new commit is the **Release SHA**. Run the same helper for
the Release SHA. Product evidence is reused only when GitHub proves the Release
SHA descends from the Code SHA and the complete changed path set is exactly
`CHANGELOG.md`; npm preflight and package/install acceptance still run on the
Release SHA.

The conceptual phases map to current inputs:

- `beta-publish`: `release_profile=beta`, `run_release_soak=false`
- `postpublish-confidence`: exact published package plus
  `run_release_soak=true` or explicit focused groups
- `stable-publish`: `release_profile=stable`

Beta-publish `all` excludes broad live/E2E soak and QA-live lanes. Stable and
full always run the soak. Stable publication rejects a validation manifest
without soak and blocking product-performance evidence.

Package Acceptance normally builds the candidate tarball from the resolved
`ref`, including full-SHA runs dispatched with `pnpm ci:full-release`. After a
beta publish, pass `release_package_spec=openclaw@YYYY.M.PATCH-beta.N` to reuse
the shipped npm package across release checks, Package Acceptance, cross-OS,
release-path Docker, and package Telegram. Use `package_acceptance_package_spec`
only when Package Acceptance should intentionally prove a different package.
The Codex plugin live package lane follows the same state: published
`release_package_spec` values derive `codex_plugin_spec=npm:@openclaw/codex@<version>`;
SHA/artifact runs pack `extensions/codex` from the selected ref; and operators
can set `codex_plugin_spec` directly for `npm:`, `npm-pack:`, or `git:` plugin
sources. The lane grants the explicit Codex CLI install approval required by
that plugin, then runs Codex CLI preflight and same-session OpenAI agent turns.
Its final zero-retry, medium-thinking turn sends visible progress with omitted
Codex `final`, reads randomized workspace inputs, writes their exact artifact,
and sends explicit completion. This catches the v2026.7.1 regression where an
ordinary progress send terminated the turn.

Use `-f skip_package_telegram_e2e=true` only when the release owner explicitly
defers the Package Acceptance Telegram E2E to a follow-up beta. The input is
rejected for `stable` and `full`, recorded in validation evidence, and does not disable the focused
`rerun_group=npm-telegram` workflow.

## Top-level stages

For `rerun_group=all`, a `Check for reusable validation evidence` job runs
first. It looks for the newest prior green full validation with the same release
profile, effective soak setting, and validation inputs. Exact-target reruns use
`exact-target-full-validation-v1`. A descendant whose complete delta is exactly
`CHANGELOG.md` uses `changelog-only-release-v1`; every product lane is skipped
and the verifier independently rechecks the GitHub commit comparison, immutable
parent artifact, child runs, and dispatch logs. Any other target change requires
a fresh Code SHA validation. Pass `reuse_evidence=false` to force a fresh full
run. Evidence reuse runs only from `main` or a canonical SHA-pinned
`release-ci/*` ref whose workflow commit remains on trusted `main` lineage;
other workflow refs run the selected lanes fresh.

Fresh package-facing validation prepares one immutable tarball plus one Docker
image artifact before dispatching Plugin Prerelease and OpenClaw Release Checks.
Both children verify the same package SHA, artifact IDs, service digests,
producer run attempt, and Docker archive digest before use. The package-independent
bare Docker layer uses a content-addressed GHCR cache; candidate-specific images
remain immutable GitHub artifacts. Focused runs with an explicit published
package spec keep the existing package path instead.

Preparation also emits a canonical request digest and a seven-day
`full-release-candidate-v1-<request-sha256>` evidence artifact. Its bounded
manifest binds the exact target and Tooling SHAs, release and soak policy,
effective survivor baselines and scenarios, preparation-plan digest, sorted
plugin package set, producer workflow/job/run attempt, and package, registry,
and image artifact identities and expiry timestamps. The execution plan seals
that producer evidence. Before preparing a candidate, the umbrella may reuse
the newest artifact with at least fourteen hours of remaining lifetime for the
same canonical request only after it revalidates the exact workflow run,
trusted publisher job, archive digest, manifest, producer attempt, producer
job, and live metadata for every package, registry, and image artifact.
Only a proven absence permits a fresh build. Discovery uncertainty and failures
after selection are blocking so the run cannot silently switch candidates.

Also for `rerun_group=all`, a `Verify Docker runtime image assets` job builds
the `runtime-assets` Docker target with
`OPENCLAW_EXTENSIONS=diagnostics-otel,codex`. It runs in parallel with the
other stages and is enforced by the umbrella verifier; lanes no longer wait for
it before dispatching. A narrower `rerun_group` skips this preflight.

| Stage                   | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution       | **Job:** `Resolve target ref`<br />**Child workflow:** none<br />**Proves:** resolves the release branch, tag, or full commit SHA and records selected inputs.<br />**Rerun:** rerun the umbrella if this fails.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Shared candidate        | **Jobs:** `Find trusted release candidate`, `Prepare shared release candidate`, and `Bind release candidate`<br />**Child workflow:** `OpenClaw Live And E2E Checks (Reusable)` for a cache miss<br />**Proves:** exact-reuses a trusted unexpired candidate for the same request or packs and validates one exact-SHA package, builds one functional Docker image, and emits content-addressed producer evidence for the package, plugin registry, image, and preparation plan. Both paths produce the same sealed downstream binding.<br />**Rerun:** rerun the affected package, plugin-prerelease, cross-OS, or live/E2E group. |
| Docker assets preflight | **Job:** `Verify Docker runtime image assets`<br />**Child workflow:** none<br />**Proves:** the `runtime-assets` Docker build target still succeeds before any other stage dispatches. Runs only for `rerun_group=all`.<br />**Rerun:** rerun the umbrella with `rerun_group=all`.                                                                                                                                                                                                                                                                                                                                                 |
| Vitest and normal CI    | **Job:** `Run normal full CI`<br />**Child workflow:** `CI`<br />**Proves:** manual full CI graph against the target ref, including Linux Node lanes, bundled plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, Control UI i18n, and Android via the umbrella.<br />**Rerun:** `rerun_group=ci`.                                                                                                                                                                                                  |
| Plugin prerelease       | **Job:** `Run plugin prerelease validation`<br />**Child workflow:** `Plugin Prerelease`<br />**Proves:** release-only plugin static checks, agentic plugin coverage, full plugin batch shards, plugin prerelease Docker lanes, and a non-blocking `plugin-inspector-advisory` artifact for compatibility triage.<br />**Rerun:** `rerun_group=plugin-prerelease`.                                                                                                                                                                                                                                                                  |
| Release checks          | **Job:** `Run release/live/Docker/QA validation`<br />**Child workflow:** `OpenClaw Release Checks`<br />**Proves:** install smoke, cross-OS package checks, Package Acceptance, and QA Lab parity. QA-live Matrix, Buzz, and Telegram plus gated advisory Discord, WhatsApp, and Slack run for stable/full, beta with `run_release_soak=true`, an explicit `qa-live` controller retry, or the direct child's manual `qa` aggregate. Stable and full profiles also run exhaustive live/E2E suites and Docker release-path chunks.<br />**Rerun:** classify the failed surface and select one concrete release-check group.          |
| Package Telegram        | **Job:** `Run package Telegram E2E`<br />**Child workflow:** `NPM Telegram Beta E2E`<br />**Proves:** a focused published-package Telegram E2E when `release_package_spec` or `npm_telegram_package_spec` is set. Full candidate validation uses the canonical Package Acceptance Telegram E2E instead.<br />**Rerun:** `rerun_group=npm-telegram` with `release_package_spec` or `npm_telegram_package_spec`.                                                                                                                                                                                                                      |
| Product performance     | **Job:** `Run product performance evidence`<br />**Child workflow:** `OpenClaw Performance`<br />**Proves:** release-profile performance run (`profile=release`, `repeat=3`, `fail_on_regression=true`, `publish_reports=false`) against the target SHA. Kova output stays in workflow artifacts and the child must prove its report publisher was skipped. Required (blocking) only for `rerun_group=all` or `rerun_group=performance`; not required for narrower rerun groups.<br />**Rerun:** `rerun_group=performance`.                                                                                                         |
| Release decision        | **Job:** `Release Decision`<br />**Child workflow:** none<br />**Proves:** polls the exact recorded child run IDs and attempts, enforces release policy, and publishes an attempt-bound decision artifact. A decisive failure becomes `blocked_diagnostics_running` while unrelated child diagnostics continue.<br />**Rerun:** fix or rerun only the blocking surface.                                                                                                                                                                                                                                                             |
| Diagnostic drain        | **Job:** `Diagnostic Drain`<br />**Child workflow:** none<br />**Proves:** with `fail_fast=false`, follows every selected exact child to terminal without cancellation and writes timing, failed-job, run-attempt, and Tooling-SHA evidence. Collector cancellation instead writes an immediate `cancelled_with_children` handoff containing active child identities.<br />**Rerun:** recover collection only for `orchestration_error`; product failures do not invalidate the drain.                                                                                                                                              |
| Execution plan          | **Job:** `Seal release execution plan`<br />**Child workflow:** none<br />**Proves:** persists the original parent attempt, exact child identities and titles, required coverage, gates, reuse identity, and fresh candidate request/producer binding in a stable run-bound artifact. Attempt-two collector recovery restores this artifact instead of redispatching.<br />**Rerun:** restore the existing plan only; a missing plan is an orchestration error.                                                                                                                                                                     |
| Umbrella verifier       | **Job:** `Verify full validation`<br />**Child workflow:** none<br />**Proves:** downloads the immutable execution plan plus the exact attempt-bound Release Decision and Diagnostic Drain artifacts, verifies their common digest and parent tuple, and accepts only a strict green decision plus terminal drain.<br />**Rerun:** recover the existing collectors or rerun only the failed product surface; the verifier never reclassifies or redispatches children.                                                                                                                                                              |

The five child-dispatch jobs own dispatch and exact identity capture only. They
emit the child run ID, run attempt, and URL, then finish. Release Decision owns
the blocking answer; Diagnostic Drain owns complete terminal evidence. The
immutable execution plan owns child identity across collector attempts. The
decision state is one of `qualifying`, `blocked_diagnostics_running`, `passed`,
`blocked_complete`, `orchestration_error`, or `cancelled_with_children`.
Persistent GitHub API failures are orchestration errors. A child whose workflow
path, display title, ref, Tooling SHA, or run ID changes is a distinct
provenance mismatch. A monotonically newer attempt is accepted only through the
composite-attempt rules above.

`blocked_diagnostics_running` is safe for immediate diagnosis but not for a
retry until Diagnostic Drain is terminal. `orchestration_error` authorizes
collector recovery against the same exact child identities, never test
redispatch. `blocked_complete` means diagnostics are complete; it does not
claim a drain is still running.

The umbrella always dispatches product performance in artifact-only mode.
`OpenClaw Performance` permits report publication only for scheduled runs or a
manual dispatch that explicitly sets `publish_reports=true`. The artifact-only
guard must complete successfully, proving the publisher job stayed skipped.
Fresh and reused evidence records
`controls.performanceReportPublication=artifact-only`; the verifier and reuse
selector reject evidence without the matching normalized performance-child
proof.

The verifier uploads the canonical manifest as
`full-release-validation-<run-id>-<run-attempt>`. Evidence tooling validates
its artifact ID, digest, producer run, and attempt before downloading that exact
artifact ID. It caps the downloaded ZIP, verifies its bytes against the REST
`sha256:` digest, and streams the only allowed bounded manifest entry without
extracting the archive. A stable-name alias remains temporarily for older
publish consumers. The verifier always prefers the attempt-qualified artifact;
as a transition, it accepts the stable name only for an attempt-1 manifest v2
producer. It rejects that legacy name for later attempts and manifest v3.

Concurrency is keyed by Validation SHA, Tooling SHA, and rerun group and does
not cancel an older run. Parent cancellation or timeout leaves adopted
identity-checked children running and records `cancelled_with_children` when
the state collector can complete its cancellation handoff. Cancel an exact
child explicitly when it is no longer useful. Do not run a second foreground
watcher when the SHA-pinned helper already owns the parent; use
`release-ci-summary --watch` only after the helper has returned or when the
parent was dispatched separately.

## Release checks stages

`OpenClaw Release Checks` is the largest child workflow. It resolves the target
once and validates the umbrella's shared package artifact when available. A
direct or focused dispatch prepares its own `release-package-under-test`
artifact when package or Docker-facing stages need it.

| Stage                    | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release target           | **Job:** `Resolve target ref`<br />**Backing workflow:** none<br />**Tests:** selected ref, optional expected Validation SHA, profile, concrete release-check groups, and focused live suite filter.<br />**Rerun:** select the concrete group for the failed surface.                                                                                                                                                                                                                                                                                                            |
| Package artifact         | **Job:** `Prepare release package artifact`<br />**Backing workflow:** none<br />**Tests:** validates the umbrella's immutable package tuple, or packs one candidate tarball for a direct/focused Release Checks dispatch, then exposes it to downstream package-facing checks.<br />**Rerun:** the affected package, cross-OS, or live/E2E group.                                                                                                                                                                                                                                |
| Install smoke            | **Job:** `Run install smoke`<br />**Backing workflow:** `Install Smoke`<br />**Tests:** full install path with root Dockerfile smoke image reuse, QR package install, root and gateway Docker smokes, installer Docker tests, and Bun global install plus CLI/local-agent/Gateway runtime smoke.<br />**Rerun:** `rerun_group=install-smoke`.                                                                                                                                                                                                                                     |
| Cross-OS                 | **Job:** `cross_os_release_checks`<br />**Backing workflow:** `OpenClaw Cross-OS Release Checks (Reusable)`<br />**Tests:** fresh and upgrade lanes on Linux, Windows, and macOS for the selected provider and mode, using the candidate tarball plus a baseline package.<br />**Rerun:** `rerun_group=cross-os`.                                                                                                                                                                                                                                                                 |
| Repo and live E2E        | **Job:** `Run repo/live E2E validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** repository E2E, live cache, OpenAI websocket streaming, native live provider and plugin shards, and Docker-backed live model/backend/gateway harnesses selected by `release_profile`.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`, optionally with `live_suite_filter`.                                                                                |
| Docker release path      | **Job:** `Run Docker release-path validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** release-path Docker chunks against the shared package artifact.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`.                                                                                                                                                                                                                                     |
| Package Acceptance       | **Job:** `Run package acceptance`<br />**Backing workflow:** `Package Acceptance`<br />**Tests:** offline plugin package fixtures, plugin update, the canonical mock-OpenAI Telegram package E2E, and published-upgrade survivor checks against the same tarball. Blocking release checks use the default latest published baseline; soak checks (`run_release_soak=true`) expand to the last 4 stable npm releases plus 3 pinned historical versions (`2026.4.23`, `2026.5.2`, `2026.4.15`), run against reported-issue upgrade fixtures.<br />**Rerun:** `rerun_group=package`. |
| Maturity scorecard       | **Job:** `Render maturity scorecard release docs`<br />**Backing workflow:** `maturity-scorecard.yml`<br />**Tests:** renders the advisory maturity scorecard docs against the target ref. Only runs when `run_maturity_scorecard=true` is passed.<br />**Rerun:** direct manual `rerun_group=qa` with `run_maturity_scorecard=true`.                                                                                                                                                                                                                                             |
| QA parity                | **Job:** `Run QA Lab parity lane` and `Run QA Lab parity report`<br />**Backing workflow:** direct jobs<br />**Tests:** candidate and baseline agentic parity packs, then the parity report.<br />**Rerun:** `rerun_group=qa-parity`; direct manual child dispatch may aggregate with `qa`.                                                                                                                                                                                                                                                                                       |
| QA runtime parity        | **Job:** `Verify QA Lab runtime-pair lanes`<br />**Backing workflow:** direct job<br />**Tests:** the canonical core `openclaw`/`codex` lane (`pnpm openclaw qa suite --runtime-pair openclaw,codex --runtime-pair-lane core`) and, with `run_release_soak=true`, the soak lane. Advisory: individual lane jobs do not block the release-check verifier.<br />**Rerun:** `rerun_group=qa-parity`; direct manual child dispatch may aggregate with `qa`.                                                                                                                           |
| QA runtime tool coverage | **Job:** `Enforce QA Lab runtime tool coverage`<br />**Backing workflow:** direct job<br />**Tests:** dynamic tool drift between `openclaw` and `codex` in the canonical core runtime-pair lane (`pnpm openclaw qa coverage --tools`), using that lane's output. Blocking: this job is not advisory-overridable.<br />**Rerun:** `rerun_group=qa-parity`; direct manual child dispatch may aggregate with `qa`.                                                                                                                                                                   |
| QA live Matrix           | **Job:** `Run QA Live Matrix catalog`<br />**Backing workflow:** `QA-Lab - All Lanes` reusable workflow<br />**Tests:** catalog-derived YAML scenarios through the shared Matrix live adapter in the `qa-live-shared` environment, distributed across deterministic shards.<br />**Rerun:** `rerun_group=qa-live` with `live_suite_filter=qa-live-matrix`; direct manual child dispatch may aggregate with `qa`.                                                                                                                                                                  |
| QA live Buzz             | **Job:** `Run QA Lab live Buzz lane`<br />**Backing workflow:** `QA-Lab - All Lanes` reusable workflow<br />**Tests:** signed canary and mention-gating round trips through the real Buzz plugin using dedicated Convex-leased identities and a hosted relay room.<br />**Rerun:** `rerun_group=qa-live` with `live_suite_filter=qa-live-buzz`; direct manual child dispatch may aggregate with `qa`.                                                                                                                                                                             |
| QA live Telegram         | **Job:** `Run QA Lab live Telegram lane`<br />**Backing workflow:** trusted `OpenClaw Release Telegram QA` dispatch<br />**Tests:** live Telegram QA with Convex CI credential leases.<br />**Rerun:** `rerun_group=qa-live`; direct manual child dispatch may aggregate with `qa`.                                                                                                                                                                                                                                                                                               |
| QA live Discord          | **Job:** `Run QA Lab live Discord lane`<br />**Backing workflow:** direct advisory job<br />**Tests:** live Discord QA with Convex CI credential leases when `OPENCLAW_RELEASE_QA_DISCORD_LIVE_CI_ENABLED` is enabled.<br />**Rerun:** `rerun_group=qa-live` with `live_suite_filter=qa-live-discord`.                                                                                                                                                                                                                                                                            |
| QA live WhatsApp         | **Job:** `Run QA Lab live WhatsApp lane`<br />**Backing workflow:** direct advisory job<br />**Tests:** live WhatsApp QA with Convex CI credential leases when `OPENCLAW_RELEASE_QA_WHATSAPP_LIVE_CI_ENABLED` is enabled.<br />**Rerun:** `rerun_group=qa-live` with `live_suite_filter=qa-live-whatsapp`.                                                                                                                                                                                                                                                                        |
| QA live Slack            | **Job:** `Run QA Lab live Slack lane`<br />**Backing workflow:** direct advisory job<br />**Tests:** live Slack QA with Convex CI credential leases when `OPENCLAW_RELEASE_QA_SLACK_LIVE_CI_ENABLED` is enabled.<br />**Rerun:** `rerun_group=qa-live` with `live_suite_filter=qa-live-slack`.                                                                                                                                                                                                                                                                                    |
| Release verifier         | **Job:** `Verify release checks`<br />**Backing workflow:** none<br />**Tests:** required release-check jobs for the selected rerun group.<br />**Rerun:** rerun after focused child jobs pass.                                                                                                                                                                                                                                                                                                                                                                                   |

## Docker release-path chunks

The Docker release-path stage runs these chunks when `live_suite_filter` is
empty:

| Chunk                                                           | Coverage                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                                                          | Core Docker release-path smoke lanes.                                                                                                        |
| `package-update-openai`                                         | OpenAI package install/update behavior, Codex on-demand install, Codex plugin live progress follow-through, and Chat Completions tool calls. |
| `package-update-anthropic`                                      | Anthropic package install and update behavior.                                                                                               |
| `package-update-core`                                           | Provider-neutral package and update behavior.                                                                                                |
| `plugins-runtime-plugins`                                       | Plugin runtime lanes that exercise plugin behavior.                                                                                          |
| `plugins-runtime-services`                                      | Service-backed and live plugin runtime lanes.                                                                                                |
| `plugins-runtime-install-a` through `plugins-runtime-install-h` | Plugin install/runtime batches split for parallel release validation.                                                                        |
| `openwebui`                                                     | OpenWebUI compatibility smoke isolated on a dedicated large-disk runner when requested.                                                      |

Use targeted `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow when
only one Docker lane failed. The release artifacts include per-lane rerun
commands with package artifact and image reuse inputs when available.

## Release profiles

`release_profile` mostly controls live/provider breadth inside release checks.
It does not remove normal full CI, Plugin Prerelease, install smoke, package
acceptance, or QA parity. Stable and full profiles always run exhaustive
repo/live E2E, Docker release-path, and QA-live soak coverage. The beta profile
adds those lanes only with `run_release_soak=true`, an explicit `qa-live`
controller retry, or the direct child's manual `qa` aggregate. Package
Acceptance supplies the canonical package Telegram E2E for every candidate, so
the umbrella does not duplicate that live poller.

| Profile  | Intended use                      | Included live/provider coverage                                                                                                                                                                            |
| -------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beta`   | Fastest release-critical smoke.   | OpenAI/core live path, Docker live models for OpenAI, native gateway core, native OpenAI gateway profile, native OpenAI plugin, and Docker live gateway OpenAI.                                            |
| `stable` | Default release approval profile. | `beta` plus Anthropic smoke, Google, MiniMax, backend, native live test harness, Docker live CLI backend, Docker ACP bind, Docker Codex harness, Docker subagent-announce, and an OpenCode Go smoke shard. |
| `full`   | Broad advisory sweep.             | `stable` plus advisory providers, plugin live shards, and media live shards.                                                                                                                               |

## Full-only additions

These suites are skipped by `stable` and included by `full`:

| Area                             | Full-only coverage                                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Docker live models               | OpenCode Go, OpenRouter, xAI, Z.ai, and Fireworks.                                                                          |
| Docker live gateway              | Advisory providers split into DeepSeek/Fireworks, OpenCode Go/OpenRouter, and xAI/Z.ai shards.                              |
| Native gateway provider profiles | Full Anthropic Opus and Sonnet/Haiku shards, Fireworks, DeepSeek, full OpenCode Go model shards, OpenRouter, xAI, and Z.ai. |
| Native plugin live shards        | Plugins A-K, L-N, O-Z other, Moonshot, and xAI.                                                                             |
| Native media live shards         | Audio, Google music, MiniMax music, and video groups A-D.                                                                   |

`stable` includes `native-live-src-gateway-profiles-anthropic-smoke` and
`native-live-src-gateway-profiles-opencode-go-smoke`; `full` uses the broader
Anthropic and OpenCode Go model shards instead. Focused reruns can still use the
aggregate `native-live-src-gateway-profiles-anthropic` or
`native-live-src-gateway-profiles-opencode-go` handles.

## Focused reruns

Use `rerun_group` to avoid repeating unrelated release boxes:

| Handle              | Scope                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `all`               | Deliberate full validation; beta without soak excludes broad live/E2E and QA-live.              |
| `ci`                | Manual full CI child only.                                                                      |
| `plugin-prerelease` | Plugin Prerelease child only.                                                                   |
| `install-smoke`     | Install Smoke through release checks.                                                           |
| `cross-os`          | Cross-OS release checks.                                                                        |
| `live-e2e`          | Repo/live E2E and Docker release-path validation.                                               |
| `package`           | Package Acceptance.                                                                             |
| `qa-parity`         | QA parity lanes and report only.                                                                |
| `qa-live`           | QA live Matrix, Buzz, and Telegram plus gated Discord, WhatsApp, and Slack lanes when enabled.  |
| `npm-telegram`      | Published-package Telegram E2E; requires `release_package_spec` or `npm_telegram_package_spec`. |
| `performance`       | Product performance evidence only.                                                              |

Use `live_suite_filter` with `rerun_group=live-e2e` when one live suite failed.
The former `release-checks` aggregate retry handle is invalid. It silently
expanded to every release-check lane, including package and Docker setup. Pick
one concrete group after classifying the failed surface.
The umbrella/controller also rejects `qa`; direct `OpenClaw Release Checks`
dispatches may use it only as a deliberate manual aggregate of `qa-parity` and
`qa-live`. Live, QA-live, and cross-OS filters must match their owning group.
Mismatches fail before scheduling and never widen to an unfiltered run.
Valid filter ids are defined in the reusable live/E2E workflow, including
`docker-live-models`, `live-gateway-docker`,
`live-gateway-anthropic-docker`, `live-gateway-google-docker`,
`live-gateway-minimax-docker`, `live-gateway-advisory-docker`,
`live-cli-backend-docker`, `live-cli-cache-docker`, `live-acp-bind-docker`, and
`live-codex-harness-docker`.

For a focused QA transport rerun, set `rerun_group=qa-live` and use the
canonical selector `qa-live-matrix`, `qa-live-buzz`, `qa-live-telegram`,
`qa-live-discord`, `qa-live-whatsapp`, or `qa-live-slack`.

The `live-gateway-advisory-docker` handle is an aggregate rerun handle for its
three provider shards, so it still fans out to all advisory Docker gateway jobs.

Use `cross_os_suite_filter` with `rerun_group=cross-os` when one cross-OS lane
failed. The filter accepts an OS id, a suite id, or an OS/suite pair, for
example `windows/packaged-upgrade`, `windows`, or `packaged-fresh`. Cross-OS
summaries include per-phase timings for packaged upgrade lanes, and long-running
commands print heartbeat lines so a stuck update is visible before the job
timeout.

QA release-check failures block normal release validation only for selected
Matrix, Telegram, and QA runtime tool coverage lanes. QA parity, runtime
parity, and the gated Discord, WhatsApp, and Slack live lanes are advisory and
publish status artifacts without blocking the release verifier. Tideclaw
alpha runs may still treat non-package-safety release-check lanes as advisory. With
`release_profile=beta`, the `Run repo/live E2E validation` live-provider suites
are advisory: third-party model deployments change underneath a release, so
beta surfaces their failures as warnings while stable and full profiles keep
them blocking. When
`live_suite_filter` explicitly requests a gated QA live lane such as Discord,
WhatsApp, or Slack, the matching `OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED` repo
variable must be enabled; otherwise input capture fails instead of silently skipping the lane.
Use controller groups `qa-parity` or `qa-live` for fresh QA evidence. A direct
manual `OpenClaw Release Checks` dispatch may use `qa` to aggregate both.

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. Classify failures as product,
harness/tooling/provenance, infrastructure/credential, or wrapper. Only a
confirmed product failure changes the Code SHA. Use one diagnosis, one fix when
needed, and one narrow retry, then reassess; do not automatically rerun `all`.
Narrow evidence is not publish authorization by itself.

For a regular release, record both Code SHA and Release SHA, the reuse policy
and changed-path set, the green Code SHA parent run, and the lightweight Release
SHA parent run. For extended-stable, record the canonical branch, exact release
SHA, fresh parent run id and attempt, workflow ref, every child run, and any
frozen-target compatibility repair or intentional omission.

Useful artifacts:

- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, runtime parity, and selected Matrix, Buzz, Telegram, Discord,
  WhatsApp, or Slack artifacts

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/install-smoke-reusable.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
- `.github/workflows/openclaw-performance.yml`
- `.github/workflows/npm-telegram-beta-e2e.yml`
