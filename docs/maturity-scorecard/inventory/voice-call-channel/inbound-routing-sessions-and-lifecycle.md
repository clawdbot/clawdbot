---
title: "Voice Call channel - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice Call channel - Conversation Routing and Delivery Maturity Note

## Summary

This note migrates archived maturity evidence for `Voice Call channel` / `Inbound Routing, Sessions, and Lifecycle` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Call Routing and Sessions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Voice Call Channel: Inbound Routing, Sessions, and Lifecycle

## Features

- Voice Call Channel: Inbound Routing, Sessions, and Lifecycle

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (52%)`

Inbound allowlists, per-number routing, per-phone/per-call session keys, initial playback behavior, stream disconnect grace, stale call reaping, restore behavior, and manager lifecycle flows are implemented and documented. Coverage remains low Alpha because the evidence is mostly simulated, and open issues show session/lifecycle behavior still has unresolved production-adjacent defects.

## Quality Score

- Score: `Alpha (58%)`

Quality is based on lifecycle design, documented caller-ID caveats, routing configuration, recovery behavior, and active archive issues. Test existence and test breadth were not counted in this Quality score.

The design is reasonably defensive: allowlists exist, low-assurance caller ID is documented, session scope is explicit, and stale/restore paths are implemented. Quality stays Alpha because active archive evidence includes stale active calls, multi-agent routing/session-key issues, and inbound transcript notification gaps.

## Completeness Score

- Score: `Alpha (52%)`
- Surface instructions: evaluated against `references/completeness/voice-call-channel.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice Call Channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Session key/routing behavior has open follow-up issue evidence.
- Stale active-call handling has an open bug.
- Inbound transcript notification and Telnyx inbound auto-response are unresolved in the issue archive.

## Evidence

### Docs

- `docs/plugins/voice-call.md:206-212` documents per-phone default session scope and per-call session scope.
- `docs/plugins/voice-call.md:545-568` documents inbound calls, allowlists, low-assurance caller ID warning, auto-responses, response model, system prompt, and timeout tuning.
- `docs/plugins/voice-call.md:569-618` documents per-number routing.
- `docs/plugins/voice-call.md:638-647` documents conversation startup behavior, initial playback/live state, retry behavior, Twilio streaming startup, barge-in clearing, and realtime opening-turn ownership.
- `docs/plugins/voice-call.md:649-655` documents Twilio stream disconnect grace.
- `docs/plugins/voice-call.md:657-681` documents stale call reaper behavior.

### Source

- `extensions/voice-call/src/config.ts:568-616` computes per-number route keys and effective config merges.
- `extensions/voice-call/src/config.ts:719-734` derives session keys for per-phone and per-call session scopes.
- `extensions/voice-call/src/webhook.ts:327-504` initializes media streaming provider callbacks and handles stream connect/disconnect with grace.
- `extensions/voice-call/src/webhook.ts:511-580` starts the server, WebSocket upgrade paths, and stale call reaper.
- `extensions/voice-call/src/providers/twilio.ts:333-397`, `extensions/voice-call/src/providers/telnyx.ts:128-225`, and `extensions/voice-call/src/providers/plivo.ts:132-299` normalize provider inbound/lifecycle events.

### Integration tests

- `extensions/voice-call/src/runtime.test.ts:380-465` covers realtime consult wiring with transcript/session key and spawned-by metadata.
- `extensions/voice-call/src/runtime.test.ts:467-516` covers per-call session keys for realtime consults.
- `extensions/voice-call/src/webhook.test.ts:1562-1650` covers stream disconnect grace and transcription readiness triggering initial messages.
- `extensions/voice-call/src/webhook.test.ts:1652-1750` covers barge-in suppression during initial messages.

### Unit tests

- `extensions/voice-call/src/manager.inbound-allowlist.test.ts:4-180` covers rejection for missing, anonymous, suffix, duplicate, and retry callers, and accepts exact allowlist matches.
- `extensions/voice-call/src/manager.closed-loop.test.ts:35-245` covers closed-loop turns without live audio, overlap rejection, stale speech tokens, repeated turns, and latency metadata.
- `extensions/voice-call/src/manager.notify.test.ts:137-370` covers provider call ID mapping, initial message modes, streaming wait/fallback, Telnyx listen, failure logging, retry, and once-only/concurrent initial messages.
- `extensions/voice-call/src/manager.restore.test.ts:34-276` covers restore verification for terminal/active/unknown/timeout/no-provider/verification failure states and remaining max duration.
- `extensions/voice-call/src/config.test.ts:281-397` covers session scope and per-number routing.

### Gitcrawl queries

- `gitcrawl search issues "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79121 for active Twilio conversations ended by stale reaper, #77753 for Google Meet and voice_call routing every call to a single configured agent in multi-agent deployments, #83967 for session-key follow-up, and #77957 for completed inbound calls persisting transcript but not notifying the user.
- `gitcrawl search issues "voice-call streaming transcription" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #79121, #79118, and #79521 for stale reaper, Telnyx inbound auto-response, and post-turn latency before speaking response.
- `gitcrawl search prs "voice-call" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 20`: returned #77763 for routing voice calls to the calling agent, #75592 for realtime caller context, #83942 for private outbound objectives, and #84161 for assistant transcript persistence on call speaking events.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call stale reaper session key inbound"`: returned `null`, so no Discord archive hits were found for those exact terms.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "google meet twilio voice-call"`: returned live notes where a stale `google_meet` session pointed at a dead voice-call ID, while a fresh `voice_call.initiate_call` produced audible outbound audio.
- `/Users/kevinlin/.local/bin/discrawl --json search --limit 10 "voice-call realtime twilio"`: returned maintainer notes about fresh calls, streaming/realtime defaults, and restart behavior around applied config.

### Archived source snapshot

- `gitcrawl doctor --json`: `version=0.2.1`, `api_supported=false`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `github_token_present=false`, `openai_key_present=true`.
- `/Users/kevinlin/.local/bin/discrawl status --json`: `state=current`, `generated_at=2026-05-29T16:49:09Z`, `last_sync_at=2026-05-29T15:59:50Z`, `messages=1487061`, `channels=25819`, `threads=25591`, `embedding_backlog=0`, `share.needs_update=true`.
