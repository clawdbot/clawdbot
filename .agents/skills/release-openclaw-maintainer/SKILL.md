---
name: release-openclaw-maintainer
description: Prepare or verify OpenClaw stable, beta, and extended-stable releases, including backport discovery, changelogs, release notes, publish commands, and artifacts.
---

# OpenClaw Release Maintainer

Use this skill for release and publish-time workflow, including preparing the
approved backport set for an extended-stable maintenance release. Load
`$release-private` if it exists before resolving Peter-owned credential
locators or private host topology. Keep ordinary development changes and
GHSA-specific advisory work outside this skill.

## Freeze the release state

Before validation or publication, write one compact state record and keep it
current:

- goal and terminal success criteria
- release version, tag, branch, cut SHA, Code SHA, and Release SHA
- active Full Release Validation parent run id and attempt
- npm preflight and publish parent run ids
- completed phases and immutable child artifacts
- approved backports or main changes
- current phase, next action, and one precise blocker if stopped

Use `references/release-handoff-template.md` when starting a release session,
recovering after compaction, or handing the release to another operator.
Completed phases stay complete. Reopen one only when a named event invalidates
its evidence, such as a Code SHA change, a non-changelog Release SHA change, or
a workflow fix that the existing parent run cannot consume.

## Respect release guardrails

- Do not change version numbers without explicit operator approval.
- Versions use `YYYY.M.PATCH`, where `PATCH` is the sequential release-train number within the month, not the calendar day.
- Choose a new beta train from stable and beta releases only. Alpha-only tags do not consume or advance the beta/stable patch number. Continue the highest existing unpublished/published beta train with the next `beta.N` when appropriate; otherwise increment the highest stable/beta patch by one and start at `beta.1`.
- Example: after stable `2026.6.5`, the next new beta train is `2026.6.6-beta.1`, even if automated alpha-only tags such as `2026.6.10-alpha.1` exist.
- Obtain explicit operator approval before the first irreversible publish
  action. Instructions to cut, ship, publish, or get a named release out carry
  through that release's validated publish and verification steps; do not ask
  again at final dispatch. Reconfirm only if the target version, tag, channel,
  publish scope, or a material risk changes.
- This skill should be sufficient to drive the normal release flow end-to-end.
- Use the private maintainer release docs for credentials, recovery steps, and mac signing/notary specifics, and use `docs/reference/RELEASING.md` for public policy.
- Core `openclaw` publish is manual `workflow_dispatch`; creating or pushing a tag does not publish by itself.
- Do not edit the root `README.md` as release prep, release closeout, or a
  substitute for release notes. Package-root README validation is a hard
  packaging gate, but a release only changes README content when an actual
  user-facing documentation contract changed.
- Normal release work happens on a branch cut from `main`, not directly on
  `main`. Use `release/YYYY.M.PATCH` for the branch name.
- Hold release scope from cut-SHA selection through publish and verification.
  The active release is the work queue; moving `main` is only a trusted
  workflow and provenance source unless the operator explicitly requests main
  work.
- Touch `main` during the active release only for an operator-requested change
  or a critical main-owned blocker that prevents this release and cannot be
  fixed or proven from the release branch. Examples include a live installer or
  trusted workflow that is sourced only from `main`. A red unrelated `main`
  check, baseline, refactor, cleanup, or later improvement is not a release
  blocker.
- Do not broaden a release-critical main fix to make moving `main` green. Keep
  the change to the exact blocker, run focused proof, follow the required main
  landing policy, then return immediately to the release branch. If unrelated
  main health blocks that landing, report the blocker and continue independent
  release work instead of adopting the failure.
- Defer normal forward-ports and main closeout until after publication.
  Forward-port before publish only when the operator requests it or `main`
  itself owns the exact release-critical runtime or workflow surface.
- If the operator asks for a release without saying stable/full, default to
  beta only. Continue from beta to stable only when the operator explicitly asks
  for the full release or an automated beta-and-stable train.
- Resolve the intended cut SHA once. If the operator supplies a SHA, use it
  exactly; do not pull, rebase, or advance it to newer `main`. Otherwise fetch
  `origin/main` once and record the selected full SHA plus its CI state. A red
  unrelated main check does not authorize healing main.
- Create a clean release worktree and `release/YYYY.M.PATCH` from that selected
  SHA. Do not commit or absorb unrelated dirty files as release preparation.
  Finish version preparation plus any operator-selected backports,
  release-only fixes, and explicitly required pre-publish main changes.
  Backports are optional.
  Freeze this product-complete tree as the **Code SHA** without changing the
  release changelog.
- Full product validation belongs to the Code SHA. If validation finds a code
  defect, fix it, freeze a new Code SHA, and validate that SHA. If the failure
  belongs to trusted workflow tooling, the harness, credentials, or
  infrastructure, repair the smallest owning surface and rerun against the same
  Code SHA. Touch `main` only under the active release scope lock above. Never
  mutate the release candidate to satisfy newer tooling or heal unrelated main.
- Generate `CHANGELOG.md` only after the Code SHA is green. The resulting
  **Release SHA** must be a descendant whose complete diff from the Code SHA is
  exactly `CHANGELOG.md`. Release-note checks, npm preflight/package bytes,
  install/update acceptance, tagging, and publication run against the Release
  SHA. Full product validation is reused through the
  `changelog-only-release-v1` evidence policy; any non-changelog source change
  returns to the Code SHA loop.
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
- Do not delete or rewrite beta tags after their matching npm package has been
  published. If a pushed beta tag fails before npm publish, the version is not
  consumed: keep the same `-beta.N`, delete/recreate or force-move the git tag
  and prerelease to the fixed commit, and rerun preflight. Do not increment to
  the next beta number until the matching npm package has actually published.
  If a published beta needs a fix, commit the fix on the release branch and
  increment to the next `-beta.N`.
