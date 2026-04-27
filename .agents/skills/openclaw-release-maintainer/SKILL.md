---
name: openclaw-release-maintainer
description: Prepare or verify OpenClaw stable/beta releases, changelogs, release notes, publish commands, and artifacts.
---

# OpenClaw Release Maintainer

Use this skill for release and publish-time workflow. Keep ordinary development changes and GHSA-specific advisory work outside this skill.

## Respect release guardrails

- Do not change version numbers without explicit operator approval.
- Ask permission before any npm publish or release step.
- This skill should be sufficient to drive the normal release flow end-to-end.
- Use the private maintainer release docs for credentials, recovery steps, and mac signing/notary specifics, and use `docs/reference/RELEASING.md` for public policy.
- Core `openclaw` publish is manual `workflow_dispatch`; creating or pushing a tag does not publish by itself.
- Normal release work happens on a branch cut from `main`, not directly on
  `main`. Use `release/YYYY.M.D` for the branch name.
- If the operator asks for a release without saying stable/full, default to
  beta only. Continue from beta to stable only when the operator explicitly asks
  for the full release or an automated beta-and-stable train.
- Before release branching, pull latest `main` and confirm current `main` CI is
  green. Then branch from that commit so regular development can continue on
  `main` while release validation runs.
- Before release branching, commit any dirty files in coherent groups, push,
  pull/rebase, then run `/changelog` on `main` and commit/push/pull that
  changelog rewrite immediately before creating the release branch.
- During release planning, inspect both `src/plugins/compat/registry.ts` and
  `src/commands/doctor/shared/deprecation-compat.ts` before branching and again
  before final publish. For every deprecated or removal-pending compatibility
  record whose `removeAfter` date is on or before the release date, either
  remove the compatibility path where safe and validate the affected tests, or
  write down why removal is blocked and get explicit maintainer approval before
  shipping the expired compatibility path.
- When removing deprecated runtime/config compatibility, preserve any doctor
  migration, repair, or hint that is still needed by supported upgrade paths.
  Doctor-side compatibility should stay tracked in
  `src/commands/doctor/shared/deprecation-compat.ts` until maintainers confirm
  the repair is no longer needed.
- Revalidate compatibility replacement text during release planning. The
  recommended replacement can shift as plugin ownership, externalization, and
  config footprint move, so do not blindly copy stale replacement annotations
  into release notes.
- Do not delete or rewrite beta tags after they leave the machine. If a
  published or pushed beta needs a fix, commit the fix on the release branch and
  increment to the next `-beta.N`.
- For a beta release train, run the fast local preflight first, publish the
  beta to npm `beta`, then run the expensive published-package roster focused
  on install/update/Docker/Parallels/NPM Telegram. If anything fails, fix it on
  the release branch, commit/push/pull, increment beta number, and repeat. Run
  the full expensive roster at least once before stable/latest promotion; for
  later beta attempts, rerun only lanes whose evidence changed unless the fix
  touches broad release, install/update, plugin, Docker, Parallels, or live QA
  behavior. After each beta is published, scan current `main` once for critical
  fixes that landed after the release branch cut and backport only important
  low-risk fixes. Operators may authorize up to 4 autonomous beta attempts;
  after 4 failed beta attempts, stop and report.
- Use `/changelog` before version/tag preparation so the top changelog section
  is deduped and ordered by user impact.
- Do not create beta-specific `CHANGELOG.md` headings. Beta releases use the
  stable base version section, for example `v2026.4.20-beta.1` uses
  `## 2026.4.20` release notes.
- When any beta or stable release is live, make a best-effort Discord
  announcement using Peter's bot token from `.profile`; do not block or roll
  back the release if the announcement fails.
- When asked to announce on X, use `~/Projects/bird/bird` and follow the
  release tweet style below.

## Keep release channel naming aligned

- `stable`: tagged releases only, published to npm `beta` by default; operators may target npm `latest` explicitly or promote later
- `beta`: prerelease tags like `vYYYY.M.D-beta.N`, with npm dist-tag `beta`
- Prefer `-beta.N`; do not mint new `-1` or `-2` beta suffixes
- `dev`: moving head on `main`
- When using a beta Git tag, publish npm with the matching beta version suffix so the plain version is not consumed or blocked

