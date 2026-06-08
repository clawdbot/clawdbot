---
title: "iOS app - Canvas and Screen Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Canvas and Screen Maturity Note

## Summary

Canvas and A2UI are real iOS node features: the app hosts a WKWebView scaffold, can navigate to Gateway-hosted Canvas/A2UI pages, evaluates JavaScript, captures snapshots, processes A2UI JSON/JSONL actions, and exposes screen recording. Coverage is still Experimental because the strongest proof is source, unit tests, docs, and manual node invocation rather than an automated real-device Canvas flow. Quality is high Experimental because the implementation includes loopback blocking and trust checks, but foreground requirements and host reachability remain common operator pitfalls.

## Category Scope

Included in this category:

- Canvas present/hide/navigate/eval/snapshot: Canvas present/hide/navigate/eval/snapshot, A2UI reset/push/pushJSONL, WKWebView scaffold loading, trusted A2UI action bridge, screen recording, foreground command gates, and Gateway Canvas host URL handling

## Features

- Canvas present/hide/navigate/eval/snapshot: Canvas present/hide/navigate/eval/snapshot, A2UI reset/push/pushJSONL, WKWebView scaffold loading, trusted A2UI action bridge, screen recording, foreground command gates, and Gateway Canvas host URL handling

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (44%)`
- Positive signals: Docs provide concrete `canvas.navigate`, `canvas.eval`, and `canvas.snapshot` examples. `scripts/dev/ios-node-e2e.ts` can run dangerous `screen.record` against a connected iOS node. Unit tests cover Canvas and A2UI helpers in shared Swift code.
- Negative signals: No automated iOS Canvas e2e was found that boots the app, pairs it, opens the Screen tab, validates A2UI readiness, and captures a snapshot from a real device or simulator.
- Integration gaps: Need repeatable foreground iOS Canvas proof for scaffold load, Gateway host load, A2UI push, action callback trust, JavaScript eval, JPEG/PNG snapshot, and screen recording.

## Quality Score

- Score: `Experimental (47%)`
- Gitcrawl reports: `iOS canvas screen A2UI` found PR #80802 for Talk/Canvas hardening and issue #68497 about exposing A2UI action bridge behavior outside native nodes. Broader `ios-node` search found issue #66983 noting Canvas commands are currently native-node centric.
- Discrawl reports: `iOS canvas screen A2UI snapshot node` found a support note describing iOS node Canvas/WKWebView, A2UI, snapshot capture, and deep-link interception. `iOS node commands foreground background unavailable` found support guidance that `canvas.*` and `screen.*` require the app foregrounded.
- Good qualities: Loopback Canvas URLs are blocked for remote Gateway loads, A2UI trusted URL comparison normalizes case/fragments, A2UI readiness retries with capability refresh, and snapshot defaults are bounded.
- Bad qualities: Operator success depends on foreground state and reachable Gateway Canvas host configuration; `A2UI_HOST_NOT_CONFIGURED` and foreground-only behavior are documented but still easy to encounter during first use.
- Excluded from quality: Canvas tests and the manual node script were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (44%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Canvas present/hide/navigate/eval/snapshot.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an iOS Canvas release-smoke artifact that proves a nonblank WKWebView, A2UI message application, trusted action callback, and snapshot output.
- Make foreground requirements and Gateway host reachability more visible in the in-app Screen tab.
- Add a public support boundary for Canvas behavior in internal/TestFlight builds.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents Canvas/A2UI usage, Gateway Canvas host paths, foreground relationship, and `node.invoke` examples.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` lists `canvas present/navigate/eval/snapshot` and screen record as foreground iPhone node commands.
- `/Users/kevinlin/code/openclaw/docs/refactor/canvas.md` and `/Users/kevinlin/code/openclaw/extensions/canvas/` document the adjacent Canvas host/plugin surface.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel+Canvas.swift` resolves Gateway Canvas and A2UI URLs, blocks loopback hosts, and refreshes host capabilities.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Screen/ScreenController.swift` hosts WKWebView Canvas, evaluates JS, captures snapshots, and validates trusted A2UI action origins.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Screen/ScreenRecordService.swift` implements screen recording.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawKit/CanvasCommands.swift` and `CanvasA2UICommands.swift` define shared command contracts.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` can invoke `screen.record` against a connected iOS node when `--dangerous` is set.
- No automated iOS Canvas/A2UI real-device e2e artifact was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/ScreenControllerTests.swift` and `ScreenRecordServiceTests.swift` cover screen behavior and screen recording parameter bounds.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Tests/OpenClawKitTests/CanvasA2UITests.swift`, `CanvasA2UIActionTests.swift`, and `CanvasSnapshotFormatTests.swift` cover shared Canvas contracts.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS canvas screen A2UI" --json`

Results:

- PR #80802 `[codex] Harden Talk, Canvas, and add macOS ambient overlay`.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "ios-node" --json` found issue #68497 about A2UI action bridge behavior and issue #66983 about Canvas node support being native-node focused.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS canvas screen A2UI snapshot node"`

Results:

- Discord support note describes iOS node Canvas as a WKWebView with bundled scaffold, A2UI, JS eval, snapshot capture, and deep-link interception.
- A separate support note under `iOS node commands foreground background unavailable` says `canvas.*` and `screen.*` are foreground-only on mobile nodes.
