---
title: "macOS companion app - Voice and Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Voice and Talk Maturity Note

## Summary

The macOS app has real native voice surfaces: wake-word listener, push-to-talk hotkey, overlay, Talk Mode loop, STT/TTS fallback planning, voice forwarding to selected session/channel, and Gateway talk-mode state updates. Coverage is Beta at the lower boundary because the native runtime paths span wake, PTT, forwarding, and Talk mode with supporting unit proof, but no latency/failure-mode/live audio scenario was found. Quality is Alpha because the surface is fast-moving and archive evidence shows crash history, routing churn, and open feature requests.

## Category Scope

Included in this category:

- Voice Wake runtime: Voice Wake runtime, trigger detection, permissions, overlay, chimes, and forwarding
- Push-to-talk: Push-to-talk and Talk Mode capture/listen/think/speak lifecycle
- Talk provider playback plan: Talk provider playback plan and Gateway talk status

## Features

- Voice Wake runtime: Voice Wake runtime, trigger detection, permissions, overlay, chimes, and forwarding
- Push-to-talk: Push-to-talk and Talk Mode capture/listen/think/speak lifecycle
- Talk provider playback plan: Talk provider playback plan and Gateway talk status

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Docs cover wake-word, push-to-talk, runtime behavior, overlay invariants, settings, and forwarding. Source implements speech recognition runtime, overlay coordination, selected-session forwarding, Talk runtime, provider fallback, and Gateway status updates. Tests cover wake-word parsing/gating, global settings sync, overlay controller/view, push-to-talk, Talk config parsing, playback plans, and speech request defaults.
- Negative signals: Tests are not live audio latency/failure-mode scenarios. No release-smoke proof was found for microphone permissions, wake trigger, Talk Mode response audio, interruption, and remote-mode forwarding together.
- Integration gaps: Need repeatable signed-app voice scenario with mic/speech permissions, wake word, push-to-talk, Talk Mode, provider failure fallback, remote mode forwarding, and logged latency/failure classification.

## Quality Score

- Score: `Alpha (63%)`
- Gitcrawl reports: Results include issue #46844 for Talk Mode idle timeout after Voice Wake, issue #87140 for pluggable macOS Push-to-Talk STT backend, issue #63531 for MLX Talk provider MVP, and issue #70266 for Talk overlay avatar support.
- Discrawl reports: Archive includes #41603 being superseded by current voicewake routing architecture, #34912/#34903 crash history around Voice Wake/Talk overlay, and community explanation that macOS is the full Talk Mode client while Android/iOS have weaker/distribution-limited voice surfaces.
- Good qualities: Runtime avoids grabbing audio at launch, handles missing default input, tracks cooldowns, gates permissions, pauses wake during push-to-talk/Talk, and routes transcript delivery through active session context.
- Bad qualities: The surface depends on OS speech/mic permissions, audio devices, overlay state, provider credentials, native hotkeys, and channel delivery. Archive history shows crashes and active UX/provider/routing requests.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Wake runtime, Push-to-talk, Talk provider playback plan.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need latency, failure-mode, and setup scorecards before promotion beyond Beta/Alpha boundary.
- Need live proof for overlay dismissal/resume, PTT conflicts, and Talk interruption on actual audio devices.
- Need clearer operator guidance for provider fallback and remote-mode voice forwarding failures.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voicewake.md` documents wake-word mode, push-to-talk, runtime behavior, overlay invariants, settings, forwarding, and quick verification.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/voice-overlay.md` documents overlay behavior.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md` documents shared Talk behavior.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` lists voice wake and Talk-related app features.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoiceWakeRuntime.swift` implements wake-word recognition, trigger gating, audio engine lifecycle, overlay updates, cooldowns, and restart behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoiceWakeForwarder.swift` routes transcripts to selected session/channel and prefixes machine context.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/TalkModeRuntime.swift` implements Talk capture, recognition, provider playback plan, silence handling, and fallback.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/TalkModeController.swift` coordinates overlay, pause, PTT disablement, Gateway talk-mode updates, and resume.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/VoicePushToTalk*.swift` implements push-to-talk hotkey/capture paths.

### Integration tests

- No live audio/Talk runtime integration scenario was found.
- Adjacent voice/realtime tests exist under `/Users/kevinlin/code/openclaw/extensions/*/src/*voice*.test.ts`, but those do not prove the macOS native app loop.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/VoiceWakeRuntimeTests.swift` covers trigger matching, trimming, gap gating, and multilingual/width-insensitive forms.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/VoiceWakeForwarderTests.swift`, `VoiceWakeGlobalSettingsSyncTests.swift`, `VoiceWakeOverlayControllerTests.swift`, `VoiceWakeOverlayTests.swift`, and `VoiceWakeTesterTests.swift` cover native voice helpers.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/VoicePushToTalkTests.swift` and `VoicePushToTalkHotkeyTests.swift` cover PTT behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/TalkModeRuntimeSpeechTests.swift`, `TalkModeConfigParsingTests.swift`, and `TalkModeGatewayConfigTests.swift` cover Talk parsing/playback logic.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS voice wake talk mode" --json`

Results:

- Issue #46844 `Talk Mode Idle Timeout / Auto-Deactivation After Voice Wake`.
- Issue #87140 `Pluggable STT backend for macOS Push-to-Talk`.

Additional macOS query context:

- Issue #63531 `Add MLX Talk provider MVP for local macOS TTS`.
- Issue #70266 `Use assistant avatar in macOS Talk Mode overlay`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS voice wake"`

Results:

- 2026-04-26 GitHub mirror: #41603 voicewake routing PR superseded by current routing architecture.
- 2026-04-20 GitHub mirror: #34912/#34903 crash reports around Voice Wake / Push-to-Talk / Talk Mode overlay were closed due to inactivity.
- 2026-04-18 support message distinguishes macOS as the full Talk Mode client and notes weaker Android/iOS voice parity.
