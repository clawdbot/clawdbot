---
title: "Voice and realtime talk - Talk Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Voice and realtime talk - Talk Providers Maturity Note

## Summary

The Talk configuration surface has real docs, a Gateway catalog, provider registry/resolver code, secret-scope checks, and shared native parsers. Coverage is beta-level. Quality is beta-level but still constrained by provider-specific voice configuration bugs and uneven provider semantics in the archive.

## Category Scope

Included in this category:

- OpenAI Realtime voice backend bridge: OpenAI Realtime voice backend bridge and browser WebRTC credential path
- Google Gemini Live backend bridge: Google Gemini Live backend bridge and browser token/WebSocket path
- Realtime voice provider SDK contracts: Realtime voice provider SDK contracts, activation metadata, provider registry, and resolver
- Provider diagnostics: Provider diagnostics, reconnect behavior, tool declarations, and bridge session lifecycle
- Talk catalog: Talk catalog discovery for transport, brain, speech, realtime voice, and transcription providers.
- Talk provider config: Talk provider selection, provider-specific realtime settings, and secret exposure rules.
- Shared native config parsing: Shared native config parsing for macOS, iOS, and Android

## Features

- OpenAI Realtime voice backend bridge: OpenAI Realtime voice backend bridge and browser WebRTC credential path
- Google Gemini Live backend bridge: Google Gemini Live backend bridge and browser token/WebSocket path
- Realtime voice provider SDK contracts: Realtime voice provider SDK contracts, activation metadata, provider registry, and resolver
- Provider diagnostics: Provider diagnostics, reconnect behavior, tool declarations, and bridge session lifecycle
- Talk catalog: Talk catalog discovery for transport, brain, speech, realtime voice, and transcription providers.
- Talk provider config: Talk provider selection, provider-specific realtime settings, and secret exposure rules.
- Shared native config parsing: Shared native config parsing for macOS, iOS, and Android

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`

The component is covered across docs, Gateway source, native shared parsing, provider resolver tests, and server-method tests. Coverage is not stable because provider-specific config behavior and cross-provider parity remain active archive topics.

## Quality Score

- Score: `Beta (74%)`

Quality is driven by explicit config shape, catalog discovery, scope-aware secret handling, provider normalization, and native/shared parser reuse. Quality risk remains around provider-specific voice parameters, provider proliferation, and runtime differences between browser, Gateway relay, and native clients.

Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/voice-and-realtime-talk.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for OpenAI Realtime voice backend bridge, Google Gemini Live backend bridge, Realtime voice provider SDK contracts, Provider diagnostics, Talk catalog, Talk provider config, Shared native config parsing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- `talk.provider` and `talk.realtime.provider` are documented, but provider-specific voice behavior has regressed before.
- The catalog has many axes, which increases operator setup complexity.
- New provider requests, including ElevenLabs realtime, Azure Foundry, xAI, and local MLX, remain active or proposed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:64` documents `talk.provider`, provider maps, realtime provider, model, voice, transport, brain, and consult config.
- `/Users/kevinlin/code/openclaw/docs/nodes/talk.md:112` documents `talk.catalog`, provider discovery, transcription providers, output formats, and locale.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:185` documents Talk mode config, auth, ephemeral secrets, mode options, and live smoke usage.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.ts:87` resolves active Talk TTS config.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.ts:161` builds the Talk catalog across modes, transports, brains, speech providers, realtime voice providers, and transcription providers.
- `/Users/kevinlin/code/openclaw/src/talk/provider-resolver.ts:23` resolves configured realtime voice providers and raises missing-provider errors.
- `/Users/kevinlin/code/openclaw/src/talk/provider-registry.ts:19` lists and canonicalizes realtime voice provider registrations.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawKit/TalkConfigParsing.swift:20` parses selected provider config and resolved Talk payloads for native apps.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/talk.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server.talk-config.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/protocol/talk-config.contract.test.ts`
- `/Users/kevinlin/code/openclaw/src/gateway/server-talk-nodes.test.ts`

### Unit tests

- `/Users/kevinlin/code/openclaw/src/talk/provider-resolver.test.ts`
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/VoiceTests/TalkConfigParsingTests.swift`
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawTests/TalkModeConfigParsingTests.swift`
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/voice/TalkModeManagerTest.kt`

### Gitcrawl queries

- `gitcrawl search issues "talk provider voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned provider and voice configuration threads including #71195, #86180, #86434, #63531, #84639, #80010, #86425, #76952, #85275, and #87140.
- `gitcrawl search issues "talk realtime voice" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10` returned open realtime/provider/setup issues including #71195, #86434, #76952, #84639, #86425, #84664, #85275, #83822, #87325, and #87140.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search "talk provider voice" --limit 5` returned 2026-05-27 release notes saying Talk and voice are easier to control, inspect, steer, cancel, and follow up from Web UI and Discord voice.
- `/Users/kevinlin/.local/bin/discrawl search "talk.speak voice directive" --limit 5` returned a GitHub archive comment for #65661 noting the macOS Talk Mode ElevenLabs voice-selection fix now reads resolved `talk.config` and retries Gateway `talk.speak` before system fallback.
