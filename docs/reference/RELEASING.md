---
doc-schema-version: 1
summary: "Release lanes, operator checklist, validation boxes, version naming, and cadence"
title: "Release policy"
read_when:
  - Looking for public release channel definitions
  - Running release validation or package acceptance
  - Looking for version naming and cadence
---

OpenClaw exposes four user-facing update channels:

- stable: the promoted regular release on npm `latest`
- extended-stable: the trailing completed month's `.33+` maintenance line on
  npm `extended-stable`
- beta: prerelease tags on npm `beta`
- dev: the moving head of `main`

Extended-stable ships the trailing month's Gateway, official npm plugins, and
Docker images without moving regular `latest` or `main` selectors.

Tideclaw alpha builds are a separate internal prerelease track (npm dist-tag `alpha`), covered under [NPM workflow inputs](#npm-workflow-inputs) and [Release test boxes](#release-test-boxes).

## Version naming

- Monthly Gateway extended-stable release version: `YYYY.M.PATCH`, with `PATCH >= 33`, git tag `vYYYY.M.PATCH`
- Daily/regular final release version: `YYYY.M.PATCH`, with `PATCH < 33`, git tag `vYYYY.M.PATCH`
- Regular fallback correction release version: `YYYY.M.PATCH-N`, git tag `vYYYY.M.PATCH-N`
- Beta prerelease version: `YYYY.M.PATCH-beta.N`, git tag `vYYYY.M.PATCH-beta.N`
- Alpha prerelease version: `YYYY.M.PATCH-alpha.N`, git tag `vYYYY.M.PATCH-alpha.N`
- Never zero-pad month or patch
- `PATCH` is a sequential monthly release-train number, not a calendar day. Regular final and beta releases advance the current train; alpha-only tags never consume or advance the beta/regular patch number, so ignore legacy alpha-only tags with higher patch numbers when selecting a beta or regular train.
- Alpha/nightly builds use the next unreleased patch train and increment only `alpha.N` for repeated builds. Once that patch has a beta, new alpha builds move to the following patch.
- npm versions are immutable: never delete, republish, or reuse a published tag. Cut the next prerelease number or the next monthly patch instead.
- `latest` continues to follow the current regular/daily npm line; `beta` is the current beta install target
- `extended-stable` means the supported trailing-month Gateway distribution, beginning at patch `33`; patch `34` and later are maintenance releases on that monthly line
- Regular final and regular correction releases publish to npm `beta` by default; release operators can target `latest` explicitly, or promote a vetted beta build later
- Gateway extended-stable publishes core, every npm-publishable official plugin,
  and its Docker images at one exact version; see the dedicated workflow below.
- Every regular final release includes the npm package, macOS app, signed standalone Android APK, and signed Windows Hub installers. macOS, iOS, and Android publication may finish in parallel after core publication; verify those native releases separately before announcing all platforms complete. Windows installer verification remains a core publication gate. Beta releases normally validate and publish the npm/package path first, with native app build/sign/notarize/promote reserved for regular final unless explicitly requested.

## Release cadence

- Releases move beta-first; stable follows only after the latest beta is validated
- Maintainers normally cut releases from a `release/YYYY.M.PATCH` branch created from current `main`, so release validation and fixes do not block new development on `main`
- If a beta tag has been pushed or published and needs a fix, maintainers cut the next `-beta.N` tag instead of deleting or recreating the old one
- Detailed release procedure, approvals, credentials, and recovery notes are maintainer-only

## Monthly Gateway extended-stable publication

For completed month `YYYY.M`, create `extended-stable/YYYY.M.33` and publish
`.33+` from that branch. Tag, branch, checkout, package version, preflight, and
validation must identify one commit. Before `.33`, protected `main` must contain
a later month's final version below patch `33`; later maintenance patches remain
eligible.

### Prepare and stabilize the candidate

Audit the unaudited mainline range, reconcile private security work, approve a
bounded backport set, and land one coordinated PR. Do not push the canonical
branch directly.

On the canonical branch, set `YYYY.M.P`, run `pnpm release:prep`, and require
that version in every publishable official plugin. From the approved ledger,
generate and commit a complete `## YYYY.M.P` section with `### Highlights`,
`### Changes`, and `### Fixes`, citing original merged `main` PRs for equivalent
backports. Preflight rejects a missing or empty section.

Carry the full current-main Docker release-channel unit: workflow, promoter,
policy, shared classifier, tests, and workflow validation. GitHub loads tag
workflows from the tagged commit; an incomplete copy can fail after building or
move regular aliases. Run focused checks.

Freeze the full branch-tip SHA. Before tagging, preflight its exact npm bytes
and run Full Release Validation against that SHA:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"

gh workflow run openclaw-npm-release.yml \
  --ref extended-stable/YYYY.M.33 \
  -f tag="$RELEASE_SHA" \
  -f preflight_only=true \
  -f npm_dist_tag=extended-stable

gh workflow run full-release-validation.yml \
  --ref extended-stable/YYYY.M.33 \
  -f ref=extended-stable/YYYY.M.33 \
  -f expected_sha="$RELEASE_SHA" \
  -f release_profile=stable
```

The SHA form is preflight-only. Run validation on the canonical branch; publish
binds its workflow ref, head/target SHA, run ID, and attempt. Save both IDs and
the successful `run_attempt`; reject `release-ci/*` evidence.

Classify failures before editing:

- Product: land another approved backport PR.
- Frozen-target tooling: backport only the smallest compatibility repair that
  tests the old product unchanged.
- Provider, approval, runner, or service: keep the candidate unchanged and use
  the bounded retry path.

Any branch change invalidates both gates. Once they pass, require the tip still
equals `RELEASE_SHA`, then push signed `vYYYY.M.P`. Later changes need the next
patch; never move or delete the tag. Tagging fixes the immutable release
identity; it does not publish Docker images.

### Publish the npm packages

Publish every npm-publishable official plugin from the same SHA and save the
successful run ID:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
gh workflow run plugin-npm-release.yml \
  --ref extended-stable/YYYY.M.33 \
  -f publish_scope=all-publishable \
  -f ref="$RELEASE_SHA" \
  -f npm_dist_tag=extended-stable
```

The workflow covers all `all-publishable` packages, including unchanged ones,
and verifies every exact version and selector. Reruns reuse published versions.

Then publish the prepared core tarball with all three saved run identities:

```bash
gh workflow run openclaw-npm-release.yml \
  --ref extended-stable/YYYY.M.33 \
  -f tag=vYYYY.M.P \
  -f preflight_only=false \
  -f npm_dist_tag=extended-stable \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f plugin_npm_run_id=<plugin-npm-run-id>
```

If the immutable candidate has already passed its saved preflight and Full
Release Validation but core publication needs a workflow-only recovery, dispatch
the trusted current-`main` workflow instead. Keep the same tag and evidence
identities; do not move the tag or republish plugins:

```bash
gh workflow run openclaw-npm-release.yml \
  --ref main \
  -f tag=vYYYY.M.P \
  -f preflight_only=false \
  -f npm_dist_tag=extended-stable \
  -f release_candidate_branch=extended-stable/YYYY.M.33 \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f plugin_npm_run_id=<plugin-npm-run-id>
```

This recovery path checks out and publishes the immutable tag and requires the
canonical branch implied by that tag. It accepts Full Release Validation
evidence from the canonical candidate branch directly, from current `main`
directly when its workflow SHA is reachable from current `main`, or from the
trusted main-pinned harness. Every accepted form must attest the immutable
tag's SHA. Use it only when the candidate source and recorded evidence are
unchanged.

For non-production rehearsal only, add
`-f bypass_extended_stable_guard=true` to preflight and publish. It bypasses the
month guard only, never canonical-ref, SHA/tag/version equality, provenance,
approval, or readback checks. Never use it for production.

### Verify and recover

From a separate clean current-`main` checkout, not the frozen branch, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P
npm view openclaw@YYYY.M.P version --userconfig "$(mktemp)"
npm view openclaw@extended-stable version --userconfig "$(mktemp)"
```

Require signatures and npm provenance for the canonical branch, plus publish,
preflight, and tarball-digest binding to the release SHA. Both commands must
return `YYYY.M.P`. Verify every prepared core package and `all-publishable`
official plugin at its exact version and selector.

If only the root selector fails, use the generated
`npm dist-tag add openclaw@YYYY.M.P extended-stable` repair command printed in
the workflow summary. Repair existing plugin or other prepared-core selectors
through approved credential-isolated tooling; the OIDC source cannot mutate
them. Never republish an immutable version.

Require `Docker Release` to verify exact default, slim, browser, and architecture
images in GHCR and Docker Hub, including attestations and platform versions. It
must advance only
`extended-stable`, `extended-stable-slim`, and `extended-stable-browser` by
digest; regular aliases remain unchanged and automatic rollback is rejected.

After that core registry readback succeeds, start Docker publication only through
`OpenClaw Release Publish`. Its Docker-only extended-stable path rechecks the
saved npm preflight artifact, exact `Full Release Validation` evidence, exact npm
version and `extended-stable` selector, and published tarball digest before it
calls the reusable `Docker Release` workflow. A tag push never publishes Docker
images by itself:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.P \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f npm_dist_tag=extended-stable \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

For alias repair, run approval-gated `Docker Channel Promotion` from current
`main` with the tag. It repeats digest, attestation, and platform checks, allows
an explicit rollback, and never rebuilds images.

Slack, Discord, and Codex are the initial documented support surfaces, not a
release allowlist: every npm-publishable official plugin ships. The regular
checklist alone owns beta/`latest`, GitHub Releases, ClawHub, native apps, mobile,
website, and private dist-tags; do not run those steps for this Gateway path.

## Regular release operator checklist

This checklist is the public shape of the release flow. Private credentials, signing, notarization, dist-tag recovery, and emergency rollback details stay in the maintainer-only release runbook.

1. Start from current `main`: pull latest, confirm the target commit is pushed, and confirm `main` CI is green enough to branch from.
2. Create `release/YYYY.M.PATCH` from that commit. Backports are optional; apply only the operator-selected set. Bump every required version location, run `pnpm release:prep`, finish release fixes and required forward-ports, and review `src/plugins/compat/registry.ts` plus `src/commands/doctor/shared/deprecation-compat.ts`.
3. Freeze the product-complete pre-changelog commit and target context as the **Code SHA/ref**, and record the trusted **Tooling SHA/ref**. Run the deterministic source preflight, then use `node scripts/full-release-validation-at-sha.mjs --sha <code-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha>`. Reuse those exact identities for later release validation; never refresh the tooling from moving `main`. Beta-publish uses `release_profile=beta` without soak; postpublish-confidence owns broad live, QA-live, mobile, and Parallels work.
4. Classify failures before editing as product, harness/tooling/provenance, infrastructure/credential, or wrapper. Only confirmed product failure creates a new Code SHA. Use one diagnosis, one fix when needed, and one narrow retry, then reassess.
5. Only after the Code SHA is green, generate the top `CHANGELOG.md` section from merged PRs and direct commits since the last reachable shipped tag. Keep entries user-facing and deduplicated. When a divergent shipped tag or later forward-port re-associates already-released PRs, pass it explicitly as `--shipped-ref`.
6. Commit only `CHANGELOG.md`. This commit is the **Release SHA**. The complete diff from Code SHA to Release SHA must be exactly `CHANGELOG.md`; any other changed path returns the release to step 2.
7. Run SHA-pinned Full Release Validation for the Release SHA with evidence reuse enabled. The lightweight parent must record `changelog-only-release-v1`, point at the green Code SHA, and dispatch no product child lanes. This reuses product evidence; it does not reuse package bytes.
8. Run `OpenClaw NPM Release` with `preflight_only=true` against the Release SHA/tag. Save the successful `preflight_run_id`. This builds and checks the exact package bytes that include the final changelog. Review its **Plugin SDK API diff** summary. If it reports changes, inspect the readable diff (also uploaded as `plugin-sdk-api-release-diff-<run-id>-<run-attempt>`) and record the 8-character acknowledgement digest printed by the report; omit the acknowledgement when it reports no Plugin SDK API changes.

   If the packaged changelog exceeds 500 KiB, packaging keeps every editorial note and replaces only the complete contribution record with a link to the full record in the exact release tag's `CHANGELOG.md`. The full source changelog and contributor credits remain unchanged after postpack restoration. Editorial notes must still satisfy the release-note minimum, and packaging fails if the compact result still exceeds the cap.

9. Run the candidate helper against the untagged Release SHA with the successful Release-SHA validation parent and npm preflight instead of dispatching either again:

   ```bash
   pnpm release:candidate -- \
     --tag vYYYY.M.PATCH-beta.N \
     --target-sha <release-sha> \
     --full-release-run <release-sha-validation-run-id> \
     --npm-preflight-run <preflight-run-id> \
     --plugin-sdk-api-acknowledgement <reviewed-8-character-digest> \
     --skip-dispatch
   ```

   Include `--plugin-sdk-api-acknowledgement` only when the preflight reported Plugin SDK API changes. For stable, also pass `--windows-node-tag vX.Y.Z`. Beta and alpha candidates defer Parallels install/update proof to the postpublish `pnpm release:beta-smoke` roster by default; pass `--run-parallels` only when the operator explicitly wants that proof before publish. Stable and full candidates run Parallels by default. The helper still verifies release-note provenance, npm preflight bytes, Telegram package proof, and plugin publish plans, then prints the publish command. After it completes green, create and push the final signed tag at that same Release SHA, then run the printed publish command.

   `pnpm release:candidate` validates the current frozen branch tip by default (or the explicit `--target-sha`), and rejects a tag that already exists. It records evidence before the final signed tag is pushed.

   `OpenClaw Release Publish` dispatches the selected or all-publishable plugin packages to npm and the same set to ClawHub in parallel, then promotes the prepared OpenClaw npm preflight artifact with the matching dist-tag once plugin npm publish succeeds. It keeps the GitHub release as a draft while it verifies registry readback, calls `Docker Release` with the immutable tag and Release SHA, and only then finalizes the GitHub release. The release checkout remains the product/data root, while planning and final verification execute from the exact trusted workflow-source checkout so an older release commit cannot silently use obsolete release tooling. Once publication binds the frozen Tooling SHA to an exact protected lightweight `release-publish/<12sha>-<provenance-run>` tag, that live tag-to-SHA mapping remains authoritative when `main` advances; the suffix records tag-creation provenance, not the current parent run id. Core and plugin npm publishers re-read that exact tag and revalidate the exact parent run tuple immediately before each npm publish or dist-tag mutation, failing closed on a missing, moved, annotated, or wrong-SHA tag, parent mismatch, or disallowed parent state. Other privileged writers require their dependent enforcement changes before the protected-tag publication route is globally complete. Before any publish child starts, it renders and caches the exact GitHub release body. When the complete matching `CHANGELOG.md` section fits GitHub's 125,000-character limit and the renderer's matching 125,000-byte safety ceiling, the page contains that exact `## YYYY.M.PATCH` section including its heading. When the source section does not fit, the page keeps the exact grouped editorial notes and replaces the oversized contribution record with a stable link to the full record in the tag-pinned `CHANGELOG.md`; partial records and truncated bullets are never published. The workflow chooses that full or compact body before adding `### Release verification`; if the proof tail would exceed the limit, it keeps the canonical body and relies on the immutable attached evidence instead. Stable releases published to npm `latest` become the GitHub latest release, while stable maintenance releases kept on npm `beta` are created with GitHub `latest=false`. The workflow also uploads the preflight dependency evidence, the full-validation manifest, and postpublish registry verification evidence to the GitHub release for post-release incident response. It prints child run IDs immediately, auto-approves release environment gates the workflow token is allowed to approve, summarizes failed child jobs with log tails, creates the draft GitHub release page up front, promotes Windows assets and dispatches Android publication concurrently with the OpenClaw npm publish, waits for ClawHub whenever OpenClaw npm is being published, then runs the trusted-main beta verifier and uploads postpublish evidence for the GitHub release, npm package, selected plugin npm packages, selected ClawHub packages, child workflow run IDs, and optional NPM Telegram run ID. The ClawHub bootstrap verifier requires the exact trusted-main workflow path and SHA, producer and terminal run attempts, release SHA, requested package set, immutable package artifact tuple, and terminal registry readback artifact; a successful legacy release-ref run is not accepted.

   Then run the post-publish package acceptance against the published `openclaw@YYYY.M.PATCH-beta.N` or `openclaw@beta` package. If a pushed or published prerelease needs a fix, cut the next matching prerelease number; never delete or rewrite the old one.

10. On a failed publish attempt, keep the Release SHA unchanged unless the failure proves a product or changelog defect. Resume successful immutable children and artifacts; never rebuild or republish a package version that already succeeded.
11. For stable, continue only after the vetted beta or release candidate has the required validation evidence. Stable npm publish also goes through `OpenClaw Release Publish`, reusing the successful preflight artifact via `preflight_run_id`. Stable macOS release readiness also requires the packaged `.zip`, `.dmg`, `.dSYM.zip`, and updated `appcast.xml` on `main`; the macOS publish workflow publishes the signed appcast to public `main` automatically after release assets verify, or opens/updates an appcast PR if branch protection blocks the direct push. Stable Windows Hub readiness requires the signed `OpenClawCompanion-Setup-x64.exe`, `OpenClawCompanion-Setup-arm64.exe`, and `OpenClawCompanion-SHA256SUMS.txt` assets on the OpenClaw GitHub release. Pass the exact signed `openclaw/openclaw-windows-node` release tag as `windows_node_tag` and its candidate-approved installer digest map as `windows_node_installer_digests`; `OpenClaw Release Publish` keeps the release draft, dispatches `Windows Node Release`, and verifies all three assets before publication.
12. After publish, run the npm post-publish verifier, optional standalone published-npm Telegram E2E when you need post-publish channel proof, dist-tag promotion when needed, verify the generated GitHub release page, run the release announcement steps, then complete [Stable main closeout](#stable-main-closeout) before calling a stable release finished.

## Stable main closeout

Stable publication is not complete until `main` carries the actual shipped release state.

1. Start from fresh latest `main`. Audit `release/YYYY.M.PATCH` against it and forward-port real fixes absent from `main`. Do not blindly merge release-only compatibility, test, or validation adapters into newer `main`.
2. For the normal path, set `main` to the shipped stable version. A late closeout may use `main` after it has advanced to a later stable OpenClaw CalVer; do not downgrade an already-started release train solely to close the prior release. The validator still requires the exact shipped changelog section and appcast entry and records the actual `main` version and SHA. Run `pnpm release:prep` after any root version change.
3. Make `CHANGELOG.md`'s `## YYYY.M.PATCH` section on `main` exactly match the tagged release branch. Include the stable `appcast.xml` update when the mac release published one.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:npm-lock:check`, and `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main` contains the shipped version and changelog before calling the stable release done.
6. Keep the repository variables `RELEASE_ROLLBACK_DRILL_ID` and `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.

`OpenClaw Stable Main Closeout` starts from the `main` push that carries the shipped version, changelog, and appcast after stable publication. It reads immutable postpublish evidence to bind the shipped tag to its Full Release Validation and Publish runs, then verifies the stable main state, release, mandatory stable soak, and blocking performance evidence. It attaches an immutable closeout manifest and checksum to the GitHub release. The automatic push trigger skips legacy releases that predate immutable postpublish evidence and never treats that skip as a completed closeout.

A complete closeout requires both assets and a matching checksum. A partial manifest replays its recorded `main` SHA and rollback drill to regenerate identical bytes, then attaches the missing checksum; an invalid pair, or a checksum without a manifest, stays blocking. A push-triggered run without rollback drill repository variables skips without completing closeout; a missing or more-than-90-day-old drill record still blocks manual evidence-backed closeout. Private recovery commands remain in the maintainer-only runbook. Use manual dispatch only to repair or replay an evidence-backed stable closeout.

If the Release Publish parent failed only after immutable npm/plugin evidence was attached, repair and publish every stable platform asset first. Then a maintainer may manually dispatch closeout with `allow_failed_publish_recovery=true`; that mode accepts only a completed failed parent and additionally requires the exact Android and Windows asset contracts, GitHub SHA-256 digests, checksum verification, Android provenance, and a successful parent-dispatched Windows promotion whose Authenticode checks and candidate-approved digests match the published installers, alongside the normal macOS/appcast checks. Automatic push closeout never enables this recovery mode.

A legacy fallback correction tag may reuse base-package evidence only when the correction tag resolves to the same source commit as the base stable tag. Its Android release reuses the base tag's verified APK and adds provenance for the correction tag. A correction with different source must publish and verify its own package evidence and use a higher Android `versionCode`.

## Release preflight

- Run `pnpm check:test-types` before release preflight so test TypeScript stays covered outside the faster local `pnpm check` gate.
- Run `pnpm check:architecture` before release preflight so the broader import cycle and architecture boundary checks are green outside the faster local gate.
- Run `pnpm build && pnpm ui:build` before `pnpm release:check` so the expected `dist/*` release artifacts and Control UI bundle exist for the pack validation step.
- Run `pnpm release:prep` after the root version bump and before tagging. It runs every deterministic release generator that commonly drifts after a version or config change: plugin versions, plugin inventory, base config schema, bundled channel config metadata, config docs baseline, plugin SDK exports, and Control UI locale bundles. It also blocks until native app translations and platform-generated locale resources match the source inventory; if they lag, wait for or dispatch `Native App Locale Refresh` before freezing the Code SHA. `pnpm release:check` re-runs those guards plus transient npm package-lock validation in check mode (including the strict locale gates plus the plugin SDK surface budget) and reports every failure in one pass before running package release checks. The npm preflight separately compares the exact release SHA with the prior published dist-tag and reports any Plugin SDK API changes.
- Plugin version sync updates the publishable `@openclaw/ai` runtime package, official plugin package versions, and existing `openclaw.compat.pluginApi` floors to the OpenClaw release version by default. Treat that field as the plugin SDK/runtime API floor, not just a copy of the package version: for plugin-only releases that intentionally remain compatible with older OpenClaw hosts, keep the floor at the oldest supported host API and document that choice in the plugin release proof.
- Run the manual `Full Release Validation` workflow before release approval to kick off all pre-release test boxes from one entrypoint. It accepts a branch, tag, or full commit SHA, dispatches manual `CI`, and dispatches `OpenClaw Release Checks` for install smoke, package acceptance, cross-OS package checks, QA Lab parity, Matrix, and Telegram lanes. Stable and full runs always include exhaustive live/E2E and Docker release-path soak; `run_release_soak=true` is retained for an explicit beta soak. Package Acceptance provides the canonical package Telegram E2E during candidate validation, avoiding a second concurrent live poller.

  Provide `release_package_spec` after publishing a beta to reuse the shipped npm package across release checks, Package Acceptance, and package Telegram E2E without rebuilding the release tarball. Provide `npm_telegram_package_spec` only when Telegram should use a different published package from the rest of release validation. Provide `package_acceptance_package_spec` when Package Acceptance should use a different published package from the release package spec. Provide `evidence_package_spec` when the release evidence report should prove that validation matches a published npm package without forcing Telegram E2E.

  ```bash
  TOOLING_SHA="<recorded-full-main-ancestor-sha>"
  node scripts/full-release-validation-at-sha.mjs \
    --sha <code-sha> \
    --target-ref release/YYYY.M.PATCH \
    --workflow-sha "$TOOLING_SHA"
  ```

- Run the manual `Package Acceptance` workflow when you want side-channel proof for a package candidate while release work continues. Use `source=npm` for `openclaw@beta`, `openclaw@latest`, or an exact release version; `source=ref` to pack a trusted `package_ref` branch/tag/SHA with the current `workflow_ref` harness; `source=url` for a public HTTPS tarball with a required SHA-256 and strict public URL policy; `source=trusted-url` for a named trusted-source policy using required `trusted_source_id` and SHA-256; or `source=artifact` for a tarball uploaded by another GitHub Actions run.

  The workflow resolves the candidate to `package-under-test`, reuses the Docker E2E release scheduler against that tarball, and can run Telegram QA against the same tarball with `telegram_mode=mock-openai` or `telegram_mode=live-frontier`. When the selected Docker lanes include `published-upgrade-survivor`, the package artifact is the candidate and `published_upgrade_survivor_baseline` selects the published baseline. `update-restart-auth` uses the candidate package as both the installed CLI and the package-under-test so it exercises the candidate update command's managed restart path.

  Example:

  ```bash
  gh workflow run package-acceptance.yml --ref main -f workflow_ref=main -f source=npm -f package_spec=openclaw@beta -f suite_profile=product -f published_upgrade_survivor_baseline=openclaw@2026.4.26 -f telegram_mode=mock-openai
  ```

  Common profiles:
  - `smoke`: install/channel/agent, gateway network, and config reload lanes
  - `package`: artifact-native package/update/restart/plugin lanes without OpenWebUI or live ClawHub
  - `product`: package profile plus MCP channels, cron/subagent cleanup, OpenAI web search, and OpenWebUI
  - `full`: Docker release-path chunks with OpenWebUI
  - `custom`: exact `docker_lanes` selection for a focused rerun

- Run the manual `CI` workflow directly when you only need deterministic normal CI coverage for the release candidate. Manual CI dispatches bypass changed scoping and force the Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, and Control UI i18n lanes. Standalone manual CI runs Android only when dispatched with `include_android=true`; `Full Release Validation` passes that input for its CI child.

  ```bash
  gh workflow run ci.yml --ref release/YYYY.M.PATCH -f include_android=true
  ```

- Run `pnpm qa:otel:smoke` when validating release telemetry. It exercises QA-lab through a local OTLP/HTTP receiver and verifies trace, metric, and log export plus bounded trace attributes and content/identifier redaction without requiring Opik, Langfuse, or another external collector.
- Run `pnpm qa:otel:collector-smoke` when validating collector compatibility. It routes the same QA-lab OTLP export through a real OpenTelemetry Collector Docker container before the local receiver assertions.
- Run `pnpm qa:prometheus:smoke` when validating protected Prometheus scraping. It exercises QA-lab, rejects unauthenticated scrapes, and verifies release-critical metric families stay free of prompt content, raw identifiers, auth tokens, and local paths.
- Run `pnpm qa:observability:smoke` for the source-checkout OpenTelemetry and Prometheus smoke lanes back to back.
- Run `pnpm release:check` before every tagged release.
- `OpenClaw NPM Release` preflight generates dependency release evidence before it packs the npm tarball. The npm advisory vulnerability gate is release-blocking. The transitive manifest risk, dependency ownership/install surface, and dependency change reports are release evidence only. The dependency change report compares the release candidate with the previous reachable release tag. The preflight uploads dependency evidence as `openclaw-release-dependency-evidence-<tag>` and also embeds it under `dependency-evidence/` inside the prepared npm preflight artifact. The real publish path reuses that preflight artifact, then attaches the same evidence to the GitHub release as `openclaw-<version>-dependency-evidence.zip`.
- Run `OpenClaw Release Publish` for the mutating publish sequence after the tag exists. Dispatch regular beta and stable publishes from trusted `main`; the release tag still selects the exact target commit and may point into `release/YYYY.M.PATCH`. Tideclaw alpha publishes remain on their matching alpha branch. Pass the successful OpenClaw npm `preflight_run_id`, successful `full_release_validation_run_id`, and exact `full_release_validation_run_attempt`, and keep the default plugin publish scope `all-publishable` unless you are deliberately running a focused repair. The workflow serializes plugin npm publish, plugin ClawHub publish, and OpenClaw npm publish so the core package is not published before its externalized plugins; Windows promotion and Android dispatch run concurrently with the core npm publish. Android approval, build, and publication are monitored separately and do not hold core publication; the child can attach its verified assets after the GitHub release becomes public. Publish reruns are resumable: an already-published core npm version skips the core dispatch after the workflow proves the registry tarball matches the tag's preflight artifact, and Windows/Android promotion is skipped when the release already carries the verified asset contract, so a retry only redoes the failed stages. Focused plugin-only repairs require `plugin_publish_scope=selected` and a nonempty plugin list. Plugin-only `all-publishable` runs require complete immutable preflight and Full Release Validation evidence; partial evidence is rejected.
- Stable `OpenClaw Release Publish` requires an exact `windows_node_tag` after the matching non-prerelease `openclaw/openclaw-windows-node` release exists, plus the candidate-approved `windows_node_installer_digests` map. Before dispatching any publish child, it verifies that source release is published, non-prerelease, contains the required x64/ARM64 installers, and still matches that approved map. It then dispatches `Windows Node Release` while the OpenClaw release is still a draft, carrying the pinned installer digest map unchanged. The child workflow downloads the signed Windows Hub installers from that exact tag, matches them against the pinned digests, verifies their Authenticode signatures use the expected OpenClaw Foundation signer on a Windows runner, writes a SHA-256 manifest, and uploads the installers plus manifest onto the canonical OpenClaw GitHub release, then re-downloads the promoted assets and verifies manifest membership and hashes. The parent verifies the current x64, ARM64, and checksum asset contract before publication. Direct recovery rejects unexpected `OpenClawCompanion-*` asset names before replacing the expected contract assets with the pinned source bytes.

  Manually dispatch `Windows Node Release` only for recovery, and always pass an exact tag, never `latest`, plus the explicit `expected_installer_digests` JSON map from the approved source release. Website download links should target exact OpenClaw release asset URLs for the current stable release, or `releases/latest/download/...` only after verifying GitHub's latest redirect points at that same release; do not link only to the companion repo release page.

- Release checks now run in a separate manual workflow: `OpenClaw Release Checks`. It always runs the QA Lab mock parity lane. The Matrix catalog and Telegram QA-live lanes run for stable/full validation, soak-enabled validation, or an explicit `qa`/`qa-live` rerun group. Bounded beta-publish `all` without soak defers those live lanes to postpublish-confidence. The live lanes use the `qa-live-shared` environment; Telegram also uses Convex CI credential leases.
- Cross-OS install and upgrade runtime validation is part of public `OpenClaw Release Checks` and `Full Release Validation`, which call the reusable workflow `.github/workflows/openclaw-cross-os-release-checks-reusable.yml` directly. This split is intentional: keep the real npm release path short, deterministic, and artifact-focused, while slower live checks stay in their own lane so they do not stall or block publish.
- Secret-bearing release checks should be dispatched through `Full Release Validation` or from the `main`/release workflow ref so workflow logic and secrets stay controlled.
- `OpenClaw Release Checks` accepts a branch, tag, or full commit SHA as long as the resolved commit is reachable from an OpenClaw branch or release tag.
- `OpenClaw NPM Release` validation-only preflight also accepts the current full 40-character workflow-branch commit SHA without requiring a pushed tag. That SHA path is validation-only and cannot be promoted into a real publish. In SHA mode the workflow synthesizes `v<package.json version>` only for the package metadata check; real publish still requires a real release tag.
- Both workflows keep the real publish and promotion path on GitHub-hosted runners, while the non-mutating validation path can use the larger Blacksmith Linux runners.
- That workflow runs `OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CACHE_TEST=1 pnpm test:live:cache` using both `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` workflow secrets.
- npm release preflight no longer waits on the separate release checks lane.
- Before tagging a release candidate locally, run `RELEASE_TAG=vYYYY.M.PATCH-beta.N pnpm release:fast-pretag-check`. The helper runs the fast release guardrails, plugin npm/ClawHub release checks, build, UI build, and `release:openclaw:npm:check` in the order that catches common approval-blocking mistakes before the GitHub publish workflow starts.
- Run `RELEASE_TAG=vYYYY.M.PATCH node --import tsx scripts/openclaw-npm-release-check.ts` (or the matching prerelease/correction tag) before approval.
- After npm publish, run `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.PATCH` (or the matching beta/correction version) to verify the published registry install path in a fresh temp prefix.
- After a beta publish, run `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC=openclaw@YYYY.M.PATCH-beta.N OPENCLAW_NPM_TELEGRAM_CREDENTIAL_ROLE=maintainer pnpm test:docker:npm-telegram-live` with `OPENCLAW_QA_CONVEX_SITE_URL` and `OPENCLAW_QA_CONVEX_SECRET_MAINTAINER` set. This verifies installed-package onboarding, Telegram setup, and real Telegram E2E against the published npm package using the shared Test Server userbot pool. CI uses the `ci` role and `OPENCLAW_QA_CONVEX_SECRET_CI` instead.
- To run the full post-publish beta smoke from a maintainer machine, use `pnpm release:beta-smoke -- --beta betaN`. The helper runs Parallels npm update/fresh-target validation, dispatches `NPM Telegram Beta E2E`, polls the exact workflow run, downloads the artifact, and prints the Telegram report.
- Maintainers can run the same post-publish check from GitHub Actions via the manual `NPM Telegram Beta E2E` workflow. It is intentionally manual-only and does not run on every merge.
- Maintainer release automation uses preflight-then-promote:
  - Real npm publish must pass a successful npm `preflight_run_id`.
  - Regular beta and stable publish orchestration and preflight use trusted `main` against the exact target tag. Tideclaw alpha publish and preflight use the matching alpha branch.
  - Stable npm releases default to `beta`; stable npm publish can target `latest` explicitly via workflow input.
  - Token-based npm dist-tag mutation lives in `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` because `npm dist-tag add` still needs `NPM_TOKEN` while the source repo keeps OIDC-only publish.
  - Public `macOS Release` is validation-only; when a tag lives only on a release branch but the workflow is dispatched from `main`, set `public_release_branch=release/YYYY.M.PATCH`.
  - Real macOS publish must pass successful macOS `preflight_run_id` and `validate_run_id`.
  - Real publish paths promote prepared artifacts instead of rebuilding them again.
- For stable correction releases like `YYYY.M.PATCH-N`, the post-publish verifier also checks the same temp-prefix upgrade path from `YYYY.M.PATCH` to `YYYY.M.PATCH-N` so release corrections cannot silently leave older global installs on the base stable payload.
- npm release preflight fails closed unless the tarball includes both `dist/control-ui/index.html` and a non-empty `dist/control-ui/assets/` payload, so we do not ship an empty browser dashboard again.
- Post-publish verification also checks that published plugin entrypoints and package metadata are present in the installed registry layout. A release that ships missing plugin runtime payloads fails the postpublish verifier and cannot be promoted to `latest`.
- `pnpm test:install:smoke` also enforces the npm pack `unpackedSize` budget on the candidate update tarball, so installer e2e catches accidental pack bloat before the release publish path.
- If the release work touched CI planning, extension timing manifests, or extension test matrices, regenerate and review the planner-owned `plugin-prerelease-extension-shard` matrix outputs from `.github/workflows/plugin-prerelease.yml` before approval so release notes do not describe a stale CI layout.
- Stable macOS release readiness also includes the updater surfaces: the GitHub release must end up with the packaged `.zip`, `.dmg`, and `.dSYM.zip`; `appcast.xml` on `main` must point at the new stable zip after publish (the macOS publish workflow commits it automatically, or opens an appcast PR when direct push is blocked); the packaged app must keep a non-debug bundle id, a non-empty Sparkle feed URL, and a `CFBundleVersion` at or above the canonical Sparkle build floor for that release version.

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

For a fresh Code SHA, the workflow resolves the target, dispatches manual `CI`, then dispatches `OpenClaw Release Checks`. Beta-publish maps to `release_profile=beta` and `run_release_soak=false`; its `all` run excludes broad live/E2E and QA-live lanes. Postpublish-confidence uses the exact published package with soak or explicit focused groups. Stable-publish maps to `release_profile=stable`. The final verifier summary includes slowest-job tables for each child run.

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

The product-performance child is artifact-only in this release path. The
umbrella dispatches it with `publish_reports=false`, and validation is rejected
unless its artifact-only guard proves that the Clawgrit report publisher stayed
skipped.

See [Full release validation](/reference/full-release-validation) for the complete stage matrix, exact workflow job names, stable versus full profile differences, artifacts, and focused rerun handles.

Child workflows are dispatched from the SHA-pinned trusted ref that runs `Full Release Validation`. Every child run must use the exact parent workflow SHA. Do not use raw `--ref main -f ref=<sha>` dispatches for release proof; use `pnpm ci:full-release --sha <target-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha>`.

Use `release_profile` to select live/provider breadth:

- `beta`: fastest release-critical OpenAI/core live and Docker path
- `stable`: beta plus stable provider/backend coverage for release approval
- `full`: stable plus broad advisory provider/media coverage

Stable and full validation always run the exhaustive live/E2E, Docker release-path, and bounded published upgrade-survivor sweep before promotion. Use `run_release_soak=true` to request that same sweep for a beta. That sweep covers the latest four stable packages plus pinned `2026.4.23` and `2026.5.2` baselines plus older `2026.4.15` coverage, with duplicate baselines removed and each baseline sharded into its own Docker runner job.

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

# After publishing a beta, add published-package Telegram E2E.
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
effective soak setting, and validation inputs match and either the target SHA
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

For bounded recovery, pass `rerun_group` to the umbrella. Supported controller groups are `ci`, `plugin-prerelease`, `install-smoke`, `cross-os`, `live-e2e`, `package`, `qa-parity`, `qa-live`, `npm-telegram`, and `performance`; use `all` only for deliberate full validation. The removed `release-checks` aggregate handle is invalid because it silently selected every release-check lane and its package/Docker setup. `qa` remains available only as a direct `OpenClaw Release Checks` manual aggregate, not as an umbrella/controller retry API. Focused `npm-telegram` reruns require `release_package_spec` or `npm_telegram_package_spec`; full/all runs use the canonical Package Acceptance Telegram E2E. Focused cross-OS reruns can add `cross_os_suite_filter=windows/packaged-upgrade` or another OS/suite filter. Live, QA-live, and cross-OS filters are valid only with their owning group; mismatches fail before scheduling and never become an unfiltered broad run. QA release-check failures block normal release validation, including OpenClaw dynamic tool drift in the core runtime-pair lane. Tideclaw alpha runs may still treat non-package-safety release-check lanes as advisory. With `release_profile=beta`, the `Run repo/live E2E validation` live-provider suites are advisory (warnings, not blockers); stable and full profiles keep them blocking. When `live_suite_filter` explicitly requests a gated QA live lane such as Discord, WhatsApp, or Slack, the matching `OPENCLAW_RELEASE_QA_*_LIVE_CI_ENABLED` repo variable must be enabled; otherwise input capture fails instead of silently skipping the lane.

### Vitest

The Vitest box is the manual `CI` child workflow. Manual CI intentionally bypasses changed scoping and forces the normal test graph for the release candidate: Linux Node shards, bundled-plugin shards, plugin and channel contract shards, Node 22 compatibility, `check-*`, `check-additional-*`, built-artifact smoke checks, docs checks, Python skills, Windows, macOS, and Control UI i18n. Android is included when `Full Release Validation` runs the box because the umbrella passes `include_android=true`; standalone manual CI requires `include_android=true` for Android coverage.

Use this box to answer "did the source tree pass the full normal test suite?" It is not the same as release-path product validation. Evidence to keep:

- `Full Release Validation` summary showing the dispatched `CI` run URL
- `CI` run green on the exact target SHA
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
- release-path Docker chunks: `core`, `package-update-openai`, `package-update-anthropic`, `package-update-core`, `plugins-runtime-plugins`, `plugins-runtime-services`, `plugins-runtime-install-a` through `plugins-runtime-install-h`, and `openwebui`
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

`OpenClaw Release Checks` runs Package Acceptance with `source=artifact`, the prepared release package artifact, `suite_profile=custom`, `docker_lanes=doctor-switch update-channel-switch skill-install update-corrupt-plugin upgrade-survivor published-upgrade-survivor root-managed-vps-upgrade update-restart-auth plugins-offline plugin-update plugin-binding-command-escape`, `telegram_mode=mock-openai`. Package Acceptance keeps migration, update, root-managed VPS upgrade, configured-auth update restart, live ClawHub skill install, stale plugin dependency cleanup, offline plugin fixtures, plugin update, plugin command-binding escape hardening, and Telegram package QA against the same resolved tarball. Blocking release checks use the default latest published package baseline; the beta profile with `run_release_soak=true`, `release_profile=stable`, or `release_profile=full` expands the published-upgrade-survivor sweep to `last-stable-4` plus the pinned `2026.4.23`, `2026.5.2`, and `2026.4.15` baselines with `reported-issues` scenarios. Use Package Acceptance with `source=npm` for an already shipped candidate, `source=ref` for a SHA-backed local npm tarball before publish, `source=trusted-url` for a maintainer-owned enterprise/private mirror, or `source=artifact` for a prepared tarball uploaded by another GitHub Actions run.

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

## Regular release publish automation

For beta, `latest`, plugin, GitHub Release, and platform publication,
`OpenClaw Release Publish` is the normal mutating entrypoint. The monthly
`.33+` Gateway extended-stable path does not use this orchestrator. The
regular workflow orchestrates the trusted-publisher workflows in the order the
release needs:

1. Check out the release tag and resolve its commit SHA.
2. Verify the tag is reachable from `main` or `release/*` (or a Tideclaw alpha branch for alpha prereleases).
3. Run `pnpm plugins:sync:check`.
4. Dispatch `Plugin NPM Release` with `publish_scope=all-publishable` and `ref=<release-sha>`.
5. Dispatch `Plugin ClawHub Release` with the same scope and SHA.
6. Dispatch `OpenClaw NPM Release` with the release tag, npm dist-tag, and saved `preflight_run_id` after verifying the saved `full_release_validation_run_id` and exact run attempt.
7. Verify the published npm package and selector readback, then call reusable `Docker Release` with the immutable tag and SHA. For stable releases, create or update the GitHub release as a draft, dispatch `Windows Node Release` with the explicit `windows_node_tag` and candidate-approved `windows_node_installer_digests`, and verify the canonical Windows installer/checksum assets. Also dispatch `Android Release` to build the exact-tag signed APK plus checksum and provenance. Finalize the GitHub release after Docker and the Windows asset contract succeed; Android completion is independent and does not hold the core release.

Android approval binds the release tag and target SHA to the approving parent's
run ID, exact attempt, full ref, and workflow SHA. The child verifies the attested
v2 receipt and the live parent identity, including the protected tooling tag or
main ancestry. Normal Android admission accepts an active or successfully completed
parent and the exact stable target release, whether draft or public. Failed or
cancelled parents remain rejected; explicit recovery can separately admit a
completed failed parent. Before provenance publication and each asset upload,
Android rechecks the live release tag target and stable classification, protected
tooling identity, and exact parent attempt/state. These are fresh boundary checks,
not an atomic GitHub validation-and-write transaction. A dispatched run link is
pending publication evidence, not an APK download claim. Monitor and approve the
linked Android run separately;
if dispatch cannot be confirmed, inspect existing runs before retrying.
For explicit Android recovery, pass `release_publish_run_attempt`,
`release_publish_full_ref`, and `release_publish_workflow_sha` from that same
parent alongside its run ID and ref; a rerun requires its own matching receipt.
Older immutable release tags retain their original Android workflow contract:
recover them with their matching frozen release tooling, rather than mixing a
new v2 producer with an older consumer.

Beta publish example:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

Include `plugin_sdk_api_acknowledgement` only when the npm preflight's Plugin SDK API report contains changes.

If a beta or regular stable package is already published but its container images are missing,
do not rerun npm or plugin publication. Reuse the immutable release tag plus its
successful npm preflight and Full Release Validation evidence through the
Docker-only recovery path. The workflow rechecks the exact npm version, the
selected npm dist-tag, and the published tarball digest before building containers:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f npm_dist_tag=beta \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

For regular stable recovery, use the same command with `tag=vYYYY.M.PATCH` and
`npm_dist_tag=latest`. Only regular stable tags (patches 1–32, including correction
suffixes) are accepted for `latest`; extended-stable recovery retains its own
selector. Recovery builds the canonical versioned images without republishing
npm packages or plugins, dispatching native releases, or finalizing the GitHub
release. Existing approval and provenance checks still apply.

Stable publish to the default beta dist-tag:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH \
  -f windows_node_tag=vX.Y.Z \
  -f windows_node_installer_digests='{"OpenClawCompanion-Setup-x64.exe":"sha256:<approved-x64-sha256>","OpenClawCompanion-Setup-arm64.exe":"sha256:<approved-arm64-sha256>"}' \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

Stable promotion directly to `latest` is explicit:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH \
  -f windows_node_tag=vX.Y.Z \
  -f windows_node_installer_digests='{"OpenClawCompanion-Setup-x64.exe":"sha256:<approved-x64-sha256>","OpenClawCompanion-Setup-arm64.exe":"sha256:<approved-arm64-sha256>"}' \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=latest
```

Use the lower-level `Plugin NPM Release` and `Plugin ClawHub Release` workflows only for focused repair or republish work. `OpenClaw Release Publish` rejects `plugin_publish_scope=selected` when `publish_openclaw_npm=true` so the core package cannot ship without every publishable official plugin, including `@openclaw/diffs-language-pack`. For a selected plugin repair, set `publish_openclaw_npm=false` with `plugin_publish_scope=selected` and `plugins=@openclaw/name`, or dispatch the child workflow directly.

First-publish ClawHub bootstrap is the exception: dispatch `Plugin ClawHub New`
from trusted `main` and pass the full target release SHA through `ref`.
Never run the bootstrap workflow itself from the release tag or branch:

```bash
gh workflow run plugin-clawhub-new.yml \
  --ref main \
  -f plugins=@openclaw/name \
  -f ref=<full-40-character-release-sha> \
  -f pretag_validation=true \
  -f dry_run=true
```

Pre-tag validation requires `dry_run=true`, rejects release-tag and parent-run
inputs, and accepts only an exact target reachable from `main` or `release/*`.
It does not load ClawHub credentials, publish package bytes, or change trusted
publisher configuration. The workflow still resolves the live registry plan,
checks out and packs the target only in a secretless job, materializes the
locked ClawHub toolchain, and validates the immutable artifact and package
slug/identity before the release tag exists. Approve the
`clawhub-plugin-bootstrap` environment only after the secretless pack jobs
finish; this protected validation job has no credentials or mutation commands.

An approved dry run or real bootstrap after tagging must include the exact
release tag plus the parent `OpenClaw Release Publish` run id, attempt, and
branch. The parent attests its own workflow SHA and a separate exact trusted
`main` SHA for `Plugin ClawHub New`; the child run and every protected
environment approval must match that approved child SHA. The release tag is
rechecked before every publish attempt and trusted-publisher mutation.

The pack job
uploads one immutable artifact whose name, Actions artifact ID/digest,
producer run/attempt, target SHA, and per-package tarball SHA-256/size are
carried into the validation and protected jobs. The protected job checks out trusted `main`
tooling only, validates the artifact tuple through the GitHub API, downloads
by exact artifact ID, rehashes every tarball, and validates local TAR paths and
package identity with the pinned CLI's USTAR canonicalization rules. Every
candidate then passes the pinned CLI publish dry-run, which returns before
registry lookup or auth. The credential-job prefilter caps compressed ClawPacks
at 120 MiB, total file payload at 50 MiB, expanded TAR data at 64 MiB, and
TAR entry count at 10,000. Existing-package trusted-publisher repair remains
configure-only, but it still packs the target and requires the requested tag
plus exact registry byte and metadata equality before changing trusted-publisher
configuration. Post-publish verification downloads the ClawHub artifact and
requires the same SHA-256 and size. A rerun-failed recovery may reuse an earlier
attempt's package artifact only when the exact producer job completed
successfully. Final evidence also binds the locked ClawHub version, lock
SHA-256, and npm integrity. A mismatch requires a new package version.

## NPM workflow inputs

`OpenClaw NPM Release` accepts these operator-controlled inputs:

- `tag`: required release tag such as `v2026.4.2`, `v2026.4.2-1`, `v2026.4.2-beta.1`, or `v2026.4.2-alpha.1`; when `preflight_only=true`, it may also be the current full 40-character workflow-branch commit SHA for validation-only preflight
- `preflight_only`: `true` for validation/build/package only, `false` for the real publish path
- `preflight_run_id`: existing successful preflight run id, required on the real publish path so the workflow reuses the prepared tarball instead of rebuilding it
- `full_release_validation_run_id`: successful `Full Release Validation` run id for this tag/SHA, required for real publish. Beta publishes may proceed on preflight alone with a warning, but stable/`latest` promotion still requires it.
- `full_release_validation_run_attempt`: exact positive run attempt paired with `full_release_validation_run_id`; required whenever the run id is provided so reruns cannot change the authorization evidence during publish.
- `release_publish_run_id`: approved `OpenClaw Release Publish` run id; required when this workflow is dispatched by that parent (bot-actor real-publish calls)
- `plugin_npm_run_id`: successful exact-head `Plugin NPM Release` run id; required for a real `extended-stable` core publish
- `npm_dist_tag`: npm target tag for the publish path; accepts `alpha`, `beta`, `latest`, or `extended-stable` and defaults to `beta`. Final patch `33` and later must use `extended-stable`; by default, `extended-stable` rejects earlier patches, and it always rejects non-final tags.
- `bypass_extended_stable_guard`: testing-only boolean, default `false`; with `npm_dist_tag=extended-stable`, bypasses monthly extended-stable eligibility while preserving release identity, artifact, approval, and readback checks.

`Plugin NPM Release` accepts `npm_dist_tag=default` for existing release
behavior or `npm_dist_tag=extended-stable` for the guarded monthly path. The
extended-stable option requires `publish_scope=all-publishable`, an empty
`plugins` input, a final patch at or above `33`, and the canonical
`extended-stable/YYYY.M.33` branch at its exact tip. It never moves plugin
`latest` or `beta`. New package versions receive `extended-stable` atomically
through OIDC trusted publication (`npm publish --tag extended-stable`); this
source workflow does not use token-authenticated `npm dist-tag add`. Retries
skip exact versions already present in npm, then fail closed unless complete
readback confirms that every exact package and `extended-stable` tag converged.

`OpenClaw Release Publish` accepts these operator-controlled inputs:

- `tag`: required release tag; must already exist
- `preflight_run_id`: successful `OpenClaw NPM Release` preflight run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_id`: successful `Full Release Validation` run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_attempt`: exact positive attempt paired with `full_release_validation_run_id`; required whenever the run id is provided
- `windows_node_tag`: exact non-prerelease `openclaw/openclaw-windows-node` release tag; required for stable OpenClaw publish
- `windows_node_installer_digests`: candidate-approved compact JSON map of the current Windows installer names to their pinned `sha256:` digests; required for stable OpenClaw publish
- `npm_telegram_run_id`: optional successful `NPM Telegram Beta E2E` run id to include in final release evidence
- `npm_dist_tag`: npm target tag for the OpenClaw package, one of `alpha`, `beta`, `latest`, or `extended-stable`
- `publish_docker_only`: beta, regular stable (`latest`), or extended-stable recovery/closeout path. It requires `publish_openclaw_npm=false`, complete preflight and Full Release Validation evidence, then verifies the exact npm package, selected dist-tag, and tarball digest before invoking Docker publication.
- `plugin_publish_scope`: defaults to `all-publishable`; use `selected` only for focused plugin-only repair work with `publish_openclaw_npm=false`
- `plugins`: comma-separated `@openclaw/*` package names when `plugin_publish_scope=selected`
- `publish_openclaw_npm`: defaults to `true`; set `false` only when using the workflow as a plugin-only repair orchestrator
- `release_profile`: release coverage profile used for release evidence summaries; defaults to `from-validation`, which reads it from the validation manifest, or override with `beta`, `stable`, or `full`
- `wait_for_clawhub`: defaults to `false` so npm availability is not blocked by the ClawHub sidecar; set `true` only when workflow completion must include ClawHub completion

`OpenClaw Release Checks` accepts these operator-controlled inputs:

- `ref`: branch, tag, or full commit SHA to validate. Secret-bearing checks require the resolved commit to be reachable from an OpenClaw branch or release tag.
- `run_release_soak`: opt into exhaustive live/E2E, Docker release-path, and all-since upgrade-survivor soak for beta release checks. It is forced on by `release_profile=stable` and `release_profile=full`.

Rules:

- Regular final and correction versions below patch `33` may publish to either `beta` or `latest`. Final versions at patch `33` or above must publish to `extended-stable`, and correction-suffix versions at that boundary are rejected.
- Beta prerelease tags may publish only to `beta`; alpha prerelease tags may publish only to `alpha`
- For `OpenClaw NPM Release`, full commit SHA input is allowed only when `preflight_only=true`
- `OpenClaw Release Checks` and `Full Release Validation` are always validation-only
- The real publish path must use the same `npm_dist_tag` used during preflight; the workflow verifies that metadata before publish continues

## Regular beta/latest stable release sequence

This legacy sequence is for the regular orchestrated release that also owns plugins, GitHub Release, Windows, and other platform work. It is not the monthly `.33+` Gateway extended-stable path documented at the top of this page.

When cutting a regular orchestrated stable release:

1. Run `OpenClaw NPM Release` with `preflight_only=true`. Before a tag exists, you may use the current full workflow-branch commit SHA for a validation-only dry run of the preflight workflow.
2. Choose `npm_dist_tag=beta` for the normal beta-first flow, or `latest` only when you intentionally want a direct stable publish.
3. Run `Full Release Validation` on the release branch, release tag, or full commit SHA when you want normal CI plus live prompt cache, Docker, QA Lab, Matrix, and Telegram coverage from one manual workflow. If you intentionally only need the deterministic normal test graph, run the manual `CI` workflow on the release ref instead.
4. Select the exact non-prerelease `openclaw/openclaw-windows-node` release tag whose signed x64 and ARM64 installers should ship. Save it as `windows_node_tag`, and save their validated digest map as `windows_node_installer_digests`. The release-candidate helper records both and includes them in its generated publish command.
5. Save the successful `preflight_run_id`, `full_release_validation_run_id`, and exact `full_release_validation_run_attempt`.
6. Run `OpenClaw Release Publish` from trusted `main` with the same `tag`, the same `npm_dist_tag`, the selected `windows_node_tag`, its saved `windows_node_installer_digests`, the saved `preflight_run_id`, `full_release_validation_run_id`, and `full_release_validation_run_attempt`. It publishes externalized plugins to npm and ClawHub before promoting the OpenClaw npm package.
7. If the release landed on `beta`, use the `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow to promote that stable version from `beta` to `latest`.
8. If the release intentionally published directly to `latest` and `beta` should follow the same stable build immediately, use that same release workflow to point both dist-tags at the stable version, or let its scheduled self-healing sync move `beta` later.

The dist-tag mutation lives in the release ledger repo because it still requires `NPM_TOKEN`, while the source repo keeps OIDC-only publish. That keeps the direct publish path and the beta-first promotion path both documented and operator-visible.

If a maintainer must fall back to local npm authentication, run any 1Password CLI (`op`) commands only inside a dedicated tmux session. Do not call `op` directly from the main agent shell; keeping it inside tmux makes prompts, alerts, and OTP handling observable and prevents repeated host alerts.

## Public references

- [`.github/workflows/full-release-validation.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/full-release-validation.yml)
- [`.github/workflows/package-acceptance.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/package-acceptance.yml)
- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`.github/workflows/openclaw-release-checks.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-release-checks.yml)
- [`.github/workflows/openclaw-cross-os-release-checks-reusable.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-cross-os-release-checks-reusable.yml)
- [`.github/workflows/docker-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/docker-release.yml)
- [`scripts/resolve-openclaw-package-candidate.mts`](https://github.com/openclaw/openclaw/blob/main/scripts/resolve-openclaw-package-candidate.mts)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)

Maintainers use the private release docs in [`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md) for the actual runbook.

## Related

- [Release channels](/install/development-channels)