- For a beta release train, keep Full Release Validation as a pre-publish Code
  SHA gate unless the operator explicitly waives it. Run independent validation
  lanes in parallel where safe, but do not start changelog or package
  finalization until the Code SHA is green. After the changelog-only Release SHA
  exists, run npm preflight and the package/install/update acceptance roster
  against its exact bytes. If a product defect appears, return to a new Code
  SHA; if a release-tooling or publication child fails, repair/resume that child
  without changing the candidate. After a published beta needs a code fix,
  increment the beta number and repeat. Defer its forward-port until after
  publication unless the operator requests it. Do not scan moving `main` for
  extra fixes during an active release unless the operator explicitly asks for
  that audit. Operators may authorize up to 4 autonomous beta attempts; after
  4 failed beta attempts, stop and report.
- As soon as the Code SHA exists, dispatch `OpenClaw Performance`
  with `target_ref=<code-sha>` in parallel with the other release work. Do
  not wait for full release validation to start the performance signal.
- Before publish/closeout, compare available product performance metrics with
  earlier releases: Kova agent-turn/resource metrics, gateway startup
  ready/listen/RSS/CPU metrics, and CLI startup metrics from release evidence
  or clawgrit reports. Report regressions explicitly. A major regression is a
  release blocker unless the operator waives it or the data clearly proves
  infrastructure noise.
- Heal release-owned CI before changelog, tagging, or publishing. The exact
  Code SHA must have green `Full Release Validation`, including the root
  Dockerfile/install-smoke path.
  Treat a red Docker, package, or release workflow lane as a release-branch
  defect until the smallest correct fix is landed and proven; do not waive it
  because npm preflight or another sibling lane passed. Unrelated moving-main
  failures are not part of this gate.
- Keep the canonical `scripts/pr` runner authoritative for prepare and merge
  artifacts. A release-gate policy change may use focused candidate tests and
  exact-SHA hosted CI for proof, but never route `prepare-*` or `merge-*`
  through PR-controlled scripts or synthesize prepare artifacts to bootstrap
  the change. If the current canonical gate cannot validate the new policy,
  stop for explicit maintainer direction rather than weakening that boundary.
- In maintainer Testbox mode, use `OPENCLAW_TESTBOX=1 scripts/pr prepare-run
<PR>` only after the exact PR head has passed `CI` and every scheduled
  hosted gate. For a workflow change, that means `Blacksmith Testbox`,
  `Blacksmith ARM Testbox`, `Blacksmith Build Artifacts Testbox`, and
  `Workflow Sanity`; only gates GitHub actually scheduled for that exact head
  are required. This preserves the canonical prepare artifacts while avoiding
  a redundant broad local suite. A
  literal `CHANGELOG.md`-only head gets a clean diff check instead because
  those workflows intentionally do not dispatch. Documentation and README
  changes still require CI. If `merge-run` requires a mainline sync, run
  `OPENCLAW_TESTBOX=1 scripts/pr prepare-sync-head <PR>`, wait for those hosted
  gates on the newly pushed SHA, then run `prepare-run` again.
- If an exact PR-head CI run has no active jobs because Blacksmith capacity is
  stalled, a maintainer may dispatch the explicit GitHub-hosted fallback from
  the PR head branch. First verify its workflow carries the current schema with
  `gh api 'repos/openclaw/openclaw/contents/.github/workflows/ci.yml?ref=<pr-head-branch>'
--jq .content | base64 --decode | rg -q 'pull_request_number:'`. If absent,
  refresh the PR head from `main`, use the new SHA, and let normal CI run before
  considering another fallback. Then dispatch:
  `gh workflow run ci.yml --repo openclaw/openclaw --ref <pr-head-branch> -f
target_ref=<full-pr-sha> -f pull_request_number=<pr-number> -f
include_android=true -f release_gate=true`.
  Use it only for an observed provider queue stall, never for failed CI or as a
  routine shortcut. The run must be named `CI release gate <full-pr-sha>` and
  pass on that exact SHA; the native hosted-gate verifier rejects generic manual
  CI runs. If `Blacksmith Build Artifacts Testbox` is the only remaining
  required gate and it is still queued without a runner, the same completed
  fallback CI may cover it because its `build-artifacts` job builds, packages,
  and smoke tests those artifacts. The verifier records that coverage. Never
  use this coverage when the artifact workflow has started, failed, been
  cancelled, or been skipped. Then rerun `OPENCLAW_TESTBOX=1 scripts/pr
prepare-run <PR>`.
- Generate the changelog once after the final Code SHA is fully green. Do not
  regenerate it for same-candidate tooling reruns, resumed publication, or
  promotion. If code changes, validate the replacement Code SHA first and then
  regenerate the release section once for that new history. Use
  `$openclaw-changelog-update` for the rewrite. Do not continue release prep if
  the target `CHANGELOG.md` section does not have `### Highlights`,
  `### Changes`, and `### Fixes`, grouped by user-facing surface while
  preserving every relevant PR/issue ref and every human `Thanks @...`
  attribution in the grouped bullet.
- Changelog PR provenance follows `origin/main`, not the release integration
  PR. Cite the original merged main PR for equivalent backports. Keep a
  release-branch PR only when the change landed there first and has not yet
  been forward-ported to `main`.
- Do not create beta-specific `CHANGELOG.md` headings. Beta releases use the
  stable base version section, for example `v2026.4.20-beta.1` uses
  `## 2026.4.20` release notes.
- When any beta or stable release is live, make a best-effort Discord
  announcement using the configured secret workflow; do not block or roll back
  the release if the announcement fails.
- When asked to announce on X, use `~/Projects/bird/bird` and follow the
  release tweet style below.

## Prepare extended-stable backports

When asked to create the initial `.33` extended-stable line or a later
maintenance patch, read
`references/extended-stable-backports.md` and follow it before version, tag, or
publication work. Treat backport discovery and preparation as an ability of
this release skill, not as a separate release workflow.

The backport ability owns the complete mainline inventory, private-security
reconciliation, candidate decisions, maintainer approval, coordinated staging
PR, and proof handoff. After that PR lands, use the dedicated npm-only sequence
below. Never route `.33+` through the regular beta/stable release sequence.

## Publish extended-stable releases

Use this path only for the trailing completed month's `.33+` line. Treat
`docs/reference/RELEASING.md`,
`scripts/openclaw-npm-extended-stable-release.mjs`, and the release workflows
on pinned current `main` as the exact command and validation contract.

1. Check out the canonical `extended-stable/YYYY.M.33` branch after the
   approved backport PR lands. Require its tip, root package version, every
   publishable official plugin version, and intended immutable `vYYYY.M.P` tag
   to identify one exact release commit.