## Handle versions and release files consistently

- Version locations include:
  - `package.json`
  - `apps/android/app/build.gradle.kts`
  - `apps/ios/Sources/Info.plist`
  - `apps/ios/Tests/Info.plist`
  - `apps/macos/Sources/OpenClaw/Resources/Info.plist`
  - `docs/install/updating.md`
  - Peekaboo Xcode project and plist version fields
- Before creating a release tag, make every version location above match the version encoded by that tag.
- For fallback correction tags like `vYYYY.M.D-N`, the repo version locations still stay at `YYYY.M.D`.
- “Bump version everywhere” means all version locations above except `appcast.xml`.
- Release signing and notary credentials live outside the repo in the private maintainer docs.
- Every stable OpenClaw release ships the npm package and macOS app together.
  Beta releases normally ship npm/package artifacts first and skip mac app
  build/sign/notarize unless the operator requests mac beta validation.
- Do not let the slower macOS signing/notary path block npm publication once
  the npm preflight has passed. Keep mac validation/publish running in
  parallel, publish npm from the successful npm preflight, then start published
  npm install/update, Docker, and Parallels verification while mac artifacts
  continue.
- After a beta is published, overlap remote/manual release rosters where useful,
  but avoid piling local Docker, Parallels, and QA-Lab work onto the same host
  when it would create system-load noise. Use selective reruns after failures or
  fixes, but keep proof that Docker, Parallels, and QA-Lab each passed at least
  once before stable/latest promotion.
- Mac packaging may be built from a slight release-branch variation of the
  tagged commit when the delta is mac packaging, signing, workflow, or
  validation-only release machinery. If mac packaging needs release-branch-only
  fixes after the stable npm package or GitHub tag is already published, do not
  create a `vYYYY.M.D-N` correction tag just to change the workflow source.
  Dispatch the private mac workflows for the original `tag=vYYYY.M.D` with
  `source_ref=release/YYYY.M.D` and `public_release_branch=release/YYYY.M.D`;
  provenance checks must prove the source SHA descends from the tag and
  validation/preflight use the same source. Reserve `vYYYY.M.D-N` correction
  tags for emergency hotfixes that must publish a new npm package/release
  identity, not for ordinary mac-only packaging recovery.
- The production Sparkle feed lives at `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`, and the canonical published file is `appcast.xml` on `main` in the `openclaw` repo.
- That shared production Sparkle feed is stable-only. Beta mac releases may
  upload assets to the GitHub prerelease, but they must not replace the shared
  `appcast.xml` unless a separate beta feed exists.
- For fallback correction tags like `vYYYY.M.D-N`, the repo version still stays
  at `YYYY.M.D`, but the mac release must use a strictly higher numeric
  `APP_BUILD` / Sparkle build than the original release so existing installs
  see it as newer.

## Build changelog-backed release notes

- Before release branching or tagging, rewrite the target `CHANGELOG.md`
  section from commit history, not just from existing notes: scan commits since
  the last reachable release tag, add missed user-facing changes, dedupe
  overlapping entries, and sort each section from most to least interesting for
  users.
- Changelog entries should be user-facing, not internal release-process notes.
- GitHub release and prerelease bodies must use the full matching
  `CHANGELOG.md` version section, not highlights or an excerpt. When creating
  or editing a release, extract from `## YYYY.M.D` through the line before the
  next level-2 heading and use that complete block as the release notes.
- When preparing release notes, scan `src/plugins/compat/registry.ts` and
  `src/commands/doctor/shared/deprecation-compat.ts` for compatibility records
  with `warningStarts` or `removeAfter` within 7 days after the release date.
  Add an `Upcoming deprecations` note to the release notes when any exist,
  including the compatibility code, target date, replacement, and a link to the
  record's `docsPath` or `/plugins/compatibility` when no more specific
  deprecation page exists.
