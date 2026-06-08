---
title: "iOS app - Distribution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Distribution Maturity Note

## Summary

The iOS app has a source-first internal preview path, XcodeGen project generation, local signing overrides, Fastlane archive/upload lanes, pinned CalVer versioning, App Store metadata files, and explicit local-vs-official push build flags. Coverage is Experimental because the distribution path is mostly manual and no recurring live TestFlight archive/upload smoke was found. Quality is Experimental because the implementation separates local signing, official bundle IDs, Keychain-backed App Store Connect secrets, relay-only official builds, and generated release metadata, but archive evidence still shows confused access requests, maintainer-operated distribution, and no public install route.

## Category Scope

Included in this category:

- Internal preview status: Internal preview status, source/Xcode manual deploy, local signing, XcodeGen project generation, Fastlane TestFlight archive/upload, versioning/changelog/metadata, release artifacts, and official-vs-local build flags

## Features

- Internal preview status: Internal preview status, source/Xcode manual deploy, local signing, XcodeGen project generation, Fastlane TestFlight archive/upload, versioning/changelog/metadata, release artifacts, and official-vs-local build flags

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`
- Positive signals: Source install and Xcode deploy steps are documented, package scripts wire signing/version prep into XcodeGen and xcodebuild, and Fastlane has local archive and TestFlight upload lanes.
- Negative signals: Public distribution is explicitly unavailable, TestFlight is maintainer-operated, no CI workflow was found for the iOS Xcode project build/archive/upload path, and no current live TestFlight upload or install-to-gateway release-smoke record was found.
- Integration gaps: Need a recurring release smoke that runs beta prep, archives the app, uploads or dry-runs TestFlight with a recorded build number, installs the resulting build, pairs it to a current Gateway, and verifies the official relay flags in the built app.

## Quality Score

- Score: `Experimental (45%)`
- Gitcrawl reports: `iOS TestFlight` found closed access-request issues #75684, #72763, and #64526; `TestFlight` also found closed access requests #61639 and #74869. More specific searches for `iOS TestFlight signing fastlane`, `iOS beta TestFlight OPENCLAW_PUSH_RELAY_BASE_URL`, `iOS version changelog TestFlight metadata`, `public TestFlight`, `beta_archive`, and `OPENCLAW_PUSH_DISTRIBUTION official` returned no matching issue/PR hits.
- Discrawl reports: Discord archive results include a March 11 PR mirror for #42991 adding the local Fastlane/TestFlight flow, a March 18 review comment on #48667 warning not to publish `beta_archive` output as a downloadable IPA because it bakes official relay flags, repeated April access-request responses saying there was no public TestFlight and users should build from source, an April 26 summary saying the app was still pre-alpha/maintainer-preview, and a May 23 user asking for the correct iOS install route because no public App Store or TestFlight link was visible.
- Good qualities: Local signing overrides are gitignored and generated per developer, App Store Connect private keys are Keychain-backed, beta prep refuses symlinked build outputs, relay base URLs are validated before entering xcconfig, official builds use canonical bundle IDs and `OpenClawPushDistribution=official`, local builds default to direct/local push, and pinned iOS versioning drives checked-in xcconfig and Fastlane release notes.
- Bad qualities: Operator access remains unclear outside maintainers, release artifacts are local-only, `apps/ios/Config/Signing.xcconfig` carries canonical team/bundle defaults that local contributors must override, there is no public install route, and archive records show stale or contradictory public availability messages around TestFlight/App Store status.
- Excluded from quality: Test coverage, CI depth, and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Internal preview status.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish one authoritative install/access status for internal preview, TestFlight, and any future public App Store route.
- Add a repeatable release-smoke artifact for beta archive/upload, installed TestFlight build verification, and official relay build flags.
- Decide whether downloadable unsigned/signed IPA artifacts are intentionally unsupported, and document that beside the Fastlane archive path.
- Record App Store Connect app ownership, tester-list operation, rollback, and release handoff expectations for maintainers.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/apps/ios/README.md` marks the app as super-alpha/internal-use only, says public distribution is unavailable, documents manual Xcode deploy, and documents local archive plus TestFlight upload via Fastlane.
- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` says availability is internal preview and describes official distributed builds using the external push relay instead of publishing raw APNs tokens to the gateway.
- `/Users/kevinlin/code/openclaw/apps/ios/VERSIONING.md` defines pinned CalVer iOS releases, TestFlight train behavior, version sync files, and promotion from the gateway version only by explicit maintainer action.
- `/Users/kevinlin/code/openclaw/apps/ios/fastlane/metadata/README.md` documents metadata upload, App Store Connect auth, release-note generation from the iOS changelog, and review-information files.

### Source

- `/Users/kevinlin/code/openclaw/package.json` defines `ios:open`, `ios:gen`, `ios:build`, `ios:run`, `ios:beta:archive`, `ios:beta`, and iOS version commands.
- `/Users/kevinlin/code/openclaw/apps/ios/project.yml` generates the Xcode project, includes SwiftFormat and SwiftLint prebuild scripts, maps bundle/version settings, and defaults Debug/Release to direct/local push flags.
- `/Users/kevinlin/code/openclaw/apps/ios/Config/Signing.xcconfig`, `apps/ios/LocalSigning.xcconfig.example`, and `scripts/ios-configure-signing.sh` define canonical signing defaults plus local-only team and bundle override generation.
- `/Users/kevinlin/code/openclaw/scripts/ios-beta-prepare.sh`, `scripts/ios-beta-archive.sh`, `scripts/ios-beta-release.sh`, and `apps/ios/fastlane/Fastfile` prepare beta xcconfig, resolve TestFlight build numbers, archive, and upload to TestFlight.
- `/Users/kevinlin/code/openclaw/scripts/ios-asc-keychain-setup.sh` stores App Store Connect `.p8` content in macOS Keychain and writes only non-secret Fastlane env keys.
- `/Users/kevinlin/code/openclaw/apps/ios/version.json`, `apps/ios/Config/Version.xcconfig`, `apps/ios/CHANGELOG.md`, and `apps/ios/fastlane/metadata/en-US/release_notes.txt` hold the pinned iOS version, generated xcconfig defaults, changelog, and derived release notes.
- `/Users/kevinlin/code/openclaw/.gitignore` ignores generated Xcode projects, `.local-signing.xcconfig`, `LocalSigning.xcconfig`, `apps/ios/build/`, local IPA/dSYM artifacts, provisioning files, and `apps/ios/fastlane/.env`.

### Integration tests

- `/Users/kevinlin/code/openclaw/.github/workflows/ci.yml` installs XcodeGen/SwiftLint/SwiftFormat in the macOS Swift lane, but the checked workflow does not run the iOS `OpenClaw.xcodeproj` build, Fastlane beta archive, or TestFlight upload path.
- `/Users/kevinlin/code/openclaw/package.json` exposes local `ios:build` and `ios:run` commands that exercise signing prep, version xcconfig generation, XcodeGen, xcodebuild, and simulator launch when run by a developer.
- No current automated archive/upload/install-to-gateway TestFlight release-smoke artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/scripts/ios-version.test.ts` covers pinned CalVer parsing, gateway-version normalization, Version.xcconfig rendering, and release-note extraction.
- `/Users/kevinlin/code/openclaw/test/scripts/ios-pin-version.test.ts` covers explicit and gateway-derived iOS version pinning plus generated artifact sync behavior.
- `/Users/kevinlin/code/openclaw/test/scripts/ios-team-id.test.ts` covers Apple team ID candidate parsing and selection used by signing setup.
- `/Users/kevinlin/code/openclaw/test/scripts/changed-lanes.test.ts` covers routing iOS version-file changes to the `ios:version:check` lane.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS TestFlight" --json`

