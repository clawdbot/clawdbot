---
title: "Voice Call channel - Telephony TTS, Playback, DTMF, and Audio Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Telephony TTS, Playback, DTMF, and Audio Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Telephony TTS, Playback, DTMF, and Audio` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Voice Call channel capability area represented by these taxonomy features:

- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio

## Features

- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (49%)`

Telephony TTS, playback, DTMF, and audio have implementation evidence for core TTS config merging, telephony synthesis, PCM to mu-law conversion, Twilio media playback, fallback behavior, DTMF handling, TTS queueing, barge-in clearing, and playback timeouts. It remains Experimental because live audio quality evidence is unstable and there is no broad live playback matrix.

## Quality Score

- Score: `Alpha (57%)`

Quality is based on audio pipeline design, fallback semantics, provider-specific constraints, and active archive state. Test existence and test breadth were not counted in this Quality score.

The code is careful about not mixing Twilio active media streams with Twilio Say fallback, clearing queued audio on barge-in, timing out synthesis/stream playback, and logging fallback decisions. It is not higher because open issues mention hold music after failed/no-stream calls, OpenAI realtime mu-law clipping, and TTS provider config alias problems.

## Completeness Score

- Score: `Experimental (49%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No live audio quality matrix was found across TTS providers and carriers.
- Active issue evidence covers hold music, duplicate greetings, and mu-law clipping.
- TTS provider config alias drift has recent PR activity, so provider-level behavior should not be assumed stable.

## Evidence

### Docs

- `docs/plugins/voice-call.md:447-479` documents TTS for calls, core TTS deep-merge behavior, Microsoft speech being ignored for voice calls, Twilio media stream fallback limits, fallback-chain logging, and barge-in clearing the queue.
- `docs/plugins/voice-call.md:480-543` documents TTS examples.
- `docs/plugins/voice-call.md:638-647` documents initial playback/live state and barge-in clearing behavior.
- `docs/plugins/voice-call.md:750-763` documents `voice_call` tool actions that include speaking and call lifecycle operations.

### Source

- `extensions/voice-call/src/telephony-tts.ts:50-115` merges telephony TTS provider config, parses directives, invokes runtime telephony TTS, logs fallback, and converts PCM to mu-law 8 kHz audio.
- `extensions/voice-call/src/telephony-audio.ts:1` exports shared realtime voice conversion/resampling helpers for telephony audio.
- `extensions/voice-call/src/providers/twilio.ts:611-660` implements Twilio TTS mode behavior and prevents fallback Say when an active stream is required.
- `extensions/voice-call/src/providers/twilio.ts:662-675` builds DTMF TwiML.
- `extensions/voice-call/src/providers/twilio.ts:677-798` streams TTS through Twilio media with queueing, 20 ms chunks, timeout, and failure handling for missing chunks/marks.
- `extensions/voice-call/src/providers/twilio.ts:803-855` implements listening/status behavior.
- `extensions/voice-call/src/media-stream.ts:484-660` implements send-buffer backpressure, audio send/mark/clear behavior.
- `extensions/voice-call/src/media-stream.ts:670-830` implements queued TTS and Talk observability.

### Integration tests

- `extensions/voice-call/src/media-stream.test.ts:96-183` covers TTS queue serialization, cancellation, and teardown behavior.
- `extensions/voice-call/src/webhook.test.ts:1652-1750` covers barge-in suppression during the initial message.
- `extensions/voice-call/src/webhook.test.ts:1562-1650` covers stream disconnect grace and transcription readiness triggering initial speech.

### Unit tests

- `extensions/voice-call/src/providers/twilio.test.ts:382-595` covers TTS fallback, retry, DTMF, stream unregister, synthesis timeout, and dropped audio.
- `extensions/voice-call/src/providers/twilio.test.ts:110-260` covers TwiML/stream setup that drives playback behavior.
- `extensions/voice-call/src/config.test.ts:399-545` covers TTS overrides.

### Gitcrawl queries

- `gitcrawl search issues "voice-call tts barge-in dtmf" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned no results for those exact terms.
- `gitcrawl search issues "voice-call realtime twilio media stream" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #85848 for OpenAI realtime audio clipping/breaking inside words during outbound calls and #79121 for stale Twilio conversation reaping.
- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #81122 for Twilio voice-call getting stuck in hold music after failed/no-stream call and #85846 for duplicate greeting.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #86285/#86502/#85932 for duplicate greeting fixes and #86413/#86366 for ElevenLabs voice/model alias fixes related to TTS config.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call tts dtmf barge"`: returned `null`, so no Discord archive hits were found for those exact terms.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned maintainer notes that fresh Twilio outbound audio worked, while stale Google Meet/voice-call state and DTMF/mode propagation required debugging.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned setup guidance that core `messages.tts` can be used for calls, plugin-level TTS can override it, and Microsoft/Edge speech should not be counted as telephony support.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
