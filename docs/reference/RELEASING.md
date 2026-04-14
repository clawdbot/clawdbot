---
title: "Release Policy"
summary: "Public release channels, version naming, and cadence"
read_when:
  - Looking for public release channel definitions
  - Looking for version naming and cadence
---

# Release Policy

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
- Every OpenClaw release ships the npm package and macOS app together

## Release cadence

- Releases move beta-first
- Stable follows only after the latest beta is validated
- Detailed release procedure, approvals, credentials, and recovery notes are
  maintainer-only

## Release preflight

- Run `pnpm build && pnpm ui:build` before `pnpm release:check` so the expected
  `dist/*` release artifacts and Control UI bundle exist for the pack
  validation step
- Run `pnpm release:check` before every tagged release
- Release checks now run in a separate manual workflow:
  `OpenClaw Release Checks`
- This split is intentional: keep the real npm release path short,
  deterministic, and artifact-focused, while slower live checks stay in their
  own lane so they do not stall or block publish
- Release checks must be dispatched from the `main` workflow ref so the
  workflow logic and secrets stay canonical
- That workflow accepts either an existing release tag or the current full
  40-character `main` commit SHA
- In commit-SHA mode it only accepts the current `origin/main` HEAD; use a
  release tag for older release commits
- `OpenClaw NPM Release` validation-only preflight also accepts the current
  full 40-character `main` commit SHA without requiring a pushed tag
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
- Maintainer release automation now uses preflight-then-promote:
  - real npm publish must pass a successful npm `preflight_run_id`
  - stable npm releases default to `beta`
  - stable npm publish can target `latest` explicitly via workflow input
  - stable npm promotion from `beta` to `latest` is still available as an explicit manual mode on the trusted `OpenClaw NPM Release` workflow
  - direct stable publishes can also run an explicit dist-tag sync mode that
    points both `latest` and `beta` at the already-published stable version
  - those dist-tag modes still need a valid `NPM_TOKEN` in the `npm-release` environment because npm `dist-tag` management is separate from trusted publishing
  - public `macOS Release` is validation-only
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
- If the release work touched CI planning, extension timing manifests, or
  extension test matrices, regenerate and review the planner-owned
  `checks-node-extensions` workflow matrix outputs from `.github/workflows/ci.yml`
  before approval so release notes do not describe a stale CI layout
- Stable macOS release readiness also includes the updater surfaces:
  - the GitHub release must end up with the packaged `.zip`, `.dmg`, and `.dSYM.zip`
  - `appcast.xml` on `main` must point at the new stable zip after publish
  - the packaged app must keep a non-debug bundle id, a non-empty Sparkle feed
    URL, and a `CFBundleVersion` at or above the canonical Sparkle build floor
    for that release version

## NPM workflow inputs

`OpenClaw NPM Release` accepts these operator-controlled inputs:

- `tag`: required release tag such as `v2026.4.2`, `v2026.4.2-1`, or
  `v2026.4.2-beta.1`; when `preflight_only=true`, it may also be the current
  full 40-character `main` commit SHA for validation-only preflight
- `preflight_only`: `true` for validation/build/package only, `false` for the
  real publish path
- `preflight_run_id`: required on the real publish path so the workflow reuses
  the prepared tarball from the successful preflight run
- `npm_dist_tag`: npm target tag for the publish path; defaults to `beta`
- `promote_beta_to_latest`: `true` to skip publish and move an already-published
  stable `beta` build onto `latest`
- `sync_stable_dist_tags`: `true` to skip publish and point both `latest` and
  `beta` at an already-published stable version

`OpenClaw Release Checks` accepts these operator-controlled inputs:

- `ref`: existing release tag or the current full 40-character `main` commit
  SHA to validate

Rules:

- Stable and correction tags may publish to either `beta` or `latest`
- Beta prerelease tags may publish only to `beta`
- Full commit SHA input is allowed only when `preflight_only=true`
- Release checks commit-SHA mode also requires the current `origin/main` HEAD
- The real publish path must use the same `npm_dist_tag` used during preflight;
  the workflow verifies that metadata before publish continues
- Promotion mode must use a stable or correction tag, `preflight_only=false`,
  an empty `preflight_run_id`, and `npm_dist_tag=beta`
- Dist-tag sync mode must use a stable or correction tag,
  `preflight_only=false`, an empty `preflight_run_id`, `npm_dist_tag=latest`,
  and `promote_beta_to_latest=false`
- Promotion and dist-tag sync modes also require a valid `NPM_TOKEN` because
  `npm dist-tag add` still needs regular npm auth; trusted publishing covers
  the package publish path only

## Stable npm release sequence

When cutting a stable npm release:

1. Run `OpenClaw NPM Release` with `preflight_only=true`
   - Before a tag exists, you may use the current full `main` commit SHA for a
     validation-only dry run of the preflight workflow
2. Choose `npm_dist_tag=beta` for the normal beta-first flow, or `latest` only
   when you intentionally want a direct stable publish
3. Run `OpenClaw Release Checks` separately with the same tag or the
   full current `main` commit SHA when you want live prompt cache coverage
   - This is separate on purpose so live coverage stays available without
     recoupling long-running or flaky checks to the publish workflow
4. Save the successful `preflight_run_id`
5. Run `OpenClaw NPM Release` again with `preflight_only=false`, the same
   `tag`, the same `npm_dist_tag`, and the saved `preflight_run_id`
6. If the release landed on `beta`, run `OpenClaw NPM Release` later with the
   same stable `tag`, `promote_beta_to_latest=true`, `preflight_only=false`,
   `preflight_run_id` empty, and `npm_dist_tag=beta` when you want to move that
   published build to `latest`
7. If the release intentionally published directly to `latest` and `beta`
   should follow the same stable build, run `OpenClaw NPM Release` with the same
   stable `tag`, `sync_stable_dist_tags=true`, `promote_beta_to_latest=false`,
   `preflight_only=false`, `preflight_run_id` empty, and `npm_dist_tag=latest`

The promotion and dist-tag sync modes still require the `npm-release`
environment approval and a valid `NPM_TOKEN` accessible to that workflow run.

That keeps the direct publish path and the beta-first promotion path both
documented and operator-visible.

## Public references

- [`.github/workflows/openclaw-npm-release.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-npm-release.yml)
- [`.github/workflows/openclaw-release-checks.yml`](https://github.com/openclaw/openclaw/blob/main/.github/workflows/openclaw-release-checks.yml)
- [`scripts/openclaw-npm-release-check.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/openclaw-npm-release-check.ts)
- [`scripts/package-mac-dist.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-dist.sh)
- [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)

Maintainers use the private release docs in
[`openclaw/maintainers/release/README.md`](https://github.com/openclaw/maintainers/blob/main/release/README.md)
for the actual runbook.
