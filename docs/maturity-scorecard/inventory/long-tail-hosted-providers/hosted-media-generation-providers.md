---
title: "Long-tail hosted providers - Hosted Media Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Hosted Media Providers Maturity Note

## Summary

Hosted media generation providers are Beta for Coverage and Alpha for Quality.
The source has strong shared contracts and live sweeps for image, video, and
music providers, but provider-specific queue latency, operation polling,
remote-media requirements, and model-access variance keep the implementation
below Beta quality.

## Category Scope

Included in this category:

- Image generation providers: Covers Image generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Video generation providers: Covers Video generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Music generation providers: Covers Music generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Media mode coverage: Covers Media mode coverage across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Text-to-speech providers: Covers Text-to-speech providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Speech-to-text providers: Covers Speech-to-text providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Realtime transcription providers: Covers Realtime transcription providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Audio format diagnostics: Covers Audio format diagnostics across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.

## Features

- Image generation providers: Covers Image generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Video generation providers: Covers Video generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Music generation providers: Covers Music generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Media mode coverage: Covers Media mode coverage across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Text-to-speech providers: Covers Text-to-speech providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Speech-to-text providers: Covers Speech-to-text providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Realtime transcription providers: Covers Realtime transcription providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Audio format diagnostics: Covers Audio format diagnostics across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals:
  - Manifest docs define image, video, and music generation provider contracts and static generation metadata.
  - Live testing docs describe image, music, and video live suites plus a combined media harness.
  - Video generation live cases cover Alibaba, BytePlus, DeepInfra, fal, MiniMax, OpenRouter, PixVerse, Qwen, Runway, Together, Vydra, and xAI.
  - Music generation live cases cover fal, Google, MiniMax, and OpenRouter.
  - Image generation live docs list DeepInfra, fal, Google, MiniMax, OpenAI, OpenRouter, Vydra, and xAI.
  - Unit tests exist for provider-specific generation providers.
- Negative signals:
  - Shared live docs explicitly skip or narrow providers/modes for release-safe runs.
  - Some providers require remote URLs or account-specific access for image-to-video or video-to-video paths.
  - Archive searches for the exact media-provider phrase returned little direct GitHub or Discord evidence.

## Quality Score

- Score: `Alpha (64%)`
- Good qualities:
  - Generation provider metadata keeps cheap auth and availability signals out of runtime-only code.
  - Shared provider paths expose provider filters, env model maps, operation timeout controls, and profile-key options.
  - Video generation runtime behavior is structured around per-provider operation caps rather than one unbounded aggregate run.
  - Media harness docs are explicit about skipped providers, provider-specific Vydra coverage, and known mode constraints.
- Bad qualities:
  - Media generation providers have costly, slow, queue-backed, and provider-specific operation semantics.
  - Remote media URL requirements and model-access gates keep mode coverage inconsistent.
  - The release-safe smoke path trades breadth and mode depth for practical runtime.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Image generation providers, Video generation providers, Music generation providers, Media mode coverage, Text-to-speech providers, Speech-to-text providers, Realtime transcription providers, Audio format diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add generated provider/mode coverage tables for image, music, and video.
- Add stable smoke presets that distinguish release-safe paths from exhaustive
  mode sweeps.
- Add archive-backed tracking for provider mode failures, queue timeouts, and
  account-specific access limits.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:196`: generation provider metadata describes static auth signals before runtime loads.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:204`: actual generation behavior stays in plugin runtime.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:630`: static contracts include image, video, and music generation provider lists.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:466`: image generation live docs name `test/image-generation.runtime.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:478`: current bundled image-generation providers include DeepInfra, fal, Google, MiniMax, OpenAI, OpenRouter, Vydra, and xAI.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:512`: music generation live docs name `extensions/music-generation-providers.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:536`: video generation live docs name `extensions/video-generation-providers.live.test.ts`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:541`: video live scope exercises the shared bundled video-generation provider path.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:552`: docs list declared-but-skipped image-to-video providers and provider-specific Vydra coverage.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:571`: media live harness runs image, music, and video suites through one entrypoint.

