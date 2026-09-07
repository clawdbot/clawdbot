---
summary: "Full Release Validation and the Vitest, Docker, QA Lab, and Package boxes"
title: "Release test boxes"
read_when:
  - You are choosing which validation box proves a release question
  - You need the rerun groups and evidence-reuse rules
  - You are reading Full Release Validation artifacts after a failure
---

## Release test boxes

`Full Release Validation` is how operators kick off the full product matrix from one entrypoint. Use the helper so every child workflow runs from a temporary branch fixed at one trusted `main` workflow SHA while the requested commit remains the candidate under test:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

The helper verifies that the recorded Tooling SHA remains reachable from current
`origin/main`, pushes `release-ci/<workflow-sha>-...` at that exact commit,
accepts only the release branch's final package version or a matching beta
prerelease, infers `beta` for that beta path and `stable` for final versions, and
dispatches `Full Release Validation` with the Validation SHA as `expected_sha`.
Target resolution rejects a mismatch before child dispatch. Every child workflow
`headSha` must match the Tooling SHA. Pass `-f reuse_evidence=false` to force a
fresh run or `-f release_profile=full` for the broad advisory sweep. Never
replace the recorded Tooling SHA with a fresh `main` lookup. The helper rejects
pinned tooling that lacks the current release-isolation contract or the
`expected_sha` dispatch input and never silently selects newer tooling. The
workflow itself never writes repository refs. Tideclaw alpha validation remains
on its matching alpha branch and exact alpha tag rather than a regular
`release/*` context.

That current-`main` lineage check authorizes the initial validation tooling
selection only. It is not permission to choose newer tooling after the
candidate SHA/ref and Tooling SHA/ref are frozen. Once publication binds the
Tooling SHA to the protected lightweight `release-publish/*` tag, the exact live
tag-to-SHA mapping and exact parent run tuple authorize the npm mutations
enforced by this foundation even if `main` has advanced. Other privileged
writers remain blocked until their dependent enforcement changes land.

After the Code SHA is green, commit only `CHANGELOG.md` and run the same helper with the Release SHA:

```bash
TOOLING_SHA="<same-recorded-tooling-sha>"
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"
```

The second parent reuses product evidence only when GitHub proves the Release SHA descends from the Code SHA and the complete changed path set is exactly `CHANGELOG.md`. It records `changelog-only-release-v1` and dispatches no product children. Npm preflight and package/install acceptance still run on the Release SHA because its tarball bytes changed.

For a fresh Code SHA, the workflow resolves the target, dispatches manual `CI`, then dispatches `OpenClaw Release Checks`. Beta-publish maps to `release_profile=beta` and `run_release_soak=false`. An `all` run for an actual beta package on its matching canonical release branch or beta tag records `coveragePolicy=npm-beta-v1`: Linux/macOS/Windows Node, Control UI, plugin, package, Linux cross-OS, and QA parity/runtime/restart/tool gates remain; Windows/macOS cross-OS outcomes are advisory; native apps, performance, and published-package Telegram confidence are deferred. Beta `all` without soak also defers broad live/E2E, QA-live, and Package Acceptance Telegram. Postpublish-confidence uses the exact published package with soak or explicit focused groups. Stable-publish maps to `release_profile=stable`. The final verifier summary includes slowest-job tables for each selected child run.

Deferred coverage is recorded as **not run**, never passed. It does not shorten
the terminal-evidence requirement for selected children. `main`, alpha, and
non-beta targets do not qualify for `npm-beta-v1`; stable, full, soak-enabled,
and focused runs retain their existing coverage. Native artifact publication
still requires its build, signing, notarization, and promotion gates.

Each dispatcher records the exact child run ID and attempt, then exits. Release
Decision reports a decisive blocker without waiting for unrelated diagnostic
tails; with `fail_fast=false`, Diagnostic Drain keeps the selected children
running to terminal. Diagnose `blocked_diagnostics_running` immediately, but do
not retry until the drain is terminal. Recover `orchestration_error` against
the same exact children and never redispatch tests merely to repair collection.
An immutable run-bound execution plan preserves the original attempt, titles,
coverage, gates, and child tuples across collector retries. The final verifier
consumes that plan and the exact attempt-bound Decision and Drain artifacts
instead of polling or reclassifying child results.

When selected, the product-performance child is artifact-only in this release
path. The umbrella dispatches it with `publish_reports=false`, and validation
is rejected unless its artifact-only guard proves that the Clawgrit report
publisher stayed skipped. `npm-beta-v1` defers this child to confidence work.
An early standalone beta performance run is optional signal, not another
mandatory prepublish wait; record available results and any observed regression.