- When cutting a mac release with a beta GitHub prerelease:
  - tag `vYYYY.M.D-beta.N` from the release commit
  - create a prerelease titled `openclaw YYYY.M.D-beta.N`
  - use release notes from the stable base `CHANGELOG.md` version section
    (`## YYYY.M.D`), not a beta-specific heading
  - attach at least the zip and dSYM zip, plus dmg if available
- Keep the top version entries in `CHANGELOG.md` sorted by impact:
  - `### Changes` first
  - `### Fixes` deduped with user-facing fixes first

## Write release tweets

Use the OpenClaw account's existing release-post style:

- Format: `OpenClaw YYYY.M.D 🦞` or `🦞 OpenClaw YYYY.M.D is live`, blank line,
  then 3-4 emoji-led bullets, blank line, one short punchline, then the release
  link.
- For beta: say `OpenClaw YYYY.M.D-beta.N 🦞` or `OpenClaw YYYY.M.D beta N is
live`; keep it clearly beta and avoid implying stable promotion.
- Lead with user-visible capabilities, then important integrations, then
  reliability/security/install fixes. Compress "lots of fixes" into one
  readable bullet.
- Read the full changelog section before drafting. Do not lead with coverage,
  CI, validation, or internal release mechanics unless the release is explicitly
  about those. Peter prefers concrete user wins: features, integrations,
  workflow improvements, and practical reliability fixes.
- Tone: high-signal, slightly cheeky, confident, not corporate. One joke is
  enough. Avoid punching down, insulting users, or promising what was not
  verified.
- Peter likes dry, compact taglines when they feel earned. Good example:
  `Big release, tiny release notes... kidding.` Keep the joke short and let the
  feature bullets carry the tweet; do not turn the punchline into a second
  paragraph or a forced bit.
- Length: release tweets are always standard tweets under 280 characters, with
  room for one URL. Trim to 3-4 bullets and count the final text before posting.
- Links/media: include the GitHub release or changelog link at the end of the
  first release tweet.
- Thread follow-ups: if doing a thread, keep the first release tweet as the
  compact launch post, then publish one focused feature explainer per reply.
  Follow-up replies should not repeat "new in VERSION" or the version number
  when the thread context already makes it obvious.
- Every follow-up tweet should include a docs URL for that specific feature.
  Prefer a bare URL over `Docs: <url>` unless the label is needed for clarity.
  Keep follow-ups concise: around 160-220 raw characters is usually the sweet
  spot; under 280 is the hard cap. If a URL makes a tweet fail, trim prose
  before dropping the URL.
  Prefer explaining diagnostics, trajectory/export, provider setup, model
  commands, or other setup-heavy features in follow-ups instead of overloading
  the first release tweet.
- Hotfix/correction: be direct and accountable. State what slipped, what is
  fixed, and the new version. Keep jokes out of incident-style posts.

Examples to adapt:

```text
OpenClaw 2026.4.20-beta.1 🦞

🐳 Docker install/update smoke
🖥️ Parallels upgrade checks
🔧 Package verification tightened

Beta first. Stable after the gauntlet.
<release link>
```

```text
OpenClaw 2026.4.20 🦞

🚀 Faster install + update
🐳 Docker + Parallels verified
🍎 macOS signed + notarized
🔧 Channel/plugin fixes

Good boring release. Best kind.
<release link>
```

```text
Packaging issue in 2026.4.20-beta.1.

2026.4.20-beta.2 fixes install/update verification. No tag rewrites; beta moves
forward.

Upgrade with the beta channel.
<release link>
```

## Run publish-time validation

Before tagging or publishing, run:

```bash
pnpm check:architecture
pnpm build
pnpm ui:build
pnpm qa:otel:smoke
pnpm release:check
pnpm test:install:smoke
```

- Use `pnpm qa:otel:smoke` when release validation needs telemetry coverage.
  It starts a local OTLP/HTTP trace receiver, runs QA-lab's
  `otel-trace-smoke`, and checks span names plus content/identifier redaction
  without external Opik or Langfuse credentials.

For a non-root smoke path:

```bash
  OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke
```

