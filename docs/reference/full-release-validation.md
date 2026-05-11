---
summary: "Full Release Validation stages, child workflows, release profiles, rerun handles, and evidence"
title: "Full release validation"
read_when:
  - Running or rerunning Full Release Validation
  - Comparing stable and full release validation profiles
  - Debugging release validation stage failures
---

`Full Release Validation` is the release umbrella. It is the single manual
entrypoint for pre-release proof, but most work happens in child workflows so a
failed box can be rerun without restarting the whole release.

Run it from a trusted workflow ref, normally `main`, and pass the release branch,
tag, or full commit SHA as `ref`:

```bash
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.D \
  -f provider=openai \
  -f mode=both \
  -f release_profile=stable
```

Child workflows use the trusted workflow ref for the harness and the input
`ref` for the candidate under test. That keeps new validation logic available
when validating an older release branch or tag.

By default, `release_profile=stable` runs the release-blocking lanes and skips
the exhaustive live/Docker soak. Pass `run_release_soak=true` to include the
soak lanes on a stable run. `release_profile=full` always enables soak lanes so
the broad advisory profile never drops coverage silently.

Package Acceptance normally builds the candidate tarball from the resolved
`ref`, including full-SHA runs dispatched with `pnpm ci:full-release`. After a
beta publish, pass `release_package_spec=openclaw@YYYY.M.D-beta.N` to reuse the
shipped npm package across release checks, Package Acceptance, cross-OS,
release-path Docker, and package Telegram. Use `package_acceptance_package_spec`
only when Package Acceptance should intentionally prove a different package.

## Top-level stages

| Stage                | Details                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target resolution    | **Job:** `Resolve target ref`<br />**Child workflow:** none<br />**Proves:** resolves the release branch, tag, or full commit SHA and records selected inputs.<br />**Rerun:** rerun the umbrella if this fails.                                                                                                                                                                                                                               |
| Vitest and normal CI | **Job:** `Run normal full CI`<br />**Child workflow:** `CI`<br />**Proves:** manual full CI graph against the target ref, including Linux Node lanes, bundled plugin shards, channel contracts, Node 22 compatibility, `check`, `check-additional`, build smoke, docs checks, Python skills, Windows, macOS, Control UI i18n, and Android via the umbrella.<br />**Rerun:** `rerun_group=ci`.                                                  |
| Plugin prerelease    | **Job:** `Run plugin prerelease validation`<br />**Child workflow:** `Plugin Prerelease`<br />**Proves:** release-only plugin static checks, agentic plugin coverage, full extension batch shards, and plugin prerelease Docker lanes.<br />**Rerun:** `rerun_group=plugin-prerelease`.                                                                                                                                                        |
| Release checks       | **Job:** `Run release/live/Docker/QA validation`<br />**Child workflow:** `OpenClaw Release Checks`<br />**Proves:** install smoke, cross-OS package checks, Package Acceptance, QA Lab parity, live Matrix, and live Telegram. With `run_release_soak=true` or `release_profile=full`, also runs exhaustive live/E2E suites and Docker release-path chunks.<br />**Rerun:** `rerun_group=release-checks` or a narrower release-checks handle. |
| Package artifact     | **Job:** `Prepare release package artifact`<br />**Child workflow:** none<br />**Proves:** creates the parent `release-package-under-test` tarball early enough for package-facing checks that do not need to wait for `OpenClaw Release Checks`.<br />**Rerun:** rerun the umbrella or provide `release_package_spec` for published-package reruns.                                                                                           |
| Package Telegram     | **Job:** `Run package Telegram E2E`<br />**Child workflow:** `NPM Telegram Beta E2E`<br />**Proves:** parent-artifact-backed Telegram package proof for `rerun_group=all` with `release_profile=full`, or published-package Telegram proof when `release_package_spec` or `npm_telegram_package_spec` is set.<br />**Rerun:** `rerun_group=npm-telegram` with `release_package_spec` or `npm_telegram_package_spec`.                           |
| Umbrella verifier    | **Job:** `Verify full validation`<br />**Child workflow:** none<br />**Proves:** re-checks recorded child run conclusions and appends slowest-job tables from child workflows.<br />**Rerun:** rerun only this job after rerunning a failed child to green.                                                                                                                                                                                    |