### Source

- `/Users/kevinlin/code/openclaw/extensions/fal/openclaw.plugin.json:2`: fal ships as a generation provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/runway/openclaw.plugin.json:2`: Runway ships as a video provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/pixverse/openclaw.plugin.json:2`: PixVerse ships as a video provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/vydra/openclaw.plugin.json:2`: Vydra ships as a generation provider plugin.
- `/Users/kevinlin/code/openclaw/extensions/comfy/openclaw.plugin.json:2`: Comfy ships with generation provider metadata.
- `/Users/kevinlin/code/openclaw/extensions/deepinfra/openclaw.plugin.json:2`: DeepInfra ships with hosted image/video provider metadata.
- `/Users/kevinlin/code/openclaw/extensions/xai/openclaw.plugin.json:2`: xAI ships with hosted image/video generation metadata.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:45`: shared video live suite imports Alibaba, BytePlus, DeepInfra, fal, Google, MiniMax, OpenAI, OpenRouter, PixVerse, Qwen, Runway, Together, Vydra, and xAI plugins.
- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:61`: video live suite gates on live-test env and provider filters.
- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:97`: video live cases enumerate hosted video providers.
- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:594`: video live suite runs one case per provider.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:33`: music live suite imports fal, Google, MiniMax, and OpenRouter plugins.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:53`: music live cases enumerate fal, Google, MiniMax, and OpenRouter.
- `/Users/kevinlin/code/openclaw/extensions/music-generation-providers.live.test.ts:170`: music live suite covers generate plus declared edit paths with shell/profile auth.
- `/Users/kevinlin/code/openclaw/extensions/vydra/vydra.live.test.ts:42`: Vydra live test covers image generation.
- `/Users/kevinlin/code/openclaw/extensions/vydra/vydra.live.test.ts:77`: Vydra live test covers video generation.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/fal/image-generation-provider.test.ts`: unit coverage for fal image generation.
- `/Users/kevinlin/code/openclaw/extensions/runway/video-generation-provider.test.ts`: unit coverage for Runway video generation.
- `/Users/kevinlin/code/openclaw/extensions/pixverse/video-generation-provider.test.ts`: unit coverage for PixVerse video generation.
- `/Users/kevinlin/code/openclaw/extensions/vydra/image-generation-provider.test.ts`: unit coverage for Vydra image generation.
- `/Users/kevinlin/code/openclaw/extensions/vydra/video-generation-provider.test.ts`: unit coverage for Vydra video generation.
- `/Users/kevinlin/code/openclaw/extensions/deepinfra/video-generation-provider.test.ts`: unit coverage for DeepInfra video generation.
- `/Users/kevinlin/code/openclaw/extensions/qwen/video-generation-provider.test.ts`: unit coverage for Qwen video generation.
- `/Users/kevinlin/code/openclaw/extensions/together/video-generation-provider.test.ts`: unit coverage for Together video generation.
- `/Users/kevinlin/code/openclaw/extensions/minimax/music-generation-provider.test.ts`: unit coverage for MiniMax music generation.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "fal Runway Pixverse Vydra image video generation provider"` returned `[]`.
- `gitcrawl --json search prs -R openclaw/openclaw "fal Runway Pixverse Vydra image video generation provider"` returned `[]`.
- Helper query `StepFun image_generation provider catalog` found #86493, StepFun plan text provider does not register image generation provider.
- Helper query `OpenRouter video generation music provider registry` found #79535, OpenRouter video/music registry gaps.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "fal Runway Pixverse Vydra video generation provider" --limit 5` returned `null`.
- Helper query `StepFun provider registry image_generation provider catalog` returned no direct Discord hits.
- This low archive hit rate is treated as neutral, not as proof of quality.
