---
title: "watchOS companion surfaces - Watch App UI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# watchOS companion surfaces - Watch App UI Maturity Note

## Summary

The Watch extension has a real SwiftUI inbox that can show generic prompts, action buttons, exec approval lists/details, loading/retry states, timestamps, and persisted state. Coverage is Experimental because this is source-backed with no watch UI smoke, snapshot, or real-device scenario. Quality is Alpha because the UI is intentionally small and stateful, but it has little public documentation, no user-facing diagnostics, and no evidence of accessibility or complication behavior.

## Category Scope

Included in this category:

- Watch app entry point: Watch app entry point and SwiftUI navigation
- Generic inbox: Generic inbox, prompt actions, exec approval loading/list/detail views
- Persistent watch inbox state: Persistent watch inbox state and duplicate-delivery suppression

## Features

- Watch app entry point: Watch app entry point and SwiftUI navigation
- Generic inbox: Generic inbox, prompt actions, exec approval loading/list/detail views
- Persistent watch inbox state: Persistent watch inbox state and duplicate-delivery suppression

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (42%)`
- Positive signals: The Watch extension source implements the app entry point, inbox store, generic inbox view, exec approval loading view, list view, detail view, persisted state, dedupe keys, and notification authorization.
- Negative signals: No watch UI render smoke, snapshot, accessibility pass, or live Apple Watch scenario was found.
- Integration gaps: Need an on-device UI scenario for first launch, generic notification display, multiple approval list display, approval detail, retry/loading state, expired/resolved approval cleanup, and persistence after app relaunch.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: `gitcrawl search openclaw/openclaw --query "Apple Watch companion MVP" --json` returned no hits. `gitcrawl search openclaw/openclaw --query "Apple Watch" --json` found mostly unrelated results and future mobile/watch ideas.
- Discrawl reports: `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "Apple Watch"` found product-interest discussion around a low-bandwidth haptic/watch interaction model, but no current UI bug archive. `/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"` found requests for notifications and quick voice responses, which are not yet represented as public watch UI docs.
- Good qualities: The UI is focused on small-screen decisions rather than full chat. It handles multiple approvals, last result state, retry status, destructive buttons, duplicate delivery, and persisted state.
- Bad qualities: There is no source-backed public promise for the watch UI beyond internal preview. Voice response, haptics, complications, and screenshots are not documented as supported watch behavior.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Experimental (42%)`
- Surface instructions: evaluated against `references/completeness/watchos-companion-surfaces.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Watch app entry point, Generic inbox, Persistent watch inbox state.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add watch UI screenshots or a maintainer preview doc that states what the watch app currently supports.
- Add watch UI smoke/snapshot coverage for prompt, approval list, approval detail, and loading/retry states.
- Define whether voice replies, haptics, and complications are planned, experimental, or out of scope.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` does not currently describe the watch UI.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` describes the iOS app as super-alpha/internal-use only and does not provide watch UI usage docs.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/OpenClawWatchApp.swift` creates `WatchInboxStore`, activates `WatchConnectivityReceiver`, and refreshes approval review on launch/active scene phase.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchInboxView.swift` implements generic inbox, exec approval loading, list, and detail views.
- `/Users/kevinlin/code/openclaw/apps/ios/WatchExtension/Sources/WatchInboxStore.swift` persists inbox state in `UserDefaults`, prunes expired approvals, dedupes deliveries, and tracks reply/approval status text.

### Integration tests

- No watch UI or watch app launch integration test was found.

### Unit tests

- No direct tests for `WatchInboxStore`, `WatchInboxView`, or `OpenClawWatchApp` were found.
- iOS tests indirectly cover prompt and approval payloads sent toward the watch, but not watch UI rendering.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Apple Watch companion MVP" --json`

Results:

- No hits.

Query:

`gitcrawl search openclaw/openclaw --query "Apple Watch" --json`

Results:

- Mostly unrelated hits plus adjacent future mobile/watch queue ideas in #46664.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "Apple Watch"`

Results:

- Product-interest discussion emphasized low-bandwidth, private watch/haptic interaction, but did not provide current OpenClaw watch UI incident evidence.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 10 "iOS app watch"`

Results:

- Users requested Apple Watch notifications and quick voice responses; archive did not show public watch UI support docs.
