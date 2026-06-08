---
title: "Image/video/music generation tools - Music Generation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Music Generation Maturity Note

## Summary

Music generation has a shared runtime, docs, provider registrations, and live
provider scaffolding, but it is the newest and least proven part of the surface.
The tool supports prompt-only generation, lyrics, instrumental mode, duration,
format, image edit mode where providers declare it, provider fallbacks, and
audio asset shaping.

Coverage is Beta because docs and source cover the intended contract and live
tests exist for representative providers. Quality is Alpha because archives
show MiniMax polling/routing issues, OpenRouter music not shipping in a report
window, lyrics value truncation, and deferred `music_generate` discoverability
problems.

## Category Scope

Included in this category:

- prompt and lyrics input: Covers prompt and lyrics input across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- instrumental mode: Covers instrumental mode across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- duration/format controls: Covers duration/format controls across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- image-reference edit lanes: Covers image-reference edit lanes across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- generated audio outputs: Covers generated audio outputs across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- provider fallback: Covers provider fallback across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.

## Features

- prompt and lyrics input: Covers prompt and lyrics input across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- instrumental mode: Covers instrumental mode across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- duration/format controls: Covers duration/format controls across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- image-reference edit lanes: Covers image-reference edit lanes across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- generated audio outputs: Covers generated audio outputs across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- provider fallback: Covers provider fallback across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs explain the tool, parameters, provider list, validation, async behavior, and live test commands; source has shared runtime and audio asset handling; live tests cover generate and declared edit lanes.
- Negative signals: The provider set is smaller and newer than image/video, edit support is provider-specific, and live proof is more credential-dependent.
- Integration gaps: Add a gateway/channel scenario for `music_generate` that verifies tool discovery, generated audio attachment delivery, and provider status behavior.

## Quality Score

- Score: `Alpha (61%)`
- Gitcrawl reports: Music searches returned #84506 on MiniMax music_generation async polling, #79535 where OpenRouter video failed and music had not shipped, #82678 where the string `none` truncated tool calls and assistant responses when used as lyrics, and #84764 requesting streamed music generation responses.
- Discrawl reports: Discord search found deferred media tool discussion where `music_generate` was not discoverable enough from the previewed source context.
- Good qualities: The music runtime shares provider candidate resolution and generated-asset shaping with the rest of the media surface.
- Bad qualities: Provider behavior and discoverability remain unsettled, and lyrics/instrumental parameter handling has produced user-visible edge cases.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for prompt and lyrics input, instrumental mode, duration/format controls, image-reference edit lanes, generated audio outputs, provider fallback.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Music provider breadth and operational proof lag image and video.
- MiniMax async polling and OpenRouter music behavior have recent archive risk.
- `music_generate` discoverability through deferred tools needs better user-visible affordances.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:11` describes shared music generation capability.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:96` lists supported providers and capability matrix.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:119` documents `list` and `status` actions.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:138` documents tool parameters.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:170` documents validation, normalization, and timeouts.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:223` documents model selection, fallbacks, and auto-detection.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:257` documents provider notes.
- `/Users/kevinlin/code/openclaw/docs/tools/music-generation.md:331` documents live test coverage and `pnpm test:live:media music`.

### Source

- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.ts:30` lists runtime music generation providers.
- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.ts:37` resolves music provider candidates and no-model messaging.
- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.ts:84` applies override normalization and invokes providers.
- `/Users/kevinlin/code/openclaw/src/music-generation/runtime.ts:126` records provider attempts and failure handling.
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-assets.ts:50` extracts music file candidates.
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-assets.ts:64` builds generated music assets from base64 data.
- `/Users/kevinlin/code/openclaw/src/music-generation/provider-assets.ts:78` downloads generated music assets.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts:194` registers OpenRouter music generation.
- `/Users/kevinlin/code/openclaw/extensions/fal/index.ts:13` registers fal music generation.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:53` declares live provider cases for fal, Google, MiniMax, and OpenRouter.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:170` sets up live auth.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:226` asserts generated audio MIME and buffers.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:260` asserts edit mode with image input where declared.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts:31` includes music live suite provider lists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:22` lists expected bundled music providers.
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:54` verifies bundled music provider manifests.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-announce-delivery.test.ts:2289` covers music completion DMs requiring the message tool.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "music generation" --json`

Results:

- Returned #84506 on MiniMax async-task polling, #79535 on OpenRouter video/music status, #82678 on `none` lyrics truncating tool calls/responses, #84764 on streaming music generation, and #78852 on media tool availability reuse.

Query: `gitcrawl search openclaw/openclaw --query "music generation Lyria MiniMax fal OpenRouter" --json`

Results:

- Returned no direct hits for the exact phrase.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "music_generate"`

Results:

- Found maintainer discussion on deferred `music_generate` tool discovery and source-preview behavior.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "music generation Lyria MiniMax fal OpenRouter"`

Results:

- Returned no direct hits for the exact phrase.
