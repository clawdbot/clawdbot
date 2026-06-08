---
title: "watchOS companion surfaces - Distribution and Support Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Distribution and Support Maturity Note

## Summary

The watchOS companion is wired as an embedded Watch app and WatchKit extension inside the iOS project, with signing variables, icon assets, Fastlane/TestFlight release automation, and iOS app versioning support. Coverage is Experimental because the evidence is project/source plus maintainer release tooling rather than a repeatable public watch install scenario. Quality is Experimental because the build boundary is explicit and maintainable, but the public support boundary still says internal preview and no public distribution.

## Category Scope

Included in this category:

- Watch app: Watch app and WatchKit extension targets
- Signing/profile variables: Signing/profile variables, bundle identifiers, icon assets, and iOS beta release flow
- Public/support status: Public/support status for the watch companion as distributed through the iOS app
- Changelog: Changelog and repo-history evidence for watchOS companion maturity
- Release metadata: Release metadata and app-store/TestFlight preparation evidence
- Historical bug/regression themes relevant to scoring: Historical bug/regression themes relevant to scoring current source quality

## Features

- Watch app: Watch app and WatchKit extension targets
- Signing/profile variables: Signing/profile variables, bundle identifiers, icon assets, and iOS beta release flow
- Public/support status: Public/support status for the watch companion as distributed through the iOS app
- Changelog: Changelog and repo-history evidence for watchOS companion maturity
- Release metadata: Release metadata and app-store/TestFlight preparation evidence
- Historical bug/regression themes relevant to scoring: Historical bug/regression themes relevant to scoring current source quality

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (38%)`
- Positive signals: `apps/ios/project.yml` declares `OpenClawWatchApp` and `OpenClawWatchExtension`, embeds the watch target from the iOS app, and points both targets at signing/profile variables. `apps/ios/README.md`, Fastlane setup, versioning docs, and package scripts cover source builds, beta archive/upload, and stable TestFlight train versioning.
- Negative signals: Public docs still state that the iOS app is internal preview and not publicly distributed. No public TestFlight install path, App Store watch install proof, or repeatable watch-target release smoke was found in the repo.
- Integration gaps: Need a release-gate scenario that builds the iOS app with embedded watch app, uploads or installs it through the intended distribution path, pairs a real watch, and verifies the watch app launches from the companion install.

## Quality Score

- Score: `Experimental (48%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "watch app" --json` found mostly unrelated results, plus iOS signing friction in PR #41284 and an adjacent mobile offline-queue issue #46664. `gitcrawl search openclaw/openclaw --query "Apple Watch" --json` found no direct current watchOS implementation bug; the closest adjacent hit was #46664 mentioning future iOS/Apple Watch complication/queue ideas.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` found public interest and support-boundary discussion, including a TestFlight access request that was answered with "no public TestFlight" and source-build guidance. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"` found a maintainer-preview summary: source builds work, no general public TestFlight, and WatchOS exec approvals require manual iOS compilation and local APNs config.
- Good qualities: The watch targets are not hidden ad hoc files; they live in the generated Xcode project model, use version/signing variables, and share the iOS release/versioning lane.
- Bad qualities: Distribution is still maintainer/internal-beta shaped. Operator docs do not give a watch-specific installation, pairing, or troubleshooting path.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (38%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Watch app, Signing/profile variables, Public/support status, Changelog, Release metadata, Historical bug/regression themes relevant to scoring.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish a watch-specific install/support boundary that matches the actual TestFlight or source-build state.
- Add a release smoke that proves the embedded Watch app survives project generation, archive, signing, and install.
- Document how watch bundle IDs and profiles should be configured for local versus official builds.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` says the iOS app is "internal preview" and not publicly distributed.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` describes "Super Alpha", local Xcode deployment, internal beta distribution, and TestFlight upload through Fastlane.
- `/Users/kevinlin/code/openclaw/apps/ios/VERSIONING.md` documents TestFlight train versioning.
- `/Users/kevinlin/code/openclaw/apps/ios/fastlane/SETUP.md` documents App Store Connect auth and beta archive/upload setup.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/project.yml` defines `OpenClawWatchApp` as `application.watchapp2` and `OpenClawWatchExtension` as `watchkit2-extension`, with WatchConnectivity and UserNotifications dependencies.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchApp/Info.plist` and `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Info.plist` are the watch target info plists.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchApp/Assets.xcassets/AppIcon.appiconset/` contains watch app icon assets.
- `/Users/kevinlin/code/openclaw/package.json` defines `ios:gen`, `ios:open`, `ios:build`, `ios:beta:archive`, and `ios:beta` scripts.

### Integration tests

- No watchOS install/archive/live-device scenario was found.
- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` exercises connected iOS node commands, but it does not cover the Watch app or WatchConnectivity path.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/scripts/ios-version.test.ts`, `ios-pin-version.test.ts`, and `ios-team-id.test.ts` cover iOS version/signing helper behavior, not watch-specific install success.
- No watch target build smoke or WatchKit extension test target was found.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "watch app" --json`

Results:

- Mostly unrelated "watch" keyword hits; relevant adjacent results include PR #41284 for iOS signing friction and issue #46664 for future mobile/watch offline queue concepts.

Query:

`gitcrawl search openclaw/openclaw --query "Apple Watch" --json`

Results:

- No direct current watchOS implementation bug; adjacent #46664 mentions future iOS/Apple Watch complication ideas.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- Public TestFlight/access discussion says the app can be built from source but no public TestFlight is generally open.
- A TestFlight access request specifically mentions using the Apple Watch companion for notifications and quick voice responses.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "WatchOS support"`

Results:

- Maintainer-preview summary says iOS and WatchOS are in the repo, watchOS exec approvals work in current builds, but the path still needs manual iOS compilation and local APNs config.
