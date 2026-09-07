# Release validation and confidence

Use `$release-openclaw-ci` for workflow dispatch, manifests, and failed-child
recovery. Select the phase below; deferred or omitted checks are not passed.
Every selected child needs terminal evidence. A required failure cannot be
waived by success on another surface.

## Source and package gates

Before tagging or publishing, complete the relevant source/package checks:

```bash
pnpm release:fast-pretag-check
pnpm check:architecture
pnpm build
pnpm ui:build
pnpm qa:otel:smoke
pnpm release:check
pnpm test:install:smoke
```

Use existing equivalent exact-SHA release evidence; do not repeat successful
checks solely because this list mentions them. Required source CI includes
`pnpm check` and `pnpm check:test-types`. Root Dockerfile/install-smoke and Linux
cross-OS proof must pass on Code SHA before changelog or tagging. Release SHA
reuses product evidence only through the exact changelog-only policy and still
qualifies its changed package bytes.

`release:fast-pretag-check` protects package-root README, plugin-local runtime,
and npm/ClawHub metadata contracts. Fix real packaging defects before tagging.
For newly publishable packages, read [first-package registry
preparation](first-package.md); do not discover missing ownership during publish
or consume the next beta with ad-hoc bootstrap publication.

Keep plugin `openclaw.release.requireLatestDependencies` declarations. Upstream
latest drift/unavailable lookups are advisory: retain the tested Codex pin and
record warnings. Malformed runtime metadata, package/install failures and
required validation failures still block.

Install smoke also checks pack budget and direct npm global fresh/update paths;
keep those enabled. `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1` is the existing
non-root-skip mode, not permission to skip install proof. Published correction
versions must prove upgrade from their base stable package. Postpublish use:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
```

`pnpm qa:otel:smoke` supplies local OTLP/redaction coverage without hosted
telemetry credentials. Video-provider checks are conditional on release scope:
`pnpm test:live:media video` is bounded default coverage; explicit FAL coverage
uses `--video-providers fal`. Full transform modes require intentional
`OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1`. Use `$one-password` before
credentialed tests. Local live model/Parallels rosters require both OpenAI and
Anthropic keys; missing either blocks those lanes, never print their values.

## Beta-publish

Use `release_profile=beta`, `run_release_soak=false`. A qualifying `all` run for
an actual beta on its canonical branch/tag records `npm-beta-v1`. Native app
CI, performance, and published-package Telegram move to confidence. Required
Node, Control UI, plugin, package, install/update, Linux cross-OS, QA parity,
runtime-pair/restart and tool-coverage gates remain. Beta `all` without soak
also defers Package Acceptance Telegram, broad live/E2E, QA-live and Parallels.
Package Telegram deferral applies to beta-profile main/alpha too, but those do
not qualify for `npm-beta-v1`.

Windows/macOS cross-OS are advisory for beta/stable/full. All-group
`cross_os_suite_filter` may omit advisory OS lanes; `npm-beta-v1` and
`npm-stable-v1` still require all Linux suites. Focused cross-OS rerun semantics
remain unchanged. Read required versus advisory conclusions in the manifest
and `release-ci-summary`.

## Postpublish confidence

Target the exact published beta with `run_release_soak=true` or focused groups.
This phase owns deferred native apps, performance, Telegram, QA-live, broad
Docker/live E2E and Parallels:

- Verify registry/provenance and install/update of the published package,
  including Docker coverage.
- Dispatch **NPM Telegram Beta E2E** from main with
  `package_spec=openclaw@<beta-version>`, `provider_mode=mock-openai`; require
  success. Its shared QA secrets use `qa-live-shared`, not npm publish approval.
  Local `pnpm test:docker:npm-telegram-live` with matching package spec and
  Convex CI environment is a debugging/fallback path.
- Use `$openclaw-parallels-smoke` for published-package install/update with both
  provider keys. Keep plugin installs enabled; disabling them proves no
  plugin/dependency release contract.
- Credentialed channel QA uses **QA-Lab - All Lanes**
  (`qa-live-transports-convex.yml`) against the published tag. SHA targets must
  satisfy its main-ancestor/open-PR-head credential trust gate. It covers mock
  parity, live Matrix and Convex-leased Telegram. After later fixes, rerun
  touched surfaces; rerun this workflow for channel, credential or QA-harness
  changes. Do not substitute unrelated local proof.

A confidence failure does not retroactively unpublish a beta. Classify it and
admit a confirmed product fix only to a new operator-approved candidate.

## Stable-publish and bounded execution

Stable/full requires its stable roster, soak, blocking performance and accepted
confidence evidence. Matching beta confidence may support the light promotion
roster in [regular release](regular-release.md), not waive a required gate.
Native publication retains separate signing/notarization/promotion gates under
[platform publication](platform-publication.md).

Bound long local lanes: install smoke 45 minutes, Docker-all 90 minutes,
standalone Docker-live 60 minutes, explicitly requested full local QA 180
minutes; use the Parallels skill's caps for VM lanes. Individual npm
install/update phases cap at 300 seconds. On timeout, inspect the affected lane
instead of leaving it running. Serialize build/package mutations before VM
packing so a concurrent build cannot remove `dist`; avoid load-induced noise.

Fix related required failures at their owner and rerun affected evidence. For
PR preparation/landing or observed hosted-runner stalls, use
`$openclaw-pr-maintainer` / `$openclaw-ci-limits`; never synthesize prepare
artifacts or replace canonical `scripts/pr` with PR-controlled scripts. Record
unrelated main failures instead of adopting them into release scope.
