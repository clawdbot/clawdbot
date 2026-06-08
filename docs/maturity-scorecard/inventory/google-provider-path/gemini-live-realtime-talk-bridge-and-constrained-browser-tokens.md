---
title: "Google provider path - Gemini Live Talk Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Gemini Live Talk Maturity Note

## Summary

Gemini Live support is a real Google provider path with a realtime voice
provider, Talk gateway relay integration, constrained browser session tokens,
audio/transcript/tool-call event handling, reconnects, and a dev live-smoke
script. Coverage is Beta because the bridge has source, unit, UI, and smoke
evidence. Quality is Alpha because archive evidence reports fragile live-call
consult behavior and active realtime schema fixes.

## Category Scope

This category covers Gemini Live realtime voice provider behavior, Talk relay
integration, constrained browser websocket tokens, audio queueing, transcript
events, Live tool calls, session resumption, reconnects, and local live-smoke
execution. It excludes non-realtime Google text transport and adapter-only media
features.

## Features

- Realtime voice sessions: Covers Realtime voice sessions across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Constrained browser tokens: Covers Constrained browser tokens across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Audio and transcript events: Covers Audio and transcript events across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Live tool calls: Covers Live tool calls across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Session reconnects: Covers Session reconnects across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Source covers provider config normalization, Live connect
  payloads, audio queueing, transcript handling, tool-call continuation,
  browser-token creation, and gateway relay integration; unit/UI tests and a
  live-smoke script cover key paths.
- Negative signals: Real Google Live and gateway-relay smoke execution is
  opt-in and credential-dependent.
- Integration gaps: No broad always-on live matrix was found for consult-heavy
  calls, browser-token expiry, reconnects, and tool-call continuation.

## Quality Score

- Score: `Alpha (65%)`
- Gitcrawl reports: #79572 is an open Google realtime PR to use `parameters`
  rather than `parametersJsonSchema` in realtime FunctionDeclarations.
- Discrawl reports: `Google Live Talk Gemini realtime` found #71849, reporting
  that realtime voice consult is too slow or fragile for live calls, with
  memory-context questions and Google Live tool-call/consult handling called
  out.
- Good qualities: Source uses constrained one-use browser tokens, explicit
  audio contracts, provider-scoped Live config, reconnect scheduling, session
  resumption, and relay-side tool-call handling.
- Bad qualities: Live voice quality depends on provider latency, consult
  continuation, browser-token lifetime, websocket behavior, and schema details
  that are still moving.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Realtime voice sessions, Constrained browser tokens, Audio and transcript events, Live tool calls, Session reconnects.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Consult-heavy Gemini Live flows need recurring live proof.
- Reconnect and session-resumption behavior is complex and provider-sensitive.
- Browser-token constraints are good security posture, but they increase the
  need for end-to-end expiry and one-use validation.
- Archive evidence shows function-declaration schema drift can break realtime
  tool calls.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/google.md:335` documents Google
  realtime voice and Live API support.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:350` documents Google
  realtime settings, including model, voice, API key, language, temperature,
  and audio format.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:377` documents Google
  Live websocket/function calling behavior.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:400` documents the
  realtime Talk live smoke command.

### Source

- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:47`
  defines Gemini Live defaults.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:298`
  builds thinking, realtime input, function declarations, and Live connect
  config.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:436`
  connects the Google realtime bridge with resumption and reconnect callbacks.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:523`
  handles audio queueing and stream-end behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:584`
  submits tool results and handles consult continuation.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:847`
  creates constrained browser sessions.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:908`
  exposes provider capabilities and session creation.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.ts:298`
  creates Talk relay sessions and wires bridge events.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:306`
  creates constrained Google Live tokens.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:340`
  smokes Google Live browser websocket setup.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts:435`
  smokes the gateway relay browser adapter.
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-google-live.test.ts`
  covers Google Live UI behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/realtime-talk-gateway-relay.test.ts`
  covers Talk gateway relay UI behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:118`
  covers provider capabilities.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:139`
  covers config normalization and fallback.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:188`
  covers Live connect config and tool declarations.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:299`
  covers invalid VAD/budget handling and dynamic thinking.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts:364`
  covers constrained browser sessions.

### Gitcrawl queries

Query: `gitcrawl search issues "Google Live Talk Gemini realtime" -R openclaw/openclaw --state all`

Results:

- Exact issue query returned no direct results.

Query: `gitcrawl search prs "Google Live Gemini realtime" -R openclaw/openclaw --state all`

Results:

- #79572 open `fix(google): use parameters not parametersJsonSchema in realtime FunctionDeclarations`.
- Other results included adjacent realtime and transcript PRs, not all
  Google-specific.

### Discrawl queries

Query: `discrawl search --limit 5 "Google Live Talk Gemini realtime"`

Results:

- Returned #71849 describing realtime voice consult as too slow/fragile for live
  calls, including Google Gemini Live tool-call/consult handling concerns.
- Returned release-note and shipped-feature context for Twilio realtime media,
  OpenAI Realtime, Google Gemini Live providers, Browser Talk WebRTC, and Google
  Meet/Chrome/Twilio realtime.