After npm publish, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
```

- This verifies the published registry install path in a fresh temp prefix.
- For stable correction releases like `YYYY.M.D-N`, it also verifies the
  upgrade path from `YYYY.M.D` to `YYYY.M.D-N` so a correction publish cannot
  silently leave existing global installs on the old base stable payload.
- Treat install smoke as a pack-budget gate too. `pnpm test:install:smoke`
  now fails the candidate update tarball when npm reports an oversized
  `unpackedSize`, so release-time e2e cannot miss pack bloat that would risk
  low-memory install/startup failures.
- Keep direct npm global coverage enabled in install smoke. It exercises plain
  `npm install -g <candidate>` fresh installs and npm-driven update installs,
  because many users install with npm even when docs prefer pnpm.
- Use `pnpm test:live:media video` for bounded video-provider smoke when video
  generation is in release scope. The default video smoke skips `fal`, runs one
  text-to-video attempt per provider with a one-second lobster prompt, and caps
  each provider operation with `OPENCLAW_LIVE_VIDEO_GENERATION_TIMEOUT_MS`
  (`180000` by default).
- Run `pnpm test:live:media video --video-providers fal` only when FAL-specific
  proof is required. Its queue latency can dominate release time.
- Set `OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1` only when intentionally
  validating the slower image-to-video and video-to-video transform lanes.

## Check all relevant release builds

- Always validate the OpenClaw npm release path before creating the tag.
- Source Peter's profile before live release validation so OpenAI and Anthropic
  credentials are available without printing secrets:
  `set -a; source "$HOME/.profile"; set +a`.
- Parallels validation and any local live model QA for this train must use both
  `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. If either is missing after sourcing
  `.profile`, stop before starting those local long lanes and report the
  missing key.
- Live credentialed channel QA is the GitHub Actions workflow
  `QA-Lab - All Lanes` (`.github/workflows/qa-live-telegram-convex.yml`), not a
  local substitute. Dispatch it from Actions against the release tag and wait
  for it to pass before npm preflight/publish readiness. Use a SHA only when it
  satisfies the workflow's secret-bearing trust gate: main ancestor or open PR
  head. It runs the QA Lab mock parity gate plus live Matrix and live Telegram
  lanes using the `qa-live-shared` environment; Telegram uses Convex CI
  credential leases.
- Default release checks:
  - `pnpm check`
  - `pnpm check:test-types`
  - `pnpm check:architecture`
  - `pnpm build`
  - `pnpm ui:build`
  - `pnpm release:check`
  - `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`
- Full pre-npm beta test roster:
  - default release checks above
  - all Docker tests: `pnpm test:docker:all`, plus standalone Docker live lanes
    not covered by the aggregate when operator says "all docker tests":
    `pnpm test:docker:live-acp-bind`, `pnpm test:docker:live-cli-backend`, and
    `pnpm test:docker:live-codex-harness`
  - all Parallels install/update tests:
    `pnpm test:parallels:npm-update -- --json` plus any needed individual
    rerun lanes from `openclaw-parallels-smoke`
  - all QA release validation: dispatch GitHub Actions > `QA-Lab - All Lanes`
    against the release tag and require success. This is the release gate for
    live credentialed Matrix/Telegram channel coverage. Use a SHA only when it
    satisfies the workflow trust gate. Run local OpenAI/Anthropic suites or
    repo-backed character evals only when the operator asks for extra model
    coverage or a failure needs local debugging.
- Post-published beta verification roster:
  - `node --import tsx scripts/openclaw-npm-postpublish-verify.ts <beta-version>`
  - install/update smoke against the published beta channel
  - Docker install/update coverage that exercises the published beta package
  - published npm Telegram proof: dispatch Actions > `NPM Telegram Beta E2E`
    from `main` with `package_spec=openclaw@<beta-version>` and
    `provider_mode=mock-openai`, and require success. This workflow is
    maintainer-dispatched and intentionally has no `npm-release` approval gate;
    `qa-live-shared` only supplies the shared QA secrets. This is the default
    button path for installed-package onboarding, Telegram setup, and real
    Telegram E2E against the published npm package.
    Use the local `pnpm test:docker:npm-telegram-live` lane with the matching
    `OPENCLAW_NPM_TELEGRAM_PACKAGE_SPEC` and Convex CI env only as a fallback
    or debugging path.
  - Parallels published beta install/update coverage with both OpenAI and
    Anthropic provider keys available
  - Parallels install/update proof must keep plugin installs enabled unless the
    operator explicitly scopes a harness-only isolation check; a lane that
    disables bundled plugin installs is not valid plugin/dependency release
    evidence.
  - targeted QA reruns only for areas touched by fixes after the full pre-npm
    roster, unless the operator requests the full QA roster again. If the fix
    touches live channel QA, credential plumbing, Matrix, Telegram, or the QA
    harness, rerun Actions > `QA-Lab - All Lanes`.