2. Create and push `vYYYY.M.P` at that exact branch tip only after version prep
   and focused backport proof are complete.
3. Dispatch `openclaw-npm-release.yml` with `preflight_only=true` and
   `npm_dist_tag=extended-stable` from the canonical branch. Save the successful
   npm preflight run ID.
4. Dispatch `full-release-validation.yml` from the same branch with
   `ref=extended-stable/YYYY.M.33` and `release_profile=stable`. Save the
   successful exact-head validation run ID and its exact `run_attempt` from
   `gh api repos/openclaw/openclaw/actions/runs/<run-id> --jq .run_attempt`.
5. Dispatch `plugin-npm-release.yml` from the same branch with
   `publish_scope=all-publishable`, the full release SHA as `ref`, and
   `npm_dist_tag=extended-stable`. Require complete exact-version and selector
   readback, then save the successful plugin run ID.
6. Dispatch the real `openclaw-npm-release.yml` publish from the same branch
   with the intended tag, `npm_dist_tag=extended-stable`, all three saved run
   IDs, and `full_release_validation_run_attempt=<saved-attempt>`. The workflow
   must publish the exact prepared core tarball and prove the referenced runs
   match the canonical branch and release SHA.
7. Independently verify the exact core package, every official plugin package,
   and all `extended-stable` selectors. If only the core selector readback
   fails, use the `openclaw` repair command generated by the core workflow. If
   an official-plugin selector is missing or stale for an already-published
   version, use the approved credential-isolated release tooling for manual
   plugin tag repair; the OIDC source workflow cannot mutate that tag. Never
   republish an immutable version.
8. Do not create a GitHub Release or publish macOS, Windows, Docker, mobile,
   website, ClawHub, or private dist-tag artifacts from this path.

## Keep release channel naming aligned

- `stable`: user updates resolve npm `latest`; tagged regular releases publish
  to npm `beta` by default, then operators may target or promote to `latest`
  explicitly
- `extended-stable`: user updates resolve npm `extended-stable`; operators
  publish the trailing completed month's `.33+` line from
  `extended-stable/YYYY.M.33`
- `beta`: prerelease tags like `vYYYY.M.PATCH-beta.N`, with npm dist-tag `beta`
- Prefer `-beta.N`; do not mint new `-1` or `-2` beta suffixes
- `dev`: moving head on `main`
- When using a beta Git tag, publish npm with the matching beta version suffix so the plain version is not consumed or blocked

## Close stable releases on main

This gate starts only after stable publication. It is a narrow shipped-state
closeout, not permission to heal broader `main`. Stable publication is not
complete until `main` carries the actual shipped release state.

1. Start from fresh latest `main`. Audit `release/YYYY.M.PATCH` against it and
   forward-port real fixes that are absent from `main`. Do not blindly merge
   release-only compatibility, test, or validation adapters into newer `main`.
2. Set `main` to the shipped stable version, not a speculative next train. Run
   `pnpm release:prep` after the root version change, then
   `pnpm deps:shrinkwrap:generate`.
3. Make `CHANGELOG.md`'s `## YYYY.M.PATCH` section on `main` exactly match the
   tagged release branch. Include the stable `appcast.xml` update when the mac
   release published one.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog
   section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:shrinkwrap:check`, and
   `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main`
   contains the shipped version and changelog before calling the stable release
   done.
6. Keep repository variables `RELEASE_ROLLBACK_DRILL_ID` and
   `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.
   `openclaw-stable-main-closeout.yml` starts from the `main` push carrying the
   shipped version, changelog, and appcast after stable publication, then binds
   immutable evidence to the published tag. Do not declare stable complete
   until it writes the immutable closeout manifest to the GitHub release. The
   drill must be within 90 days; manual dispatch is only for repair/replay, and
   private rollback commands remain in the maintainer-only runbook.

## Handle versions and release files consistently

Use the release preparation controller before manual version edits:

```bash
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --shadow
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --write
pnpm release:prepare -- --version YYYY.M.PATCH-beta.N --check
```

Shadow mode is the default and never runs mutating commands. Write mode aligns
the root and macOS versions, optionally Android with `--android`, then runs only
the version-owned generated metadata DAG. Every mode writes an exact
HEAD/worktree-bound manifest under git metadata for cutover review.

- Version locations include:
  - `package.json`
  - `apps/android/app/build.gradle.kts`
  - `apps/ios/Sources/Info.plist`
  - `apps/ios/Tests/Info.plist`
  - `apps/macos/Sources/OpenClaw/Resources/Info.plist`
  - `docs/install/updating.md`
  - Peekaboo Xcode project and plist version fields
- Before creating a release tag, make every version location above match the version encoded by that tag.
- For fallback correction tags like `vYYYY.M.PATCH-N`, the repo version locations still stay at `YYYY.M.PATCH`.
- “Bump version everywhere” means all version locations above except `appcast.xml`.
- Release signing and notary credentials live outside the repo in the private maintainer docs.
- Every stable OpenClaw release ships the npm package, macOS app, and signed
  Windows Hub installers together. Beta releases normally ship npm/package
  artifacts first and skip native app build/sign/notarize/promote unless the
  operator requests native beta validation.
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
  create a `vYYYY.M.PATCH-N` correction tag just to change the workflow source.
  Dispatch the release-ops mac workflows for the original `tag=vYYYY.M.PATCH`
  with `source_ref=release/YYYY.M.PATCH` and
  `public_release_branch=release/YYYY.M.PATCH`;
  provenance checks must prove the source SHA descends from the tag and
  validation/preflight use the same source. Reserve `vYYYY.M.PATCH-N` correction
  tags for emergency hotfixes that must publish a new npm package/release
  identity, not for ordinary mac-only packaging recovery.
- The production Sparkle feed lives at `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`, and the canonical published file is `appcast.xml` on `main` in the `openclaw` repo.
- That shared production Sparkle feed is stable-only. Beta mac releases may
  upload assets to the GitHub prerelease, but they must not replace the shared
  `appcast.xml` unless a separate beta feed exists.
