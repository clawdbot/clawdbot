---
summary: "Release lanes, operator checklist, validation boxes, version naming, and cadence"
title: "Release policy"
read_when:
  - Looking for public release channel definitions
  - Running release validation or package acceptance
  - Looking for version naming and cadence
---

OpenClaw has three public release lanes:

- stable: tagged releases that publish to npm `beta` by default, or to npm `latest` when explicitly requested
- beta: prerelease tags that publish to npm `beta`
- dev: the moving head of `main`

## Version naming

- Stable release version: `YYYY.M.D`
  - Git tag: `vYYYY.M.D`
- Stable correction release version: `YYYY.M.D-N`
  - Git tag: `vYYYY.M.D-N`
- Beta prerelease version: `YYYY.M.D-beta.N`
  - Git tag: `vYYYY.M.D-beta.N`
- Do not zero-pad month or day
- `latest` means the current promoted stable npm release
- `beta` means the current beta install target
- Stable and stable correction releases publish to npm `beta` by default; release operators can target `latest` explicitly, or promote a vetted beta build later
- Every stable OpenClaw release ships the npm package and macOS app together;
  beta releases normally validate and publish the npm/package path first, with
  mac app build/sign/notarize reserved for stable unless explicitly requested

## Release cadence

- Releases move beta-first
- Stable follows only after the latest beta is validated
- Maintainers normally cut releases from a `release/YYYY.M.D` branch created
  from current `main`, so release validation and fixes do not block new
  development on `main`
- If a beta tag has been pushed or published and needs a fix, maintainers cut
  the next `-beta.N` tag instead of deleting or recreating the old beta tag
- Detailed release procedure, approvals, credentials, and recovery notes are
  maintainer-only

## Release operator checklist

This checklist is the public shape of the release flow. Private credentials,
signing, notarization, dist-tag recovery, and emergency rollback details stay in
the maintainer-only release runbook.

1. Start from current `main`: pull latest, confirm the target commit is pushed,
   and confirm current `main` CI is green enough to branch from it.
2. Rewrite the top `CHANGELOG.md` section from real commit history with
   `/changelog`, keep entries user-facing, commit it, push it, and rebase/pull
   once more before branching.
3. Review release compatibility records in
   `src/plugins/compat/registry.ts` and
   `src/commands/doctor/shared/deprecation-compat.ts`. Remove expired
   compatibility only when the upgrade path stays covered, or record why it is
   intentionally carried.
4. Create `release/YYYY.M.D` from current `main`; do not do normal release work
   directly on `main`.
5. Bump every required version location for the intended tag, then run the
   local deterministic preflight:
   `pnpm check:test-types`, `pnpm check:architecture`,
   `pnpm build && pnpm ui:build`, and `pnpm release:check`.
6. Run `OpenClaw NPM Release` with `preflight_only=true`. Before a tag exists,
   a full 40-character release-branch SHA is allowed for validation-only
   preflight. Save the successful `preflight_run_id`.
7. Kick off all pre-release tests with `Full Release Validation` for the
   release branch, tag, or full commit SHA. This is the one manual entrypoint
   for the four big release test boxes: Vitest, Docker, QA Lab, and Package.
8. If validation fails, fix on the release branch and rerun the smallest failed
   file, lane, workflow job, package profile, provider, or model allowlist that
   proves the fix. Rerun the full umbrella only when the changed surface makes
   prior evidence stale.
9. For beta, tag `vYYYY.M.D-beta.N`, publish with npm dist-tag `beta`, then run
   post-publish package acceptance against the published `openclaw@YYYY.M.D-beta.N`
   or `openclaw@beta` package. If a pushed or published beta needs a fix, cut
   the next `-beta.N`; do not delete or rewrite the old beta.
10. For stable, continue only after the vetted beta or release candidate has the
    required validation evidence. Stable npm publish reuses the successful
    preflight artifact via `preflight_run_id`; stable macOS release readiness
    also requires the packaged `.zip`, `.dmg`, `.dSYM.zip`, and updated
    `appcast.xml` on `main`.
