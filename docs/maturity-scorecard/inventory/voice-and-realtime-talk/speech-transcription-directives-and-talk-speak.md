---
title: "Voice and realtime talk - Speech and Transcription Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Speech and Transcription Maturity Note

## Summary

Speech transcription, JSON voice directives, and `talk.speak` form the non-full-duplex voice path that supports native Talk and fallback audio output. Coverage is beta-level because docs, Gateway methods, transcription relay source, provider transcription bridges, native parsers, and tests exist. Quality remains Alpha because dedicated Talk transcription config is not fully separated and voice-provider parameter handling has regressed before.

## Category Scope

Included in this category:

- Voice directives: Voice directives and directive stripping before TTS playback.
- Talk speech playback: Gateway talk.speak and fallback TTS behavior.
- Transcription relay sessions: Gateway transcription relay sessions, transcript events, and cleanup behavior.
- Realtime transcription providers: Realtime transcription provider selection, diagnostics, and provider-specific bridge behavior.
- Native directive parsing: Native directive parsing and Talk speech locale behavior

## Features

- Voice directives: Voice directives and directive stripping before TTS playback.
- Talk speech playback: Gateway talk.speak and fallback TTS behavior.
- Transcription relay sessions: Gateway transcription relay sessions, transcript events, and cleanup behavior.
- Realtime transcription providers: Realtime transcription provider selection, diagnostics, and provider-specific bridge behavior.
- Native directive parsing: Native directive parsing and Talk speech locale behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`

Docs and source cover directives, `talk.speak`, transcription sessions, and provider transcription bridges. Coverage is not stable because Talk transcription still shares config lineage with Voice Call provider settings.

## Quality Score

- Score: `Alpha (68%)`

Quality is helped by structured voice directives, directive stripping before TTS, provider abstraction, and fallback behavior. It remains Alpha because Talk transcription config is still partly borrowed, and the archive shows prior voice selection failures in native Talk.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Voice directives, Talk speech playback, Transcription relay sessions, Realtime transcription providers, Native directive parsing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Dedicated Talk transcription config is not fully separated from Voice Call streaming provider config.
- Provider-specific voice settings have regressed before.
- `talk.speak` archive queries had sparse direct results, which makes operator history harder to evaluate.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:40` documents JSON voice directives, supported keys, and directive stripping before TTS.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:117` documents realtime transcription provider discovery and the current note that transcription borrows the Voice Call streaming provider until dedicated Talk config exists.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md:708` documents realtime voice and transcription-related OpenAI settings.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:335` documents Google realtime voice provider behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.ts:87` builds Talk TTS config used by `talk.speak`.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk-session.ts:130` creates realtime and transcription relay sessions.
- `/Users/kevinlin/code/openclaw/src/gateway/talk-transcription-relay.ts` implements the Gateway transcription relay.
- `/Users/kevinlin/code/openclaw/src/realtime-transcription/websocket-session.ts:103` manages realtime transcription WebSocket connect and audio send behavior.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-transcription-provider.ts:182` resolves OpenAI transcription auth and session handling.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkDirectiveParserTest.kt` covers native directive parsing behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/talk-transcription-relay.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-transcription-provider.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/realtime-transcription/websocket-session.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/deepgram/realtime-transcription-provider.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/elevenlabs/realtime-transcription-provider.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/mistral/realtime-transcription-provider.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/xai/realtime-transcription-provider.test.ts`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkSpeakClientTest.kt`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkDirectiveParserTest.kt`

### Gitcrawl queries

- `gitcrawl search issues "talk.speak voice directive" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned no direct issue matches.
- `gitcrawl search issues "talk provider voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #86180 for ElevenLabs TTS voice parameter behavior and related provider/voice issues.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "talk.speak voice directive" --limit 5` returned #65661 fixed-on-main evidence that macOS Talk Mode now reads resolved `talk.config` and retries Gateway `talk.speak` before system fallback.
- `/Users/kevinlin/.local/bin/discrawl search "OpenAI Realtime Talk Google Live" --limit 5` returned release notes saying realtime errors surface in Talk and local audio survives Telegram delivery.