- Check all release-related build surfaces touched by the release, not only the npm package.
- For beta-style full e2e batteries, hard-cap top-level long lanes instead of letting them run indefinitely. Use host `timeout --foreground`/`gtimeout --foreground` caps such as:
  - `45m` for `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`
  - `90m` for `pnpm test:docker:all`
  - `60m` each for standalone Docker live lanes
  - `180m` for local full QA live OpenAI + Anthropic rosters when explicitly
    requested; the default release channel QA gate is Actions >
    `QA-Lab - All Lanes`
  - Parallels caps from the `openclaw-parallels-smoke` skill
    If a lane hits its cap, stop and inspect/fix the affected lane before continuing; do not continue to wait on the same process.
- Actual npm install/update phases are capped at 5 minutes. If `npm install -g`, installer package install, or `openclaw update` takes longer than 300s in release e2e, stop treating the run as healthy progress and debug the installer/updater or harness.
- Serialize host build/package mutations ahead of VM lanes. Finish `pnpm build`, `pnpm ui:build`, `pnpm release:check`, install smoke, and any Docker/package-prep lanes before starting Parallels `npm pack` lanes; otherwise `dist` can disappear during VM pack prep and produce false failures.
- Include mac release readiness in preflight by running the public validation
  workflow in `openclaw/openclaw` and the real mac preflight in
  `openclaw/releases-private` for every release.
- Treat the `appcast.xml` update on `main` as part of mac release readiness, not an optional follow-up.
- The workflows remain tag-based. The agent is responsible for making sure
  preflight runs complete successfully before any publish run starts.
- Any fix after preflight means a new commit. Delete and recreate the tag and
  matching GitHub release from the fixed commit, then rerun preflight from
  scratch before publishing.
  Exception: never delete or recreate a beta tag that has already been pushed or
  published; increment to the next beta number instead.
- For stable mac releases, generate the signed `appcast.xml` before uploading
  public release assets so the updater feed cannot lag the published binaries.
- Serialize stable appcast-producing runs across tags so two releases do not
  generate replacement `appcast.xml` files from the same stale seed.
- For stable releases, rely primarily on the latest beta's broader release
  workflow confidence. When promoting the matching non-beta build to npm
  `latest`, prefer a light time-bounded verification pass: published npm
  postpublish verify, Docker install/update smoke, macOS-only Parallels
  install/update smoke, and required QA signal. Do not rerun the full
  Docker/Parallels matrix unless the beta evidence is stale, the stable build
  differs materially from beta, or the operator explicitly asks for full
  retesting.
- If any required build, packaging step, or release workflow is red, do not say the release is ready.

## Use the right auth flow

- OpenClaw publish uses GitHub trusted publishing.
- Stable npm promotion from `beta` to `latest` uses the private
  `openclaw/releases-private/.github/workflows/openclaw-npm-dist-tags.yml`
  workflow because `npm dist-tag` management needs `NPM_TOKEN`, while the
  public npm release workflow stays OIDC-only.
- Prefer fixing the private workflow token path over any local 1Password
  fallback. The desired setup is a granular npm token stored as the private
  repo's `NPM_TOKEN` secret, scoped to the `openclaw` package with read/write
  and 2FA bypass for automation.