11. After publish, run the npm post-publish verifier, optional standalone
    published-npm Telegram E2E when you need post-publish channel proof,
    dist-tag promotion when needed, GitHub release/prerelease notes from the
    complete matching `CHANGELOG.md` section, and the release announcement
    steps.

## Release preflight

- Run `pnpm check:test-types` before release preflight so test TypeScript stays
  covered outside the faster local `pnpm check` gate
- Run `pnpm check:architecture` before release preflight so the broader import
  cycle and architecture boundary checks are green outside the faster local gate
- Run `pnpm build && pnpm ui:build` before `pnpm release:check` so the expected
  `dist/*` release artifacts and Control UI bundle exist for the pack
  validation step
- Run the manual `Full Release Validation` workflow before release approval to
  kick off all pre-release test boxes from one entrypoint. It accepts a branch,
  tag, or full commit SHA, dispatches manual `CI`, and dispatches
  `OpenClaw Release Checks` for install smoke, package acceptance, Docker
  release-path suites, live/E2E, OpenWebUI, QA Lab parity, Matrix, and Telegram
  lanes. Provide `npm_telegram_package_spec` only after a package has been
  published and the post-publish Telegram E2E should run too. Provide
  `evidence_package_spec` when the private evidence report should prove that the
  validation matches a published npm package without forcing Telegram E2E.
  Example:
  `gh workflow run full-release-validation.yml --ref main -f ref=release/YYYY.M.D`
- Run the manual `Package Acceptance` workflow when you want side-channel proof
  for a package candidate while release work continues. Use `source=npm` for
  `openclaw@beta`, `openclaw@latest`, or an exact release version; `source=ref`
  to pack a trusted `package_ref` branch/tag/SHA with the current
  `workflow_ref` harness; `source=url` for an HTTPS tarball with a required
  SHA-256; or `source=artifact` for a tarball uploaded by another GitHub
  Actions run. The workflow resolves the candidate to
  `package-under-test`, reuses the Docker E2E release scheduler against that
  tarball, and can run Telegram QA against the same tarball with
  `telegram_mode=mock-openai` or `telegram_mode=live-frontier`. When the
  selected Docker lanes include `published-upgrade-survivor`, the package
  artifact is the candidate and `published_upgrade_survivor_baseline` selects
  the published baseline.
  Example: `gh workflow run package-acceptance.yml --ref main -f workflow_ref=main -f source=npm -f package_spec=openclaw@beta -f suite_profile=product -f published_upgrade_survivor_baseline=openclaw@2026.4.26 -f telegram_mode=mock-openai`
  Common profiles:
  - `smoke`: install/channel/agent, gateway network, and config reload lanes
  - `package`: artifact-native package/update/plugin lanes without OpenWebUI or live ClawHub
  - `product`: package profile plus MCP channels, cron/subagent cleanup,
    OpenAI web search, and OpenWebUI
  - `full`: Docker release-path chunks with OpenWebUI
  - `custom`: exact `docker_lanes` selection for a focused rerun
- Run the manual `CI` workflow directly when you only need full normal CI
  coverage for the release candidate. Manual CI dispatches bypass changed
  scoping and force the Linux Node shards, bundled-plugin shards, channel
  contracts, Node 22 compatibility, `check`, `check-additional`, build smoke,
  docs checks, Python skills, Windows, macOS, Android, and Control UI i18n
  lanes.
  Example: `gh workflow run ci.yml --ref release/YYYY.M.D`
- Run `pnpm qa:otel:smoke` when validating release telemetry. It exercises
  QA-lab through a local OTLP/HTTP receiver and verifies the exported trace
  span names, bounded attributes, and content/identifier redaction without
  requiring Opik, Langfuse, or another external collector.
- Run `pnpm release:check` before every tagged release
- Release checks now run in a separate manual workflow:
  `OpenClaw Release Checks`
