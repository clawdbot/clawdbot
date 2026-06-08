---
title: "iOS app - Media and Sharing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Media and Sharing Maturity Note

## Summary

iOS media support is implemented across camera snap/clip, photo-library reads, screen recording, local payload bounding, and a Share Extension that forwards text, URLs, and attachments to the paired Gateway as `agent.request`. Coverage is Experimental because there is no current public/TestFlight media smoke proving camera, photo, share, and transcript persistence end to end. Quality is mid Experimental because payload limits and permission errors are explicit, while archive records show media metadata and large-attachment regressions still affect mobile/share paths.

## Category Scope

Included in this category:

- Camera list/snap/clip: Camera list/snap/clip, photo-library latest image payloads, screen recording as media, Share Extension draft/send flow, attachment extraction, gateway relay settings for share, and mobile media payload limits

## Features

- Camera list/snap/clip: Camera list/snap/clip, photo-library latest image payloads, screen recording as media, Share Extension draft/send flow, attachment extraction, gateway relay settings for share, and mobile media payload limits

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`
- Positive signals: The manual iOS node e2e script can invoke `photos.latest`, `camera.snap`, and `screen.record` against a connected node; app and shared Swift unit tests cover parameter bounds and share deep-link behavior.
- Negative signals: No automated real-device media scorecard was found for camera permissions, front/back device selection, clip audio, photo-library limits, Share Extension attachment delivery, transcript metadata persistence, and foreground/background failure modes.
- Integration gaps: Need a current TestFlight or real-device smoke that captures camera/photo/screen/share artifacts and verifies they appear in the Gateway transcript with metadata intact.

## Quality Score

- Score: `Experimental (45%)`
- Gitcrawl reports: `iOS share extension media metadata` found issue #60339 for offloadedRefs metadata lost in iOS share/node transcripts and PR #86936 to persist media metadata in `agent.request` transcripts. `iOS app` also found PR #73711 for photos-picker-style iOS attachment thumbnails.
- Discrawl reports: `iOS camera photos share extension media` returned no hits. Broader `iOS app` and `iOS node commands foreground background unavailable` results mention camera foreground requirements and internal-preview/TestFlight limits.
- Good qualities: Camera output defaults are bounded, photo-library responses stay under Gateway WebSocket payload budgets, Share Extension records status events, retries legacy client id on protocol mismatch, and uses a paired Gateway config rather than unauthenticated upload.
- Bad qualities: The media path still relies on base64 payloads for several commands, foreground-only commands are easy to invoke from the wrong state, and recent archive records show transcript metadata preservation was still being repaired.
- Excluded from quality: Unit tests and manual media invocation script were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Camera list/snap/clip.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a media release smoke covering camera snap, camera clip with and without audio, photo-library retrieval, Share Extension image forwarding, and transcript metadata retention.
- Move large media flows toward durable handles where base64 payload budgets are too tight.
- Expose clearer in-app recovery for camera/photo permission failures and background-only errors.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` lists camera, screen, photos, and foreground/background limits.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` lists camera snap/clip, screen record, photos, and Share Extension deep-link forwarding as current concrete features.
- `/Users/kevinlin/code/openclaw/docs/nodes/camera.md` documents the cross-node camera command family.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Camera/CameraController.swift` implements photo and clip capture with permissions, device selection, JPEG transcode, and MP4 export.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Media/PhotoLibraryService.swift` implements `photos.latest` with payload budgets and JPEG downscaling.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Screen/ScreenRecordService.swift` records screen video payloads.
- `/Users/kevinlin/code/openclaw/apps/ios/ShareExtension/ShareViewController.swift` prepares a share draft and sends `agent.request` through a paired Gateway node session.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` includes `photos.latest` and optional dangerous `camera.snap` and `screen.record` invocations.
- No automated real-device media and Share Extension e2e artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/CameraControllerClampTests.swift`, `CameraControllerErrorTests.swift`, and `ScreenRecordServiceTests.swift` cover parameter bounds and errors.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/ShareToAgentDeepLinkTests.swift` covers share message and route encoding.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatImageProcessorTests.swift` covers shared image processing helpers.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS share extension media metadata" --json`

Results:

- Issue #60339 `[Bug]: bug(gateway): offloadedRefs metadata lost in transcript for iOS share/node path`.
- PR #86936 `fix(gateway): persist media metadata in agent.request transcripts`.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "iOS app" --json` found PR #73711 for iOS photos-picker-style attachment thumbnails.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS camera photos share extension media"`

Results:

- No hits.

Additional query context:

- `discrawl search --mode fts --limit 5 "iOS node commands foreground background unavailable"` found support guidance that camera and screen commands require the iOS app foregrounded.
