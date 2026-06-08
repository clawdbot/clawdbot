---
title: "Image/video/music generation tools - Video Generation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Video Generation Maturity Note

## Summary

The shared video runtime has a strong request contract. It supports
text-to-video, image-to-video, and video-to-video modes; image, video, and audio
references; role validation; duration caps; aspect-ratio and resolution
normalization; generated-audio and watermark controls; typed provider options;
and provider skipping when a model cannot safely accept the requested media.

Coverage is Stable because docs and source cover the mode contract in detail,
with runtime validation and provider-capability contract tests. Quality is Beta
because the normalization behavior is careful, but operator experience can still
be surprising when every provider is skipped due to media-type or provider
option constraints.

## Category Scope

Included in this category:

- text-to-video: Covers text-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- image-to-video: Covers image-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- video-to-video: Covers video-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- reference role validation: Covers reference role validation across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- audio refs: Covers audio refs across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- typed providerOptions: Covers typed providerOptions across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- queue-backed jobs: Covers queue-backed jobs across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- polling/timeout handling: Covers polling/timeout handling across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- Hosted URL download: Covers hosted URL download across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- provider skip explanations: Covers provider skip explanations across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- returned asset metadata: Covers returned asset metadata across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.

## Features

- text-to-video: Covers text-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- image-to-video: Covers image-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- video-to-video: Covers video-to-video across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- reference role validation: Covers reference role validation across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- audio refs: Covers audio refs across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- typed providerOptions: Covers typed providerOptions across video generation request normalization before provider execution: `generate`, `imageToVideo`, and `videoToVideo` modes, reference media typing and roles, and related video generation modes behavior.
- queue-backed jobs: Covers queue-backed jobs across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- polling/timeout handling: Covers polling/timeout handling across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- Hosted URL download: Covers hosted URL download across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- provider skip explanations: Covers provider skip explanations across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- returned asset metadata: Covers returned asset metadata across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs describe modes, references, validation, normalization, provider options, and fallback behavior; runtime source validates typed options and skips incompatible candidates.
- Negative signals: The contract is broad enough that coverage for every media-input combination, role list, and provider-specific option remains uneven.
- Integration gaps: Add an end-to-end matrix that exercises text-only, image reference, video reference, audio reference, invalid typed provider options, and all-provider-skip explanations.

## Quality Score

- Score: `Beta (71%)`
- Gitcrawl reports: Video search returned issues where accepted model/config surfaces later failed at runtime and where OpenRouter video generation silently failed.
- Discrawl reports: Discord search found a video-generation failure where multiple providers were skipped because the request included unsupported reference audio inputs.
- Good qualities: The runtime avoids silently dropping incompatible reference inputs and records skipped candidates with reasons.
- Bad qualities: Provider skipping is correct but can be opaque; a user can provide a plausible prompt and references yet receive no successful provider attempt.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for text-to-video, image-to-video, video-to-video, reference role validation, audio refs, typed providerOptions, queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Provider skip reasons need clearer user-facing synthesis.
- Reference audio support is especially uneven across video providers.
- Typed provider options protect providers from bad input, but they also increase the number of ways a request can fail before generation begins.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:23` documents `generate`, `imageToVideo`, and `videoToVideo` modes.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:135` documents provider capabilities and live lanes.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:167` documents reference image, video, audio, and role parameters.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:201` documents style controls, timeout, and providerOptions validation.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:236` documents normalization and ignored overrides.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:247` documents mode selection, mixed reference warnings, fallback, and typed options.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:434` documents mode-specific capabilities.

### Source

- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:40` validates providerOptions schema.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:114` resolves video provider candidates.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:151` overlays provider/model capability metadata and skips unsafe reference-input combinations.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:206` validates typed providerOptions and skips incompatible candidates.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:243` applies duration hard-cap skip logic.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:282` normalizes requests and validates provider results.
- `/Users/kevinlin/code/openclaw/src/media-generation/runtime-shared.ts:336` derives aspect ratio and resolution.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:594` runs selected video generation providers against declared modes with shell/profile auth.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts:31` includes video live suite provider lists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:4` declares expected bundled video providers.
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:54` checks every bundled video provider manifest.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.video-generation.test.ts:1` exercises shared video tool registration tests.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "video generation providerOptions duration reference inputs video_generate" --json`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl search openclaw/openclaw --query "video generation" --json`

Results:

- Returned #79535 on OpenRouter video generation silently failing, #45655 on image/video-output models accepted in config but failing at runtime, and #81805 on video-generation provider-registry tests passing in isolation.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "video generation OpenRouter Runway fal xAI Sora"`

Results:

- Found a maintainer video-generation failure where twelve providers were skipped because reference audio inputs were unsupported by the selected candidates.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "video_generate"`

Results:

- Found maintainer discussion on deferred `video_generate` discovery and tool preview behavior.