- `OpenClaw Release Checks` also runs the QA Lab mock parity gate plus the fast
  live Matrix profile and Telegram QA lane before release approval. The live
  lanes use the `qa-live-shared` environment; Telegram also uses Convex CI
  credential leases. Run the manual `QA-Lab - All Lanes` workflow with
  `matrix_profile=all` and `matrix_shards=true` when you want full Matrix
  transport, media, and E2EE inventory in parallel.
- Cross-OS install and upgrade runtime validation is part of public
  `OpenClaw Release Checks` and `Full Release Validation`, which call the
  reusable workflow
  `.github/workflows/openclaw-cross-os-release-checks-reusable.yml` directly
- This split is intentional: keep the real npm release path short,
  deterministic, and artifact-focused, while slower live checks stay in their
  own lane so they do not stall or block publish
- Secret-bearing release checks should be dispatched through `Full Release
Validation` or from the `main`/release workflow ref so workflow logic and
  secrets stay controlled
- `OpenClaw Release Checks` accepts a branch, tag, or full commit SHA as long
  as the resolved commit is reachable from an OpenClaw branch or release tag
- `OpenClaw NPM Release` validation-only preflight also accepts the current
  full 40-character workflow-branch commit SHA without requiring a pushed tag
- That SHA path is validation-only and cannot be promoted into a real publish
- In SHA mode the workflow synthesizes `v<package.json version>` only for the
  package metadata check; real publish still requires a real release tag
- Both workflows keep the real publish and promotion path on GitHub-hosted
  runners, while the non-mutating validation path can use the larger
  Blacksmith Linux runners
