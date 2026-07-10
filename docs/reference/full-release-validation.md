---
summary: "Full Release Validation stages, child workflows, release profiles, rerun handles, and evidence"
title: "Full release validation"
read_when:
  - Running or rerunning Full Release Validation
  - Comparing stable and full release validation profiles
  - Debugging release validation stage failures
---

`Full Release Validation` is the release umbrella: the single manual entrypoint
for pre-release proof. Most work happens in child workflows so a failed box can
be rerun without restarting the whole release.

Run it from a trusted workflow ref, normally `main`, and pass the release branch,
tag, or full commit SHA as `ref`:

```bash
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.PATCH \
  -f provider=openai \
  -f mode=both \
  -f release_profile=stable
```

`provider` also accepts `anthropic` or `minimax` for cross-OS onboarding and the
end-to-end agent turn. Reusable child jobs resolve the called workflow harness
from `job.workflow_repository` and `job.workflow_sha`, while the input `ref`
selects the candidate under test. This keeps current trusted validation logic
available when validating an older release branch or tag.

Every dispatched child must report the same workflow SHA as the parent
`Full Release Validation` run. If `main` moves between the parent and child
dispatches, the umbrella fails closed even when the child itself succeeds. For
an immutable exact-commit proof, use
`pnpm ci:full-release --sha <target-sha>`. The helper creates a temporary
`release-ci/*` ref pinned to current trusted `origin/main`, passes the target
SHA only as the candidate `ref`, disables evidence reuse, and deletes the ref
after validation. Pass `--workflow-sha <trusted-main-sha>` to select an older
workflow commit still reachable from current `origin/main`. The workflow never
creates or updates repository refs itself.

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

## Top-level stages

For `rerun_group=all`, a `Check for reusable validation evidence` job runs
first: it looks for the newest prior green full validation for the exact same
target SHA, release profile, effective soak setting, and validation inputs.
When such evidence exists, every lane is skipped and the umbrella verifier
re-checks the immutable parent artifact, child runs, and dispatch logs. This is
same-candidate rerun recovery only; it does not authorize cross-SHA reuse. For
a changed candidate, rerun every package, artifact, install, Docker, or provider
gate affected by that delta. Pass `reuse_evidence=false` to force a fresh full
run. Evidence reuse runs only when the umbrella itself was dispatched from
`main`; non-main workflow refs run the selected lanes fresh.

Also for `rerun_group=all`, a `Verify Docker runtime image assets` job builds
the `runtime-assets` Docker target with
`OPENCLAW_EXTENSIONS=diagnostics-otel,codex`. It runs in parallel with the
other stages and is enforced by the umbrella verifier; lanes no longer wait for
it before dispatching. A narrower `rerun_group` skips this preflight.

| Stage                   | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution       | **Job:** `Resolve target ref`<br />**Child workflow:** none<br />**Proves:** resolves the release branch, tag, or full commit SHA and records selected inputs.<br />**Rerun:** rerun the umbrella if this fails.                                                                                                                                                                                                                                                                                                            |
| Docker assets preflight | **Job:** `Verify Docker runtime image assets`<br />**Child workflow:** none<br />**Proves:** the `runtime-assets` Docker build target still succeeds before any other stage dispatches. Runs only for `rerun_group=all`.<br />**Rerun:** rerun the umbrella with `rerun_group=all`.                                                                                                                                                                                                                                         |
| Vitest and normal CI    | **Job:** `Run normal full CI`<br />**Child workflow:** `CI`<br />**Proves:** manual full CI graph against the target ref, including Linux Node lanes, bundled plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, Control UI i18n, and Android via the umbrella.<br />**Rerun:** `rerun_group=ci`.                                                                                          |
| Plugin prerelease       | **Job:** `Run plugin prerelease validation`<br />**Child workflow:** `Plugin Prerelease`<br />**Proves:** release-only plugin static checks, agentic plugin coverage, full plugin batch shards, plugin prerelease Docker lanes, and a non-blocking `plugin-inspector-advisory` artifact for compatibility triage.<br />**Rerun:** `rerun_group=plugin-prerelease`.                                                                                                                                                          |
| Release checks          | **Job:** `Run release/live/Docker/QA validation`<br />**Child workflow:** `OpenClaw Release Checks`<br />**Proves:** install smoke, cross-OS package checks, Package Acceptance, QA Lab parity, live Matrix, and live Telegram. Stable and full profiles also run exhaustive live/E2E suites and Docker release-path chunks; beta can opt in with `run_release_soak=true`.<br />**Rerun:** `rerun_group=release-checks` or a narrower release-checks handle.                                                                |
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
once and prepares a shared `release-package-under-test` artifact when package
or Docker-facing stages need it.