For `ref=main` and `rerun_group=all`, a newer umbrella supersedes an older one.
When the parent is cancelled, its monitor cancels any child workflow it already
dispatched. Release branch and tag validation runs do not cancel each other by
default.

## Release checks stages

`OpenClaw Release Checks` is the largest child workflow. It resolves the target
once and prepares a shared `release-package-under-test` artifact when package
or Docker-facing stages need it.

| Stage               | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release target      | **Job:** `Resolve target ref`<br />**Backing workflow:** none<br />**Tests:** selected ref, optional expected SHA, profile, rerun group, and focused live suite filter.<br />**Rerun:** `rerun_group=release-checks`.                                                                                                                                                                                                                                                                              |
| Package artifact    | **Job:** `Prepare release package artifact`<br />**Backing workflow:** none<br />**Tests:** packs or resolves one candidate tarball and uploads `release-package-under-test` for downstream package-facing checks.<br />**Rerun:** the affected package, cross-OS, or live/E2E group.                                                                                                                                                                                                              |
| Install smoke       | **Job:** `Run install smoke`<br />**Backing workflow:** `Install Smoke`<br />**Tests:** full install path with root Dockerfile smoke image reuse, QR package install, root and gateway Docker smokes, installer Docker tests, Bun global install image-provider smoke, and fast bundled-plugin install/uninstall E2E.<br />**Rerun:** `rerun_group=install-smoke`.                                                                                                                                 |
| Cross-OS            | **Job:** `cross_os_release_checks`<br />**Backing workflow:** `OpenClaw Cross-OS Release Checks (Reusable)`<br />**Tests:** fresh and upgrade lanes on Linux, Windows, and macOS for the selected provider and mode, using the candidate tarball plus a baseline package.<br />**Rerun:** `rerun_group=cross-os`.                                                                                                                                                                                  |
| Repo and live E2E   | **Job:** `Run repo/live E2E validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** repository E2E, live cache, OpenAI websocket streaming, native live provider and plugin shards, and Docker-backed live model/backend/gateway harnesses selected by `release_profile`.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`, optionally with `live_suite_filter`. |
| Docker release path | **Job:** `Run Docker release-path validation`<br />**Backing workflow:** `OpenClaw Live And E2E Checks (Reusable)`<br />**Tests:** release-path Docker chunks against the shared package artifact.<br />**Runs:** `run_release_soak=true`, `release_profile=full`, or focused `rerun_group=live-e2e`.<br />**Rerun:** `rerun_group=live-e2e`.                                                                                                                                                      |
| Package Acceptance  | **Job:** `Run package acceptance`<br />**Backing workflow:** `Package Acceptance`<br />**Tests:** offline plugin package fixtures, plugin update, mock-OpenAI Telegram package acceptance, and published-upgrade survivor checks against the same tarball. Blocking release checks use the default latest published baseline; soak checks expand to every stable npm release at or after `2026.4.23` plus reported-issue fixtures.<br />**Rerun:** `rerun_group=package`.                          |
| QA parity           | **Job:** `Run QA Lab parity lane` and `Run QA Lab parity report`<br />**Backing workflow:** direct jobs<br />**Tests:** candidate and baseline agentic parity packs, then the parity report.<br />**Rerun:** `rerun_group=qa-parity` or `rerun_group=qa`.                                                                                                                                                                                                                                          |
| QA live Matrix      | **Job:** `Run QA Lab live Matrix lane`<br />**Backing workflow:** direct job<br />**Tests:** fast live Matrix QA profile in the `qa-live-shared` environment.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`.                                                                                                                                                                                                                                                                           |
| QA live Telegram    | **Job:** `Run QA Lab live Telegram lane`<br />**Backing workflow:** direct job<br />**Tests:** live Telegram QA with Convex CI credential leases.<br />**Rerun:** `rerun_group=qa-live` or `rerun_group=qa`.                                                                                                                                                                                                                                                                                       |
| Release verifier    | **Job:** `Verify release checks`<br />**Backing workflow:** none<br />**Tests:** required release-check jobs for the selected rerun group.<br />**Rerun:** rerun after focused child jobs pass.                                                                                                                                                                                                                                                                                                    |

## Docker release-path chunks

The Docker release-path stage runs these chunks when `live_suite_filter` is
empty:

| Chunk                                                           | Coverage                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `core`                                                          | Core Docker release-path smoke lanes.                                            |
| `package-update-openai`                                         | OpenAI package install/update behavior, including Codex on-demand install.       |
| `package-update-anthropic`                                      | Anthropic package install and update behavior.                                   |
| `package-update-core`                                           | Provider-neutral package and update behavior.                                    |
| `plugins-runtime-plugins`                                       | Plugin runtime lanes that exercise plugin behavior.                              |
| `plugins-runtime-services`                                      | Service-backed and live plugin runtime lanes; includes OpenWebUI when requested. |
| `plugins-runtime-install-a` through `plugins-runtime-install-h` | Plugin install/runtime batches split for parallel release validation.            |

Use targeted `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow when
only one Docker lane failed. The release artifacts include per-lane rerun
commands with package artifact and image reuse inputs when available.