Results:

- Closed issue #75684 `Request: iOS TestFlight Invite`.
- Closed issue #72763 `Request iOS TestFlight Access - Adam J. Graham`.
- Closed issue #64526 `Request iOS TestFlight Access`.

Query:

`gitcrawl search openclaw/openclaw --query "TestFlight" --json`

Results:

- Closed issue #75684 `Request: iOS TestFlight Invite`.
- Closed issue #74869 `Request: iOS Node TestFlight invite`.
- Closed issue #61639 `Request: TestFlight access for iOS app`.
- Closed issue #72763 `Request iOS TestFlight Access - Adam J. Graham`.
- Closed issue #64526 `Request iOS TestFlight Access`.

Query:

`gitcrawl search openclaw/openclaw --query "iOS TestFlight signing fastlane" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "iOS beta TestFlight OPENCLAW_PUSH_RELAY_BASE_URL" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "iOS version changelog TestFlight metadata" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "public TestFlight" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "beta_archive" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "OPENCLAW_PUSH_DISTRIBUTION official" --json`

Results:

- No hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS TestFlight signing fastlane"`

Results:

- 2026-03-11 `iOS Alpha`: maintainer message saying they were going to land PR #42991 for the TestFlight beta release flow.
- 2026-03-11 GitHub mirror: PR #42991 `feat(ios): add local beta release flow`, summarizing Fastlane/TestFlight prep, Xcode project regeneration, archive/export/upload from source, App Store Connect build-number lookup, and watch app beta packaging.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS beta TestFlight relay"`

