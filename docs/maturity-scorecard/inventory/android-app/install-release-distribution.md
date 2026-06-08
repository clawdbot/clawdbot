---
title: "Android app - Distribution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Distribution Maturity Note

## Summary

The Android app has a public Google Play install path, source build/run docs, Play and third-party product flavors, signed AAB release automation, version-code auto-bumping, and startup/performance scripts. Coverage remains Alpha because the app README still marks the rebuild as extremely alpha and leaves full end-to-end QA and release hardening unchecked. Quality is also Alpha: the Play policy split is a strong design choice, but archive evidence includes an outdated Play Store protocol mismatch and an open request for prebuilt APK release artifacts.

## Category Scope

Included in this category:

- Public Google Play install path: Public Google Play install path and source build/run entrypoints
- Manual install path: Manual install path and Google Play distribution behavior.
- Release smoke and startup performance: Release smoke and startup performance checks for Android app distribution.

## Features

- Public Google Play install path: Public Google Play install path and source build/run entrypoints
- Manual install path: Manual install path and Google Play distribution behavior.
- Release smoke and startup performance: Release smoke and startup performance checks for Android app distribution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (60%)`
- Positive signals: Public install is documented, source build/run commands exist, package scripts expose assemble/install/test/release tasks, release automation builds signed Play and third-party AABs, and Android benchmark scripts cover startup and online UI paths.
- Negative signals: The app README still labels the rebuild extremely alpha and leaves full end-to-end QA and release hardening incomplete. The release path is mostly documented and scripted, but no recurring public release smoke record was found.
- Integration gaps: Need a repeatable release checklist that installs the Play artifact, pairs it to a current Gateway, runs chat/voice/camera/background scenarios, verifies version compatibility, and records Play Console policy status.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: `Play Store Android app protocol mismatch` found issue #85971 for Play Store Android app v2026.4.5 protocol mismatch against Gateway >= v2026.5.12 and issue #87216 as a related manual LAN setup protocol-mismatch report. `Android APK releases` found issue #9443 requesting prebuilt Android APK releases.
- Discrawl reports: Search found a May 19 support message saying the Play Store app was outdated and had a protocol mismatch; the user built a newer app locally and then hit a connected/operator-offline state.
- Good qualities: Play and third-party flavors separate Google Play restricted permissions from sideload-only SMS, call-log, and photo surfaces. Release signing properties are kept local-only, release bundles are copied to a predictable output directory, and release AAB signatures are verified.
- Bad qualities: Distribution is still fragile for ordinary users because Play can lag Gateway protocol changes, APK artifacts are not fully productized, and docs explicitly say release hardening is unfinished.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (60%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Public Google Play install path, Manual install path, Release smoke and startup performance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish and record a current Play smoke path against the current Gateway protocol.
- Decide whether GitHub release APKs or third-party AAB/APK artifacts are part of the supported distribution promise.
- Add release hardening evidence for Play policy declarations, app signing, version skew, rollback, and fresh-install pairing.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` links the official Google Play app, describes Android as a companion node, and points to source under `apps/android`.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` marks the rebuild as extremely alpha, lists rebuild checklist items, documents Play and third-party builds, and calls out full end-to-end QA and release hardening as unchecked.
- `/Users/kevinlin/code/openclaw/README.md` lists Android as an optional node with Connect, Chat, Voice, Canvas, Camera, Screen, and device command families.

### Source

- `/Users/kevinlin/code/openclaw/package.json` defines `android:assemble`, `android:install`, `android:bundle:release`, `android:test`, `android:test:integration`, lint, and third-party variants.
- `/Users/kevinlin/code/openclaw/apps/android/app/build.gradle.kts` sets `applicationId = "ai.openclaw.app"`, `minSdk = 31`, `targetSdk = 36`, Play and third-party flavors, release signing checks, R8/resource shrinking, lint warnings as errors, and version `2026.5.28`.
- `/Users/kevinlin/code/openclaw/apps/android/scripts/build-release-aab.ts` auto-bumps version name/code, builds Play and third-party release bundles, verifies signatures with `jarsigner`, and prints SHA-256 hashes.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/play/AndroidManifest.xml` removes restricted media permissions from the Play flavor; `/Users/kevinlin/code/openclaw/apps/android/app/src/thirdParty/AndroidManifest.xml` adds SMS and call-log permissions for the third-party flavor.

### Integration tests

- `/Users/kevinlin/code/openclaw/apps/android/benchmark/src/main/java/ai/openclaw/app/benchmark/StartupMacrobenchmark.kt` and `apps/android/scripts/perf-startup-benchmark.sh` cover startup measurement.
- `/Users/kevinlin/code/openclaw/apps/android/scripts/perf-online-benchmark.sh` measures launch-to-connected, Screen tab, and Chat tab paths on a connected device.
- No current Play Store install to paired Gateway release-smoke artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/ui/OnboardingFlowLogicTest.kt` covers onboarding flow logic adjacent to install.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/SecurePrefsTest.kt` and `SecurePrefsNotificationForwardingTest.kt` cover stored app state used after install.
- Release AAB automation itself does not appear to have a dedicated unit test.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Play Store Android app protocol mismatch" --json`

Results:

- Issue #85971 `[Bug] Play Store Android app v2026.4.5 protocol mismatch against Gateway >= v2026.5.12 - clawx user report`.
- Issue #87216 `Android manual LAN setup parses ws:// as host ws and resolves http://ws:<port>`.

Query:

`gitcrawl search openclaw/openclaw --query "Android APK releases" --json`

Results:

- Issue #9443 `Request: Prebuilt Android APK releases`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android Play Store protocol mismatch"`

Results:

- 2026-05-19 support message: a user built the Android app locally because the Play Store app was outdated and had a protocol mismatch; the newer local build connected by Tailscale but reported operator offline.
