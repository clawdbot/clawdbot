---
title: "Voice and realtime talk - Browser Control UI Realtime Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Browser Control UI Realtime Talk Maturity Note

## Summary

Control UI Talk covers OpenAI WebRTC, Google Live browser WebSocket, and Gateway relay adapters. Coverage is beta-level because docs, UI source, Gateway source, and live smoke paths exist. Quality remains Alpha because archive evidence includes model/billing failures, spoken-output mismatch, and user confusion from multiple transport paths.

## Category Scope

- Browser Talk start/stop UI and status display.
- OpenAI WebRTC and Google Live browser sessions.
- Gateway relay browser adapter for backend-only providers.
- Browser tool-call forwarding, transcript events, and audio playback.

## Features

- Browser Talk start/stop UI: Browser Talk start/stop UI and status display
- Browser WebRTC sessions: Browser WebRTC sessions for OpenAI Realtime and Google Live providers.
- Browser relay mode: Browser relay mode for backend-only realtime providers.
- Browser tool-call forwarding: Browser tool-call forwarding, transcript events, and audio playback

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`

The browser component has docs, three transport implementations, Gateway session APIs, UI state wiring, transport-specific tests, and a live smoke script. Coverage is limited by provider credentials and browser-media behavior that can only be proven live.

## Quality Score

- Score: `Alpha (68%)`

Quality has strong pieces: constrained browser credentials, explicit relay fallback, and a shared event interface. It remains Alpha because the archive shows active user-visible failures for OpenAI model access, assistant spoken-output mismatch, camera-frame follow-up, and Control UI Talk complexity.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Talk start/stop UI, Browser WebRTC sessions, Browser relay mode, Browser tool-call forwarding.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- OpenAI WebRTC can fail with `model_not_found` or billing/setup problems.
- Spoken output can diverge from Control UI text when delivery mirror behavior differs.
- Browser transport choices are hard to explain and operate.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:101` documents Chat/Talk, OpenAI WebRTC, Google constrained one-use browser tokens, Gateway relay, `talk.session.appendAudio`, consult, and steering.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:185` documents Talk mode configuration, auth, ephemeral secrets, options, status row, and live smoke.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:12` describes browser `talk.client.create` sessions for WebRTC and provider WebSocket transports, plus `talk.session.create` for Gateway relay.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-client.ts:30` implements `talk.client.create` for client-owned browser realtime sessions.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-client.ts:160` implements browser `talk.client.toolCall` forwarding for `openclaw_agent_consult`.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app.ts:1087` wires Talk launch options and runtime state in the Control UI.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-webrtc.ts` implements the OpenAI WebRTC client path.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-google-live.ts:73` implements the Google Live browser WebSocket client path.
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-gateway-relay.ts:44` implements the Gateway relay browser adapter.

### Integration tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-webrtc.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-google-live.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-gateway-relay.test.ts`
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/app.talk.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/chat/realtime-talk-conversation.test.ts`
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-consult.test.ts`

### Gitcrawl queries

- `gitcrawl search issues "Control UI Talk realtime" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #83822 for OpenAI WebRTC `model_not_found`, #85275 for spoken-output mismatch, #86425 for camera frame support, #77966 for Google Meet audio verification, and #73019 for xAI realtime voice.
- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned additional Control UI and Talk provider follow-ups.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "Control UI Talk" --limit 5` returned release notes that Google Live browser Talk uses constrained ephemeral credentials when available and Gateway relay when the provider is backend-only.
- `/Users/kevinlin/.local/bin/discrawl search "Control UI Talk" --limit 5` also returned a 2026-04-30 discussion calling out Control UI/Talk feature breadth across generic browser realtime transport, Google Live, and Gateway relay.
