---
title: "Image/video/music generation tools - Video Providers and Polling Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools - Video Providers and Polling Maturity Note

## Summary

Video provider breadth is high. The bundled provider surface covers OpenAI
Sora, OpenRouter videos API, fal queue jobs, Runway tasks, PixVerse, Together,
xAI, Qwen, Google, MiniMax, and additional provider registrations. The common
contract supports queue submission, polling, hosted URL handling, downloads, and
provider capability declarations.

Coverage is Beta because docs and tests cover the core provider list and live
suite, but provider-specific async semantics vary heavily. Quality is Alpha
because archive results include OpenRouter video failures, accepted config that
fails at runtime, async delivery churn, and provider/request combinations that
skip all candidates.

## Category Scope

This category covers provider integration and async polling for video
generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway,
PixVerse, Together, xAI, Qwen, Google, MiniMax, BytePlus, Alibaba, DeepInfra,
Vydra, queue jobs, task polling, hosted media URLs, downloads, and returned
video asset metadata.

## Features

- queue-backed jobs: Covers queue-backed jobs across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- polling/timeout handling: Covers polling/timeout handling across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- Hosted URL download: Covers hosted URL download across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- provider skip explanations: Covers provider skip explanations across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.
- returned asset metadata: Covers returned asset metadata across provider integration and async polling for video generation after request normalization: OpenAI Sora, OpenRouter, fal, Runway, and related video providers and polling behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Provider docs list many video providers, source registers multiple plugins, capability contract tests track provider manifests, and live-provider wrappers exercise declared modes.
- Negative signals: Async polling, hosted URL expiry, provider-specific schema drift, and mode-specific behavior vary widely and are not equally proven across providers.
- Integration gaps: Add provider-smoke lanes for one representative direct API, one queue API, one hosted URL download, and one OpenRouter videos API job, with artifact delivery verification.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: Video searches returned #79535 on OpenRouter video generation silently failing, #45655 on configured image/video output models failing at runtime, and #86279/#86034 on generated media success being obscured by delivery failure.
- Discrawl reports: Discord search found a video request where providers across fal, Google, MiniMax, OpenAI, Runway, xAI, OpenRouter, BytePlus, Qwen, Alibaba, DeepInfra, and Vydra were skipped due to unsupported reference audio inputs.
- Good qualities: Provider declarations and runtime skip logic make heterogeneous provider capabilities explicit.
- Bad qualities: Provider breadth creates many fragile edges: queue semantics, long latency, hosted URL download failures, and capability mismatches can all prevent a successful user-visible video.
- Excluded from quality: Unit, integration, live, and QA test breadth were treated as Coverage inputs only; tests did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/image-video-music-generation-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Cross-provider video latency and polling semantics are not uniform enough for strong evidence.
- Hosted URL and artifact-download behavior remain provider dependent.
- OpenRouter video and older accepted-but-failing model configs are still visible in current archive evidence.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:11` documents generation from text, images, or videos and provider auto-selection.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:108` lists supported video providers.
- `/Users/kevinlin/code/openclaw/docs/tools/video-generation.md:380` documents provider notes for fal, OpenAI, OpenRouter, Runway, xAI, and others.
- `/Users/kevinlin/code/openclaw/docs/providers/runway.md` documents the Runway provider.
- `/Users/kevinlin/code/openclaw/docs/providers/pixverse.md` documents the PixVerse provider.
- `/Users/kevinlin/code/openclaw/docs/providers/fal.md` documents fal media generation support.
- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents OpenRouter media generation support.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/index.ts:47` registers OpenAI video generation.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts:194` registers OpenRouter video generation and video catalog providers.
- `/Users/kevinlin/code/openclaw/extensions/fal/index.ts:13` registers fal video generation.
- `/Users/kevinlin/code/openclaw/extensions/xai/index.ts:234` registers xAI video generation.
- `/Users/kevinlin/code/openclaw/extensions/runway/index.ts:4` registers Runway video generation.
- `/Users/kevinlin/code/openclaw/extensions/pixverse/index.ts:6` registers PixVerse video generation.
- `/Users/kevinlin/code/openclaw/extensions/together/index.ts:39` registers Together video generation.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.ts:282` invokes providers and validates returned video results.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts:594` live-tests selected video providers and declared modes.
- `/Users/kevinlin/code/openclaw/scripts/test-live-media.ts:31` includes video provider live suite definitions.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:4` lists expected bundled video providers.
- `/Users/kevinlin/code/openclaw/src/media-generation/provider-capabilities.contract.test.ts:54` verifies bundled video provider manifests.
- `/Users/kevinlin/code/openclaw/src/agents/openclaw-tools.video-generation.test.ts:1` exercises shared video tool registration support.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "video generation provider OpenRouter Runway fal xAI Sora" --json`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl search openclaw/openclaw --query "video generation" --json`

Results:

- Returned #79535 on OpenRouter video generation silently failing, #45655 on image/video-output models accepted in config but failing at runtime, #86279 on media generation success versus delivery failure, and #77700 on prepared runtime resolution migration for image/music/video providers.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "video generation OpenRouter Runway fal xAI Sora"`

Results:

- Found a provider-skip report covering fal, Google, MiniMax, OpenAI, Runway, xAI, OpenRouter, BytePlus, Qwen, Alibaba, DeepInfra, and Vydra when reference audio inputs were unsupported.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "video_generate"`

Results:

- Found maintainer discussion on deferred tool discovery and media tool preview behavior.