- If the private dist-tag workflow cannot promote because `NPM_TOKEN` is absent
  or stale, use the local tmux + 1Password fallback:
  - Start or reuse a tmux session so interactive `npm login` and OTP prompts
    are observable and recoverable.
  - Hard rule: never run `op` directly in the main agent shell during release
    work. Any 1Password CLI use must happen inside that tmux session so prompts
    and alerts are contained and observable.
  - Use the 1Password item `op://Private/Npmjs` for npm credentials and OTP.
    Do not print passwords, tokens, or OTPs to the transcript; send them through
    tmux buffers, env vars scoped to the tmux command, or `expect` with
    `log_user 0`.
  - Re-authenticate npm inside that tmux session with
    `npm login --auth-type=legacy`, then confirm `npm whoami` reports
    `steipete`.
  - Promote with a fresh OTP:
    `npm dist-tag add openclaw@YYYY.M.D latest --otp "$OTP"`.
  - Verify with a cache-bypassed registry read, for example:
    `npm view openclaw dist-tags --json --prefer-online --cache /tmp/openclaw-npm-cache-verify-$$`
    and `npm view openclaw@latest version dist.tarball --json --prefer-online`.
- Direct stable publishes can also use that private dist-tag workflow to point
  `beta` at the already-published `latest` version when the operator wants both
  tags aligned immediately.
- The publish run must be started manually with `workflow_dispatch`.
- The npm workflow and the private mac publish workflow accept
  `preflight_only=true` to run validation/build/package steps without uploading
  public release assets.
- Real npm publish requires a prior successful npm preflight run id so the
  publish job promotes the prepared tarball instead of rebuilding it.
- Real private mac publish requires a prior successful private mac preflight
  run id so the publish job promotes the prepared artifacts instead of
  rebuilding or renotarizing them again.
- The private mac workflow also accepts `smoke_test_only=true` for branch-safe
  workflow smoke tests that use ad-hoc signing, skip notarization, skip shared
  appcast generation, and do not prove release readiness.
- `preflight_only=true` on the npm workflow is also the right way to validate an
  existing tag after publish; it should keep running the build checks even when
  the npm version is already published.
- npm validation-only preflight may still be dispatched from ordinary branches
  when testing workflow changes before merge. Release checks and real publish
  use only `main` or `release/YYYY.M.D`.
- `.github/workflows/macos-release.yml` in `openclaw/openclaw` is now a
  public validation-only handoff. It validates the tag/release state and points
  operators to the private repo. It still rebuilds the JS outputs needed for
  release validation, but it does not sign, notarize, or publish macOS
  artifacts.
- `openclaw/releases-private/.github/workflows/openclaw-macos-validate.yml`
  is the required private mac validation lane for `swift test`; keep it green
  before any real stable mac publish run starts.
- Real mac preflight and real mac publish both use
  `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`.
- The private mac validation lane runs on GitHub's standard macOS runner.
- The private mac preflight path runs on GitHub's xlarge macOS runner and uses
  a SwiftPM cache because the build/sign/notarize/package path is CPU-heavy.
- Private mac preflight uploads notarized build artifacts as workflow artifacts
  instead of uploading public GitHub release assets.
- Private smoke-test runs upload ad-hoc, non-notarized build artifacts as
  workflow artifacts and intentionally skip stable `appcast.xml` generation.
- For stable releases, npm preflight, public mac validation, private mac
  validation, and private mac preflight must all pass before any real publish
  run starts. For beta releases, npm preflight plus the selected Docker,
  install/update, Parallels, and release-check lanes are sufficient unless mac
  beta validation was explicitly requested.
- Real publish runs may be dispatched from `main` or from a
  `release/YYYY.M.D` branch. For release-branch runs, the tag must be contained
  in that release branch, and the real publish must reuse a successful preflight
  from the same branch.
- The release workflows stay tag-based; rely on the documented release sequence
  rather than workflow-level SHA pinning.
- The `npm-release` environment must be approved by `@openclaw/openclaw-release-managers` before publish continues.
- Mac publish uses
  `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml` for
  private mac preflight artifact preparation and real publish artifact
  promotion.