Results:

- 2026-03-18 GitHub mirror: review comment on PR #48667 warns not to upload `beta_archive` output as a downloadable IPA because the official beta-release path bakes `OpenClawPushTransport=relay` and `OpenClawPushDistribution=official`.
- 2026-03-14 GitHub mirror: issue #46446 `Request iOS TestFlight Beta Access - @catallo`.
- 2026-03-12 maintainer digest: iOS TestFlight invites were sent and pre-alpha push notification relay was shipping that day.
- 2026-03-11 GitHub mirror: PR #43369 `feat(push): add iOS APNs relay gateway`, including iOS relay registration, App Attest, and official-build push configuration.
- 2026-02-24 and 2026-02-25 TestFlight support messages explain invite delays, Hide My Email relay-address handling, and TestFlight refresh/mailbox checks.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS TestFlight beta access"`

Results:

- 2026-04-25 GitHub mirror: issue #61639 comment closed as implemented after a Codex review claimed the app moved past invite-only beta, while noting stale docs.
- 2026-04-18 GitHub mirror: issue #68525 requested iOS TestFlight access and was closed with `Not available, build from source.`
- 2026-04-13 and 2026-04-08 GitHub mirrors: additional iOS TestFlight access requests for node capabilities.
- 2026-04-05 GitHub mirrors: repeated comments said there was no public TestFlight and users could build from source with Xcode.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS TestFlight invite"`

Results:

- 2026-05-23 `general`: user asked for the correct iOS access route because docs mentioned internal preview/official-TestFlight but no public App Store or TestFlight link was visible.
- 2026-04-26 summary: current read was still pre-alpha/maintainer-preview, source-build works, no official public TestFlight/invite flow exists, and developer account/org handoff was still being sorted.
- 2026-04-13 `iOS node`: reply said there was not an official iOS TestFlight/public invite path yet.
- 2026-04-03 `iOS App Testflight request`: user reported trouble requesting an invite because their Apple ID message was blocked.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "beta_archive official distribution iOS"`

Results:

- No hits.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "iOS build from source Xcode TestFlight"`

Results:

- 2026-03-11 GitHub mirror: PR #42991 `feat(ios): add local beta release flow`.
- 2026-02-19 `Openclaw iOS Node app?`: reply said there was no public TestFlight link and the current path was Xcode-only install from source.
- 2026-02-15 `How can I get access to test the iPhone app with TestFlight`: reply said there was no public TestFlight and recommended `pnpm ios:open`.
- 2026-02-14 `Access request for ios app`: reply said the app was alpha/internal preview, source build was fastest, and TestFlight required sharing an Apple ID email with maintainers.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 8 "public TestFlight iOS source Xcode"`

Results:

- 2026-04-05 GitHub mirrors: repeated comments on TestFlight access issues said there was no public TestFlight, users should watch Discord for public beta announcements, and the app could be built from source with Xcode.
