---
title: "Voice Call channel - Streaming Transcription and Auto-response Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Streaming Transcription and Auto-response Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Streaming Transcription and Auto-response` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Voice Call channel capability area represented by these taxonomy features:

- Voice Call Channel: Streaming Transcription and Auto-response

## Features

- Voice Call Channel: Streaming Transcription and Auto-response

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (47%)`

Streaming transcription has docs, config, media-stream runtime code, provider-generic STT plumbing, early media buffering, transcription readiness handling, Talk events, and auto-response integration. It remains Experimental because the evidence does not show stable live phone-call coverage across STT providers, and archive evidence includes operator notes where config/restart state affected live Twilio media-stream validation.

## Quality Score

- Score: `Alpha (55%)`

Quality is based on media-stream lifecycle design, provider-generic config, failure behavior, and archive state. Test existence and test breadth were not counted in this Quality score.

The design handles provider connection readiness, early media, queue limits, callback events, and failure closure. Quality stays Alpha because provider availability, Gateway restart application, STT readiness, and auto-response latency remain operationally fragile.

## Completeness Score

- Score: `Experimental (47%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No current live STT provider matrix was found for Deepgram, ElevenLabs, Mistral, OpenAI, and xAI in real phone calls.
- Gateway restart/config application state can make live media-stream validation misleading.
- Auto-response latency and Telnyx speech path behavior have open issue evidence.

## Evidence

### Docs

- `docs/plugins/voice-call.md:367-377` documents streaming transcription with Deepgram, ElevenLabs, Mistral, OpenAI, and xAI; queued inbound audio while the provider connects; and greeting behavior after transcription readiness.
- `docs/plugins/voice-call.md:379-445` documents streaming provider examples.
- `docs/plugins/voice-call.md:620-636` documents the spoken output JSON contract and defensive extraction.
- `docs/plugins/voice-call.md:638-647` documents startup behavior, initial playback state, retry behavior, Twilio streaming startup, and barge-in clearing.

### Source

- `extensions/voice-call/src/config.ts:653-717` normalizes streaming provider config and media-stream path settings.
- `extensions/voice-call/src/webhook.ts:327-504` initializes media streaming provider callbacks and connects stream events to call metadata.
- `extensions/voice-call/src/media-stream.ts:136-285` implements MediaStreamHandler state, WebSocket upgrade handling, max payloads, pending connection caps, Twilio media message handling, and STT forwarding.
- `extensions/voice-call/src/media-stream.ts:327-455` creates transcription sessions, emits Talk events, connects transcription providers, and closes on readiness failure.
- `extensions/voice-call/src/media-stream.ts:484-660` implements pending caps/timeouts, send-buffer backpressure, audio sending, mark handling, and clear behavior.
- `extensions/voice-call/src/media-stream.ts:670-830` implements queued TTS and Talk observability.

### Integration tests

- `extensions/voice-call/src/webhook.test.ts:211-256` verifies auto-selection of the first realtime transcription provider and MediaStreamHandler presence.
- `extensions/voice-call/src/webhook.test.ts:258-316` records media stream Talk events on call metadata.
- `extensions/voice-call/src/webhook.test.ts:1562-1650` verifies stream disconnect grace and transcription readiness triggering initial messages.
- `extensions/voice-call/src/media-stream.test.ts:706-771` defers transcription readiness until STT connects.
- `extensions/voice-call/src/media-stream.test.ts:773-855` forwards early Twilio media before readiness.
- `extensions/voice-call/src/media-stream.test.ts:857-916` closes on STT readiness failure.

### Unit tests

- `extensions/voice-call/src/config.test.ts:399-545` covers streaming defaults, custom path behavior, and related realtime/TTS config interactions.
- `extensions/voice-call/src/media-stream.test.ts:185-215` covers malformed JSON wrapping and Talk event startup behavior.
- `extensions/voice-call/src/media-stream.test.ts:918-925` guards oversized pre-start frames.

### Gitcrawl queries

- `gitcrawl search issues "voice-call streaming transcription" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79121 for stale Twilio reaper, #79118 for Telnyx inbound speech not auto-responding, #79521 for post-turn compaction delaying speech response, and #73019 for xAI realtime voice provider proposal.
- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #77957 for inbound calls persisting transcript without user notification and #85848 for Twilio mu-law audio clipping.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #84161 for persisting assistant transcript on call speaking events and #75018/#73032 for realtime speech provider work.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call streaming transcription"`: returned maintainer/archive notes on provider-generic streaming STT, ElevenLabs/xAI streaming transcription support, a live Twilio config where streaming was enabled but required Gateway restart to apply, and setup guidance distinguishing regular webhook/TTS handling from media-stream STT.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned guidance that streaming transcription is especially relevant for conversation mode and not always required for simple notify tests.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned live notes where streaming config was set but the running Gateway had not yet applied it due to deferred restart state.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
