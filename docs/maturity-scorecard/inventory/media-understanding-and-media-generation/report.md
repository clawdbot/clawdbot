---
title: "Media understanding and media generation Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Media understanding and media generation Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (78%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (78%)`
- LTS Features: `0/6`

## Summary

This report promotes the archived `media-understanding-and-media-generation` maturity evidence from `/Users/kevinlin/tmp/maturity/media-understanding-and-media-generation` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                         | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Media Intake and Access](media-file-intake-storage-and-secure-access.md)        | ❌  | `Beta (74%)`   | `Beta (76%)`  | `Beta (74%)`   | Local and remote media references, MIME and type detection, Size caps and bounded reads, Safe remote fetch, Local root policy, Inbound media store, PDF/document extraction dispatch, QR and media helper classification                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [Channel Media Handling](channel-attachment-staging-and-reply-media-delivery.md) | ❌  | `Stable (84%)` | `Alpha (68%)` | `Stable (84%)` | Inbound attachment staging, Sandbox media rewrites, Reply media templating, Message-tool attachment delivery, Duplicate delivery suppression                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [Media Configuration](media-understanding-orchestration-and-configuration.md)    | ❌  | `Stable (82%)` | `Beta (77%)`  | `Stable (82%)` | Media capability configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [Text-to-Speech Delivery](tts-and-outbound-voice-audio-delivery.md)              | ❌  | `Stable (84%)` | `Beta (70%)`  | `Stable (84%)` | TTS, Outbound Voice Audio Delivery                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [Media Understanding](image-understanding-and-vision-routing.md)                 | ❌  | `Beta (72%)`   | `Alpha (62%)` | `Beta (72%)`   | Audio attachment selection, Batch STT provider and CLI fallback, Voice-note mention preflight, Transcript insertion and echo, Audio proxy and limit handling, Inbound image summarization, Active vision model bypass, Text-only model media offload, Vision provider fallback, Image and PDF input routing, Video Understanding, Direct Video Analysis                                                                                                                                                                                                                                                                                  |
| [Media Generation](image-generation-tool-and-provider-routing.md)                | ❌  | `Beta (74%)`   | `Alpha (64%)` | `Beta (74%)`   | Image generation tool invocation, Provider and model selection, Reference image editing, Generated image task lifecycle, Generated image persistence and delivery, Music generation tool invocation, Provider and model selection, Lyrics, instrumental, duration, and format controls, Reference inputs where supported, Music task lifecycle and duplicate status, Generated audio persistence and delivery, Video generation tool invocation, Mode and provider capability selection, Reference image, video, and audio inputs, Provider option validation, Video task lifecycle and status, Generated video persistence and delivery |

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

### 1. Media Intake and Access

Search anchors: Local and remote media references, MIME and type detection, Size caps and bounded reads, Safe remote fetch, Local root policy, Inbound media store, PDF/document extraction dispatch, QR and media helper classification.

