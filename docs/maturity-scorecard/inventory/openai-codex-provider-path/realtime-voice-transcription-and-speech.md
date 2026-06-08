---
title: "OpenAI / Codex provider path - Voice and Realtime Audio Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Voice and Realtime Audio Maturity Note

## Summary

OpenAI speech and Realtime coverage is meaningful but not yet Stable. Docs cover TTS, batch speech-to-text, Realtime transcription, Realtime voice, billing, OAuth fallback, Azure deployment bridges, browser WebRTC, backend WebSocket, and live smoke tooling. Source has dedicated provider plugins and gateway relay code. Coverage is Beta because much of the proof is opt-in live smoke or channel-specific. Quality is Alpha because Realtime has a separate OpenAI Platform billing/quota path, voice/session fields have provider-specific constraints, and barge-in/echo tuning is complex.

## Category Scope

Included in this category:

- Realtime Voice Transcription: Covers Realtime Voice Transcription across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.
- Speech: Covers Speech across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.

## Features

- Realtime Voice Transcription: Covers Realtime Voice Transcription across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.
- Speech: Covers Speech across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Dedicated OpenAI provider plugins exist for speech, Realtime transcription, and Realtime voice; Gateway relay tests cover browser audio, transcripts, and tool results; live smoke script verifies OpenAI backend bridge and WebRTC SDP exchange.
- Negative signals: Standard CI cannot cover actual OpenAI Realtime billing/quota and audio transport behavior without credentials.
- Integration gaps: Realtime voice needs stronger release proof for Platform billing, OAuth client secret minting, Azure deployment shape, and channel-specific voice front ends.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: #76952 requests clearer docs for Realtime Talk voices, voice-agent roles, and mobile/phone bridge options.
- Discrawl reports: Realtime-specific archive queries returned no direct rows, but OpenAI docs and source show explicit handling for insufficient quota and billing split risks.
- Good qualities: Source handles API-key versus Codex OAuth auth, client secret minting, Azure-specific session shapes, barge-in truncation, reconnects, and transcript events explicitly.
- Bad qualities: Realtime is operationally sensitive to billing, quota, echo, session duration, voice immutability, and channel audio behavior.
- Excluded from quality: Realtime tests and live smoke presence were used only for Coverage.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Realtime Voice Transcription, Speech.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Realtime billing and quota should be surfaced before first audio turn when possible.
- Voice and barge-in settings need clearer operator diagnostics when echo/noise truncates output.
- Browser WebRTC, backend WebSocket, and Voice Call paths need a shared release proof story.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents TTS, batch STT, Realtime transcription, Realtime voice, Platform billing split, OAuth-backed client secrets, Azure Realtime settings, and live smoke command.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md` documents OpenAI Realtime voice settings for Discord voice, wake-name gating, agent consult, barge-in, echo/noise handling, and log interpretation.
- `/Users/kevinlin/code/openclaw/docs/plugins/voice-call.md` documents Voice Call plugin Realtime/streaming provider configuration.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/speech-provider.ts` implements OpenAI TTS provider config, voices, response formats, directive parsing, and talk config resolution.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-transcription-provider.ts` implements OpenAI Realtime transcription WebSocket sessions, OAuth client-secret fallback, VAD settings, and transcript event handling.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.ts` implements Realtime voice WebSocket bridge, browser session creation, API-key/Codex OAuth auth selection, Azure deployment mode, barge-in controls, reconnects, and tool result continuation.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-provider-shared.ts` mints Realtime and transcription client secrets through OpenAI HTTP APIs.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.ts` bridges browser audio, transcripts, OpenClaw agent consult tools, forced consults, barge-in, and relay session lifetime.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/talk-realtime-relay.test.ts` exercises browser audio, transcripts, tool calls, agent run registration, cancellation, and relay session behavior.
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts` verifies OpenAI backend WebSocket bridge and browser WebRTC SDP exchange when live credentials are provided.
- `/Users/kevinlin/code/openclaw/src/talk/provider-resolver.test.ts` covers configured provider resolution and model/voice overrides for Realtime voice providers.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.test.ts` covers OpenAI Realtime voice provider config and event handling.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-transcription-provider.test.ts` covers Realtime transcription provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/openai/speech-provider.test.ts` and `extensions/openai/tts.test.ts` cover TTS config and OpenAI speech request behavior.
- `/Users/kevinlin/code/openclaw/src/talk/agent-run-control.test.ts` covers semantic Realtime control tool calls.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "realtime voice OpenAI Platform credits quota"`

Results:

- Returned #76952, a docs/feature request for Realtime Talk voices, voice-agent role, and mobile/phone bridge options.

Query: `gitcrawl --json search issues -R openclaw/openclaw "barge-in realtime provider audio truncation Discord voice"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

### Discrawl queries

Query: `discrawl search --limit 10 "OpenAI realtime gpt-realtime quota insufficient_quota barge-in voice WebRTC"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.

Query: `discrawl search --limit 10 "realtime voice OpenAI Platform credits quota"`

Results:

- Returned no matching rows. This was treated as neutral after successful freshness checks.
