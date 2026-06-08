---
title: "Image/video/music generation tools Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Image/video/music generation tools Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (77%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (77%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `image-video-music-generation-tools` maturity evidence from `/Users/kevinlin/tmp/maturity/image-video-music-generation-tools` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                            | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Media Routing and Discovery](configuration-model-refs-and-provider-discovery.md)   | ❌  | `Stable (82%)` | `Beta (74%)`  | `Stable (82%)` | default media model config, per-call model refs and fallbacks, auth-backed tool discovery, action=list provider inspection                                                                                                                                                                                  |
| [Task Lifecycle and Delivery](session-backed-tool-invocation-and-task-lifecycle.md) | ❌  | `Beta (78%)`   | `Alpha (65%)` | `Beta (78%)`   | background task creation, task status/list/show/cancel, duplicate guards, progress keepalive, completion/failure wake, no-session inline fallback, local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof |
| [Image Generation](image-generation-and-editing-runtime.md)                         | ❌  | `Beta (78%)`   | `Alpha (66%)` | `Beta (78%)`   | text-to-image, reference-image editing, output hints, action=status, provider attempt metadata, OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics                                                                            |
| [Video Generation](video-generation-modes-and-request-normalization.md)             | ❌  | `Beta (76%)`   | `Alpha (62%)` | `Beta (76%)`   | text-to-video, image-to-video, video-to-video, reference role validation, audio refs, typed providerOptions, queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata                                                                          |
| [Music Generation](music-generation-tools-and-providers.md)                         | ❌  | `Beta (72%)`   | `Alpha (61%)` | `Beta (72%)`   | prompt and lyrics input, instrumental mode, duration/format controls, image-reference edit lanes, generated audio outputs, provider fallback                                                                                                                                                                |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Media Routing and Discovery

Search anchors: default media model config, per-call model refs and fallbacks, auth-backed tool discovery, action=list provider inspection.

Category note: [Media Routing and Discovery](configuration-model-refs-and-provider-discovery.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- default media model config: Covers default media model config across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- per-call model refs and fallbacks: Covers per-call model refs and fallbacks across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- auth-backed tool discovery: Covers auth-backed tool discovery across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.
- action=list provider inspection: Covers action=list provider inspection across `imageGenerationModel`, `videoGenerationModel`, `musicGenerationModel`, provider/model refs, and related model routing and tool discovery behavior.

Primary docs:

- `docs/gateway/config-agents.md`
- `docs/tools/image-generation.md`
- `docs/tools/video-generation.md`
- `docs/tools/music-generation.md`

### 2. Task Lifecycle and Delivery

Search anchors: background task creation, task status/list/show/cancel, duplicate guards, progress keepalive, completion/failure wake, no-session inline fallback, local media persistence, MIME/filename inference, Hosted URL fallback, message-tool handoff, idempotent missing-media fallback, channel attachment proof.

Category note: [Task Lifecycle and Delivery](session-backed-tool-invocation-and-task-lifecycle.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (65%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- background task creation: Covers background task creation across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- task status/list/show/cancel: Covers task status/list/show/cancel across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- duplicate guards: Covers duplicate guards across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- progress keepalive: Covers progress keepalive across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- completion/failure wake: Covers completion/failure wake across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- no-session inline fallback: Covers no-session inline fallback across `image_generate`, `video_generate`, and `music_generate` tool exposure, background task scheduling, and related async task lifecycle behavior.
- local media persistence: Covers local media persistence across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- MIME/filename inference: Covers MIME/filename inference across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- Hosted URL fallback: Covers hosted URL fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- message-tool handoff: Covers message-tool handoff across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- idempotent missing-media fallback: Covers idempotent missing-media fallback across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.
- channel attachment proof: Covers channel attachment proof across generated image/audio/video artifact objects, MIME and filename inference, local media paths, hosted media URLs, and related generated media delivery behavior.

Primary docs:

- `docs/tools/media-overview.md`
- `docs/tools/image-generation.md`
- `docs/tools/video-generation.md`
- `docs/tools/music-generation.md`

### 3. Image Generation

Search anchors: text-to-image, reference-image editing, output hints, action=status, provider attempt metadata, OpenAI/Codex OAuth, API-key OpenAI, OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth, provider error diagnostics.

Category note: [Image Generation](image-generation-and-editing-runtime.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- text-to-image: Covers text-to-image across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- reference-image editing: Covers reference-image editing across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- output hints: Covers output hints across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- action=status: Covers action=status across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- provider attempt metadata: Covers provider attempt metadata across image generation and editing runtime behavior after a provider candidate has been selected: request normalization, timeout handling, reference-image inputs, image response parsing, and related image generation and editing behavior.
- OpenAI/Codex OAuth: Covers OpenAI/Codex OAuth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- API-key OpenAI: Covers API-key OpenAI across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth: Covers OpenRouter/xAI/fal/LiteLLM/DeepInfra/Google/MiniMax/ComfyUI auth across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.
- provider error diagnostics: Covers provider error diagnostics across provider registrations and auth paths for image generation and editing, including OpenAI/Codex OAuth, OpenRouter, xAI, and related image providers and auth behavior.

Primary docs:

- `docs/tools/image-generation.md`
- `docs/cli/infer.md`
- `docs/tools/media-overview.md`

### 4. Video Generation

Search anchors: text-to-video, image-to-video, video-to-video, reference role validation, audio refs, typed providerOptions, queue-backed jobs, polling/timeout handling, Hosted URL download, provider skip explanations, returned asset metadata.

Category note: [Video Generation](video-generation-modes-and-request-normalization.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

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

Primary docs:

- `docs/tools/video-generation.md`
- `docs/providers/runway.md`
- `docs/providers/pixverse.md`
- `docs/providers/fal.md`
- `docs/providers/openrouter.md`

### 5. Music Generation

Search anchors: prompt and lyrics input, instrumental mode, duration/format controls, image-reference edit lanes, generated audio outputs, provider fallback.

Category note: [Music Generation](music-generation-tools-and-providers.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (61%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- prompt and lyrics input: Covers prompt and lyrics input across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- instrumental mode: Covers instrumental mode across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- duration/format controls: Covers duration/format controls across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- image-reference edit lanes: Covers image-reference edit lanes across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- generated audio outputs: Covers generated audio outputs across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.
- provider fallback: Covers provider fallback across `music_generate`, prompt and lyrics inputs, instrumental mode, duration, and related music generation behavior.

Primary docs:

- `docs/tools/music-generation.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/image-video-music-generation-tools/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/image-video-music-generation-tools`.