See [Full release validation](/reference/full-release-validation) for the complete stage matrix, exact workflow job names, stable versus full profile differences, artifacts, and focused rerun handles.

Child workflows are dispatched from the SHA-pinned trusted ref that runs `Full Release Validation`. Every child run must use the exact parent workflow SHA. Do not use raw `--ref main -f ref=<sha>` dispatches for release proof; use `pnpm ci:full-release --sha <target-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha>`.

Use `release_profile` to select live/provider breadth:

- `beta`: fastest release-critical OpenAI/core live and Docker path
- `stable`: beta plus stable provider/backend coverage for release approval
- `full`: stable plus broad advisory provider/media coverage

Stable and full validation always run the exhaustive live/E2E, Docker release-path, and bounded published upgrade-survivor sweep before promotion. Use `run_release_soak=true` to request that same sweep for a beta. The sweep resolves the latest stable baseline once and runs the reported-issue upgrade fixtures against it. Broader historical migration coverage remains available through the separate manual `Update Migration` workflow.

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the target ref once as `release-package-under-test` and reuses that artifact in cross-OS, Package Acceptance, and release-path Docker checks when soak runs. This keeps all package-facing boxes on the same bytes and avoids repeated package builds. After a beta is already on npm, set `release_package_spec=openclaw@YYYY.M.PATCH-beta.N` so release checks download the shipped package once, extract its build source SHA from `dist/build-info.json`, and reuse that artifact for cross-OS, Package Acceptance, release-path Docker, and package Telegram lanes.

The cross-OS OpenAI install smoke uses `OPENCLAW_CROSS_OS_OPENAI_MODEL` when the repo/org variable is set, otherwise `openai/gpt-5.6-luna`, because this lane is proving package install, onboarding, gateway startup, and one live agent turn rather than benchmarking the most capable model. The broader live provider matrix remains the place for model-specific coverage.

Use these variants depending on release stage:

```bash
TOOLING_SHA="<recorded-full-main-ancestor-sha>"

# Validate the product-complete Code SHA.
pnpm ci:full-release \
  --sha <code-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"

# Validate the changelog-only Release SHA by reusing Code SHA product evidence.
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA"

# Run postpublish confidence against the exact published beta.
pnpm ci:full-release \
  --sha <release-sha> \
  --target-ref release/YYYY.M.PATCH \
  --workflow-sha "$TOOLING_SHA" \
  -f release_package_spec=openclaw@YYYY.M.PATCH-beta.N \
  -f evidence_package_spec=openclaw@YYYY.M.PATCH-beta.N \
  -f run_release_soak=true \
  -f npm_telegram_provider_mode=mock-openai
```

Do not use the full umbrella as the first rerun after a focused fix. Classify the failure as product, harness/tooling/provenance, infrastructure/credential, or wrapper. Only confirmed product failure changes the Code SHA. Use one diagnosis, one fix when needed, and one narrow retry, then reassess. A narrow green run is evidence, not publish authorization by itself; there is no standalone parent finalizer.

`rerun_group=all` may reuse a prior green umbrella run when the release profile,
coverage policy, effective soak setting, and validation inputs match and either the target SHA
is identical or the new target is a descendant whose complete changed path set
is exactly `CHANGELOG.md`. Exact-target reuse records
`exact-target-full-validation-v1`; the post-validation Release SHA records
`changelog-only-release-v1`. The latter reuses only product validation. Npm
preflight, package bytes, release-note provenance, and install/update acceptance
must still run against the Release SHA. Any version, source, generated,
dependency, package, or workflow-owned target change requires a new Code SHA
and fresh full validation. Concurrency is keyed by Validation SHA, Tooling SHA,
and rerun group and does not cancel prior runs. Parent cancellation leaves
adopted children running until the operator cancels the exact child. Pass
`reuse_evidence=false` only when a fresh full run is intentionally required.