- For fallback correction tags like `vYYYY.M.PATCH-N`, the repo version still stays
  at `YYYY.M.PATCH`, but the mac release must use a strictly higher numeric
  `APP_BUILD` / Sparkle build than the original release so existing installs
  see it as newer.
- Stable Windows Hub release closeout requires the signed
  `OpenClawCompanion-Setup-x64.exe`, `OpenClawCompanion-Setup-arm64.exe`, and
  `OpenClawCompanion-SHA256SUMS.txt` assets on the canonical
  `openclaw/openclaw` GitHub Release. Pass the exact signed
  `openclaw/openclaw-windows-node` release tag as `windows_node_tag` to
  `OpenClaw Release Publish`, together with the candidate-approved
  `windows_node_installer_digests` map; it prevalidates the published source
  release and required installers against that map before any publish child,
  dispatches the public `Windows Node Release` workflow while the OpenClaw
  release is still a draft, carries those pinned source asset digests
  unchanged, verifies the expected OpenClaw Foundation Authenticode signer on
  Windows, re-downloads and checksum-verifies the promoted asset contract, and
  blocks publication until the canonical asset contract is present. Use direct
  `Windows Node Release` dispatch only for recovery, always with an exact tag,
  never `latest`, and the explicit `expected_installer_digests` JSON map from
  the approved source release. Recovery rejects unexpected
  `OpenClawCompanion-*` target asset names, then replaces the expected contract
  assets with the pinned source bytes.
- Website Windows Hub download links should target exact canonical
  `openclaw/openclaw/releases/download/vYYYY.M.PATCH/...` assets for the current
  stable release, or `releases/latest/download/...` only after verifying the
  redirect resolves to that same tag, so the installable signed Windows artifact
  is visible from both the GitHub release page and openclaw.ai.

## Build changelog-backed release notes

- `CHANGELOG.md` is release-owned. Normal PRs and direct `main` fixes should
  not edit it.
- After the product-complete Code SHA passes Full Release Validation, rewrite
  the target `CHANGELOG.md` section from history, not existing notes. Use the
  last reachable stable or beta release tag as the base, then inspect every
  commit through the Code SHA. This is the one release-note mutation that
  creates the Release SHA.
- Generate `$openclaw-changelog-update`'s full contribution manifest before
  the editorial rewrite. It is the required source for `### Highlights`,
  `### Changes`, and `### Fixes`; do not preserve old grouped prose without
  comparing it to the manifest's PRs, contributors, direct commits, and
  unlinked commits.
- A same-Code-SHA retry reuses the existing changelog. A new beta containing
  code changes must first validate its replacement Code SHA, then refresh the
  same stable-base `## YYYY.M.PATCH` section once.
- Always fetch and pass current `origin/main` as the canonical main ref.
  Equivalent release/backport PRs are omitted in favor of the original merged
  main PR. A release-branch PR remains only until that change is forward-ported.
- Include both merged PR commits and direct commits on `main`. Direct commits
  matter: infer notes from their subject, body, touched files, linked issues,
  tests, and nearby code when no PR body exists.
- Keep direct commits in the generated manifest and use them to shape grouped
  user outcomes, but never dump them into `CHANGELOG.md` or GitHub release
  bodies. The public complete record is PR-first and exhaustive for PRs.
- Prefer PR bodies, issue links, review proof, and commit bodies over commit
  subjects alone. If a commit fixed an issue directly, the commit body should
  name the user-visible behavior, affected surface, issue ref, and credited
  reporter/contributor when known.
- Treat missing context as a release-note audit gap: inspect the diff and linked
  issue, draft the best accurate entry, and note the uncertainty for maintainer
  review rather than inventing impact.
- Add missed user-facing changes, remove internal-only noise, dedupe overlapping
  PR/direct-commit entries, and sort each section from most to least interesting
  for users.
- Group related highlights, changes, and fixes by user-facing surface and
  impact, but never lose traceability: each grouped bullet keeps every relevant
  `#issue`, `(#PR)`, `Fixes #...`, and every human `Thanks @...` handle.
  Multiple thanks in one bullet are expected when multiple contributor PRs are
  grouped.
- Highlights earn their place only when they are a visible capability/workflow
  unlock, a material reliability or safety repair, a broad user-facing
  improvement, or a release-defining integration/compatibility change. Keep
  five to eight user-outcome bullets; omit tests, CI, refactors, docs, and
  implementation trivia unless their outcome materially affects users.
- Do not give `docs`, `test`, `refactor`, `ci`, `build`, `chore`, or `style`
  PRs/direct commits their own Highlights, Changes, or Fixes entry. They remain
  accounted for in the PR record or manifest, but are not product release
  content. Treat explicit internal title signals such as `QA`, `lint`, or
  `testing` the same way even when the PR has no conventional prefix.
- Use the generated `### Complete contribution record` as PR-first accounting:
  every merged source PR appears once with author/co-author credit, including
  PRs identified only by an explicit active-commit `#NNN` reference after a
  cherry-pick or squash. Keep issues inline as `#NNN` in titles and grouped
  prose; do not create a linked-issues inventory or a direct-commit listing.
  When grouped prose names a PR, keep every contributor and linked-reporter
  credit from that PR's record on the same bullet.
- Changelog entries should be user-facing, not internal release-process notes.
- GitHub release and prerelease bodies use
  `scripts/render-github-release-notes.mjs`. When the full matching
  `CHANGELOG.md` version section fits GitHub's 125,000-character limit and
  the renderer's matching 125,000-byte safety ceiling, publish the exact
  `## YYYY.M.PATCH` block through the line before the next level-2 heading,
  including the version heading.
- When that complete body exceeds either limit, keep the exact grouped
  editorial notes through the line before `### Complete contribution record`,
  then replace the oversized record with the canonical tag-pinned
  `CHANGELOG.md` link emitted by the renderer. Never truncate bullets or emit a
  partial contribution record. Candidate validation, publish, and
  `verify-release-notes.mjs` must share this renderer so the compact form cannot
  drift.
- Choose the full or compact changelog body before adding
  `### Release verification`. Append that proof only when the final body still
  fits; otherwise leave the immutable evidence assets attached and omit the
  body tail. Do not discard a fitting full contribution record to make room
  for proof.
