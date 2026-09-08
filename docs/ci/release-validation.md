---
summary: "Full Release Validation, Package Acceptance, install smoke, and Docker E2E"
title: "Release validation workflows"
read_when:
  - You are coordinating a release validation run or rerun
  - You need to validate a published package or plugin build
---

## Full Release Validation

`Full Release Validation` is the manual release umbrella. Every run binds an
exact Validation SHA + Tooling SHA tuple and rejects an `expected_sha` mismatch
before child dispatch. Validation SHA maps to the Code SHA for product
validation or the Release SHA for changelog-only validation; it is not a third
release identity. Beta-publish maps to `release_profile=beta` with
`run_release_soak=false`. A canonical beta's `all` run records `npm-beta-v1`:
it retains Node and Control UI CI, Plugin Prerelease, package/install/cross-OS
checks, and QA parity, while deferring native apps, performance, and Telegram
confidence. Broad live/E2E and QA-live remain outside that bounded gate.
Postpublish-confidence uses the exact published package with soak or explicit
focused groups. Regular stable releases use `release_profile=stable` and
`npm-stable-v1`: only native apps are deferred; stable soak, blocking performance,
Node on all three OS families, Control UI, package acceptance, and QA remain.
Both npm scopes require an exact release version and validated matching branch
or tag context. Numeric regular corrections are supported; extended-stable,
uncontextualized `main`, full profiles, and explicit `ci` groups retain full CI.

See [Full release validation](/reference/full-release-validation) for the
stage matrix, exact workflow job names, profile differences, artifacts, and
focused rerun handles.

The live/E2E selected-ref validator fetches the complete commit and ref history
with a sparse checkout. Ancestry and release-ref checks remain unchanged, while
historical file contents stay out of this metadata-only job. Build and test jobs
check out their own complete source trees.

