---
title: "macOS companion app - Menu Status and Dashboard Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Menu Status and Dashboard Maturity Note

## Summary

The menu-bar surface is a complete operator shell for toggles, health summaries, node/pairing state, usage, WebChat, Canvas, Talk, settings, debug actions, and dock shortcuts. Coverage is Beta because the menu shell is broad and rendered across connection modes in smoke coverage, but there is no full live menu-status scenario that drives agent work, node state, health, and dashboard actions together. Quality is Beta with visible risk from archive reports about duplicate icons, credential flicker, and native chat hangs.

## Category Scope

- Menu-bar status, action menu, status icon state, dock menu, dashboard/chat/canvas/talk shortcuts.
- Activity state ingestion and status row behavior.
- Out of scope: browser Control UI dashboard internals.

## Features

- Menu-bar status: Menu-bar status, action menu, status icon state, dock menu, dashboard/chat/canvas/talk shortcuts
- Activity state ingestion: Activity state ingestion and status row behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Docs specify status row and icon behavior. Source renders menu toggles and shortcuts in local, remote, and unconfigured modes. Smoke tests build menu content and dock shortcuts.
- Negative signals: Coverage does not prove real agent-event ingestion, health transitions, pairing prompts, usage snapshots, and Dashboard/WebChat/Canvas actions in a running app.
- Integration gaps: Missing a live macOS app scenario that drives a main-session job, non-main job, health degradation, pairing approval, WebChat open, Canvas open, and dashboard open from the menu.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query results include PR #82739 for duplicate menu bar icons, issue #85352 for credentials-gate flicker on menu open, and issue #71586 for companion app chat UI hang when using the status-bar menu.
- Discrawl reports: Discord search for `macOS menu bar` mostly surfaced adjacent menu-bar app discussion, not a high-volume OpenClaw support cluster.
- Good qualities: Menu source keeps common controls close to the status item, hides health while work is active, separates devices from presence entries, and exposes debug actions behind a debug pane.
- Bad qualities: Archive reports show native menu/application shell regressions have occurred, and status correctness depends on several asynchronous stores updating together.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Menu-bar status, Activity state ingestion.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a deterministic status/icon scenario for agent events, health, node pairing, and usage snapshots.
- Need clearer operator guidance when the menu shows a degraded state but the dashboard, WebChat, or node service disagree.
- Need recurring regression proof for duplicate status items and credential-gate flicker.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/menu-bar.md` defines menu-visible work state, context submenu, usage row, status priority, event ingestion, and testing checklist.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/icon.md` describes working/idle icon behavior and debug override.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` lists native notifications and menu-bar status as first-class app features.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift` renders connection status, health, node state, pairing prompts, browser/camera/exec/canvas/voice toggles, dashboard/chat/canvas/talk actions, settings, debug actions, and quit.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/IconState.swift` maps main/other work states to badge symbols and working state.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/AppNavigationActions.swift` routes menu actions to Dashboard, Chat, and Canvas.

### Integration tests

- No dedicated live app menu-status integration scenario was found.
- `/Users/kevinlin/code/openclaw/test/scripts/package-mac-app.test.ts` only covers package-script behavior relevant to app launch artifacts.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MenuContentSmokeTests.swift` builds menu content in local, remote, unconfigured, debug/canvas states and verifies dock menu shortcuts.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/CritterIconRendererTests.swift` and `MasterDiscoveryMenuSmokeTests.swift` cover adjacent icon/discovery UI surfaces.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS menu bar" --json`

Results:

- PR #82739 `fix(macos): prevent duplicate menu bar icons`.
- Issue #85352 `macOS menu bar app flashes credentials gate on open`.
- Issue #71586 `macOS companion app chat UI hangs when dragging scrollbar thumb up and down`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS menu bar"`

Results:

- Search returned mostly adjacent menu-bar app discussion, not a direct OpenClaw support cluster.
- No direct high-volume menu-status operator confusion cluster appeared in the top five results.
