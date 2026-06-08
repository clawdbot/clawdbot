---
title: "macOS companion app - Canvas Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Canvas Maturity Note

## Summary

Canvas is a first-class macOS app feature with a WKWebView panel, custom local URL scheme, file watching, snapshots, JavaScript evaluation, Gateway canvas host auto-navigation, and A2UI v0.8 commands. Coverage is Beta because Canvas has concrete WKWebView and A2UI runtime paths with supporting smoke proof, but no full live agent-to-WKWebView scenario was found. Quality is Alpha because archive evidence shows recent A2UI visibility, allowlist, and payload delivery regressions.

## Category Scope

Included in this category:

- Canvas panel open/hide/navigate/eval/snapshot: Canvas panel open/hide/navigate/eval/snapshot behavior, status, and operator-visible verification.
- Local custom URL scheme: Local custom URL scheme and session-root file serving
- A2UI host auto-navigation: A2UI host auto-navigation, push/reset, and action bridge
- Canvas enable/disable setting: Canvas enable/disable setting and node command behavior

## Features

- Canvas panel open/hide/navigate/eval/snapshot: Canvas panel open/hide/navigate/eval/snapshot behavior, status, and operator-visible verification.
- Local custom URL scheme: Local custom URL scheme and session-root file serving
- A2UI host auto-navigation: A2UI host auto-navigation, push/reset, and action bridge
- Canvas enable/disable setting: Canvas enable/disable setting and node command behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Docs and source cover Canvas file roots, custom scheme, panel behavior, agent API, A2UI commands, deep links, and security. Unit/smoke tests cover IPC payloads, scheme safety, window smoke, A2UI host URL refresh, and snapshot size/error handling.
- Negative signals: Coverage does not prove a full Gateway-to-node `canvas.a2ui.push` reaching the WKWebView renderer in a running app. A2UI support is explicitly v0.8 and excludes `createSurface` v0.9.
- Integration gaps: Need a real app scenario that invokes `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.push`, and action bridge callback through Gateway node invoke.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: Results include issue #81159 where `canvas.a2ui.push` returns ok but payload never reaches WKWebView, issue #86707 where macOS node declares `canvas.*` commands that Gateway allowlist blocks, PR #62021 for wildcard A2UI host rewrite to loopback, and PR #86729 to add macOS canvas commands to platform allowlist.
- Discrawl reports: Archive includes #75039 as a should-backport fix for macOS Canvas A2UI content being wiped by redundant reload, #62609 closeout for loopback/Tailscale Serve A2UI host failure, and #66983 request for web canvas node support.
- Good qualities: Canvas blocks directory traversal, uses a custom scheme for local content, gates Canvas with a setting, fail-closes A2UI action credentials, and refreshes the A2UI host capability.
- Bad qualities: The feature depends on Gateway canvas host URLs, node platform allowlists, WKWebView load timing, custom scheme behavior, and A2UI version compatibility; recent archive hits are directly user-visible.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Canvas panel open/hide/navigate/eval/snapshot, Local custom URL scheme, A2UI host auto-navigation, Canvas enable/disable setting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need live A2UI push proof from Gateway through macOS node into WKWebView.
- Need platform allowlist and node command declaration parity to stay covered in release smoke.
- Need docs for v0.8/v0.9 A2UI compatibility and expected failure modes.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/canvas.md` documents Canvas storage, custom URL scheme, panel behavior, agent API, A2UI v0.8 commands, deep links, and security notes.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` lists Canvas commands as macOS node capabilities.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` is related through shared visual/chat surfaces but is not the primary Canvas doc.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/CanvasManager.swift` creates/reuses panels, auto-navigates to A2UI, tracks Gateway canvas host URL, and refreshes debug status.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/CanvasWindowController.swift` creates WKWebView, custom scheme handler, file watcher, A2UI action bridge, and panel/window behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/CanvasSchemeHandler.swift` serves session-root content and blocks escapes.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift` dispatches `canvas.*` and `canvas.a2ui.*` node commands.

### Integration tests

- No full Gateway node-invoke to live WKWebView Canvas scenario was found.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/CanvasWindowSmokeTests.swift` opens and closes the native window controller, but does not prove Gateway delivery.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/CanvasIPCTests.swift` covers Canvas IPC codable round trips.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/CanvasFileWatcherTests.swift` covers file-watcher behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MacNodeRuntimeTests.swift` covers A2UI host URL refresh.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/LowCoverageHelperTests.swift` covers custom scheme file serving and symlink escape blocking.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS canvas A2UI node" --json`

Results:

- Issue #81159 `canvas.a2ui.push / canvas.a2ui.pushJSONL returns ok but payload never reaches WKWebView renderer`.
- Issue #86707 `canvas.* commands declared by macOS node are blocked by gateway platform allowlist`.
- PR #62021 `fix(macos): rewrite wildcard A2UI host to loopback`.
- PR #86729 `fix(gateway): add canvas commands to macOS node platform allowlist`.
- Issue #83958 includes macOS app node command list and timeout behavior.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS canvas A2UI"`

Results:

- 2026-04-30 maintainer backport list marks #75039 `fix(macos): keep A2UI canvas content visible` as should-backport.
- 2026-04-25 GitHub mirror closes #62609 after capability-scoped canvas/A2UI access.
- 2026-04-15 GitHub mirror opens #66983 requesting broader web canvas node support.
