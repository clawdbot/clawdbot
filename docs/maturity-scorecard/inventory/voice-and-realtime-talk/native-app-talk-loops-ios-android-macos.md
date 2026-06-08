---
title: "Voice and realtime talk - Native App Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Native App Talk Maturity Note

## Summary

Native Talk exists across macOS, iOS, Android, and shared OpenClawKit parsing. Coverage is Alpha because each platform has meaningful source and tests, but cross-device realtime proof and parity are uneven. Quality is Alpha because operator-facing behavior still differs by platform, with macOS realtime speech-to-speech parity and Android wake/manual-mic limitations visible in docs and archive evidence.

## Category Scope

Included in this category:

- macOS native Talk mode: macOS native Talk mode, speech recognition, TTS playback, and push-to-talk handoff
- iOS Talk mode: iOS Talk mode, WebRTC sessions, realtime relay sessions, and wake preferences
- Android Talk mode: Android Talk mode, speech-recognizer mode, realtime relay, mic capture, and debug E2E receiver
- Shared Talk config: Shared Talk config and command parsing

## Features

- macOS native Talk mode: macOS native Talk mode, speech recognition, TTS playback, and push-to-talk handoff
- iOS Talk mode: iOS Talk mode, WebRTC sessions, realtime relay sessions, and wake preferences
- Android Talk mode: Android Talk mode, speech-recognizer mode, realtime relay, mic capture, and debug E2E receiver
- Shared Talk config: Shared Talk config and command parsing

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`

Native source and unit-level platform proof are broad, and Android has a debug E2E receiver/script. Coverage remains Alpha because native realtime behavior is not as uniformly documented or live-smoked as browser/Gateway relay behavior.

## Quality Score

- Score: `Alpha (64%)`

Quality is helped by permission gates, silence handling, fallback playback, shared config parsing, and platform-specific session managers. It remains Alpha because the docs and archive show platform parity gaps, disabled/manual Android wake, provider-specific fallback history, and open macOS realtime speech-to-speech work.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for macOS native Talk mode, iOS Talk mode, Android Talk mode, Shared Talk config.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- macOS OpenAI realtime speech-to-speech parity remains open.
- Android voice wake is documented as disabled/manual mic.
- Native provider behavior is not yet as cohesive as the browser/Gateway relay paths.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:9` documents native macOS/iOS/Android STT/TTS Talk runtime shapes.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:126` documents macOS and Android native Talk behavior, permissions, fallback, `talk.speak`, MLX, latency tier validation, and Android PCM formats.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voicewake.md:39` documents macOS push-to-talk hotkey behavior and forwarding into Gateway commands.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/TalkModeRuntime.swift:9` implements macOS Talk mode runtime, speech recognition, silence handling, and playback.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoicePushToTalk.swift:39` implements push-to-talk hotkey and overlay handoff.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/TalkModeManager.swift:31` implements iOS Talk state and provider selection.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/RealtimeTalkRelaySession.swift:154` starts iOS realtime relay sessions through Gateway `talk.session.create`.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/TalkRealtimeWebRTCSession.swift:78` starts iOS WebRTC Talk sessions.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt:90` implements Android Talk mode state, speech-recognizer path, and realtime session state.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/MicCaptureManager.kt:270` handles Talk events, chat events, assistant reply playback, and transcription sessions.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawKit/TalkCommands.swift:3` defines shared Talk command names.

### Integration tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/debug/java/ai/openclaw/app/VoiceE2eReceiver.kt`
- `/Users/kevinlin/code/openclaw/apps/android/scripts/voice-e2e.sh`
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceTests/RealtimeTalkRelaySessionTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/TalkModeRuntimeSpeechTests.swift`

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/TalkAudioPlayerTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/TalkModeGatewayConfigTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/VoicePushToTalkTests.swift`
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceTests/TalkModeIncrementalSpeechBufferTests.swift`
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceTests/TalkSpeechLocaleTests.swift`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkAudioPlayerTest.kt`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkDirectiveParserTest.kt`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/MicCaptureManagerTest.kt`

### Gitcrawl queries

- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #71195 for macOS OpenAI realtime speech-to-speech parity, #85275 for spoken-output mismatch, and related provider/setup issues.
- `gitcrawl search issues "macOS Talk voice wake push to talk" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #87140 for pluggable STT backend for macOS Push-to-Talk.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "talk realtime voice" --limit 5` returned 2026-05-27 release notes saying Talk and voice runs can be inspected, steered, cancelled, and followed up.
- `/Users/kevinlin/.local/bin/discrawl search "Android realtime voice e2e relay path" --limit 5` returned no direct results.
- `/Users/kevinlin/.local/bin/discrawl search "talk.speak voice directive" --limit 5` returned #65661 fixed-on-main evidence for macOS configured voice fallback behavior.
