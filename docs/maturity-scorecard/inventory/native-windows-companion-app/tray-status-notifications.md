---
title: "Native Windows companion app - Tray, Status, and Native Notifications Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Tray, Status, and Native Notifications Maturity Note

## Summary

The desired Windows companion shape includes a system tray app and status
surface, but current OpenClaw main does not ship one. Archive evidence references
an external `openclaw-windows-node` suite with System Tray app scope, and review
comments on prior Windows companion PRs mention tray badge/status behavior. That
is not landed source support for the scorecard row.

## Category Scope

- Windows system tray app, status icon, status menu, native notifications, and app launch/quit controls.
- Status indicators for Gateway, node pairing, work activity, and updates.
- App-specific notification permission and failure handling.

## Features

- Windows system tray app: Windows system tray app, status icon, status menu, native notifications, and app launch/quit controls
- Status indicators: Status indicators for Gateway, node pairing, work activity, and updates
- App-specific notification permission: App-specific notification permission and failure handling

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (5%)`
- Positive signals: archive evidence shows tray/status work has been proposed and developed outside the current supported app surface.
- Negative signals: current main has no Windows tray app source, tray runtime, app icon/menu controller, native notification bridge, or app-level status loop.
- Integration gaps: no app-launch, tray-state, notification, Gateway status, or update-state scenario can be run for a supported Windows companion app.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (35%)`
- Gitcrawl reports: `#81673` mentions Windows companion suite/system tray/node packaging scope; `#73315` is a cross-platform desktop app PR, not landed support.
- Discrawl reports: `openclaw-windows-node` is described as a Windows companion suite with System Tray app, shared library, node, and PowerToys extension; a review comment on `#54588` flags stale tray badge/UI refresh behavior after remote node dequeue.
- Good qualities: the desired tray/status ownership is identifiable from archive activity.
- Bad qualities: no supported implementation, UX contract, fallback behavior, or operator docs exist in current main.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (5%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Windows system tray app, Status indicators, App-specific notification permission.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No tray source or status menu lives in the supported OpenClaw repo.
- No app notification contract is documented for Windows.
- Status UX for Gateway, node, pairing, update, and work activity is undefined in current docs.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md` does not document a Windows tray/status app.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents the macOS menu-bar companion behavior, which is adjacent parity context but not Windows support.

### Source

- `/Users/kevinlin/code/openclaw/apps/` has no Windows app directory.
- `/Users/kevinlin/code/openclaw/src/gateway/node-command-policy.ts:75-105` includes Windows node command defaults, but that is Gateway policy, not a tray app.

### Integration tests

- No Windows companion tray integration tests were found.
- Existing Windows Parallels smoke focuses on CLI/Gateway install, update, and agent turn behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/gateway-misc.test.ts:879-902` checks safe Windows companion node command policy defaults.
- No Windows tray/status unit tests were found in current main.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows tray app companion node" --json`
- `gitcrawl search openclaw/openclaw --query "safe Windows companion commands" --json`

Results:

- `#81673` open issue mentions Windows companion suite/system tray/node work.
- `#74163` open tracking PR surfaces Windows platform issues, but not landed tray support.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows tray app companion node"`

Results:

- `2026-03-13` GitHub mirror describes `openclaw/openclaw-windows-node` as a Windows companion suite with System Tray app, shared library, node, and PowerToys Command Palette extension.
- `2026-03-28` review comment on `#54588` flags tray badge/UI refresh stale state after remote node dequeue.
- `2026-04-26` GitHub mirror for `#71876` says the Windows tray app is now a full companion node, but that is archive/prototype context rather than current main source.
