---
title: "Android app - Voice Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Voice Maturity Note

## Summary

Android voice has moved beyond a placeholder: the app exposes manual mic dictation and Talk Mode UI, Gateway `talk.speak` synthesis with local fallback, realtime relay plumbing, foreground-service microphone type switching, voice e2e scripts, and focused unit coverage. Coverage is Alpha because the strongest e2e artifact is a debug-script path rather than a repeated user install flow. Quality is Alpha because the archive records voice churn, a prior mic-thrashing loop, and unresolved requests around agent/session switching and per-agent TTS voice.

## Category Scope

Included in this category:

- Voice tab: Voice tab, manual mic capture, Talk Mode listen/think/speak loop, Gateway Talk config, talk.speak, realtime relay mode, voice capture service type, and voice e2e receiver/script

## Features

- Voice tab: Voice tab, manual mic capture, Talk Mode listen/think/speak loop, Gateway Talk config, talk.speak, realtime relay mode, voice capture service type, and voice e2e receiver/script

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals: Docs describe manual mic and Talk capture modes, Android 14+ foreground-service microphone requirements, Gateway `talk.speak`, local TTS fallback, realtime Gateway relay conditions, and Voice Wake being disabled in UX/runtime. The debug voice e2e script can run normal and realtime voice paths through an installed debug app.
- Negative signals: Voice proof depends on debug receiver/script setup and synthetic transcripts; no recurring real-device audio latency, microphone permission, speech-recognizer failure, provider fallback, and background/foreground scenario was found.
- Integration gaps: Need a signed-app voice scorecard that grants microphone permission, runs manual mic and Talk Mode, exercises `talk.speak` fallback, verifies realtime relay when configured, backgrounds/reopens the app, and records failure classifications.

## Quality Score

- Score: `Alpha (60%)`
- Gitcrawl reports: `Android Talk Mode` found issue #56613 requesting Voice/Talk tab agent switching and per-agent TTS voice, plus PR #80082 adjusting Android foreground-service use for Talk Mode. `Android app` search also surfaces the broader app rebuild/release context.
- Discrawl reports: Search found a landed PR comment for #66179 exposing Talk Mode in UI and foreground microphone permission; a comment closing #47883 after replacing a mic thrashing loop with the new manual mic path; and a support message noting older Android partial voice behavior and voice-wake/talk-mode churn.
- Good qualities: The current source separates manual mic from Talk Mode, checks microphone permission, handles speech recognizer availability, tracks listening/speaking state, pauses capture during TTS, and falls back from Gateway `talk.speak` when eligible.
- Bad qualities: Voice behavior is constrained by Android speech recognizer availability, audio focus, foreground-service policy, provider configuration, and session routing. User-facing requests for Talk tab agent/session switching remain open.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice tab.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add real-device audio and provider failure scorecards for manual mic and Talk Mode.
- Add Voice tab session/agent selection if Android is expected to match Chat session controls.
- Keep docs aligned with actual Voice Wake state; current docs correctly say Android Voice Wake remains disabled.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents manual Mic, continuous Talk Mode, foreground-service microphone behavior, Gateway `talk.speak`, local TTS fallback, realtime relay conditions, and disabled Voice Wake.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` lists Voice tab full functionality in the rebuild checklist and documents the `voice-e2e.sh` script.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md` is the shared Talk behavior reference.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/VoiceScreen.kt` exposes manual dictation and Talk UI, permission prompts, speaker toggle, status, and transcript rendering.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/MicCaptureManager.kt` implements manual mic transcription, queueing, Gateway send, TTS pause/resume, and pending run timeout.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/TalkModeManager.kt` implements Talk Mode listening, speech recognizer lifecycle, chat finalization, realtime relay, audio playback, and interruption controls.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/voice/TalkSpeakClient.kt` calls Gateway `talk.speak` and classifies local fallback.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/NodeForegroundService.kt` promotes Talk Mode to `dataSync|microphone`.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/debug/java/ai/openclaw/app/VoiceE2eReceiver.kt` supports debug voice e2e orchestration.

### Integration tests

- `/Users/kevinlin/code/openclaw/apps/android/scripts/voice-e2e.sh` installs the debug app, grants `RECORD_AUDIO`, uses `adb reverse`, drives normal and realtime voice modes through `VoiceE2eReceiver`, captures screenshots, and saves filtered logcat.
- No repeated signed Play build voice scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/MicCaptureManagerTest.kt`, `TalkModeManagerTest.kt`, `TalkSpeakClientTest.kt`, `TalkAudioPlayerTest.kt`, `TalkDirectiveParserTest.kt`, `TalkModeConfigParsingTest.kt`, `VoiceWakeCommandExtractorTest.kt`, `VoiceWakeManagerTest.kt`, and `ChatEventTextTest.kt` cover the main voice helpers.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/NodeForegroundServiceTest.kt` covers foreground-service type behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Android Talk Mode" --json`

Results:

- Issue #56613 `[Feature]: Talk/Voice tab - agent/session switching + per-agent TTS voice`.
- PR #80082 `fix(android): avoid dataSync FGS for persistent node`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android Talk Mode Voice tab"`

Results:

- 2026-04-25 GitHub mirror comment on #66179 says Android Talk Mode UI and foreground microphone permission landed.
- 2026-04-25 GitHub mirror comment on #47883 says the prior mic thrashing loop was replaced by manual Voice tab backed by `MicCaptureManager`.
- 2026-03-28 GitHub mirror issue #56613 requests Voice/Talk tab agent switching and per-agent TTS voice.