For bounded recovery, pass `rerun_group` to the umbrella. Supported controller groups are `ci`, `plugin-prerelease`, `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`, and `performance`; use `all` only for deliberate full validation. The removed `release-checks` aggregate handle is invalid because it silently selected every release-check lane and its package/Docker setup. `qa` remains available only as a direct `OpenClaw Release Checks` manual aggregate, not as an umbrella/controller retry API. Focused `npm-telegram` reruns require `release_package_spec` or `npm_telegram_package_spec`; all-group runs use Package Acceptance Telegram E2E except beta without soak, where it is deferred. Focused cross-OS reruns can add `cross_os_suite_filter=windows/packaged-upgrade` or another OS/suite filter. Live and QA-live filters are valid only with their owning group. Cross-OS filters also work with `rerun_group=all`: add `-f cross_os_suite_filter=ubuntu,macos` to exclude Windows. `npm-stable-v1` and `npm-beta-v1` qualification is preserved when all three Linux suites remain selected; omitted advisory lanes are not run, never passed. Mismatches fail before scheduling and never become an unfiltered broad run. QA release-check failures block normal release validation, including OpenClaw dynamic tool drift in the core runtime-pair lane. Tideclaw alpha runs may still treat non-package-safety release-check lanes as advisory. With `release_profile=beta`, the `Run repo/live E2E validation` live-provider suites are advisory (warnings, not blockers); stable and full profiles keep them blocking. When `live_suite_filter` explicitly requests a gated QA live lane such as Discord, WhatsApp, or Slack, the matching `OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED` repo variable must be enabled; otherwise input capture fails instead of silently skipping the lane.

### Vitest

The Vitest box is the manual `CI` child workflow. Manual CI bypasses changed scoping and selects the normal test graph for the release candidate: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, and Control UI i18n. Under `npm-beta-v1`, the umbrella passes `release_scope=npm-beta` and `include_android=false`: native Swift/OpenClawKit, iOS, Android, and native i18n CI lanes are deferred; macOS and Windows Node checks remain. Other Full Release Validation runs use full CI with Android. Standalone manual CI defaults to full coverage and requires `include_android=true` for Android.

Use this box to answer "did the source tree pass the selected CI suite?" It is separate from release-path product validation. Evidence to keep:

- `Full Release Validation` summary showing the dispatched `CI` run URL
- `CI` run green on the exact target SHA
- recorded coverage policy and effective CI `release_scope`, including deferred native coverage
- failed or slow shard names from the CI jobs when investigating regressions
- Vitest timing artifacts such as `.artifacts/vitest-shard-timings.json` when a run needs performance analysis

Run manual CI directly only when the release needs deterministic normal CI but not the Docker, QA Lab, live, cross-OS, or package boxes. Use the first command for non-Android direct CI. Add `include_android=true` when direct release-candidate CI must cover Android:

```bash
gh workflow run ci.yml --ref main -f target_ref=release/YYYY.M.PATCH
gh workflow run ci.yml --ref main -f target_ref=release/YYYY.M.PATCH -f include_android=true
```

### Docker

The Docker box lives in `OpenClaw Release Checks` through `openclaw-live-and-e2e-checks-reusable.yml`, plus the release-mode `install-smoke` workflow. It validates the release candidate through packaged Docker environments instead of only source-level tests.

Release Docker coverage includes:

- full install smoke with the slow Bun global install smoke enabled
- root Dockerfile smoke image preparation/reuse by target SHA, with QR, root/gateway, and installer/Bun smoke jobs running as separate install-smoke shards
- repository E2E lanes
- release-path Docker chunks: `core`, `package-update-openai`, `package-update-onboarding`, `package-update-migrations`, `package-update-self-upgrade`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`
- OpenWebUI coverage on a dedicated large-disk runner when requested
- split bundled plugin install/uninstall lanes `bundled-plugin-install-uninstall-0` through `bundled-plugin-install-uninstall-23`
- live/E2E provider suites and Docker live model coverage when release checks include live suites

Use Docker artifacts before rerunning. The release-path scheduler uploads `.artifacts/docker-tests/` with lane logs, `summary.json`, `failures.json`, phase timings, scheduler plan JSON, and rerun commands. For focused recovery, use `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow instead of rerunning all release chunks. Generated rerun commands include prior `package_artifact_run_id` and prepared Docker image inputs when available, so a failed lane can reuse the same tarball and GHCR images.

### QA Lab

The QA Lab box is also part of `OpenClaw Release Checks`. It is the agentic behavior and channel-level release gate, separate from Vitest and Docker package mechanics.

Release QA Lab coverage includes:

- mock parity lane comparing the OpenAI candidate lane against the `anthropic/claude-opus-4-8` baseline using the agentic parity pack
- Matrix live-adapter catalog lane using the `qa-live-shared` environment
- live Telegram QA lane using Convex CI credential leases
- `pnpm qa:otel:smoke`, `pnpm qa:otel:collector-smoke`, `pnpm qa:prometheus:smoke`, or `pnpm qa:observability:smoke` when release telemetry needs explicit local proof

