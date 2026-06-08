---
title: "Android app - Media Capture Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Media Capture Maturity Note

## Summary

Android media capture includes CameraX photo and clip capture, image payload resizing, camera HUD feedback, WebView Canvas/A2UI, photo-library access in the third-party flavor, and live capability checks for camera/canvas commands. Coverage is Alpha because the implementation is real but foreground-only and the Android camera docs are not fully aligned with the source command set. Quality is Alpha because permissions, payload limits, WebView readiness, Play flavor restrictions, and foreground state make the operator path fragile.

## Category Scope

Included in this category:

- Camera and media capture: Camera listing, capture, photo, screen, and media capture behavior.

## Features

- Camera and media capture: Camera listing, capture, photo, screen, and media capture behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: Android docs cover Canvas and camera foreground commands; source implements CameraX photo/clip capture, permission prompting, payload guards, A2UI/WebView actions, and photo-library access where the flavor permits it. The live capability suite profiles `camera.list`, `camera.snap`, `camera.clip`, `canvas.*`, and `canvas.a2ui.*`.
- Negative signals: Live capability tests are preconditioned on a paired, foregrounded, unlocked app and require the Screen tab for Canvas/A2UI. Docs for shared camera commands only list Android `camera.list` in the Android section even though source and platform docs expose snap/clip.
- Integration gaps: Need a real-device Android media scorecard that keeps the app foregrounded, grants camera/mic/photo permissions, invokes front/back photo, short clip with/without audio, Canvas navigate/eval/snapshot, and records background failure behavior.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: `camera.snap Android` found issue #87058 where Android node connected but advertised zero commands; the snippet notes `camera.snap`, `camera.clip`, and `canvas.*` are high-risk gated commands. `photos.latest Android` returned no direct hits.
- Discrawl reports: Search found January support messages describing Android node camera snap/clip, Canvas, voice wake, and screen recording as supported node abilities, and warning that nodes are often offline or foreground dependent.
- Good qualities: Camera commands request runtime permissions, clamp clip duration, cap payload size, recompress JPEGs under API limits, show camera HUD state, and separate Play flavor from third-party photo access.
- Bad qualities: Media commands are foreground-only, WebView/A2UI depends on Screen tab readiness and Gateway canvas host reachability, and Play flavor removes photo-library permissions. Source/docs alignment is imperfect for Android camera command details.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Camera and media capture.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Align `/nodes/camera` Android command docs with source and platform docs for `camera.snap` and `camera.clip`.
- Add a foreground/background media failure-mode runbook with exact operator messages.
- Decide whether `photos.latest` is supported only for third-party builds or should have a Play-safe replacement.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents Canvas host, `canvas.eval`, `canvas.snapshot`, `canvas.navigate`, A2UI commands, and foreground-only camera commands `camera.snap` and `camera.clip`.
- `/Users/kevinlin/code/openclaw/docs/nodes/camera.md` documents Android camera settings, permissions, foreground requirement, and `camera.list`; its Android command list is narrower than the source and platform page.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` documents Screen tab requirements for A2UI integration tests and says Play builds remove photo-library access.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/CameraCaptureManager.kt` implements CameraX device listing, photo capture, clip recording, permission requests, EXIF rotation, JPEG scaling, and payload limits.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/CameraHandler.kt` handles `camera.list`, `camera.snap`, `camera.clip`, HUD state, debug logging, clip size limits, and base64 payloads.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/PhotosHandler.kt` implements `photos.latest` with permission checks, latest image query, resizing, and base64 budget caps.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/CanvasScreen.kt` implements the WebView Canvas, safe browsing settings, WebMessage A2UI bridge, visibility lifecycle, and render-process handling.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/node/InvokeDispatcher.kt` enforces foreground requirement for camera and canvas commands.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/android-node.capabilities.live.test.ts` includes profiles for `camera.list`, `camera.snap`, `camera.clip`, `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, and A2UI push/reset commands.
- `/Users/kevinlin/code/openclaw/apps/android/scripts/perf-online-benchmark.sh` checks Screen tab WebView availability before running the screen benchmark.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/node/CameraHandlerTest.kt`, `JpegSizeLimiterTest.kt`, `PhotosHandlerTest.kt`, `CanvasControllerSnapshotParamsTest.kt`, `CanvasActionTrustTest.kt`, and `CanvasA2UIActionBridgeTest.kt` cover media and canvas helpers.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/node/InvokeDispatcherTest.kt` covers command dispatch behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "camera.snap Android" --json`

Results:

- Issue #87058 `Android node connects but advertises zero commands ...`; snippet notes `camera.snap`, `camera.clip`, and `canvas.*` as correctly gated high-risk commands.

Query:

`gitcrawl search openclaw/openclaw --query "photos.latest Android" --json`

Results:

- No direct hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android camera snap screen canvas"`

Results:

- 2026-01-03 support messages describe Android nodes as paired companion devices that can expose camera snap/clip, Canvas, screen recording, and audio/TTS surfaces, while noting real availability depends on node connectivity.