Category note: [Media Intake and Access](media-file-intake-storage-and-secure-access.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Local and remote media references: Covers Local and remote media references across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- MIME and type detection: Covers MIME and type detection across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Size caps and bounded reads: Covers Size caps and bounded reads across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Safe remote fetch: Covers Safe remote fetch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Local root policy: Covers Local root policy across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- Inbound media store: Covers Inbound media store across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- PDF/document extraction dispatch: Covers PDF/document extraction dispatch across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.
- QR and media helper classification: Covers QR and media helper classification across Included: Local and remote media references, including plain paths, `file://`, HTTP(S), and related media file intake, storage, and secure access behavior.

Primary docs:

- `docs/tools/media-overview.md`
- `docs/nodes/media-understanding.md`
- `docs/gateway/security/secure-file-operations.md`
- `docs/tools/pdf.md`
- `docs/tools/image-generation.md`
- `docs/cli/qr.md`
- `docs/channels/line.md`
- `docs/channels/whatsapp.md`

### 2. Channel Media Handling

Search anchors: Inbound attachment staging, Sandbox media rewrites, Reply media templating, Message-tool attachment delivery, Duplicate delivery suppression, Media understanding (audio), Provider + CLI fallback, Mention detection in groups.

Category note: [Channel Media Handling](channel-attachment-staging-and-reply-media-delivery.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Alpha (68%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- Inbound attachment staging: Covers Inbound attachment staging across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Sandbox media rewrites: Covers Sandbox media rewrites across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Reply media templating: Covers Reply media templating across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Message-tool attachment delivery: Covers Message-tool attachment delivery across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.
- Duplicate delivery suppression: Covers Duplicate delivery suppression across inbound attachment staging, sandbox rewrites, `MediaPath`/`MediaPaths`/`MediaUrls` templating, media notes, and related channel attachment staging and reply media delivery behavior.

Primary docs:

- `docs/nodes/images.md`
- `docs/tools/media-overview.md`
- `docs/channels/discord.md`

### 3. Media Configuration

Search anchors: media understanding and media generation media understanding orchestration and configuration, media understanding orchestration and configuration.

Category note: [Media Configuration](media-understanding-orchestration-and-configuration.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (77%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Media capability configuration: tools.media image/audio/video config, shared and per-capability media model entries, provider/CLI entry resolution, auth-backed capability selection, fallback ordering, scope rules, concurrency, active-model skip behavior, offloaded image routing, image generation tool factory availability, image generation task status/list/duplicate guard, and generated-media delivery into the reply pipeline

Primary docs:

- `docs/tools/media-overview.md`
- `docs/tools/image-generation.md`
- `docs/plugins/manifest.md`
- `docs/plugins/codex-harness.md`

### 4. Text-to-Speech Delivery

Search anchors: TTS, Outbound Voice Audio Delivery, media understanding and media generation tts and outbound voice audio delivery, tts and outbound voice audio delivery.

Category note: [Text-to-Speech Delivery](tts-and-outbound-voice-audio-delivery.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (70%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- TTS: Covers TTS across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.
- Outbound Voice Audio Delivery: Covers Outbound Voice Audio Delivery across `tts` agent/tool and Gateway methods, `messages.tts`, provider registry, directives, and related tts and outbound voice audio delivery behavior.

Primary docs:

- `docs/tools/tts.md`
- `docs/tools/media-overview.md`
- `docs/channels/discord.md`

### 5. Media Understanding

Search anchors: Audio attachment selection, Batch STT provider and CLI fallback, Voice-note mention preflight, Transcript insertion and echo, Audio proxy and limit handling, Media understanding (audio), Provider + CLI fallback, Mention detection in groups, Inbound image summarization, Active vision model bypass, Text-only model media offload, Vision provider fallback, Image and PDF input routing, Video Understanding, Direct Video Analysis, media understanding and media generation video understanding and direct video analysis, video understanding and direct video analysis.

Category note: [Media Understanding](image-understanding-and-vision-routing.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Audio attachment selection: Covers Audio attachment selection across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Batch STT provider and CLI fallback: Covers Batch STT provider and CLI fallback across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Voice-note mention preflight: Covers Voice-note mention preflight across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Transcript insertion and echo: Covers Transcript insertion and echo across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Audio proxy and limit handling: Covers Audio proxy and limit handling across batch audio/STT media understanding, local CLI fallbacks, provider transcription, voice-note preflight before mention gates, and related audio transcription and voice note understanding behavior.
- Inbound image summarization: Covers Inbound image summarization across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Active vision model bypass: Covers Active vision model bypass across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Text-only model media offload: Covers Text-only model media offload across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Vision provider fallback: Covers Vision provider fallback across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Image and PDF input routing: Covers Image and PDF input routing across image summarization before reply routing, active-model vision skip behavior, text-only model offload through `MediaPaths`/`media://inbound`, image-model fallback resolution, and related image understanding and vision routing behavior.
- Video Understanding: Covers Video Understanding across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.
- Direct Video Analysis: Covers Direct Video Analysis across video summarization before reply routing, provider/CLI video media entries, size and timeout controls, proxy support, video request construction, and direct video analysis paths. It does not score video generation.

Primary docs:

- `docs/nodes/audio.md`
- `docs/nodes/media-understanding.md`
- `docs/tools/media-overview.md`
- `docs/channels/whatsapp.md`
- `docs/nodes/images.md`
- `docs/cli/infer.md`
- `docs/tools/pdf.md`

### 6. Media Generation

Search anchors: Image generation tool invocation, Provider and model selection, Reference image editing, Generated image task lifecycle, Generated image persistence and delivery, Media understanding (audio), Provider + CLI fallback, Mention detection in groups, Music generation tool invocation, Lyrics, instrumental, duration, and format controls, Reference inputs where supported, Music task lifecycle and duplicate status, Generated audio persistence and delivery, Video generation tool invocation, Mode and provider capability selection, Reference image, video, and audio inputs, Provider option validation, Video task lifecycle and status, Generated video persistence and delivery.

Category note: [Media Generation](image-generation-tool-and-provider-routing.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (64%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Image generation tool invocation: Covers Image generation tool invocation across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Reference image editing: Covers Reference image editing across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image task lifecycle: Covers Generated image task lifecycle across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Generated image persistence and delivery: Covers Generated image persistence and delivery across `image_generate`, model selection, provider registration, provider capability listing, and related image generation tool and provider routing behavior.
- Music generation tool invocation: Covers Music generation tool invocation across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Provider and model selection: Covers Provider and model selection across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Lyrics, instrumental, duration, and format controls: Covers Lyrics, instrumental, duration, and format controls across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Reference inputs where supported: Covers Reference inputs where supported across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Music task lifecycle and duplicate status: Covers Music task lifecycle and duplicate status across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Generated audio persistence and delivery: Covers Generated audio persistence and delivery across `music_generate`, provider/model config, lyrics/instrumental/duration/format controls, image reference inputs where supported, and related music generation tool and provider routing behavior.
- Video generation tool invocation: Covers Video generation tool invocation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Mode and provider capability selection: Covers Mode and provider capability selection across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Reference image, video, and audio inputs: Covers Reference image, video, and audio inputs across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Provider option validation: Covers Provider option validation across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Video task lifecycle and status: Covers Video task lifecycle and status across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.
- Generated video persistence and delivery: Covers Generated video persistence and delivery across `video_generate`, mode resolution, provider capabilities, reference image/video/audio inputs, and related video generation tool and provider routing behavior.

Primary docs:

- `docs/tools/image-generation.md`
- `docs/tools/media-overview.md`
- `docs/tools/skills.md`
- `docs/tools/music-generation.md`
- `docs/tools/video-generation.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/media-understanding-and-media-generation/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/media-understanding-and-media-generation`.
