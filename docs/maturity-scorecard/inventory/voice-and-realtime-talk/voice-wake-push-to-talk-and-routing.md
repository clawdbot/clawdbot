---
title: "Voice and realtime talk - Voice Wake and Routing Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Voice Wake and Routing Maturity Note

## Summary

Voice Wake and push-to-talk are adjacent to Talk because they trigger and route voice capture into local apps and Gateway commands. Coverage is beta-level across docs, Gateway config, native runtime source, and platform tests. Quality remains Alpha because archive evidence includes wake failures, stale crash reports, overlay pinwheels, and pending idle-timeout behavior.

## Category Scope

Included in this category:

- Wake-word settings: Gateway-owned wake-word settings and routing preferences.
- Wake routing: Default, last-focused app, local app, and specific-node routing methods.
- macOS Voice Wake runtime: macOS Voice Wake runtime, push-to-talk hotkey, overlay adoption, pause/resume behavior, and forwarding
- Mobile wake preferences: iOS and Android wake preferences and command extraction.

## Features

- Wake-word settings: Gateway-owned wake-word settings and routing preferences.
- Wake routing: Default, last-focused app, local app, and specific-node routing methods.
- macOS Voice Wake runtime: macOS Voice Wake runtime, push-to-talk hotkey, overlay adoption, pause/resume behavior, and forwarding
- Mobile wake preferences: iOS and Android wake preferences and command extraction.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`

The component has dedicated docs, Gateway methods, native macOS runtime, iOS/Android preference managers, and a wide set of platform tests. Coverage is not stable because wake reliability requires real OS permission, audio, focus, and overlay behavior.

## Quality Score

- Score: `Alpha (66%)`

Quality has improved through Gateway-owned state, explicit routing, overlay lifecycle hardening, and push-to-talk pause/resume behavior. It remains Alpha because real-world wake reliability and overlay behavior have repeatedly failed in archive evidence.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Wake-word settings, Wake routing, macOS Voice Wake runtime, Mobile wake preferences.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Voice Wake idle timeout and auto-deactivation are still tracked.
- macOS Voice Wake has open and stale failure evidence.
- Overlay lifecycle and permission behavior remain operator-sensitive.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/voicewake.md:9` documents Gateway-owned wake words, native toggles, and Android disabled/manual mic behavior.
- `/Users/kevinlin/code/openclaw/docs/nodes/voicewake.md:28` documents `voicewake.get`, `voicewake.set`, routing methods, and broadcast events.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voicewake.md:12` documents wake-word and push-to-talk modes, pause timing, hard stop, overlay, and restart behavior.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voice-overlay.md:14` documents overlay adoption, per-capture tokens, unified send, and logging.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/voicewake.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/voicewake-routing.ts`
- `/Users/kevinlin/code/openclaw/src/infra/voicewake.ts`
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoiceWakeRuntime.swift:10` implements the background wake listener.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoicePushToTalk.swift:146` handles push-to-talk begin, permissions, overlay adoption, and wake runtime pause.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/VoiceWakeManager.swift`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/VoiceWakeManager.kt`

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-talk-nodes.test.ts`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeRuntimeTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoicePushToTalkTests.swift`

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeForwarderTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeGlobalSettingsSyncTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeHelpersTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeOverlayControllerTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoiceWakeOverlayTests.swift`
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceTests/VoiceWakeGatewaySyncTests.swift`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/VoiceWakeManagerTest.kt`

### Gitcrawl queries

- `gitcrawl search issues "voice wake" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #46844 for Talk Mode idle timeout/auto-deactivation, #87140 for macOS Push-to-Talk STT backend, #43480 for a VoiceWakeOverlay pinwheel, and related wake items.
- `gitcrawl search issues "macOS Talk voice wake push to talk" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #87140.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "voice wake push to talk" --limit 5` returned #34912 stale/closed crash evidence for Voice Wake/Push-to-Talk/Talk Mode, #64986 open evidence for macOS companion Voice Wake failure despite permissions, and release planning notes to split mac push-to-talk and voice wake from broader voice work.
