---
title: "Voice Call channel - Realtime Voice and Calls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Realtime Voice and Calls Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Realtime Voice and Agent Consult` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Realtime Voice and Calls`
- Merged from: `Realtime and Streaming Conversation`, `Telephony Providers and Media`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Call Channel: Realtime Voice and Agent Consult
- Voice Call Channel: Streaming Transcription and Auto-response
- Voice Call Channel: Provider Transports and Call Control
- Voice Call Channel: Telephony Tts, Playback, Dtmf, and Audio
- Voice Call Channel: Cli, Gateway Rpc, and Agent Tool

## Features

- Voice Call Channel: Realtime Voice and Agent Consult
- Voice Call Channel: Streaming Transcription and Auto-response

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (44%)`

Realtime voice has meaningful implementation evidence for Twilio media streams, OpenAI/Google realtime providers, stream tokens, WebSocket bridging, agent context, fast context, consult tools, native tool-call handling, and barge-in. It remains Experimental because live-call archive evidence is dominated by open defects and contribution work rather than stable scenario proof.

## Quality Score

- Score: `Alpha (55%)`

Quality is based on realtime runtime structure, token/bridge design, tool policy controls, provider support boundaries, and active issue/PR state. Test existence and test breadth were not counted in this Quality score.

The component has solid architectural pieces, including per-call tokens, bridge lifecycle, audio pacing/backpressure, consult policy, fast context, and dedupe of forced/native consults. It is not higher because the active archive shows double greetings, audio clipping, first-turn latency, realtime tool binding gaps, stream path hardening, and provider parity gaps.

## Completeness Score

- Score: `Experimental (44%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel, Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live realtime evidence is still dominated by open defects and follow-up PRs.
- Telnyx bidirectional realtime parity is not established by the current evidence.
- Tool binding and consult latency are active concerns for live phone calls.

## Evidence

### Docs

- `docs/plugins/voice-call.md:214-236` documents realtime voice, the streaming/realtime mutual exclusion, Twilio Media Streams support, optional realtime provider config, Google/OpenAI providers, consult tools, consult policy, agent context, fast context, and behavior when realtime provider config is missing.
- `docs/plugins/voice-call.md:238-254` documents realtime tool policy and consult policy.
- `docs/plugins/voice-call.md:256-365` documents agent voice context and Google/OpenAI realtime provider examples.
- `docs/plugins/voice-call.md:638-647` states realtime owns the opening turn and barge-in clears queued entries.

### Source

- `extensions/voice-call/src/config.ts:653-717` normalizes realtime provider config, stream path, consult settings, and agent context.
- `extensions/voice-call/src/config.ts:793-883` validates realtime settings and prevents incompatible realtime/streaming combinations.
- `extensions/voice-call/src/runtime.ts:380-465` wires realtime consult tools, safe-read-only policy, transcript/session key metadata, and spawned-by metadata.
- `extensions/voice-call/src/webhook/realtime-handler.ts:288-510` implements stream tokens, TwiML generation, upgrade handling, frame parsing, active bridges, and issue-stream-token behavior.
- `extensions/voice-call/src/webhook/realtime-handler.ts:620-900` implements audio pacing/backpressure, bridge sessions, sinks, transcripts to manager, tool calls, barge-in, errors, and close handling.
- `extensions/voice-call/src/webhook/realtime-handler.ts:1029-1325` implements forced consult behavior, call registration/end, native/forced consult dedupe, and working responses.

### Integration tests

- `extensions/voice-call/src/runtime.test.ts:380-465` covers realtime consult tool wiring, safe-read-only tool policy, transcript/session key metadata, and spawned-by metadata.
- `extensions/voice-call/src/runtime.test.ts:467-516` covers per-call session keys for realtime consults.
- `extensions/voice-call/src/runtime.test.ts:518-587` covers fast memory context answers before embedded agent consult.
- `extensions/voice-call/src/webhook.test.ts:972-1031` covers replayed realtime Twilio webhooks not minting stream state.
- `extensions/voice-call/src/webhook.test.ts:1033-1096` verifies initial provider TwiML is served before realtime shortcut behavior.
- `extensions/voice-call/src/webhook.test.ts:1098-1200` covers realtime allowlist rejection and acceptance.

### Unit tests

- `extensions/voice-call/src/config.test.ts:32-279` covers realtime mutual exclusion and provider restrictions.
- `extensions/voice-call/src/config.test.ts:399-545` covers custom realtime stream path and realtime settings.
- `extensions/voice-call/src/providers/twilio.test.ts:110-260` covers streaming TwiML and conversation URL behavior used by realtime stream setup.

### Gitcrawl queries

- `gitcrawl search issues "voice-call realtime twilio media stream" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #85847 for first-turn latency from realtime provider WebSocket timing, #85848 for OpenAI realtime audio clipping, #79121 for stale reaper during Twilio conversations, #80841 for AMD/dynamic mode switching, and #59245 for outbound task calls.
- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #85846 for OpenAI realtime double greeting, #79918 for sibling stream path upgrades, #79055 for pre-answer context preload, #80840 for realtime tools advertised without handler binding, and #78190 for per-agent realtime voice.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #86285, #86502, and #85932 for double-greeting fixes; #75592 for realtime caller context; #79919 for stream path hardening; and #79572 for realtime FunctionDeclaration parameter fixes.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call realtime twilio"`: returned discussion that Twilio has Media Streams/realtime WebSocket support, Telnyx bidirectional streaming was still contribution work, live config notes where realtime was disabled, and issue/PR commentary on slow/fragile consults and outbound realtime streams.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call twilio telnyx plivo"`: returned review evidence that realtime mode needed fail-fast handling on provider paths where it would silently do nothing.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned release/maintainer notes that realtime voice paths became more debuggable while Google Meet/Twilio voice-call state still needed care.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
