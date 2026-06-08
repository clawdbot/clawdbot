---
title: "Voice Call channel - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Media and Rich Content Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Provider Transports and Call Control` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Telephony Providers and Media`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Call Channel: Provider Transports and Call Control
- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio

## Features

- Voice Call Channel: Provider Transports and Call Control
- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (48%)`

Twilio, Telnyx, Plivo, and mock providers have real adapter code for outbound calls, inbound events, status, DTMF, TTS/listen operations, and provider-specific webhook parsing. Coverage remains Experimental because the evidence is mainly code and simulated provider paths; there is no current live carrier scenario matrix proving the same behavior across all providers.

## Quality Score

- Score: `Alpha (58%)`

Quality is based on provider abstraction shape, normalization behavior, documented limitations, and current archive state. Test existence and test breadth were not counted in this Quality score.

The adapters normalize carrier-specific events into one call manager contract and fail early on missing credentials. Quality is limited by weaker parity outside Twilio, open Telnyx auto-response evidence, and active provider/realtime expansion work.

## Completeness Score

- Score: `Experimental (48%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel, Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Telnyx and Plivo are not evidenced at the same live depth as Twilio.
- Telnyx inbound auto-response has an open issue.
- No carrier-by-carrier live scenario matrix was found for outbound, inbound, DTMF, TTS, streaming, and teardown behavior.

## Evidence

### Docs

- `docs/plugins/voice-call.md:11-17` lists Twilio, Telnyx, Plivo, and mock providers and states support for outbound notifications, multi-turn conversations, realtime voice, streaming transcription, and inbound calls.
- `docs/plugins/voice-call.md:101-168` documents provider, from/to numbers, provider credentials, number routing, serving, security, outbound, streaming, realtime, and session scope config.
- `docs/plugins/voice-call.md:170-204` documents provider exposure/security notes and streaming connection caps.
- `docs/plugins/plugin-inventory.md:173` lists the voice-call plugin as the Twilio/Telnyx/Plivo phone-call plugin.

### Source

- `extensions/voice-call/src/providers/twilio.ts:333-397` normalizes Twilio speech, DTMF, status, and end webhooks into call events.
- `extensions/voice-call/src/providers/twilio.ts:417-518` builds TwiML for stored responses, conversations, streams, and per-call tokens.
- `extensions/voice-call/src/providers/telnyx.ts:62-225` validates Telnyx config, verifies webhooks, and parses call lifecycle, transcription, DTMF, and status events.
- `extensions/voice-call/src/providers/telnyx.ts:264-385` implements Telnyx initiate, answer, hangup, TTS, listen, status, and streaming fields.
- `extensions/voice-call/src/providers/plivo.ts:54-213` validates Plivo config, verifies webhooks, parses XML/special flows, and normalizes webhooks.
- `extensions/voice-call/src/providers/plivo.ts:301-483` implements Plivo outbound, TTS/listen, and status behavior.

### Integration tests

- `extensions/voice-call/src/runtime.test.ts:305-351` verifies provider runtime fail-closed behavior for external providers with local-only webhooks.
- `extensions/voice-call/src/webhook.test.ts:703-800` exercises replay handling and Plivo replay side effects.
- `extensions/voice-call/src/webhook.test.ts:1033-1096` verifies provider TwiML is served before realtime shortcut paths.

### Unit tests

- `extensions/voice-call/src/providers/twilio.test.ts:110-260` covers outbound TwiML, conversation URL, streaming TwiML, and inbound queue handling.
- `extensions/voice-call/src/providers/twilio.test.ts:263-595` covers cleanup, dedupe, turn tokens, TTS fallback, retry, DTMF, stream unregister, synthesis timeout, and dropped audio.
- `extensions/voice-call/src/providers/telnyx.test.ts:121-456` covers Telnyx webhook verification, parsing, dedupe, direction, transcription, answer control, and media streaming fields.
- `extensions/voice-call/src/providers/plivo.test.ts:18-85` covers answer callback, verified key handling, and callback base pinning.

### Gitcrawl queries

- `gitcrawl search issues "voice-call twilio telnyx plivo" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79118, where Telnyx inbound calls answer and greet but do not auto-respond on the `call.speech` path.
- `gitcrawl search issues "voice-call realtime twilio media stream" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #85847, #80841, #85848, #79121, and #59245 for realtime latency, Twilio AMD/dynamic mode switching, audio clipping, stale reaper, and outbound task calls.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned open provider-adjacent PRs including routing calls to the calling agent (#77763), private outbound objectives (#83942), proxy matching (#86527), transcript persistence (#84161), and bundled channel voice plugin dependencies (#82105).

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned setup/provider guidance and a review note that realtime mode should fail fast on non-Twilio provider paths rather than silently doing nothing.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call realtime twilio"`: returned a contributor note that Twilio has full Media Streams/realtime WebSocket support while Telnyx bidirectional streaming was still contribution work.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned live Twilio voice-call/Google Meet notes showing fresh outbound audio worked, but stale session state and mode propagation remained debuggability concerns.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