## Release profiles

`release_profile` mostly controls live/provider breadth inside release checks.
It does not remove normal full CI, Plugin Prerelease, install smoke, package
acceptance, or QA Lab. For `stable`, exhaustive repo/live E2E and Docker
release-path chunks are soak coverage and run when `run_release_soak=true`.
`full` forces soak coverage on and also makes the umbrella run package Telegram
E2E against the parent release package artifact when `rerun_group=all`, so a full
pre-publish candidate does not silently skip that Telegram package lane.

| Profile   | Intended use                      | Included live/provider coverage                                                                                                                                                     |
| --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimum` | Fastest release-critical smoke.   | OpenAI/core live path, Docker live models for OpenAI, native gateway core, native OpenAI gateway profile, native OpenAI plugin, and Docker live gateway OpenAI.                     |
| `stable`  | Default release approval profile. | `minimum` plus Anthropic smoke, Google, MiniMax, backend, native live test harness, Docker live CLI backend, Docker ACP bind, Docker Codex harness, and an OpenCode Go smoke shard. |
| `full`    | Broad advisory sweep.             | `stable` plus advisory providers, plugin live shards, and media live shards.                                                                                                        |

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
| `qa-live`           | QA live Matrix and Telegram only.                                                               |
| `npm-telegram`      | Published-package Telegram E2E; requires `release_package_spec` or `npm_telegram_package_spec`. |

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
commands print heartbeat lines so a stuck Windows update is visible before the
job timeout.

QA release-check lanes are advisory. A QA-only failure is reported as a warning
and does not block the release-check verifier; rerun `rerun_group=qa`,
`qa-parity`, or `qa-live` when you need fresh QA evidence.

## Evidence to keep

Keep the `Full Release Validation` summary as the release-level index. It links
child run ids and includes slowest-job tables. For failures, inspect the child
workflow first, then rerun the smallest matching handle above.

Useful artifacts:

- `release-package-under-test` from the Full Release Validation parent and `OpenClaw Release Checks`
- Docker release-path artifacts under `.artifacts/docker-tests/`
- Package Acceptance `package-under-test` and Docker acceptance artifacts
- Cross-OS release-check artifacts for each OS and suite
- QA parity, Matrix, and Telegram artifacts

## Workflow files

- `.github/workflows/full-release-validation.yml`
- `.github/workflows/openclaw-release-checks.yml`
- `.github/workflows/openclaw-live-and-e2e-checks-reusable.yml`
- `.github/workflows/plugin-prerelease.yml`
- `.github/workflows/install-smoke.yml`
- `.github/workflows/openclaw-cross-os-release-checks-reusable.yml`
- `.github/workflows/package-acceptance.yml`
