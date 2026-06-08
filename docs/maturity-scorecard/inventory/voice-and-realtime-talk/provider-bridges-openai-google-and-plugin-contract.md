---
title: "Voice and realtime talk - Provider Bridges for Openai, Google, and Plugin Contracts Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Provider Bridges for Openai, Google, and Plugin Contracts Maturity Note

## Summary

OpenAI Realtime, Google Gemini Live, and plugin-registered realtime voice providers are implemented through shared provider contracts and bridge sessions. Coverage is beta-level. Quality remains Alpha because provider setup, model access, billing, and provider roadmap churn are the most visible operator risks.

## Category Scope

- OpenAI Realtime voice backend bridge and browser WebRTC credential path.
- Google Gemini Live backend bridge and browser token/WebSocket path.
- Realtime voice provider SDK contracts, activation metadata, provider registry, and resolver.
- Provider diagnostics, reconnect behavior, tool declarations, and bridge session lifecycle.

## Features

- OpenAI Realtime voice backend bridge: OpenAI Realtime voice backend bridge and browser WebRTC credential path
- Google Gemini Live backend bridge: Google Gemini Live backend bridge and browser token/WebSocket path
- Realtime voice provider SDK contracts: Realtime voice provider SDK contracts, activation metadata, provider registry, and resolver
- Provider diagnostics: Provider diagnostics, reconnect behavior, tool declarations, and bridge session lifecycle

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`

OpenAI and Google have provider docs, source bridges, provider tests, and live smoke paths. The plugin contract also exposes provider registration and capability metadata. Coverage is not stable because non-OpenAI/Google providers and Azure-style deployment variants remain active.

## Quality Score

- Score: `Alpha (68%)`

Quality is helped by normalized config, auth resolution, bridge event handling, reconnect logic, tool declarations, and explicit provider capabilities. It remains Alpha because provider setup is fragile, OpenAI billing/model access can fail, and archive evidence shows active provider roadmap churn.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for OpenAI Realtime voice backend bridge, Google Gemini Live backend bridge, Realtime voice provider SDK contracts, Provider diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- OpenAI WebRTC can fail when org billing/model access is missing.
- Azure Foundry, ElevenLabs realtime, xAI, and local provider work are not settled.
- Camera-frame support for realtime Talk is still open.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md:95` documents OpenAI Realtime voice setup requirements, Platform credits, API key, and Codex OAuth caveats.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md:708` documents OpenAI realtime voice settings, voices, GA session shape, Azure notes, WebRTC client secrets, backend relay, and live smoke.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:335` documents Google realtime voice provider settings, Gemini Live WebSocket, tool calls, constrained Control UI tokens, and live smoke.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-provider-plugins.md:519` documents realtime voice provider capability registration and catalog integration.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.ts:202` normalizes OpenAI realtime voice provider config.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.ts:347` resolves OpenAI auth through Codex OAuth, environment, or API key settings.
- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.ts:416` implements the OpenAI realtime voice bridge session.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:213` normalizes Google realtime voice provider config.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:308` maps Google config and tool declarations.
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.ts:436` implements the Google Live bridge.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/realtime-voice.ts:1` exports the provider contract used by plugin providers.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openai/realtime-voice-provider.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/google/realtime-voice-provider.test.ts`
- `/Users/kevinlin/code/openclaw/scripts/dev/realtime-talk-live-smoke.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/provider-registry.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/provider-resolver.test.ts`
- `/Users/kevinlin/code/openclaw/src/talk/activation-name.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/talk-voice/index.test.ts`

### Gitcrawl queries

- `gitcrawl search issues "OpenAI Realtime Talk Google Live" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #86425 for camera frame support and #83822 for OpenAI WebRTC `model_not_found`.
- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned #86434 for ElevenLabs realtime voice, #87325 for Azure Foundry GPT Realtime Talk, and #73019 for xAI realtime voice proposal.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "OpenAI Realtime Talk Google Live" --limit 5` returned 2026-05-03 release notes saying realtime errors surface in Talk and a #7200 archive comment listing shipped OpenAI Realtime, Google Gemini Live, Browser Talk WebRTC, and Gateway relay paths.
- `/Users/kevinlin/.local/bin/discrawl search "talk realtime voice" --limit 5` returned release notes for stronger Talk and voice control in Web UI and Discord voice.