| Stage                    | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release target           | **Job:** `Resolve target ref`<br />**Backing workflow:** none<br />**Tests:** selected ref, optional expected SHA, profile, rerun group, and focused live suite filter.<br />**Rerun:** `rerun_group=release-checks`.                                                                                                                                                                                                                                                                                                                                                             |
| Package artifact         | **Job:** `Prepare release package artifact`<br />**Backing workflow:** none<br />**Tests:** packs or resolves one candidate tarball and uploads `release-package-under-test` for downstream package-facing checks.<br />**Rerun:** the affected package, cross-OS, or live/E2E group.                                                                                                                                                                                                                                                                                             |
| Install smoke            | **Job:** `Run install smoke`<br />**Backing workflow:** `Install Smoke`<br />**Tests:** full install path with root Dockerfile smoke image reuse, QR package install, root and gateway Docker smokes, installer Docker tests, and Bun global install image-provider smoke.<br />**Rerun:** `rerun_group=install-smoke`.                                                                                                                                                                                                                                                           |
| Cross-OS                 | **Job:** `cross_os_release_checks`<br />**Backing workflow:** `OpenClaw Cross-OS Release Checks (Reusable)`<br />**Tests:** fresh and upgrade lanes on Linux, Windows, and macOS for the selected provider and mode, using the candidate tarball plus a baseline package.<br />**Rerun:** `rerun_group=cross-os`.                                                                                                                                                                                                                                                                 |
| Repo and live E2E        | **Job:** `Run repo/live E2E validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** repository E2E, live cache, OpenAI websocket streaming, native live provider and plugin shards, and Docker-backed live model/backend/gateway harnesses selected by `release_profile`.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`, optionally with `live_suite_filter`.                                                                                |
| Docker release path      | **Job:** `Run Docker release-path validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** release-path Docker chunks against the shared package artifact.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`.                                                                                                                                                                                                                                     |
| Package Acceptance       | **Job:** `Run package acceptance`<br />**Backing workflow:** `Package Acceptance`<br />**Tests:** offline plugin package fixtures, plugin update, the canonical mock-OpenAI Telegram package E2E, and published-upgrade survivor checks against the same tarball. Blocking release checks use the default latest published baseline; soak checks (`run_release_soak=true`) expand to the last 4 stable npm releases plus 3 pinned historical versions (`2026.4.23`, `2026.5.2`, `2026.4.15`), run against reported-issue upgrade fixtures.<br />**Rerun:** `rerun_group=package`. |
| Maturity scorecard       | **Job:** `Render maturity scorecard release docs`<br />**Backing workflow:** `maturity-scorecard.yml`<br />**Tests:** renders the advisory maturity scorecard docs against the target ref. Only runs when `run_maturity_scorecard=true` is passed.<br />**Rerun:** `rerun_group=qa` with `run_maturity_scorecard=true`.                                                                                                                                                                                                                                                           |
| QA parity                | **Job:** `Run QA Lab parity lane` and `Run QA Lab parity report`<br />**Backing workflow:** direct jobs<br />**Tests:** candidate and baseline agentic parity packs, then the parity report.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                                                         |
| QA runtime parity        | **Job:** `Run QA Lab runtime parity lane`<br />**Backing workflow:** direct job<br />**Tests:** an `openclaw`/`codex` runtime-pair agentic parity lane (`pnpm openclaw qa suite --runtime-pair openclaw,codex`), including a standard tier and, with `run_release_soak=true`, a soak tier. Advisory: individual failures do not block the release-check verifier.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                    |
| QA runtime tool coverage | **Job:** `Enforce QA Lab runtime tool coverage`<br />**Backing workflow:** direct job<br />**Tests:** dynamic tool drift between `openclaw` and `codex` in the standard runtime-parity tier (`pnpm openclaw qa coverage --tools`), using the QA runtime parity lane's output. Blocking: this job is not advisory-overridable.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                                                        |
| QA live Matrix           | **Job:** `Run QA Lab live Matrix lane`<br />**Backing workflow:** direct job<br />**Tests:** fast live Matrix QA profile in the `qa-live-shared` environment.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                                                                                          |
| QA live Telegram         | **Job:** `Run QA Lab live Telegram lane`<br />**Backing workflow:** direct job<br />**Tests:** live Telegram QA with Convex CI credential leases.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                                                                                                      |
| Release verifier         | **Job:** `Verify release checks`<br />**Backing workflow:** none<br />**Tests:** required release-check jobs for the selected rerun group.<br />**Rerun:** rerun after focused child jobs pass.                                                                                                                                                                                                                                                                                                                                                                                   |

## Docker release-path chunks

The Docker release-path stage runs these chunks when `live_suite_filter` is
empty:

| Chunk                                                           | Coverage                                                                                                                   |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `core`                                                          | Core Docker release-path smoke lanes.                                                                                      |
| `package-update-openai`                                         | OpenAI package install/update behavior, Codex on-demand install, Codex plugin live turns, and Chat Completions tool calls. |
| `package-update-anthropic`                                      | Anthropic package install and update behavior.                                                                             |
| `package-update-core`                                           | Provider-neutral package and update behavior.                                                                              |
| `plugins-runtime-plugins`                                       | Plugin runtime lanes that exercise plugin behavior.                                                                        |
| `plugins-runtime-services`                                      | Service-backed and live plugin runtime lanes.                                                                              |
| `plugins-runtime-install-a` through `plugins-runtime-install-h` | Plugin install/runtime batches split for parallel release validation.                                                      |
| `openwebui`                                                     | OpenWebUI compatibility smoke isolated on a dedicated large-disk runner when requested.                                    |

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

The `live-gateway-advisory-docker` handle is an aggregate rerun handle for its
three provider shards, so it still fans out to all advisory Docker gateway jobs.

Use `cross_os_suite_filter` with `rerun_group=cross-os` when one cross-OS lane
failed. The filter accepts an OS id, a suite id, or an OS/suite pair, for
example `windows/packaged-upgrade`, `windows`, or `packaged-fresh`. Cross-OS
summaries include per-phase timings for packaged upgrade lanes, and long-running
commands print heartbeat lines so a stuck update is visible before the job
timeout.

QA release-check failures block normal release validation. The QA runtime tool
coverage check (dynamic tool drift between `openclaw` and `codex` in the
standard tier) also blocks the release-check verifier even though the
underlying QA runtime parity lane is advisory. Tideclaw alpha runs may still
treat non-package-safety release-check lanes as advisory. With
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

Useful artifacts:

- `release-package-under-test` from `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, runtime parity, Matrix, and Telegram artifacts

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