Use this box to answer "does the release behave correctly in QA scenarios and live channel flows?" Keep the artifact URLs for parity, Matrix, and Telegram lanes when approving the release. Matrix runs use the same catalog-derived sharded selection in scheduled, manual, and release workflows.

### Package

The Package box is the installable-product gate. It is backed by `Package Acceptance` and the resolver `scripts/resolve-openclaw-package-candidate.mts`. The resolver normalizes a candidate into the `package-under-test` tarball consumed by Docker E2E, validates the package inventory, records the package version and SHA-256, and keeps the workflow harness ref separate from the package source ref.

Supported candidate sources:

- `source=npm`: `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release version
- `source=ref`: pack a trusted `package_ref` branch, tag, or full commit SHA with the selected `workflow_ref` harness
- `source=url`: download a public HTTPS `.tgz` with required `package_sha256`; URL credentials, non-default HTTPS ports, private/internal/special-use hostnames or resolved addresses, and unsafe redirects are rejected
- `source=trusted-url`: download an HTTPS `.tgz` with required `package_sha256` and `trusted_source_id` from a named policy in `.github/package-trusted-sources.json`; use this for maintainer-owned enterprise mirrors or private package repositories instead of adding an input-level private-network bypass to `source=url`
- `source=artifact`: reuse a `.tgz` uploaded by another GitHub Actions run

`OpenClaw Release Checks` runs Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, and `docker_lanes=release-typed-onboarding doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape`. This retains typed onboarding, migration, update, root-managed VPS upgrade, configured-auth update restart, live ClawHub skill install, stale plugin dependency cleanup, offline plugin fixtures, plugin update, and plugin command-binding escape hardening against the same resolved tarball. Telegram uses `telegram_mode=none` for beta `all` without soak; explicit `package` and soak-enabled runs select `mock-openai` by default. Blocking release checks use the default latest published package baseline. Soak resolves the latest stable baseline once and adds the `reported-issues` scenarios; broad historical migration remains a separate manual workflow. Use Package Acceptance with `source=npm` for an already shipped candidate, `source=ref` for a SHA-backed local npm tarball before publish, `source=trusted-url` for a maintainer-owned enterprise/private mirror, or `source=artifact` for a prepared tarball uploaded by another GitHub Actions run.

It is the GitHub-native replacement for most of the package/update coverage that previously required Parallels. Cross-OS release checks still matter for OS-specific onboarding, installer, and platform behavior, but package/update product validation should prefer Package Acceptance.

The canonical checklist for update and plugin validation is [Testing updates and plugins](/help/testing-updates-plugins). Use it when deciding which local, Docker, Package Acceptance, or release-check lane proves a plugin install/update, doctor cleanup, or published-package migration change. Exhaustive published update migration from every stable `2026.4.23+` package is a separate manual `Update Migration` workflow, not part of Full Release CI.

Legacy package-acceptance leniency is intentionally time boxed. Packages through `2026.4.25` may use the compatibility path for metadata gaps already published to npm: private QA inventory entries missing from the tarball, missing `gateway install --wrapper`, missing patch files in the tarball-derived git fixture, missing persisted `update.channel`, legacy plugin install-record locations, missing marketplace install-record persistence, and config metadata migration during `plugins update`. The published `2026.4.26` package may warn for local build metadata stamp files that were already shipped. Later packages must satisfy the modern package contracts; those same gaps fail release validation.

Use broader Package Acceptance profiles when the release question is about an actual installable package:

```bash
gh workflow run package-acceptance.yml \
  --ref main \
  -f workflow_ref=main \
  -f source=npm \
  -f package_spec=openclaw@beta \
  -f suite_profile=product \
  -f published_upgrade_survivor_baseline=openclaw@2026.4.26
```

Common package profiles:

- `smoke`: quick package install/channel/agent, gateway network, and config reload lanes
- `package`: install/update/restart/plugin package contracts plus live ClawHub skill install proof; this is the release-check default
- `product`: `package` plus MCP channels, cron/subagent cleanup, OpenAI web search, and OpenWebUI
- `full`: Docker release-path chunks with OpenWebUI
- `custom`: exact `docker_lanes` list for focused reruns

For package-candidate Telegram proof, enable `telegram_mode=mock-openai` or `telegram_mode=live-frontier` on Package Acceptance. The workflow passes the resolved `package-under-test` tarball into the Telegram lane; the standalone Telegram workflow still accepts a published npm spec for post-publish checks.

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