- Real private mac publish uploads the packaged `.zip`, `.dmg`, and
  `.dSYM.zip` assets to the existing GitHub release in `openclaw/openclaw`
  automatically when `OPENCLAW_PUBLIC_REPO_RELEASE_TOKEN` is present in the
  private repo `mac-release` environment.
- For stable releases, the agent must also download the signed
  `macos-appcast-<tag>` artifact from the successful private mac workflow and
  then update `appcast.xml` on `main`.
- For beta mac releases, do not update the shared production `appcast.xml`
  unless a separate beta Sparkle feed exists.
- The private repo targets a dedicated `mac-release` environment. If the GitHub
  plan does not yet support required reviewers there, do not assume the
  environment alone is the approval boundary; rely on private repo access and
  CODEOWNERS until those settings can be enabled.
- Do not use `NPM_TOKEN` or the plugin OTP flow for the OpenClaw package
  publish path; package publishing uses trusted publishing.
- Use `NPM_TOKEN` only for explicit npm dist-tag management modes, because npm
  does not support trusted publishing for `npm dist-tag add`.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Only publish plugins that already exist on npm; bundled disk-tree-only plugins stay unpublished.

## Fallback local mac publish

- Keep the original local macOS publish workflow available as a fallback in case
  CI/CD mac publishing is unavailable or broken.
- Preserve the existing maintainer workflow Peter uses: run it on a real Mac
  with local signing, notary, and Sparkle credentials already configured.
- Follow the private maintainer macOS runbook for the local steps:
  `scripts/package-mac-dist.sh` to build, sign, notarize, and package the app;
  manual GitHub release asset upload; then `scripts/make_appcast.sh` plus the
  `appcast.xml` commit to `main`.
- `scripts/package-mac-dist.sh` now fails closed for release builds if the
  bundled app comes out with a debug bundle id, an empty Sparkle feed URL, or a
  `CFBundleVersion` below the canonical Sparkle build floor for that short
  version. For correction tags, set a higher explicit `APP_BUILD`.
- `scripts/make_appcast.sh` first uses `generate_appcast` from `PATH`, then
  falls back to the SwiftPM Sparkle tool output under `apps/macos/.build`.
- For stable tags, the local fallback may update the shared production
  `appcast.xml`.
- For beta tags, the local fallback still publishes the mac assets but must not
  update the shared production `appcast.xml` unless a separate beta feed exists.
- Treat the local workflow as fallback only. Prefer the CI/CD publish workflow
  when it is working.
- After any stable mac publish, verify all of the following before you call the
  release finished:
  - the GitHub release has `.zip`, `.dmg`, and `.dSYM.zip` assets
  - `appcast.xml` on `main` points at the new stable zip
  - the packaged app reports the expected short version and a numeric
    `CFBundleVersion` at or above the canonical Sparkle build floor

## Run the release sequence

1. Confirm the operator explicitly wants to cut a release.
2. Choose the exact target version and git tag.
3. Commit any dirty files in coherent groups, push, pull/rebase, and verify the
   worktree is clean.
4. Pull latest `main` and confirm current `main` CI is green.
5. Run `/changelog` for the stable base target version on `main`, commit the
   changelog rewrite immediately, push, and pull/rebase. For beta releases,
   keep the changelog heading as `## YYYY.M.D`, not `## YYYY.M.D-beta.N`.
6. Create `release/YYYY.M.D` from that post-changelog `main` commit.
7. Make every repo version location match the beta tag before creating it.
8. Commit release preparation changes on the release branch and push the branch.
9. Run the fast local beta preflight from the release branch before any npm
   preflight or publish. Keep expensive Docker, Parallels, and published-package
   install/update lanes for after the beta is live unless the operator asks to
   run them before beta publication.
10. For beta releases, skip mac app build/sign/notarize unless beta scope or a
    release blocker specifically requires it. For stable releases, include the
    mac app, signing, notarization, and appcast path.
11. Confirm the target npm version is not already published.
12. Create and push the git tag from the release branch.
13. Create or refresh the matching GitHub release.
14. Dispatch Actions > `QA-Lab - All Lanes` against the release tag and wait
    for the mock parity, live Matrix, and live Telegram credentialed-channel
    lanes to pass.
