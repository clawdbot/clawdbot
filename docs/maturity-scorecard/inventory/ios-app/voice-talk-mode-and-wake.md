---
title: "iOS app - Voice Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Voice Maturity Note

## Summary

iOS has a real but highly experimental voice stack: Talk mode, push-to-talk node commands, Speech recognition, gateway Talk configuration sync, voice wake trigger words, realtime Gateway relay sessions, local TTS playback, and microphone suppression between Talk, wake, and camera clip capture. Coverage remains Experimental because no current device-level voice scorecard was found for mic permissions, backgrounding, relay audio, barge-in, and provider fallback. Quality is Experimental because the code addresses many robustness concerns but docs and archive records still frame voice as foreground-first and sensitive to iOS audio limits.

## Category Scope

Included in this category:

- Voice wake: Voice wake, trigger-word sync, Talk Mode, push-to-talk commands, realtime Gateway relay, Speech and microphone permissions, audio session coordination, background suspension, and voice settings

## Features

- Voice wake: Voice wake, trigger-word sync, Talk Mode, push-to-talk commands, realtime Gateway relay, Speech and microphone permissions, audio session coordination, background suspension, and voice settings

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (38%)`
- Positive signals: Docs describe Talk and voice wake availability; source implements native and relay paths; unit tests cover config parsing, voice wake preferences, gateway sync parsing, and some realtime relay state behavior.
- Negative signals: No real-device iOS voice e2e artifact was found for mic permission prompts, Speech authorization, realtime relay audio frames, TTS fallback, foreground/background transitions, and wake-word trigger delivery.
- Integration gaps: Need a device voice scorecard covering Talk start/stop, PTT once/start/stop/cancel, voice wake command dispatch, realtime relay connection, provider failure, and background suspension/resume.

## Quality Score

- Score: `Experimental (43%)`
- Gitcrawl reports: `iOS voice wake talk` returned PR #81402 for runtime-state SQLite work that mentions voicewake state, but no direct iOS voice bug hits. Broader `iOS app` results included issue #47584 for Siri App Intent integration and PR #40877 for CLLocationManager/SFSpeechRecognizer main-thread warnings.
- Discrawl reports: `iOS voice wake talk microphone` found support guidance that Talk Mode is available on iOS nodes and uses microphone plus TTS. A February iOS app support note says bidirectional voice and hands-free are supported through Talk mode plus Voice Wake, but still foreground-first because background audio/socket suspension is a real limitation.
- Good qualities: Talk and wake coordinate microphone ownership, Talk suppresses voice wake during push-to-talk, realtime relay frames are bounded, simulator voice wake reports unsupported, and Gateway Talk config is synced.
- Bad qualities: Voice success depends on iOS foreground/audio session behavior, provider configuration, Speech availability, and user permission prompts; docs describe the feature as best-effort outside active foreground use.
- Excluded from quality: Unit tests for config and relay state were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (38%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice wake.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add real-device Talk/voice wake scorecards with latency, background, audio focus, and provider-failure evidence.
- Document exact behavior for Talk background keep-active, wake suppression, and microphone contention.
- Clarify Siri/App Intent as future work rather than current support.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents Voice wake, Talk mode, PTT commands, and best-effort background behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` states Talk and Voice Wake work but remain foreground-first and rough.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md` documents adjacent node Talk behavior.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/TalkModeManager.swift` implements Talk mode state, gateway config, PTT, TTS, speech capture, and background suspension.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/VoiceWakeManager.swift` implements trigger words, Speech recognition, microphone permission handling, and suppression.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Voice/RealtimeTalkRelaySession.swift` creates Gateway relay sessions and streams PCM audio frames.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Settings/VoiceWakeWordsSettingsView.swift` exposes trigger-word settings.

### Integration tests

- No automated iOS voice/Talk real-device e2e artifact was found.
- Gateway-side Talk relay tests exist outside the iOS app surface, but they do not prove the iOS app microphone/audio path.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/TalkModeConfigParsingTests.swift`, `TalkModeIncrementalSpeechBufferTests.swift`, `TalkSpeechLocaleTests.swift`, and `RealtimeTalkRelaySessionTests.swift` cover local Talk logic.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceWakeManagerStateTests.swift`, `VoiceWakeManagerExtractCommandTests.swift`, `VoiceWakeGatewaySyncTests.swift`, and `VoiceWakePreferencesTests.swift` cover wake settings and parsing.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS voice wake talk" --json`

Results:

- PR #81402 `refactor: move runtime state to SQLite`, with voicewake state mentioned in the state inventory.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "iOS app" --json` found issue #47584 for Siri App Intent support and PR #40877 for SFSpeechRecognizer main-thread warning fixes.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS voice wake talk microphone"`

Results:

- January support note lists Talk Mode as available on iOS node with microphone and TTS, plus voice wake detection.
- February iOS app support note says bidirectional voice is supported via Talk Mode plus Voice Wake, but still foreground-first because iOS background audio/socket suspension remains a limitation.