- That workflow runs
  `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache`
  using both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` workflow secrets
- npm release preflight no longer waits on the separate release checks lane
- Run `RELEASE_TAG=vYYYY.M.D node --import tsx scripts/openclaw-npm-release-check.ts`
  (or the matching beta/correction tag) before approval
- After npm publish, run
  `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.D`
  (or the matching beta/correction version) to verify the published registry
  install path in a fresh temp prefix
- After a beta publish, run `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC=openclaw@YYYY.M.D-beta.N OPENCLAW_NPM_TELEGRAM_CREDENTIAL_SOURCE=convex OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=ci pnpm test:docker:npm-telegram-live`
  to verify installed-package onboarding, Telegram setup, and real Telegram E2E
  against the published npm package using the shared leased Telegram credential
  pool. Local maintainer one-offs may omit the Convex vars and pass the three
  `OPENCLAW_QA_TELEGRAM_*` env credentials directly.
- Maintainers can run the same post-publish check from GitHub Actions via the
  manual `NPM Telegram Beta E2E` workflow. It is intentionally manual-only and
  does not run on every merge.
- Maintainer release automation now uses preflight-then-promote:
  - real npm publish must pass a successful npm `preflight_run_id`
  - the real npm publish must be dispatched from the same `main` or
    `release/YYYY.M.D` branch as the successful preflight run
  - stable npm releases default to `beta`
  - stable npm publish can target `latest` explicitly via workflow input
  - token-based npm dist-tag mutation now lives in
    `openclaw/releases-private/.github/workflows/openclaw-npm-dist-tags.yml`
    for security, because `npm dist-tag add` still needs `NPM_TOKEN` while the
    public repo keeps OIDC-only publish
  - public `macOS Release` is validation-only; when a tag lives only on a
    release branch but the workflow is dispatched from `main`, set
    `public_release_branch=release/YYYY.M.D`
  - real private mac publish must pass successful private mac
    `preflight_run_id` and `validate_run_id`
  - the real publish paths promote prepared artifacts instead of rebuilding
    them again
- For stable correction releases like `YYYY.M.D-N`, the post-publish verifier
  also checks the same temp-prefix upgrade path from `YYYY.M.D` to `YYYY.M.D-N`
  so release corrections cannot silently leave older global installs on the
  base stable payload
- npm release preflight fails closed unless the tarball includes both
  `dist/control-ui/index.html` and a non-empty `dist/control-ui/assets/` payload
  so we do not ship an empty browser dashboard again
- Post-publish verification also checks that the published registry install
  contains non-empty bundled plugin runtime deps under the root `dist/*`
  layout. A release that ships with missing or empty bundled plugin
  dependency payloads fails the postpublish verifier and cannot be promoted
  to `latest`.
- `pnpm test:install:smoke` also enforces the npm pack `unpackedSize` budget on
  the candidate update tarball, so installer e2e catches accidental pack bloat
  before the release publish path
- If the release work touched CI planning, extension timing manifests, or
  extension test matrices, regenerate and review the planner-owned
  `plugin-prerelease-extension-shard` matrix outputs from
  `.github/workflows/plugin-prerelease.yml` before approval so release notes do
  not describe a stale CI layout
- Stable macOS release readiness also includes the updater surfaces:
  - the GitHub release must end up with the packaged `.zip`, `.dmg`, and `.dSYM.zip`
  - `appcast.xml` on `main` must point at the new stable zip after publish
  - the packaged app must keep a non-debug bundle id, a non-empty Sparkle feed
    URL, and a `CFBundleVersion` at or above the canonical Sparkle build floor
    for that release version

## Release test boxes

`Full Release Validation` is how operators kick off all pre-release tests from
one entrypoint. Run it from the trusted `main` workflow ref and pass the release
branch, tag, or full commit SHA as `ref`:

```bash
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.D \
  -f provider=openai \
  -f mode=both \
  -f release_profile=stable \
  -f evidence_package_spec=openclaw@YYYY.M.D-beta.N
```

The workflow resolves the target ref, dispatches manual `CI` with
`target_ref=<release-ref>`, dispatches `OpenClaw Release Checks`, and
optionally dispatches standalone post-publish Telegram E2E when
`npm_telegram_package_spec` is set. `OpenClaw Release Checks` then fans out
install smoke, cross-OS release checks, live/E2E Docker release-path coverage,
Package Acceptance with Telegram package QA, QA Lab parity, live Matrix, and
live Telegram. A full run is only acceptable when the `Full Release Validation`
summary shows `normal_ci` and `release_checks` as successful, and any optional
`npm_telegram` child is either successful or intentionally skipped. The final
verifier summary includes slowest-job tables for each child run, so the release
manager can see the current critical path without downloading logs.
See [Full release validation](/reference/full-release-validation) for the
complete stage matrix, exact workflow job names, stable versus full profile
differences, artifacts, and focused rerun handles.
Child workflows are dispatched from the trusted ref that runs `Full Release
Validation`, normally `--ref main`, even when the target `ref` points at an
older release branch or tag. There is no separate Full Release Validation
workflow-ref input; choose the trusted harness by choosing the workflow run ref.

Use `release_profile` to select live/provider breadth:

- `minimum`: fastest release-critical OpenAI/core live and Docker path
- `stable`: minimum plus stable provider/backend coverage for release approval
- `full`: stable plus broad advisory provider/media coverage

`OpenClaw Release Checks` uses the trusted workflow ref to resolve the target
ref once as `release-package-under-test` and reuses that artifact in both
release-path Docker checks and Package Acceptance. This keeps all
package-facing boxes on the same bytes and avoids repeated package builds.
The cross-OS OpenAI install smoke uses `OPENCLAW_CROSS_OS_OPENAI_MODEL` when the
repo/org variable is set, otherwise `openai/gpt-5.4-mini`, because this lane is
proving package install, onboarding, gateway startup, and one live agent turn
rather than benchmarking the slowest default model. The broader live provider
matrix remains the place for model-specific coverage.

Use these variants depending on release stage:

```bash
# Validate an unpublished release candidate branch.
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.D \
  -f provider=openai \
  -f mode=both \
  -f release_profile=stable

# Validate an exact pushed commit.
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=<40-char-sha> \
  -f provider=openai \
  -f mode=both

# After publishing a beta, add published-package Telegram E2E.
gh workflow run full-release-validation.yml \
  --ref main \
  -f ref=release/YYYY.M.D \
  -f provider=openai \
  -f mode=both \
  -f evidence_package_spec=openclaw@YYYY.M.D-beta.N \
  -f npm_telegram_package_spec=openclaw@YYYY.M.D-beta.N \
  -f npm_telegram_provider_mode=mock-openai
```

Do not use the full umbrella as the first rerun after a focused fix. If one box
fails, use the failed child workflow, job, Docker lane, package profile, model
provider, or QA lane for the next proof. Run the full umbrella again only when
the fix changed shared release orchestration or made earlier all-box evidence
stale. The umbrella's final verifier re-checks the recorded child workflow run
ids, so after a child workflow is rerun successfully, rerun only the failed
`Verify full validation` parent job.

For bounded recovery, pass `rerun_group` to the umbrella. `all` is the real
release-candidate run, `ci` runs only the normal CI child, `plugin-prerelease`
runs only the release-only plugin child, `release-checks` runs every release
box, and the narrower release groups are `install-smoke`, `cross-os`,
`live-e2e`, `package`, `qa`, `qa-parity`, `qa-live`, and `npm-telegram` when the
standalone package Telegram lane is supplied.

### Vitest

The Vitest box is the manual `CI` child workflow. Manual CI intentionally
bypasses changed scoping and forces the normal test graph for the release
candidate: Linux Node shards, bundled-plugin shards, channel contracts, Node 22
compatibility, `check`, `check-additional`, build smoke, docs checks, Python
skills, Windows, macOS, Android, and Control UI i18n.

Use this box to answer "did the source tree pass the full normal test suite?"
It is not the same as release-path product validation. Evidence to keep:

- `Full Release Validation` summary showing the dispatched `CI` run URL
- `CI` run green on the exact target SHA
- failed or slow shard names from the CI jobs when investigating regressions
- Vitest timing artifacts such as `.artifacts/vitest-shard-timings.json` when
  a run needs performance analysis

Run manual CI directly only when the release needs deterministic normal CI but
not the Docker, QA Lab, live, cross-OS, or package boxes:

```bash
gh workflow run ci.yml --ref main -f target_ref=release/YYYY.M.D
```

### Docker

The Docker box lives in `OpenClaw Release Checks` through
`openclaw-live-and-e2e-checks-reusable.yml`, plus the release-mode
`install-smoke` workflow. It validates the release candidate through packaged
Docker environments instead of only source-level tests.

Release Docker coverage includes:

- full install smoke with the slow Bun global install smoke enabled
- root Dockerfile smoke image preparation/reuse by target SHA, with QR,
  root/gateway, and installer/Bun smoke jobs running as separate install-smoke
  shards
- repository E2E lanes
- release-path Docker chunks: `core`, `package-update-openai`,
  `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`,
  `plugins-runtime-services`,
  `plugins-runtime-install-a`, `plugins-runtime-install-b`,
  `plugins-runtime-install-c`, `plugins-runtime-install-d`,
  `plugins-runtime-install-e`, `plugins-runtime-install-f`,
  `plugins-runtime-install-g`, `plugins-runtime-install-h`,
  `bundled-channels-core`, `bundled-channels-update-a`,
  `bundled-channels-update-discord`, `bundled-channels-update-b`, and
  `bundled-channels-contracts`
- OpenWebUI coverage inside the `plugins-runtime-services` chunk when requested
- split bundled-channel dependency lanes across channel-smoke, update-target,
  and setup/runtime contract chunks instead of one large bundled-channel job
- split bundled plugin install/uninstall lanes
  `bundled-plugin-install-uninstall-0` through
  `bundled-plugin-install-uninstall-23`
- live/E2E provider suites and Docker live model coverage when release checks
  include live suites

Use Docker artifacts before rerunning. The release-path scheduler uploads
`.artifacts/docker-tests/` with lane logs, `summary.json`, `failures.json`,
phase timings, scheduler plan JSON, and rerun commands. For focused recovery,
use `docker_lanes=<lane[,lane]>` on the reusable live/E2E workflow instead of
rerunning all release chunks. Generated rerun commands include prior
`package_artifact_run_id` and prepared Docker image inputs when available, so a
failed lane can reuse the same tarball and GHCR images.

### QA Lab

The QA Lab box is also part of `OpenClaw Release Checks`. It is the agentic
behavior and channel-level release gate, separate from Vitest and Docker
package mechanics.

Release QA Lab coverage includes:

- mock parity gate comparing the OpenAI candidate lane against the Opus 4.6
  baseline using the agentic parity pack
- fast live Matrix QA profile using the `qa-live-shared` environment
- live Telegram QA lane using Convex CI credential leases
- `pnpm qa:otel:smoke` when release telemetry needs explicit local proof

Use this box to answer "does the release behave correctly in QA scenarios and
live channel flows?" Keep the artifact URLs for parity, Matrix, and Telegram
lanes when approving the release. Full Matrix coverage remains available as a
manual sharded QA-Lab run rather than the default release-critical lane.

### Package

The Package box is the installable-product gate. It is backed by
`Package Acceptance` and the resolver
`scripts/resolve-openclaw-package-candidate.mjs`. The resolver normalizes a
candidate into the `package-under-test` tarball consumed by Docker E2E, validates
the package inventory, records the package version and SHA-256, and keeps the
workflow harness ref separate from the package source ref.

Supported candidate sources:

- `source=npm`: `openclaw@beta`, `openclaw@latest`, or an exact OpenClaw release
  version
- `source=ref`: pack a trusted `package_ref` branch, tag, or full commit SHA
  with the selected `workflow_ref` harness
- `source=url`: download an HTTPS `.tgz` with required `package_sha256`
- `source=artifact`: reuse a `.tgz` uploaded by another GitHub Actions run

`OpenClaw Release Checks` runs Package Acceptance with `source=ref`,
`package_ref=<release-ref>`, `suite_profile=custom`,
`docker_lanes=bundled-channel-deps-compat plugins-offline`, and
`telegram_mode=mock-openai`. The release-path Docker chunks cover the
overlapping install, update, and plugin-update lanes; Package Acceptance keeps
artifact-native bundled-channel compat, offline plugin fixtures, and Telegram
package QA against the same resolved tarball. It is the GitHub-native
replacement for most of the package/update coverage that previously required
Parallels. Cross-OS release checks still matter for OS-specific onboarding,
installer, and platform behavior, but package/update product validation should
prefer Package Acceptance.

Legacy package-acceptance leniency is intentionally time boxed. Packages through
`2026.4.25` may use the compatibility path for metadata gaps already published
to npm: private QA inventory entries missing from the tarball, missing
`gateway install --wrapper`, missing patch files in the tarball-derived git
fixture, missing persisted `update.channel`, legacy plugin install-record
locations, missing marketplace install-record persistence, and config metadata
migration during `plugins update`. The published `2026.4.26` package may warn
for local build metadata stamp files that were already shipped. Later packages
must satisfy the modern package contracts; those same gaps fail release
validation.

Use broader Package Acceptance profiles when the release question is about an
actual installable package:

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

- `smoke`: quick package install/channel/agent, gateway network, and config
  reload lanes
- `package`: install/update/plugin package contracts without live ClawHub; this is the release-check
  default
- `product`: `package` plus MCP channels, cron/subagent cleanup, OpenAI web
  search, and OpenWebUI
- `full`: Docker release-path chunks with OpenWebUI
- `custom`: exact `docker_lanes` list for focused reruns

For package-candidate Telegram proof, enable `telegram_mode=mock-openai` or
`telegram_mode=live-frontier` on Package Acceptance. The workflow passes the
resolved `package-under-test` tarball into the Telegram lane; the standalone
Telegram workflow still accepts a published npm spec for post-publish checks.

## NPM workflow inputs

`OpenClaw NPM Release` accepts these operator-controlled inputs:

- `tag`: required release tag such as `v2026.4.2`, `v2026.4.2-1`, or
  `v2026.4.2-beta.1`; when `preflight_only=true`, it may also be the current
  full 40-character workflow-branch commit SHA for validation-only preflight
- `preflight_only`: `true` for validation/build/package only, `false` for the
  real publish path
- `preflight_run_id`: required on the real publish path so the workflow reuses
  the prepared tarball from the successful preflight run
- `npm_dist_tag`: npm target tag for the publish path; defaults to `beta`

`OpenClaw Release Checks` accepts these operator-controlled inputs:

- `ref`: branch, tag, or full commit SHA to validate. Secret-bearing checks
  require the resolved commit to be reachable from an OpenClaw branch or
  release tag.

Rules:

- Stable and correction tags may publish to either `beta` or `latest`
- Beta prerelease tags may publish only to `beta`
- For `OpenClaw NPM Release`, full commit SHA input is allowed only when
  `preflight_only=true`
- `OpenClaw Release Checks` and `Full Release Validation` are always
  validation-only
- The real publish path must use the same `npm_dist_tag` used during preflight;
  the workflow verifies that metadata before publish continues

## Stable npm release sequence

When cutting a stable npm release:

1. Run `OpenClaw NPM Release` with `preflight_only=true`
   - Before a tag exists, you may use the current full workflow-branch commit
     SHA for a validation-only dry run of the preflight workflow
2. Choose `npm_dist_tag=beta` for the normal beta-first flow, or `latest` only
   when you intentionally want a direct stable publish
3. Run `Full Release Validation` on the release branch, release tag, or full
   commit SHA when you want normal CI plus live prompt cache, Docker, QA Lab,
   Matrix, and Telegram coverage from one manual workflow
4. If you intentionally only need the deterministic normal test graph, run the
   manual `CI` workflow on the release ref instead
5. Save the successful `preflight_run_id`
6. Run `OpenClaw NPM Release` again with `preflight_only=false`, the same
   `tag`, the same `npm_dist_tag`, and the saved `preflight_run_id`
7. If the release landed on `beta`, use the private
   `openclaw/releases-private/.github/workflows/openclaw-npm-dist-tags.yml`
   workflow to promote that stable version from `beta` to `latest`
8. If the release intentionally published directly to `latest` and `beta`
   should follow the same stable build immediately, use that same private
   workflow to point both dist-tags at the stable version, or let its scheduled
   self-healing sync move `beta` later

The dist-tag mutation lives in the private repo for security because it still
requires `NPM_TOKEN`, while the public repo keeps OIDC-only publish.

That keeps the direct publish path and the beta-first promotion path both
documented and operator-visible.

If a maintainer must fall back to local npm authentication, run any 1Password
CLI (`op`) commands only inside a dedicated tmux session. Do not call `op`
directly from the main agent shell; keeping it inside tmux makes prompts,
alerts, and OTP handling observable and prevents repeated host alerts.

## Public references

- [`.github/workflows/full-release-validation.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/full-release-validation.yml)
- [`.github/workflows/package-acceptance.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/package-acceptance.yml)
- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`.github/workflows/openclaw-release-checks.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-release-checks.yml)
- [`.github/workflows/openclaw-cross-os-release-checks-reusable.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-cross-os-release-checks-reusable.yml)
- [`scripts/resolve-openclaw-package-candidate.mjs`](https://github.com/openclaw/openclaw/blob/main/scripts/resolve-openclaw-package-candidate.mjs)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)

Maintainers use the private release docs in
[`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)
for the actual runbook.

## Related

- [Release channels](/install/development-channels)