- Before publishing or closing a release, run
  `$openclaw-changelog-update`'s `verify-release-notes.mjs` with every stable
  and beta release tag in the train. Do not publish or leave a page live when
  it is missing a source-history reference, eligible human credit, or the
  complete matching changelog body.
- Treat the selected `--base` as a strict history boundary: it must be an
  ancestor of the target, and existing changelog prose or contribution rows
  cannot pull older PRs into the new release. Use `--seed-ref` only for an
  intentional historical backfill. When a divergent prior release tag or later
  forward-port re-associates already-shipped PRs, pass repeatable explicit
  `--shipped-ref <tag>` values. They subtract only explicit PR rows in complete
  contribution records from numbered sections of those tag snapshots, ignore
  `Unreleased`, and retain the exact excluded PR inventory and count in
  manifest/provenance for candidate checks.
- To update an existing GitHub Release body, resolve the numeric release id and
  patch that resource with the notes file as the `body` field:
  `gh api repos/openclaw/openclaw/releases/tags/vYYYY.M.PATCH --jq .id`, then
  `gh api -X PATCH repos/openclaw/openclaw/releases/<id> -F body=@/tmp/notes.md`.
  Do not trust `gh release edit --notes-file` or `--input` JSON if verification
  disagrees; verify with `gh api repos/openclaw/openclaw/releases/<id>` because
  the tag lookup and `gh release view` can lag or show stale body text.
- When preparing release notes, scan `src/plugins/compat/registry.ts` and
  `src/commands/doctor/shared/deprecation-compat.ts` for compatibility records
  with `warningStarts` or `removeAfter` within 7 days after the release date.
  Add an `Upcoming deprecations` note to the release notes when any exist,
  including the compatibility code, target date, replacement, and a link to the
  record's `docsPath` or `/plugins/compatibility` when no more specific
  deprecation page exists.
- When cutting a mac release with a beta GitHub prerelease:
  - tag `vYYYY.M.PATCH-beta.N` from the release commit
  - create a prerelease titled `openclaw YYYY.M.PATCH-beta.N`
  - use release notes from the stable base `CHANGELOG.md` version section
    (`## YYYY.M.PATCH`), not a beta-specific heading
  - attach at least the zip and dSYM zip, plus dmg if available
- Keep the top version entries in `CHANGELOG.md` sorted by impact:
  - `### Changes` first
  - `### Fixes` deduped with user-facing fixes first

## Write release tweets

Use the OpenClaw account's existing release-post style:

- Format: `OpenClaw YYYY.M.PATCH 🦞` or `🦞 OpenClaw YYYY.M.PATCH is live`, blank line,
  then 3-4 emoji-led bullets, blank line, one short punchline, then the release
  link.
- For beta: say `OpenClaw YYYY.M.PATCH-beta.N 🦞` or `OpenClaw YYYY.M.PATCH beta N is
live`; keep it clearly beta and avoid implying stable promotion.
- Lead with user-visible capabilities, then important integrations, then
  reliability/security/install fixes. Compress "lots of fixes" into one
  readable bullet.
- Read the full changelog section before drafting. Do not lead with coverage,
  CI, validation, or internal release mechanics unless the release is explicitly
  about those. Peter prefers concrete user wins: features, integrations,
  workflow improvements, and practical reliability fixes.
- Do not feature QA parity, test coverage, release gates, or validation lanes in
  user-facing launch tweets. Keep them for release notes or maintainer proof
  unless the operator explicitly asks for validation-focused copy.