15. Start `.github/workflows/openclaw-npm-release.yml` from the release branch
    with `preflight_only=true`
    and choose the intended `npm_dist_tag` (`beta` default; `latest` only for
    an intentional direct stable publish). Wait for it to pass. Save that run id
    because the real publish requires it to reuse the prepared npm tarball.
16. For stable releases, start `.github/workflows/macos-release.yml` in
    `openclaw/openclaw` and wait for the public validation-only run to pass.
17. For stable releases, start
    `openclaw/releases-private/.github/workflows/openclaw-macos-validate.yml`
    with the same tag and wait for the private mac validation lane to pass.
18. For stable releases, start
    `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`
    with `preflight_only=true` and wait for it to pass. Save that run id because
    the real publish requires it to reuse the notarized mac artifacts.
19. If any preflight or validation run fails, fix the issue on a new commit,
    delete the tag and matching GitHub release, recreate them from the fixed
    commit, and rerun all relevant preflights from scratch before continuing.
    Never reuse old preflight results after the commit changes. For pushed or
    published beta tags, do not delete/recreate; increment to the next beta tag.
20. Start `.github/workflows/openclaw-npm-release.yml` from the same branch with
    the same tag for the real publish, choose `npm_dist_tag` (`beta` default,
    `latest` only when you intentionally want direct stable publish), keep it
    the same as the preflight run, and pass the successful npm
    `preflight_run_id`.
21. Wait for `npm-release` approval from `@openclaw/openclaw-release-managers`.
22. Run postpublish verification:
    `node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>`.
23. Run the post-published beta verification roster. First scan current `main`
    for critical fixes that landed after the release branch cut; backport only
    important low-risk fixes before starting expensive lanes, or increment to
    the next beta if the fix must change the already-published package. If any
    lane fails after the beta tag/package is pushed or published, fix,
    commit/push/pull, increment to the next beta tag, and rerun the affected
    beta evidence. Once the beta is live, start remote/manual rosters where they
    can overlap safely, but keep local Docker and Parallels load controlled.
    Ensure the full expensive roster has passed at least once before
    stable/latest promotion. The roster includes the manual Actions >
    `NPM Telegram Beta E2E` workflow against the exact published beta package.
    If a pre-npm lane fails before any tag/package leaves the machine, fix and
    rerun the same intended beta attempt. Repeat up to the operator's
    authorized beta-attempt limit, normally 4.
24. Announce the beta/stable release on Discord best-effort using Peter's bot
    token from `.profile`.
25. If the operator requested beta only, stop after beta verification and the
    announcement.
26. If the stable release was published to `beta`, use the light stable
    promotion roster when the matching beta already carried the full confidence
    pass: published npm postpublish verify, Docker install/update smoke,
    macOS-only Parallels install/update smoke, and required QA signal.
    Then start the private
    `openclaw/releases-private/.github/workflows/openclaw-npm-dist-tags.yml`
    workflow to promote that stable version from `beta` to `latest`, then
    verify `latest` now points at that version.
27. If the stable release was published directly to `latest` and `beta` should
    follow it, start that same private dist-tag workflow to point `beta` at the
    stable version, then verify both `latest` and `beta` point at that version.
28. For stable releases, start
    `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`
    for the real publish with the successful private mac `preflight_run_id` and
    wait for success.
29. Verify the successful real private mac run uploaded the `.zip`, `.dmg`,
    and `.dSYM.zip` artifacts to the existing GitHub release in
    `openclaw/openclaw`.
30. For stable releases, download `macos-appcast-<tag>` from the successful
    private mac run, update `appcast.xml` on `main`, and verify the feed. Merge
    or cherry-pick release branch changes back to `main` after stable succeeds.
31. For beta releases, publish the mac assets only when intentionally requested;
    expect no shared production
    `appcast.xml` artifact and do not update the shared production feed unless a
    separate beta feed exists.
32. After publish, verify npm and the attached release artifacts.

## GHSA advisory work

- Use `openclaw-ghsa-maintainer` for GHSA advisory inspection, patch/publish flow, private-fork validation, and GHSA API-specific publish checks.