`OpenClaw Release Publish` is the manual mutating release workflow. Dispatch
regular beta and stable publishes from a protected lightweight
`release-publish/<tooling-sha12>-<epoch>` tag at the frozen Tooling SHA after the
release tag exists and after the OpenClaw npm preflight has succeeded (the preflight runs
`pnpm plugins:sync:check` among its checks). The tag still selects the exact
release commit, including a commit on `release/YYYY.M.PATCH`; Tideclaw alpha
publishes keep using their matching alpha branch. For current validation runs,
set `preflight_run_id` and `full_release_validation_run_id` to the same successful
Full Release Validation run ID and pin `full_release_validation_run_attempt`.
The publisher resolves the independent `Full Release Artifacts` producer from
that validation manifest's sealed `publicationArtifacts.npmPreflight` descriptor.
The producer ID alone does not carry Full Release Validation authorization.
Historical recovery may still supply a separate successful `OpenClaw NPM Release`
preflight run ID alongside the matching successful Full Release Validation run
and attempt. Create the tooling tag with the [release publish commands](/reference/RELEASING#regular-release-publish-automation);
real core npm, plugin npm, or ClawHub publication from `main` is rejected before
child dispatch. Docker-only recovery may still use `main`.

The publisher dispatches `Plugin NPM Release` for all
publishable plugin packages, dispatches `Plugin ClawHub Release` for the same
release SHA, then dispatches `OpenClaw NPM Release` after plugin npm succeeds.
Stable Windows promotion is optional: supply both an exact `windows_node_tag`
and candidate-approved `windows_node_installer_digests` to dispatch its signed
installers after GitHub release finalization. Omit both to skip Windows.
For npm-stable evidence, when the tagged `apps/android/version.json` matches
the stable tag's base version, a separate native qualification job starts full
CI for the exact release SHA with Android enabled. A successful result is revalidated
after core publication before the separate Android job creates its existing
approval receipt and dispatches the tag-owned APK workflow. This keeps frozen
release tags usable without allowing narrower npm evidence to authorize an
unqualified native build. Native failure remains visible and prevents Android
approval; core npm and GitHub release finalization do not wait for it. The whole
parent can remain active after core publication while native qualification
finishes. Existing full evidence and macOS's independent validation retain their
native qualification contracts. A mismatched Android pin skips both native
qualification and APK publication, with the pin, release train, and shared
mobile cutter (`scripts/mobile-release-version.ts --prepare`) remedy recorded
in the parent summary and release proof.
Focused plugin-only repairs use `plugin_publish_scope=selected` with a nonempty
package list. Plugin-only `all-publishable` runs require the same immutable npm
preflight and Full Release Validation evidence as a core publish.

```bash
PUBLISH_REF="release-publish/<tooling-sha12>-<epoch>"
FRV_RUN_ID="<successful-full-release-validation-run-id>"
FRV_RUN_ATTEMPT="<successful-full-release-validation-run-attempt>"
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_id="$FRV_RUN_ID" \
  -f full_release_validation_run_attempt="$FRV_RUN_ATTEMPT" \
  -f npm_dist_tag=beta
```

For pinned commit proof on a fast-moving branch, use the helper instead of
`gh workflow run ... --ref main -f ref=<sha>`:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
VALIDATION_SHA="<full-release-candidate-sha>"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

GitHub workflow dispatch refs must be branches or tags, not raw commit SHAs. The
helper pushes a temporary `release-ci/<sha>-...` branch at a trusted Tooling
SHA, passes the requested Validation SHA through `ref` and `expected_sha`, reuses
strict exact-target evidence when available, and verifies every child workflow
`headSha` matches the Tooling SHA. Record that Tooling SHA once and never refresh
it from moving `main`. Regular release branches accept only their final package
version or a matching beta prerelease; Tideclaw alpha validation uses its exact
alpha tag and matching alpha branch.

`release_profile` controls live/provider breadth passed into release checks. The
manual release workflows default to `stable`; use `full` only when you
intentionally want the broad advisory provider/media matrix. Stable and full
release checks always run the exhaustive live/E2E and Docker release-path soak;
the beta profile can opt in with `run_release_soak=true`.

`fail_fast` defaults to `false`: the umbrella waits for each dispatched child
workflow and reports its independent failures together. Set `fail_fast=true`
only when cancelling a child after its first failed job is more useful than the
complete failure inventory. In Release Checks, this also enables the Matrix QA
CLI's own first-scenario cancellation.

- `beta` keeps the fastest OpenAI/core release-critical lanes.
- `stable` adds the stable provider/backend set.
- `full` runs the broad advisory provider/media matrix.

The umbrella records dispatched child run ids, and `Verify full validation`
checks them during that parent attempt. Parent cancellation or timeout leaves
adopted exact children running; cancel one explicitly when it is no longer
needed.

For recovery, classify product, harness/tooling/provenance,
infrastructure/credential, and wrapper failures before editing. Only confirmed
product failure changes the Code SHA. Use one diagnosis, one fix when needed,
and one narrow `rerun_group` retry, then reassess; never widen automatically to
`all`. Narrow evidence is not publish authorization by itself.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the selected ref once into a `release-package-under-test` tarball, then passes that artifact to cross-OS checks and Package Acceptance, plus the live/E2E release-path Docker workflow when soak coverage runs. That keeps the package bytes consistent across release boxes and avoids repacking the same candidate in multiple child jobs. For the Codex npm-plugin live lane, release checks either pass a matching published plugin spec derived from `release_package_spec`, pass the operator-supplied `codex_plugin_spec`, or leave the input blank so the Docker script packs the selected checkout's Codex plugin.

Full Release Validation concurrency is keyed by Validation SHA, Tooling SHA,
rerun group, release profile, and effective soak coverage with
`cancel-in-progress: false`. Release Checks uses the same coverage identity in
each phase, so beta, stable, and full requests do not queue behind each other.
Stable/full always include soak; setting their soak flag explicitly does not
create another concurrency group. Parent cancellation does not cancel adopted
children.

In the canonical repository's `hybrid` runner mode, target resolution, evidence
reuse, candidate discovery, candidate binding, and candidate resolution use
the small Blacksmith runner pool. These serial jobs otherwise compound hosted
runner admission delays before tests can start. Other modes and noncanonical
repositories retain GitHub-hosted runners; the reusable harness also honors
its explicit hosted-runner override. Long-running decision and diagnostic
collectors remain hosted.

## Live and E2E shards

The release live/E2E child keeps broad native `pnpm test:live` coverage, but it runs it as named shards through `scripts/test-live-shard.mjs` instead of one serial job:

- `native-live-src-agents` and `native-live-src-agents-zai-coding`
- `native-live-src-gateway-core`
- provider-filtered `native-live-src-gateway-profiles` jobs
- `native-live-src-gateway-backends`
- `native-live-src-infra`
- `native-live-test`
- `native-live-extensions-a-k`
- `native-live-extensions-l-n`
- `native-live-extensions-moonshot`
- `native-live-extensions-openai`
- `native-live-extensions-o-z-other`
- `native-live-extensions-xai`
- split media audio/video shards and provider-filtered music shards

That keeps the same file coverage while making slow live provider failures easier to rerun and diagnose. The aggregate `native-live-src-gateway`, `native-live-extensions-o-z`, `native-live-extensions-media`, and `native-live-extensions-media-music` shard names remain valid for manual one-shot reruns.

Stable/full release validation includes the configless `agent exec --auth-env-only` Code Mode smoke in `native-live-test`. The test runner builds the runtime before starting workers. The smoke copies that built distribution outside the source checkout, applies the package's plugin exclusions, and reuses installed dependencies. It supplies only `OPENAI_API_KEY` to a fresh CLI environment, runs `openai/gpt-5.6-sol` without a runtime override, and verifies Code Mode engagement, nested tool calls, and an exact read-to-write artifact. This proves built-distribution behavior; Package Acceptance owns tarball installation proof. The shard requires passing evidence from this test; a missing key or skipped test cannot satisfy the release gate.

Gateway-profile shards and shards containing the image-tool provider or OpenAI plugin live tests prepare the `sourcePerformance` build profile before starting Vitest. This supplies executable provider and agent runtime artifacts without building declarations or the Control UI. Provider requests, assertions, and test deadlines remain unchanged; gateway diagnostic environment settings apply only to gateway-profile shards. Cold source-plugin Jiti import cost remains a separate performance follow-up, not live provider latency.

Stable/full release runs explicitly enable OpenAI AgentSession repeated compaction in `native-live-src-agents` with `OPENCLAW_LIVE_OPENAI_COMPACTION=1` and `OPENCLAW_LIVE_OPENAI_COMPACTION_FULL=0`. This uses the bounded 48k context profile and requires multiple compactions plus durable-marker recall. Manual shard runs retain the explicit opt-in; once enabled, a skipped compaction test fails the shard's pass-evidence gate. The separate 922k full-context stress profile remains a manual opt-in.

The native live media shards run in `ghcr.io/openclaw/openclaw-live-media-runner:ubuntu-24.04`, built by the `Live Media Runner Image` workflow. That image preinstalls `ffmpeg` and `ffprobe`; media jobs only verify the binaries before setup. Keep Docker-backed live suites on normal Blacksmith runners — container jobs are the wrong place to launch nested Docker tests.

Docker-backed live model/backend shards use a separate shared `ghcr.io/openclaw/openclaw-live-test:<sha>-<extensions>` image per selected commit. The live release workflow builds and pushes that image once, then the Docker live model, provider-sharded gateway, CLI backend, ACP bind, and Codex harness shards run with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Gateway Docker shards carry explicit script-level `timeout` caps below the workflow job timeout so a stuck container or cleanup path fails fast instead of consuming the whole release-check budget. If those shards rebuild the full source Docker target independently, the release run is misconfigured and will waste wall clock on duplicate image builds.

## Package Acceptance

Use `Package Acceptance` when the question is "does this installable OpenClaw package work as a product?" It is different from normal CI: normal CI validates the source tree, while package acceptance validates a single tarball through the same Docker E2E harness users exercise after install or update.

### Jobs

1. `resolve_package` checks out `workflow_ref`, resolves one package candidate, writes `.artifacts/docker-e2e-package/openclaw-current.tgz`, writes `.artifacts/docker-e2e-package/package-candidate.json`, uploads both as the `package-under-test` artifact, and prints the source, workflow ref, package ref, version, SHA-256, and profile in the GitHub step summary.
2. `package_integrity` downloads the `package-under-test` artifact and enforces the public package tarball contract with `scripts/check-openclaw-package-tarball.mjs`.
3. `npm_12_install_sh` installs that exact artifact through the public Linux installer under npm 12 in an isolated home/prefix, then verifies the CLI version and lifecycle-completion guard.
4. `docker_acceptance` calls `openclaw-live-and-e2e-checks-reusable.yml` with the resolved package source SHA (falling back to `workflow_ref`) and `package_artifact_name=package-under-test`. The reusable workflow downloads that artifact, validates the tarball inventory, prepares package-digest Docker images when needed, and runs the selected Docker lanes against that package instead of packing the workflow checkout. When a profile selects multiple targeted `docker_lanes`, the reusable workflow prepares the package and shared images once, then fans those lanes out as parallel targeted Docker jobs with unique artifacts.
5. `package_telegram` optionally calls `NPM Telegram Beta E2E`. It runs when `telegram_mode` is not `none` and installs the same `package-under-test` artifact when Package Acceptance resolved one; standalone Telegram dispatch can still install a published npm spec.
6. `summary` fails the workflow if package resolution, integrity, npm 12 installer acceptance, Docker acceptance, or the optional Telegram lane failed. The `advisory` input downgrades acceptance failures to warnings for advisory callers.

### Candidate sources

- `source=npm` accepts only `openclaw@extended-stable`, `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version such as `openclaw@2026.4.27-beta.2`. Use this for published extended-stable, prerelease, or stable acceptance.
- `source=ref` packs a trusted `package_ref` branch, tag, or full commit SHA. The resolver fetches OpenClaw branches/tags, verifies the selected commit is reachable from repository branch history or a release tag, installs deps in a detached worktree, and packs it with `scripts/package-openclaw-for-docker.mjs`.
- `source=url` downloads a public HTTPS `.tgz`; `package_sha256` is required. This path rejects URL credentials, non-default HTTPS ports, private/internal/special-use hostnames or resolved IPs, and redirects outside the same public safety policy.
- `source=trusted-url` downloads an HTTPS `.tgz` from a named trusted-source policy in `.github/package-trusted-sources.json`; `package_sha256` and `trusted_source_id` are required. Use this only for maintainer-owned enterprise mirrors or private package repositories that need configured hosts, ports, path prefixes, redirect hosts, or private-network resolution. If the policy declares bearer auth, the workflow uses the fixed `OPENCLAW_TRUSTED_PACKAGE_TOKEN` secret; URL-embedded credentials are still rejected.
- `source=artifact` downloads one `.tgz` from `artifact_run_id` and `artifact_name`; `package_sha256` is optional but should be supplied for externally shared artifacts.

Keep `workflow_ref` and `package_ref` separate. `workflow_ref` is the trusted workflow/harness code that runs the test. `package_ref` is the source commit that gets packed when `source=ref`. This lets the current test harness validate older trusted source commits without running old workflow logic.

### Suite profiles

- `smoke` — `npm-onboard-channel-agent`, `gateway-network`, `config-reload`
- `package` — `npm-onboard-channel-agent`, `doctor-switch`, `update-channel-switch`, `skill-install`, `update-corrupt-plugin`, `upgrade-survivor`, `published-upgrade-survivor`, `root-managed-vps-upgrade`, `update-restart-auth`, `plugins-offline`, `plugin-update`
- `product` — the `package` set with live `plugins` coverage instead of `plugins-offline`, plus `mcp-channels`, `cron-mcp-cleanup`, `openai-web-search-minimal`, `openwebui`
- `full` — full Docker release-path chunks with OpenWebUI
- `custom` — exact `docker_lanes`; required when `suite_profile=custom`

The `package` profile uses offline plugin coverage so published-package validation is not gated on live ClawHub availability. The optional Telegram lane reuses the `package-under-test` artifact in `NPM Telegram Beta E2E`, with the published npm spec path kept for standalone dispatches.

For the dedicated update and plugin testing policy, including local commands,
Docker lanes, Package Acceptance inputs, release defaults, and failure triage,
see [Testing updates and plugins](/help/testing-updates-plugins).

Release checks call Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, `docker_lanes='doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape'`, and `telegram_mode=mock-openai`. This keeps package migration, update, live ClawHub skill install, stale-plugin-dependency cleanup, configured-plugin install repair, offline plugin, plugin-update, and Telegram proof on the same resolved package tarball. Set `release_package_spec` on Full Release Validation or OpenClaw Release Checks after publishing a beta to run the same matrix against the shipped npm package without rebuilding; set `package_acceptance_package_spec` only when Package Acceptance needs a different package from the rest of release validation. Cross-OS release checks still cover OS-specific onboarding, installer, and platform behavior; package/update product validation should start with Package Acceptance.

The `published-upgrade-survivor` Docker lane validates one published package baseline per scenario. In Package Acceptance, the resolved `package-under-test` tarball is always the candidate and `published_upgrade_survivor_baseline` selects the fallback published baseline, defaulting to `openclaw@latest`; failed-lane rerun commands preserve that baseline. Current source release checks set `published_upgrade_survivor_baselines=supported-lines` for `legacy-operator-state`: npm's current `latest`, the preceding stable version, `extended-stable` when that tag exists, and the documented oldest supported baseline `2026.6.34`. The resolver reads `npm view openclaw versions` and `npm view openclaw dist-tags` at run time, pins exact versions before fanout, and deduplicates overlapping lines. Normal current-source release checks retain `base` and add `legacy-operator-state`; release soak selects `reported-issues`, including legacy operator state and the existing issue-shaped fixtures.

Expanded release qualification requires the candidate's `YYYY.M.PATCH` base version
to be at least the trusted workflow package's base version, ignoring prerelease
suffixes for this comparison. It then reads immutable source-directory metadata for
the operator-state harness. Older source targets and extended-stable contexts
or branches keep the validated candidate-relative predecessor. Published candidates retain that predecessor and the preexisting synthetic
scenario inventory because their qualification path does not prepare the
registry required by the operator-state fixture.
A separate `package_acceptance_package_spec` override resolves its predecessor
from the override's actual package version inside Package Acceptance.

The child workflow prepares or reuses the prerelease plugin registry required
by the new scenario's artifact assertions, so that scenario runs only for
qualifying unpublished candidates. Published requalification retains `base`, or every preexisting
reported-issue scenario for soak, because its package path does not prepare
that registry. Historical qualification likewise excludes only the newly added
operator-state scenario. Existing frozen-target compatibility checks and the
explicit scenario-omission opt-in remain unchanged; candidate source code is
never executed to choose this profile.

For the standalone `supported-lines` selector, the group planner runs every
preexisting synthetic scenario only against that separately resolved
predecessor, and runs `legacy-operator-state` against each supported baseline.
It merges overlapping groups and retains every requested fixture; a missing
or moving-tag predecessor fails planning. Comma and whitespace delimiters and
repeated standalone selectors use the resolver's normal token grammar. Explicit version lists and mixed selector/version lists retain the
full Cartesian baseline/scenario matrix for deliberate manual proof. The
selector provenance travels only as internal reusable-workflow metadata;
there is no new manual-dispatch input.

Expanded published-upgrade survivor and update-migration selections are split by baseline into groups of at most three scenarios, with at most 32 targeted Docker jobs active per matrix. Grouping shares the execution planner's baseline-compatibility policy, so every supported scenario runs exactly once without creating empty shards for old baselines. Each scenario owns a fresh container and the unchanged npm resource limit; package and image identities remain shared across the matrix. `Update Migration` runs weekly on Sunday at 03:17 UTC and on manual dispatch. It defaults to `supported-lines` with both `plugin-deps-cleanup` and `legacy-operator-state`, keeps the existing cleanup coverage, and forwards no provider secrets. The weekly run keeps cleanup on the candidate-relative predecessor and exercises native operator state on each supported baseline. A planning allowance of 12 minutes per scenario plus 30 minutes for shared package/image preparation and controls gives about 78 runner-minutes weekly with three distinct baselines, or 90 with four; actual timing artifacts determine the observed cost.

Pass `baselines=all-since-2026.4.23` for exhaustive historical cleanup; `last-stable-4`, `release-history`, and exact historical versions remain explicit manual selections. Local aggregate runs can pass the resolved exact specs through `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS`, keep a single lane with `OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC`, or set `OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS` for the scenario matrix. Existing scenarios retain their baked `openclaw config set` recipes and summary records. The new operator-state scenario instead uses the baseline's own agent, exec-approvals, cron, and plugin CLIs, then verifies preserved state and a mock-provider turn after upgrade. Gateway probes include `/healthz`, `/readyz`, and RPC status. See [Testing updates and plugins](/help/testing-updates-plugins) for the preserved-state and successful-upgrade requirements.

All supported baseline rows require successful updates. Existing synthetic
`base` and reported-issue fixtures retain their success assertions and run once
on the candidate-relative predecessor. The lane does not run an extra Doctor or
omit those fixtures to turn a failed schema upgrade into a pass.

The Windows packaged and installer fresh lanes also verify that an installed package can import a browser-control override from a raw absolute Windows path. The OpenAI cross-OS agent-turn smoke defaults to `OPENCLAW_CROSS_OS_OPENAI_MODEL` when set, otherwise `openai/gpt-5.6-luna`, so the install and gateway proof uses the lower-cost GPT-5.6 test tier.

### Legacy compatibility windows

Package Acceptance has bounded legacy-compatibility windows for already-published packages. Packages through `2026.4.25`, including `2026.4.25-beta.*`, may use the compatibility path:

- known private QA entries in `dist/postinstall-inventory.json` may point at tarball-omitted files;
- `doctor-switch` may skip the `gateway install --wrapper` persistence subcase when the package does not expose that flag;
- `update-channel-switch` may prune missing pnpm `patchedDependencies` from the tarball-derived fake git fixture and may log missing persisted `update.channel`;
- plugin smokes may read legacy install-record locations or accept missing marketplace install-record persistence;
- `plugin-update` may allow config metadata migration while still requiring the install record and no-reinstall behavior to stay unchanged.

The published `2026.4.26` package may also warn for local build metadata stamp files that were already shipped. Current package validators require both npm lockfile formats to be absent from new tarballs.

### Examples

```bash
# Validate the current beta package with product-level coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f telegram_mode=mock-openai

# Validate the published extended-stable package with package coverage.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@extended-stable \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Pack and validate a release branch with the current harness.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=ref \
  -f package_ref=release/YYYY.M.PATCH \
  -f suite_profile=package \
  -f telegram_mode=mock-openai

# Validate a tarball URL. SHA-256 is mandatory for source=url.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=url \
  -f package_url=https://example.com/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Validate a tarball from a named trusted private mirror policy.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=trusted-url \
  -f trusted_source_id=enterprise-artifactory \
  -f package_url=https://packages.example.internal:8443/artifactory/openclaw/openclaw-current.tgz \
  -f package_sha256=<64-char-sha256> \
  -f suite_profile=smoke

# Reuse a tarball uploaded by another Actions run.
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=artifact \
  -f artifact_run_id=<run-id> \
  -f artifact_name=package-under-test \
  -f suite_profile=custom \
  -f docker_lanes='install-e2e plugin-update'
```

When debugging a failed package acceptance run, start at the `resolve_package` summary to confirm the package source, version, and SHA-256. Then inspect the `docker_acceptance` child run and its Docker artifacts: `.artifacts/docker-tests/**/summary.json`, `failures.json`, lane logs, phase timings, and rerun commands. Prefer rerunning the failed package profile or exact Docker lanes instead of rerunning full release validation.

## Install smoke

The `Install Smoke` workflow no longer runs on pull requests or `main` pushes. Its nightly/manual wrapper and release validation both call the read-only `install-smoke-reusable.yml` core, and every run takes the full install-smoke path on GitHub-hosted runners:

- The root Dockerfile smoke image is built once per target SHA, bound to the workflow revision and producer attempt in an immutable artifact, then loaded by the CLI smoke, agents delete shared-workspace CLI smoke, container gateway-network E2E, and bundled `matrix` plugin build-arg smoke. The plugin smoke verifies runtime dependency install mirroring and that the plugin loads without entry-escape diagnostics.
- QR package install and the installer/update Docker smokes (including Rocky Linux installer lanes and an update lane against a configurable `update_baseline_version` npm baseline) run as separate jobs so installer work does not wait behind the root image smokes.

The slow Bun global install and runtime smoke is separately gated by `run_bun_global_install_smoke`. It installs the candidate with trusted lifecycle scripts, then verifies representative CLI, local-agent, and Gateway paths under Bun 1.4 or newer. It runs on the nightly schedule, defaults on for workflow calls from release checks, and manual `Install Smoke` dispatches can opt into it. Normal PR CI still runs the fast Bun launcher regression lane for Node-relevant changes. QR and installer Docker tests keep their own install-focused Dockerfiles.

## Local Docker E2E

`pnpm test:docker:all` prebuilds one shared live-test image, packs OpenClaw once as an npm tarball, and builds two shared `scripts/e2e/Dockerfile` images:

- a bare Node/Git runner for installer/update/plugin-dependency lanes;
- a functional image that installs the same tarball into `/app` for normal functionality lanes.

Docker lane definitions live in `scripts/lib/docker-e2e-scenarios.mts`, planner logic lives in `scripts/lib/docker-e2e-plan.mts`, and the runner only executes the selected plan. The scheduler selects the image per lane with `OPENCLAW_DOCKER_E2E_BARE_IMAGE` and `OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE`, then runs lanes with `OPENCLAW_SKIP_DOCKER_BUILD=1`. Live lanes that use these package images do not require the separate source live-test image; model/backend lanes that consume the source image still prepare it.

### Tunables

| Variable                               | Default | Purpose                                                                                       |
| -------------------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `OPENCLAW_DOCKER_ALL_PARALLELISM`      | 10      | Main-pool slot count for normal lanes.                                                        |
| `OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM` | 10      | Provider-sensitive tail-pool slot count.                                                      |
| `OPENCLAW_DOCKER_ALL_LIVE_LIMIT`       | 9       | Concurrent live lane cap so providers do not throttle.                                        |
| `OPENCLAW_DOCKER_ALL_NPM_LIMIT`        | 5       | Concurrent npm install lane cap.                                                              |
| `OPENCLAW_DOCKER_ALL_SERVICE_LIMIT`    | 7       | Concurrent multi-service lane cap.                                                            |
| `OPENCLAW_DOCKER_ALL_START_STAGGER_MS` | 2000    | Stagger between lane starts to avoid Docker daemon create storms; set `0` for no stagger.     |
| `OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS`  | 7200000 | Per-lane fallback timeout (120 minutes); selected live/tail lanes use tighter caps.           |
| `OPENCLAW_DOCKER_ALL_DRY_RUN`          | unset   | `1` prints the scheduler plan without running lanes.                                          |
| `OPENCLAW_DOCKER_ALL_LANES`            | unset   | Comma-separated exact lane list; skips cleanup smoke so agents can reproduce one failed lane. |

A lane heavier than its effective cap can still start from an empty pool, then runs alone until it releases capacity. The local aggregate preflights Docker, removes stale OpenClaw E2E containers, emits active-lane status, persists lane timings for longest-first ordering, and stops scheduling new pooled lanes after the first failure by default.

### Reusable live/E2E workflow

Repository E2E runs as nine independent jobs: four duration-weighted Gateway shards, four
duration-weighted Control UI shards, and the standalone agent-plugin Gateway
test. Two independent producers build the selected source once per profile:
the full private-QA build for Gateway package/type checks, and the CI artifact
build for UI and agent-plugin tests. Consumers restore exact producer artifacts,
including generated plugin assets and local build metadata, and install their
own Chromium and sandbox prerequisites. Each group has four test slots, so long
UI shards start together without waiting for Gateway declarations or tests.
A failed producer blocks its own consumers; other diagnostics continue.
Gateway shards retain the existing
four fresh-process boundaries and two-worker limit. Each UI shard runs its
bundled files with up to two workers, then its private-server, real-Gateway, and
runtime-budget files serially. The root sequencer assigns files across both
projects to the same four weighted shards. No tests are filtered out, and the
existing 90-minute job deadline is unchanged. Local `pnpm test:e2e` still runs
its suite commands sequentially; each UI command uses the same project policy.

This removes seven builds per invocation and raises peak test concurrency from
six to eight. Release checks use GitHub-hosted runners, so this adds no
Blacksmith registrations there. A standalone Blacksmith invocation can register
eleven runners: two producers and nine test jobs. Producer artifact identities
survive consumer-only retries; consumers never select an artifact by their own
current attempt number.

The reusable live/E2E workflow asks `scripts/test-docker-all.mjs --plan-json` which package, image kind, live image, lane, and credential coverage is required. `scripts/docker-e2e.mjs` then converts that plan into GitHub outputs and summaries. It either packs OpenClaw through `scripts/package-openclaw-for-docker.mjs`, downloads a current-run package artifact, or downloads a package artifact from `package_artifact_run_id`, then validates the tarball inventory. The default `no-push-artifact` path builds package-digest-tagged bare/functional images through Blacksmith's Docker layer cache, packs the exact image bytes into an immutable workflow artifact, and has each consumer verify and load that artifact. `existing-only` instead requires explicit `docker_e2e_bare_image`/`docker_e2e_functional_image` GHCR refs and never builds or pushes. Those registry pulls use a bounded 180-second per-attempt timeout so a stuck stream retries quickly instead of consuming most of the CI critical path. After successful scheduled validation, `openclaw-scheduled-live-checks.yml` passes the immutable tested-image manifest to the separate package-write publisher; read-only release and prerelease callers never traverse that writer.

### Release-path chunks

Release Docker coverage runs smaller chunked jobs with `OPENCLAW_SKIP_DOCKER_BUILD=1` so each chunk verifies and loads only the artifact-backed image kind it needs (or pulls it under explicit `existing-only` reuse) and executes multiple lanes through the same weighted scheduler:

- `OPENCLAW_DOCKER_ALL_PROFILE=release-path`
- `OPENCLAW_DOCKER_ALL_CHUNK=core | package-update-openai | package-update-onboarding | package-update-migrations | package-update-self-upgrade | plugins-runtime-plugins | plugins-runtime-services | plugins-runtime-install-a..h | openwebui`

Current release Docker chunks are `core`, `package-update-openai`, `package-update-onboarding`, `package-update-migrations`, `package-update-self-upgrade`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`. `package-update-openai` includes the live Codex plugin package lane, which installs the candidate OpenClaw package, installs the Codex plugin from `codex_plugin_spec` or a same-ref tarball with explicit Codex CLI install approval, runs Codex CLI preflight and same-session agent turns, then runs a zero-retry medium-thinking turn that sends progress, reads randomized workspace inputs, writes their exact artifact, and sends completion. `plugins-runtime-core`, `plugins-runtime`, and `plugins-integrations` remain aggregate plugin/runtime aliases. The `install-e2e` lane alias remains the aggregate manual rerun alias for both provider installer lanes.

Provider-neutral package checks run in three balanced rows: onboarding and install switching, channel/published migrations, and self-upgrades. This avoids serializing eight npm-heavy lanes behind one runner's npm resource limit. The aggregate `package-update-core` and `package-update` names remain available for manual runs. The `package-update-openai` row also runs root-managed VPS upgrade and authenticated update restart proof. Scheduler resource limits remain unchanged. Credential preflight failures remain blocking while the following diagnostic pool drains non-live lanes; earlier setup failures and cancellation still prevent execution.

OpenWebUI runs as a standalone `openwebui` chunk on a dedicated large-disk Blacksmith runner whenever stable or full release-path coverage requests it, even when the reusable workflow routes supported jobs to GitHub-hosted runners. Keeping the external image pull separate prevents the large image from competing with the shared package and plugin images in `plugins-runtime-services`; legacy aggregate plugin/runtime chunks still include OpenWebUI for compatible manual reruns. Bundled-channel update lanes retry once for transient npm network failures.

Each chunk uploads `.artifacts/docker-tests/` with lane logs, timings, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, slow-lane tables, and per-lane rerun commands. The workflow `docker_lanes` input runs selected lanes against images prepared for that run instead of the chunk jobs, which keeps failed-lane debugging bounded to one targeted Docker job; if a selected lane is a live Docker lane, the targeted job builds the live-test image locally for that rerun. The rerun helper validates the failure artifact's exact selected target SHA and manual dispatch repacks that ref, because the internal reusable-workflow package tuple is not part of the `workflow_dispatch` schema. Generated commands include prepared image inputs and `shared_image_policy=existing-only` only when those inputs are GHCR-backed; runner-local artifact tags are omitted so a fresh runner rebuilds them. An explicit target override drops recovered GHCR image refs unless the artifact proves they match the override. Artifact-generated workflow-definition refs are also omitted because full-release temporary branches are deleted; dispatch uses the repository default branch unless the operator explicitly overrides it.

```bash
pnpm test:docker:rerun <run-id>      # download Docker artifacts and print combined/per-lane targeted rerun commands
pnpm test:docker:timings <summary>   # slow-lane and phase critical-path summaries
```

The scheduled live/E2E workflow runs the full release-path Docker suite daily and, after it succeeds, invokes the explicit publisher for the exact tested image artifacts.

## Plugin Prerelease

Plugin batch execution preserves existing process limits when the only forwarded options are numeric `--retry` and exact-file `--exclude` selections. Codex retains at most 12 files per sequential process, including release runs with those options. Watch mode, suite-wide bail or sharding, reports, broad exclusion patterns, and other options retain their single-process semantics.

`Plugin Prerelease` is more expensive product/package coverage, so it is a separate workflow dispatched by `Full Release Validation` or by an explicit operator. Normal pull requests, `main` pushes, and standalone manual CI dispatches keep that suite off. It balances non-Telegram bundled plugin tests across eight generic extension workers; those jobs run up to two plugin config groups at a time with one Vitest worker per group and a larger Node heap. Telegram runs in dedicated shards of at most ten test files, preserving one-file Vitest processes while scheduling two processes concurrently. The combined extension matrix is capped at 12 concurrent jobs. The release-only Docker prerelease path (enabled by the `full_release_validation` input) batches targeted Docker lanes in groups of four to avoid reserving dozens of runners for one-to-three-minute jobs. The workflow also uploads an informational `plugin-inspector-advisory` artifact from `@openclaw/plugin-inspector`; inspector findings are triage input and do not change the blocking Plugin Prerelease gate.

## Related

- [Install overview](/install)
- [Release channels](/install/development-channels)