- Do not feature plugin-author or developer tooling such as SDK helpers,
  tool-plugin scaffolding, build/validate/init commands, or internal CLI
  plumbing in general user-facing launch tweets unless the operator explicitly
  asks for developer-focused copy.
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
- Peter's preferred thread workflow: first agree on the generic launch tweet,
  then proceed through follow-up tweets one by one. When he says `next`, provide
  or copy the next follow-up only; do not dump the full thread again unless asked.
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
pnpm release:fast-pretag-check
pnpm check:architecture
pnpm build
pnpm ui:build
pnpm qa:otel:smoke
pnpm release:check
pnpm test:install:smoke
```

- Treat `pnpm release:fast-pretag-check` as a hard packaging gate. Every
  publishable plugin must have a non-empty package-root `README.md`, build its
  package-local runtime, and pass the npm and ClawHub release metadata checks
  before a tag or publish workflow can start. Do not defer README, entrypoint,
  or packed-artifact failures to postpublish verification.
- Before generating the changelog, require green CI for the exact Code SHA, not
  an earlier branch SHA. Heal every related red CI, release-check, packaging,
  or root-Dockerfile lane on the release branch and rerun the affected exact-SHA
  gates. Defer product-fix forward-ports until after publication unless the
  active release scope lock requires an exact main-owned blocker fix. Never
  waive a red Docker lane because npm preflight passed.
- Root Dockerfile proof is mandatory on the Code SHA before every beta and
  stable tag. The changelog-only Release SHA reuses that product proof, while
  exact Release SHA npm preflight and package/install acceptance prove the
  changed package bytes. The tag-triggered Docker Release workflow is
  post-tag publishing, not the first valid proof that the root Dockerfile can
  build.
- Before tagging, diff publishable plugin package manifests against the last
  reachable stable/beta release tag. For every newly publishable package
  (`openclaw.release.publishToNpm: true` or `publishToClawHub: true`) whose
  package name did not exist in the base tag, verify the target registry package
  already exists in npm/ClawHub or stop and help the owner mint/prepublish the
  package first. Do not hide or disable release surfaces just to unblock a
  train unless the owner explicitly decides the plugin should not ship in that
  release; first-package registry ownership is release prep, not product
  rollback. The mint/prepublish path must either be the real release publish
  path for the auto-bumped beta version, or a deliberately non-consuming
  registry-prep step that cannot occupy the next beta version/tag. Confirm
  registry owner, npm scope/package-creation permission, provenance path, and
  first-package publish plan before the full release publish continues. Useful
  npm probe:
  `npm view <package-name> version dist-tags --json --prefer-online`; a 404 for
  a package newly added to the release is a release-prep blocker, not something
  to discover from the publish job.
- Bootstrap a new ClawHub package only from the trusted workflow source:
  `gh workflow run plugin-clawhub-new.yml --ref main -f plugins=@openclaw/name -f ref=<full-release-sha> -f pretag_validation=true -f dry_run=true`.
  The workflow source stays on `main`; `ref` is the exact release target. A
  pre-tag dry run rejects tag/parent-approval inputs and requires the target to be
  reachable from `main` or `release/*`. It must still resolve the live registry
  plan, pack every candidate, upload and download the exact artifact ID, rehash
  the inventory, reject ambiguous TAR paths locally with the pinned CLI's USTAR
  canonicalization, and validate each tarball with the pinned CLI publish
  dry-run. It never loads credentials or changes package/trusted-publisher
  state. Approve the `clawhub-plugin-bootstrap` environment only after the
  secretless pack jobs finish; the protected validation job itself has no
  credentials or mutation commands. For an
  existing version missing trusted-publisher configuration, pack the target
  bytes too and require its tag plus exact registry byte/metadata equality
  before allowing configuration-only repair. The credential-job prefilter
  enforces the ClawHub 120 MiB compressed and 50 MiB total-payload limits, plus
  64 MiB expanded-TAR and 10,000-TAR-entry parser-safety limits. A mismatch
  requires a new version; never bless unrelated immutable bytes. A real run
  publishes the exact downloaded tarball, bounds each CLI attempt, and records
  byte-identical registry readback. Final release verification must consume the
  unique terminal readback artifact and bind its main-only workflow SHA/attempt,
  target SHA, requested packages, package artifact ID/name/digest, and
  per-package SHA-256/size/npm integrity metadata. The parent approval attests a
  separate exact trusted-main child workflow SHA; the child run and protected
  approval must match it. Rerun-failed recovery may reuse a prior package
  artifact only when the exact producer job succeeded. Final evidence must also
  preserve the locked ClawHub version, lock SHA-256, and npm integrity.
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
- For stable correction releases like `YYYY.M.PATCH-N`, it also verifies the
  upgrade path from `YYYY.M.PATCH` to `YYYY.M.PATCH-N` so a correction publish cannot
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
- Use the configured secret workflow before live release validation so OpenAI
  and Anthropic credentials are available without printing secrets.
- Parallels validation and any local live model QA for this train must use both
  `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. If either cannot be injected, stop
  before starting those local long lanes and report the missing key.
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
  workflow in `openclaw/openclaw` and the release-ops mac preflight in
  `openclaw/releases` for every release.
- Treat the `appcast.xml` update on `main` as part of mac release readiness, not an optional follow-up.
- The workflows remain tag-based. The agent is responsible for making sure
  preflight runs complete successfully before any publish run starts.
- Any fix after preflight means a new commit. Delete and recreate the tag and
  matching GitHub release from the fixed commit, then rerun preflight from
  scratch before publishing.
  Exception: never delete or recreate a beta tag whose matching npm package has
  already been published; increment to the next beta number instead. If only the
  pushed tag/prerelease exists and npm publish has not happened, recreate that
  same beta tag at the fixed commit.
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
- Stable npm promotion from `beta` to `latest` uses the restricted release-ops
  `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow
  because `npm dist-tag` management needs `NPM_TOKEN`, while the public npm
  release workflow stays OIDC-only.
- Prefer fixing the release-ops workflow token path over any local 1Password
  fallback. The desired setup is a granular npm token stored as the release-ops
  repo's `NPM_TOKEN` secret, scoped to the `openclaw` package with read/write
  and 2FA bypass for automation.
- If the release-ops dist-tag workflow cannot promote because `NPM_TOKEN` is
  absent or stale, use the local tmux + 1Password fallback:
  - Start or reuse a tmux session so interactive `npm login` and OTP prompts
    are observable and recoverable.
  - Hard rule: never run `op` directly in the main agent shell during release
    work. Any 1Password CLI use must happen inside that tmux session so prompts
    and alerts are contained and observable.
  - Use `$release-private` for the npm credentials and OTP item.
    Do not print passwords, tokens, or OTPs to the transcript; send them through
    tmux buffers, env vars scoped to the tmux command, or `expect` with
    `log_user 0`.
  - Re-authenticate npm inside that tmux session with
    `npm login --auth-type=legacy`, then confirm `npm whoami` reports
    `steipete`.
  - Promote with a fresh OTP:
    `npm dist-tag add openclaw@YYYY.M.PATCH latest --otp "$OTP"`.
  - Verify with a cache-bypassed registry read, for example:
    `npm view openclaw dist-tags --json --prefer-online --cache /tmp/openclaw-npm-cache-verify-$$`
    and `npm view openclaw@latest version dist.tarball --json --prefer-online`.
- Direct stable publishes can also use that release-ops dist-tag workflow to
  point `beta` at the already-published `latest` version when the operator wants
  both tags aligned immediately.
- The publish run must be started manually with `workflow_dispatch`.
- The npm workflow and the release-ops mac publish workflow accept
  `preflight_only=true` to run validation/build/package steps without uploading
  public release assets.
- Real npm publish requires a prior successful npm preflight run id plus the
  successful Full Release Validation run id and exact run attempt for the same
  tag/SHA so the publish job promotes the prepared tarball instead of rebuilding
  it and attaches the correct release evidence.
- Real release-ops mac publish requires a prior successful release-ops mac
  preflight run id so the publish job promotes the prepared artifacts instead of
  rebuilding or renotarizing them again.
- The release-ops mac workflow also accepts `smoke_test_only=true` for branch-safe
  workflow smoke tests that use ad-hoc signing, skip notarization, skip shared
  appcast generation, and do not prove release readiness.
- `preflight_only=true` on the npm workflow is also the right way to validate an
  existing tag after publish; it should keep running the build checks even when
  the npm version is already published.
- npm registry metadata is eventually consistent immediately after trusted
  publishing. Keep postpublish `npm view` checks on bounded `--prefer-online`
  retries, and carry that verified tarball/integrity metadata into later proof
  steps instead of reading the registry again. If the OpenClaw npm child
  succeeded but the parent publish workflow failed on an immediate exact-version
  `E404`, verify the exact version with a cache-bypassed registry read, run the
  standalone postpublish verifier and the full beta verifier with the original
  successful child run IDs, then finalize the draft, dependency evidence asset,
  and release proof manually. Never rerun the publish workflow for that
  already-published version.
- npm validation-only preflight may still be dispatched from ordinary branches
  when testing workflow changes before merge. Regular beta and stable release
  checks and publish orchestration use trusted `main` against the exact target
  tag; Tideclaw alpha keeps its matching alpha branch.
- `.github/workflows/macos-release.yml` in `openclaw/openclaw` is now a
  public validation-only handoff. It validates the tag/release state and points
  operators to the release-ops repo. It still rebuilds the JS outputs needed for
  release validation, but it does not sign, notarize, or publish macOS
  artifacts.
- `openclaw/releases/.github/workflows/openclaw-macos-validate.yml` is the
  required release-ops mac validation lane for `swift test`; keep it green
  before any real stable mac publish run starts.
- Real mac preflight and real mac publish both use
  `openclaw/releases/.github/workflows/openclaw-macos-publish.yml`.
- The release-ops mac validation lane runs on GitHub's standard macOS runner.
- The release-ops mac preflight path runs on GitHub's xlarge macOS runner and uses
  a SwiftPM cache because the build/sign/notarize/package path is CPU-heavy.
- Release-ops mac preflight uploads notarized build artifacts as workflow
  artifacts instead of uploading public GitHub release assets.
- Release-ops smoke-test runs upload ad-hoc, non-notarized build artifacts as
  workflow artifacts and intentionally skip stable `appcast.xml` generation.
- For stable releases, npm preflight, Full Release Validation, public mac
  validation, release-ops mac validation, and release-ops mac preflight must all
  pass before any real publish run starts. For beta releases, npm preflight and
  Full Release Validation must pass before npm publish unless the operator
  explicitly waives the full gate; mac beta validation is still only required
  when requested.
- Focused plugin-only repairs use `plugin_publish_scope=selected` with a nonempty
  package list. `all-publishable` plugin runs require complete immutable npm
  preflight and Full Release Validation evidence even when core npm publication
  is disabled.
- Dispatch regular beta and stable `OpenClaw Release Publish` runs from trusted
  `main`; the tag still selects the exact release commit, including a commit on
  `release/YYYY.M.PATCH`. Tideclaw alpha publish runs remain on their matching
  alpha branch. Reuse the successful preflight for that exact release SHA.
- The release workflows stay tag-based; rely on the documented release sequence
  rather than workflow-level SHA pinning.
- The `npm-release` environment must be approved by `@openclaw/openclaw-release-managers` before publish continues.
- Mac publish uses
  `openclaw/releases/.github/workflows/openclaw-macos-publish.yml` for
  release-ops mac preflight artifact preparation and real publish artifact
  promotion.
- Real release-ops mac publish uploads the packaged `.zip`, `.dmg`, and
  `.dSYM.zip` assets to the existing GitHub release in `openclaw/openclaw`
  automatically when `OPENCLAW_PUBLIC_REPO_RELEASE_TOKEN` is present in the
  release-ops repo `mac-release` environment.
- For stable releases, the agent must also download the signed
  `macos-appcast-<tag>` artifact from the successful release-ops mac workflow
  and then update `appcast.xml` on `main`.
- For beta mac releases, do not update the shared production `appcast.xml`
  unless a separate beta Sparkle feed exists.
- The release-ops repo targets a dedicated `mac-release` environment. If the
  GitHub plan does not yet support required reviewers there, do not assume the
  environment alone is the approval boundary; rely on restricted repo access and
  CODEOWNERS until those settings can be enabled.
- Do not use `NPM_TOKEN` or the plugin OTP flow for the OpenClaw package
  publish path; package publishing uses trusted publishing.
- Use `NPM_TOKEN` only for explicit npm dist-tag management modes, because npm
  does not support trusted publishing for `npm dist-tag add`.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Publishable plugins that are new to npm require owner-led first-package
  minting before the full release publish. Do not consume the next beta version
  with an ad-hoc manual package publish; use the release-owned auto-bumped
  version path, or a non-consuming registry setup/preflight step. Bundled
  disk-tree-only plugins stay unpublished.

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

1. Confirm release intent once. Treat prior explicit instructions to cut, ship,
   publish, or complete the named release as continuing authorization through
   publish and verification. Reconfirm only if the release identity, channel,
   publish scope, or material risk changes.
2. Choose the exact target version, git tag, and npm dist-tag (`beta` or
   `latest`).
3. Start from a clean release worktree. Do not absorb unrelated dirty files.
4. Resolve the cut SHA once. Use an operator-supplied SHA exactly; otherwise
   fetch `origin/main` once, record its full SHA and CI state, and do not chase a
   newer moving head.
5. Create `release/YYYY.M.PATCH` from that selected commit.
6. Make every repo version location match the beta tag. Apply only explicitly
   selected backports or release fixes. Make a pre-publish main change only
   under the active release scope lock. Freeze the result as the Code SHA.
7. Immediately dispatch Actions > `OpenClaw Performance` from the pinned
   trusted workflow source with `target_ref=<code-sha>`, `profile=release`,
   `repeat=3`, deep profiling
   off, live OpenAI off, and regression failure off. Let it run in parallel
   with Code SHA validation.
8. Run the deterministic source preflight, then Full Release Validation against
   the exact Code SHA with
   `node scripts/full-release-validation-at-sha.mjs --sha <code-sha> --target-ref release/YYYY.M.PATCH`.
   Use one transition watcher. Product failures return to step 6 with a new
   Code SHA; tooling/harness failures are fixed separately and rerun against the
   same Code SHA.
9. After the Code SHA is green, run `/changelog` once for the stable-base target
   version using current `origin/main` for canonical PR provenance. Keep the
   heading as `## YYYY.M.PATCH`, not `## YYYY.M.PATCH-beta.N`.
10. Commit only `CHANGELOG.md` and freeze the Release SHA. Verify
    `<code-sha>..<release-sha>` changes exactly `CHANGELOG.md`; any other path
    returns to step 6.
11. Dispatch Full Release Validation for the Release SHA with evidence reuse
    enabled. It must select `changelog-only-release-v1`, reuse the green Code SHA
    product matrix, and run no product lanes again.
12. Run npm preflight and release-note/package/install/update acceptance against
    the exact Release SHA and prepared tarball. A package or install failure that
    exposes a product defect returns to step 6; a tooling failure keeps the
    Release SHA unchanged.
13. For beta releases, skip mac app build/sign/notarize unless beta scope or a
    release blocker specifically requires it. For stable releases, include the
    mac app, signing, notarization, and appcast path.
14. Confirm the target npm version is not already published.
15. Create and push the git tag from the Release SHA.
16. Do not create or publish the matching GitHub release page yet. The real
    publish workflow creates or undrafts it only after postpublish verification
    and release evidence upload pass.
17. Run `pnpm release:candidate -- --tag <tag> --full-release-run
<release-sha-validation-run-id> --npm-preflight-run <preflight-run-id>
--skip-dispatch` to consume the existing reused full evidence and exact
    Release SHA preflight instead of dispatching either again. It completes
    package/install proof and prints the publish command.
18. Start publication only after the candidate bundle is green. Reuse successful
    immutable child runs/artifacts on retry; do not rebuild or republish versions
    that already succeeded.
19. Before real publish, review the early performance run if it has completed.
    Compare against earlier release evidence or clawgrit reports where
    available. Call out minor regressions in the release proof; block on major
    regressions unless waived or proven noisy.
20. For stable releases, start `.github/workflows/macos-release.yml` in
    `openclaw/openclaw` and wait for the public validation-only run to pass.
21. For stable releases, start
    `openclaw/releases/.github/workflows/openclaw-macos-validate.yml` with the
    same tag and wait for the release-ops mac validation lane to pass.
22. For stable releases, start
    `openclaw/releases/.github/workflows/openclaw-macos-publish.yml` with
    `preflight_only=true` and wait for it to pass. Save that run id because the
    real publish requires it to reuse the notarized mac artifacts.
23. Classify every failure before changing git state. Product defects return to
    step 6 and invalidate downstream Code/Release SHA evidence. Changelog or
    release-note defects change only the Release SHA and reuse the green Code
    SHA evidence after the exact delta is reverified. Tooling, credential,
    approval, registry selector, or publication-child failures keep the
    candidate unchanged and resume the smallest failed surface.
24. Start `.github/workflows/openclaw-release-publish.yml` from the exact pinned
    trusted workflow source
    with the same tag for the real beta or stable publish, choose `npm_dist_tag` (`beta` default,
    `latest` only when you intentionally want direct stable publish), keep it
    the same as the preflight run, and pass the successful npm
    `preflight_run_id` plus the successful `full_release_validation_run_id` and
    its exact `full_release_validation_run_attempt`.
    For stable publish, also pass the exact non-prerelease
    `openclaw/openclaw-windows-node` tag as `windows_node_tag` and its
    candidate-approved installer digest map as `windows_node_installer_digests`.
25. Wait for `npm-release` approval from `@openclaw/openclaw-release-managers`.
26. Wait for the real publish workflow to run postpublish verification,
    create or update the GitHub release as a draft, upload dependency evidence,
    promote and verify the required Windows Hub assets for stable releases,
    append release verification proof, and only then undraft/publish it. If a
    waited plugin publish or Windows Hub promotion fails after OpenClaw npm
    succeeds, the workflow keeps the release draft with OpenClaw npm evidence
    and exits red; do not undraft until the gap is repaired. The standalone
    verifier command remains the first recovery probe:
    `node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>`.
    For a failed postpublish parent after successful publish children, also run
    `pnpm release:verify-beta -- <published-version> ... --skip-github-release`
    with the original child run IDs and an evidence output path before manually
    recreating the workflow's draft, dependency evidence asset, proof section,
    and publish step.
27. Run the post-published beta verification roster. Do not scan current `main`
    for extra fixes unless the operator explicitly requests a backport audit.
    Apply only operator-selected backports, and increment to the next beta if a
    selected fix must change the already-published package. If any
    lane fails after the beta package is published, fix, commit/push/pull,
    increment to the next beta tag, and rerun the affected beta evidence. Once
    the beta is live, start remote/manual rosters where they
    can overlap safely, but keep local Docker and Parallels load controlled.
    Ensure the full expensive roster has passed at least once before
    stable/latest promotion. The roster includes the manual Actions >
    `NPM Telegram Beta E2E` workflow against the exact published beta package.
    If a pre-npm lane fails before any tag/package leaves the machine, fix and
    rerun the same intended beta attempt. Repeat up to the operator's
    authorized beta-attempt limit, normally 4.
28. Announce the beta/stable release on Discord best-effort using the configured secret workflow.
29. If the operator requested beta only, stop after beta verification and the
    announcement.
30. If the stable release was published to `beta`, use the light stable
    promotion roster when the matching beta already carried the full confidence
    pass: published npm postpublish verify, Docker install/update smoke,
    macOS-only Parallels install/update smoke, and required QA signal.
    Then start the restricted release-ops
    `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow
    to promote that stable version from `beta` to `latest`, then verify
    `latest` now points at that version.
31. If the stable release was published directly to `latest` and `beta` should
    follow it, start that same release-ops dist-tag workflow to point `beta` at
    the stable version, then verify both `latest` and `beta` point at that
    version.
32. For stable releases, start
    `openclaw/releases/.github/workflows/openclaw-macos-publish.yml` for the
    real publish with the successful release-ops mac `preflight_run_id` and wait
    for success.
33. Verify the successful real release-ops mac run uploaded the `.zip`, `.dmg`,
    and `.dSYM.zip` artifacts to the existing GitHub release in
    `openclaw/openclaw`.
34. For stable releases, download `macos-appcast-<tag>` from the successful
    release-ops mac run, update `appcast.xml` on `main`, verify the feed, then
    complete the **Close stable releases on main** gate.
35. For beta releases, publish the mac assets only when intentionally requested;
    expect no shared production
    `appcast.xml` artifact and do not update the shared production feed unless a
    separate beta feed exists.
36. After stable main closeout, verify npm and the attached release artifacts.

## GHSA advisory work

- Use `openclaw-ghsa-maintainer` for GHSA advisory inspection, patch/publish flow, private-fork validation, and GHSA API-specific publish checks.
