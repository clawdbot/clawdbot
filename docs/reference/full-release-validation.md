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

Freeze the product-complete pre-changelog commit as the **Code SHA**, then run:

```bash
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH
```

`provider` also accepts `anthropic` or `minimax` for cross-OS onboarding and the
end-to-end agent turn. The helper infers the `beta` profile from alpha/beta
package versions and `stable` otherwise. Pass alternate workflow inputs with
`-f key=value`; use `-f release_profile=full` only for the broad advisory sweep.

The helper creates a temporary `release-ci/*` ref pinned to one trusted
`origin/main` workflow SHA, passes the target SHA only as the candidate `ref`,
and deletes the temporary ref after validation. Every dispatched child must
report that same workflow SHA. Pass
`-f reuse_evidence=false` to force a fresh run or
`--workflow-sha <trusted-main-sha>` to select an older workflow commit still
reachable from current `origin/main`. The workflow never creates or updates
repository refs itself.

## Extended-stable exception

Extended-stable publish requires a run whose workflow and target are both the
canonical branch:

```bash
gh workflow run full-release-validation.yml \
  --ref extended-stable/YYYY.M.33 \
  -f ref=extended-stable/YYYY.M.33 \
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

`release_profile=stable` and `release_profile=full` always run the exhaustive
live/Docker soak. Pass `run_release_soak=true` to include the same soak lanes
with the `beta` profile. Stable publication rejects a validation manifest
without this soak and blocking product-performance evidence.

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

Also for `rerun_group=all`, a `Verify Docker runtime image assets` job builds
the `runtime-assets` Docker target with
`OPENCLAW_EXTENSIONS=diagnostics-otel,codex`. It runs in parallel with the
other stages and is enforced by the umbrella verifier; lanes no longer wait for
it before dispatching. A narrower `rerun_group` skips this preflight.

| Stage                   | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution       | **Job:** `Resolve target ref`<br />**Child workflow:** none<br />**Proves:** resolves the release branch, tag, or full commit SHA and records selected inputs.<br />**Rerun:** rerun the umbrella if this fails.                                                                                                                                                                                                                                                                                                            |
| Shared candidate        | **Job:** `Prepare shared release candidate`<br />**Child workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Proves:** packs and validates one exact-SHA package, builds one functional Docker image, and records immutable package and image artifact tuples for both package-facing child workflows.<br />**Rerun:** rerun the affected package, plugin-prerelease, cross-OS, or live/E2E group.                                                                                                                 |
| Docker assets preflight | **Job:** `Verify Docker runtime image assets`<br />**Child workflow:** none<br />**Proves:** the `runtime-assets` Docker build target still succeeds before any other stage dispatches. Runs only for `rerun_group=all`.<br />**Rerun:** rerun the umbrella with `rerun_group=all`.                                                                                                                                                                                                                                         |
| Vitest and normal CI    | **Job:** `Run normal full CI`<br />**Child workflow:** `CI`<br />**Proves:** manual full CI graph against the target ref, including Linux Node lanes, bundled plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, Control UI i18n, and Android via the umbrella.<br />**Rerun:** `rerun_group=ci`.                                                                                          |
| Plugin prerelease       | **Job:** `Run plugin prerelease validation`<br />**Child workflow:** `Plugin Prerelease`<br />**Proves:** release-only plugin static checks, agentic plugin coverage, full plugin batch shards, plugin prerelease Docker lanes, and a non-blocking `plugin-inspector-advisory` artifact for compatibility triage.<br />**Rerun:** `rerun_group=plugin-prerelease`.                                                                                                                                                          |
| Release checks          | **Job:** `Run release/live/Docker/QA validation`<br />**Child workflow:** `OpenClaw Release Checks`<br />**Proves:** install smoke, cross-OS package checks, Package Acceptance, QA Lab parity, live Matrix and Telegram, plus gated advisory Discord, WhatsApp, and Slack lanes. Stable and full profiles also run exhaustive live/E2E suites and Docker release-path chunks; beta can opt in with `run_release_soak=true`.<br />**Rerun:** `rerun_group=release-checks` or a narrower release-checks handle.              |
| Package Telegram        | **Job:** `Run package Telegram E2E`<br />**Child workflow:** `NPM Telegram Beta E2E`<br />**Proves:** a focused published-package Telegram E2E when `release_package_spec` or `npm_telegram_package_spec` is set. Full candidate validation uses the canonical Package Acceptance Telegram E2E instead.<br />**Rerun:** `rerun_group=npm-telegram` with `release_package_spec` or `npm_telegram_package_spec`.                                                                                                              |
| Product performance     | **Job:** `Run product performance evidence`<br />**Child workflow:** `OpenClaw Performance`<br />**Proves:** release-profile performance run (`profile=release`, `repeat=3`, `fail_on_regression=true`, `publish_reports=false`) against the target SHA. Kova output stays in workflow artifacts and the child must prove its report publisher was skipped. Required (blocking) only for `rerun_group=all` or `rerun_group=performance`; not required for narrower rerun groups.<br />**Rerun:** `rerun_group=performance`. |
| Umbrella verifier       | **Job:** `Verify full validation`<br />**Child workflow:** none<br />**Proves:** re-checks recorded child run conclusions and appends slowest-job tables from child workflows.<br />**Rerun:** rerun only this job after rerunning a failed child to green.                                                                                                                                                                                                                                                                 |

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

For `ref=main` with `rerun_group=all`, for `release/*` refs, and for Tideclaw
alpha refs, a newer umbrella run supersedes an older one with the same ref and
rerun group. When the parent is cancelled, its monitor cancels any child
workflow it already dispatched. Tag and pinned-SHA validation runs do not
cancel each other.

## Release checks stages

`OpenClaw Release Checks` is the largest child workflow. It resolves the target
once and validates the umbrella's shared package artifact when available. A
direct or focused dispatch prepares its own `release-package-under-test`
artifact when package or Docker-facing stages need it.

| Stage                    | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release target           | **Job:** `Resolve target ref`<br />**Backing workflow:** none<br />**Tests:** selected ref, optional expected SHA, profile, rerun group, and focused live suite filter.<br />**Rerun:** `rerun_group=release-checks`.                                                                                                                                                                                                                                                                                                                                                             |
| Package artifact         | **Job:** `Prepare release package artifact`<br />**Backing workflow:** none<br />**Tests:** validates the umbrella's immutable package tuple, or packs one candidate tarball for a direct/focused Release Checks dispatch, then exposes it to downstream package-facing checks.<br />**Rerun:** the affected package, cross-OS, or live/E2E group.                                                                                                                                                                                                                                |
| Install smoke            | **Job:** `Run install smoke`<br />**Backing workflow:** `Install Smoke`<br />**Tests:** full install path with root Dockerfile smoke image reuse, QR package install, root and gateway Docker smokes, installer Docker tests, and Bun global install image-provider smoke.<br />**Rerun:** `rerun_group=install-smoke`.                                                                                                                                                                                                                                                           |
| Cross-OS                 | **Job:** `cross_os_release_checks`<br />**Backing workflow:** `OpenClaw Cross-OS Release Checks (Reusable)`<br />**Tests:** fresh and upgrade lanes on Linux, Windows, and macOS for the selected provider and mode, using the candidate tarball plus a baseline package. Packaged-upgrade restores an immutable installed-baseline cache and caps install/updater stages at five minutes. Its result is advisory for beta and blocking for stable; fresh lanes remain blocking.<br />**Rerun:** `rerun_group=cross-os`.                                                          |
| Repo and live E2E        | **Job:** `Run repo/live E2E validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** repository E2E, live cache, OpenAI websocket streaming, native live provider and plugin shards, and Docker-backed live model/backend/gateway harnesses selected by `release_profile`.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`, optionally with `live_suite_filter`.                                                                                |
| Docker release path      | **Job:** `Run Docker release-path validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** release-path Docker chunks against the shared package artifact.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`.                                                                                                                                                                                                                                     |
| Package Acceptance       | **Job:** `Run package acceptance`<br />**Backing workflow:** `Package Acceptance`<br />**Tests:** offline plugin package fixtures, plugin update, the canonical mock-OpenAI Telegram package E2E, and published-upgrade survivor checks against the same tarball. Blocking release checks use the default latest published baseline; soak checks (`run_release_soak=true`) expand to the last 4 stable npm releases plus 3 pinned historical versions (`2026.4.23`, `2026.5.2`, `2026.4.15`), run against reported-issue upgrade fixtures.<br />**Rerun:** `rerun_group=package`. |
| Maturity scorecard       | **Job:** `Render maturity scorecard release docs`<br />**Backing workflow:** `maturity-scorecard.yml`<br />**Tests:** renders the advisory maturity scorecard docs against the target ref. Only runs when `run_maturity_scorecard=true` is passed.<br />**Rerun:** `rerun_group=qa` with `run_maturity_scorecard=true`.                                                                                                                                                                                                                                                           |
| QA parity                | **Job:** `Run QA Lab parity lane` and `Run QA Lab parity report`<br />**Backing workflow:** direct jobs<br />**Tests:** candidate and baseline agentic parity packs, then the parity report.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                                                         |
| QA runtime parity        | **Job:** `Verify QA Lab runtime-pair lanes`<br />**Backing workflow:** direct job<br />**Tests:** the canonical core `openclaw`/`codex` lane (`pnpm openclaw qa suite --runtime-pair openclaw,codex --runtime-pair-lane core`) and, with `run_release_soak=true`, the soak lane. Advisory: individual lane jobs do not block the release-check verifier.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                             |
| QA runtime tool coverage | **Job:** `Enforce QA Lab runtime tool coverage`<br />**Backing workflow:** direct job<br />**Tests:** dynamic tool drift between `openclaw` and `codex` in the canonical core runtime-pair lane (`pnpm openclaw qa coverage --tools`), using that lane's output. Blocking: this job is not advisory-overridable.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                                                                     |
| QA live Matrix           | **Job:** `Run QA Live Matrix profile`<br />**Backing workflow:** `QA-Lab - All Lanes` reusable workflow<br />**Tests:** parity-proven YAML scenarios through the shared Matrix live adapter in the `qa-live-shared` environment.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`; use `live_suite_filter=qa-live-matrix` for a focused Matrix rerun.                                                                                                                                                                                                                    |
| QA live Telegram         | **Job:** `Run QA Lab live Telegram lane`<br />**Backing workflow:** trusted `OpenClaw Release Telegram QA` dispatch<br />**Tests:** live Telegram QA with Convex CI credential leases.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                                                                 |
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
acceptance, or QA Lab. Stable and full profiles always run exhaustive repo/live
E2E and Docker release-path soak coverage. The beta profile can opt in with
`run_release_soak=true`. Package Acceptance supplies the canonical package
Telegram E2E for every full candidate, so the umbrella does not duplicate that
live poller.

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
| `all`               | All Full Release Validation stages.                                                             |
| `ci`                | Manual full CI child only.                                                                      |
| `plugin-prerelease` | Plugin Prerelease child only.                                                                   |
| `release-checks`    | All OpenClaw Release Checks stages.                                                             |
| `install-smoke`     | Install Smoke through release checks.                                                           |
| `cross-os`          | Cross-OS release checks.                                                                        |
| `live-e2e`          | Repo/live E2E and Docker release-path validation.                                               |
| `package`           | Package Acceptance.                                                                             |
| `qa`                | QA parity plus QA live lanes.                                                                   |
| `qa-parity`         | QA parity lanes and report only.                                                                |
| `qa-live`           | QA live Matrix/Telegram plus gated Discord, WhatsApp, and Slack lanes when enabled.             |
| `npm-telegram`      | Published-package Telegram E2E; requires `release_package_spec` or `npm_telegram_package_spec`. |
| `performance`       | Product performance evidence only.                                                              |

Use `live_suite_filter` with `rerun_group=live-e2e` when one live suite failed.
Valid filter ids are defined in the reusable live/E2E workflow, including
`docker-live-models`, `live-gateway-docker`,
`live-gateway-anthropic-docker`, `live-gateway-google-docker`,
`live-gateway-minimax-docker`, `live-gateway-advisory-docker`,
`live-cli-backend-docker`, `live-acp-bind-docker`, and
`live-codex-harness-docker`.

For a focused QA transport rerun, set `rerun_group=qa-live` and use the
canonical selector `qa-live-matrix`, `qa-live-telegram`, `qa-live-discord`,
`qa-live-whatsapp`, or `qa-live-slack`.

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
Rerun `rerun_group=qa`, `qa-parity`, or `qa-live` when you
need fresh QA evidence.

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. For failures, inspect the child
workflow first, then rerun the smallest matching handle above.

Use `pnpm release:evidence-impact -- --base <sha> --head <sha>` to classify an
iteration before rerunning. Changelog-only finalization can reuse the green Code
SHA evidence under `changelog-only-release-v1`. Release-tooling-only and
plugin-only classifications select smaller diagnostic handles, but still
require a final green full validation for the new SHA. Product or mixed changes
use `rerun_group=all`.

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
- QA parity, runtime parity, and selected Matrix, Telegram, Discord, WhatsApp,
  or Slack artifacts

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
