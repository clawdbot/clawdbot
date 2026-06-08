---
title: "Voice and realtime talk - Realtime Talk Sessions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Realtime Talk Sessions Maturity Note

## Summary

Gateway relay sessions provide the backend-owned path for realtime Talk and transcription. Coverage is beta-level because the source exposes a full session API with docs, limits, state tracking, live smoke coverage, and relay tests. Quality reaches the beta threshold because the runtime includes explicit limits and cleanup, while archive issues still show per-session context and async speech-injection gaps.

## Category Scope

Included in this category:

- Agent consult handoff: Consult handoff behavior between active Talk sessions and agent runs.
- Active Talk agent-run status: Active Talk agent-run status, cancel, steer, and follow-up controls
- Talkback runtime behavior: Talkback runtime behavior and assistant speech coordination
- Forced consult scheduling: Forced consult scheduling and control event propagation
- Browser Talk start/stop UI: Browser Talk start/stop UI and status display
- Browser WebRTC sessions: Browser WebRTC sessions for OpenAI Realtime and Google Live providers.
- Browser relay mode: Browser relay mode for backend-only realtime providers.
- Browser tool-call forwarding: Browser tool-call forwarding, transcript events, and audio playback
- Realtime session controls: Realtime session create, audio append, turn cancellation, steering, tool-result submission, and close controls.
- Gateway relay sessions: Gateway relay sessions for realtime voice and transcription flows.
- Audio-frame limits: Audio-frame limits, session TTL, per-connection/global caps, transcript events, and relay cleanup

## Features

- Agent consult handoff: Consult handoff behavior between active Talk sessions and agent runs.
- Active Talk agent-run status: Active Talk agent-run status, cancel, steer, and follow-up controls
- Talkback runtime behavior: Talkback runtime behavior and assistant speech coordination
- Forced consult scheduling: Forced consult scheduling and control event propagation
- Browser Talk start/stop UI: Browser Talk start/stop UI and status display
- Browser WebRTC sessions: Browser WebRTC sessions for OpenAI Realtime and Google Live providers.
- Browser relay mode: Browser relay mode for backend-only realtime providers.
- Browser tool-call forwarding: Browser tool-call forwarding, transcript events, and audio playback
- Realtime session controls: Realtime session create, audio append, turn cancellation, steering, tool-result submission, and close controls.
- Gateway relay sessions: Gateway relay sessions for realtime voice and transcription flows.
- Audio-frame limits: Audio-frame limits, session TTL, per-connection/global caps, transcript events, and relay cleanup

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`

The relay runtime has broad Gateway method coverage, source-level safeguards, relay-specific tests, and a live smoke script that exercises browser adapter and session APIs. Coverage is not stable because backend relay behavior spans multiple providers and live audio transports.

## Quality Score

- Score: `Beta (70%)`

Quality is supported by TTLs, audio-frame caps, per-connection/global session limits, transcript/health state, cleanup, forced consult scheduling, and explicit error propagation. Quality is capped by open requests for per-session realtime instructions/context and non-blocking speech injection.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Agent consult handoff, Active Talk agent-run status, Talkback runtime behavior, Forced consult scheduling, Browser Talk start/stop UI, Browser WebRTC sessions, Browser relay mode, Browser tool-call forwarding, Realtime session controls, Gateway relay sessions, Audio-frame limits.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Per-session realtime instructions and context are still an open request.
- Non-blocking realtime relay speech injection remains open.
- Relay behavior depends on provider-specific bridge reliability.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:12` describes `talk.session.create` for Gateway relay sessions and Android opt-in.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:117` documents Gateway relay and realtime transcription behavior.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:101` describes backend providers through Gateway relay and browser mic PCM through `talk.session.appendAudio`.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts:130` implements realtime and transcription `talk.session.create` paths.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts:408` implements `talk.session.appendAudio`.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts:553` implements cancellation and control methods.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.ts:46` defines TTL, audio-frame, per-connection, and global session limits.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.ts:298` creates realtime relay sessions, provider bridges, transcript events, steering, forced consult scheduling, and cleanup.
- `/Users/kevinlin/code/openclaw/src/talk/session-runtime.ts:16` defines the bridge session interface used by relay providers.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/talk-transcription-relay.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.test.ts`
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/session-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/talk-session-controller.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/session-log-runtime.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/forced-consult-coordinator.test.ts`

### Gitcrawl queries

- `gitcrawl search issues "talk.session gateway relay" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #84664 for per-session realtime instructions/context, #84639 for non-blocking realtime relay speech injection, and #86425 for camera frame support.
- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned broader relay/provider issues including #84639 and #84664.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "gateway relay talk" --limit 5` returned GitHub archive comments for #71849 describing realtime voice consult latency and fragility, plus fixed-on-main #60093 and #71262 for shared realtime voice provider and consult paths.
- `/Users/kevinlin/.local/bin/discrawl search "gateway relay talk" --limit 5` also returned a PR #71272 review comment about default instructions referencing an unavailable tool under `toolPolicy: none`.
