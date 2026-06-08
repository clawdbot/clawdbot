---
title: "OpenRouter provider path Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (75%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (75%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `openrouter-provider-path` maturity evidence from `/Users/kevinlin/tmp/maturity/openrouter-provider-path` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                              | LTS | Coverage     | Quality       | Completeness | Features to evaluate                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | --- | ------------ | ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Provider Setup and Auth](operator-setup-and-provider-registration.md)                | ❌  | `Beta (78%)` | `Alpha (64%)` | `Beta (78%)` | First-run setup, Default model selection, Provider plugin registration, Model-ref examples, OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance, Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache                                                                   |
| [Chat Runtime and Normalization](chat-completions-transport-routing-and-reasoning.md) | ❌  | `Beta (76%)` | `Beta (70%)`  | `Beta (76%)` | Chat completions route, Provider routing params, Per-model route overrides, Reasoning payload policy, Anthropic/Gemini/DeepSeek variants, Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization, Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions |
| [Provider Recovery and Diagnostics](failover-errors-overflow-and-diagnostics.md)      | ❌  | `Beta (74%)` | `Alpha (65%)` | `Beta (74%)` | Timeout/retry classification, Auth/billing/key-limit classification, Context overflow, Model fallback notices, Guarded fetch/pricing warnings                                                                                                                                                                                                                                                                                                   |
| [Media Generation and Speech](media-generation-speech-and-media-understanding.md)     | ❌  | `Beta (72%)` | `Alpha (66%)` | `Beta (72%)` | image_generate OpenRouter route, video_generate async jobs/polling/download, music_generate audio route, Text-to-speech, Speech-to-text transcription, Inbound media understanding, Generated artifact delivery                                                                                                                                                                                                                                 |

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

### 1. Provider Setup and Auth

Search anchors: First-run setup, Default model selection, Provider plugin registration, Model-ref examples, OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance, Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache.

Category note: [Provider Setup and Auth](operator-setup-and-provider-registration.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (64%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- First-run setup: Covers First-run setup across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Default model selection: Covers Default model selection across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Provider plugin registration: Covers Provider plugin registration across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Model-ref examples: Covers Model-ref examples across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- OPENROUTER_API_KEY: Covers OPENROUTER_API_KEY across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Auth profiles and auth order: Covers Auth profiles and auth order across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Status/probe and removal: Covers Status/probe and removal across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Provider-entry SecretRef/API-key resolution: Covers Provider-entry SecretRef/API-key resolution across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Gateway env inheritance: Covers Gateway env inheritance across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Static catalog rows: Covers Static catalog rows across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Dynamic /models discovery: Covers Dynamic /models discovery across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- openrouter/auto and nested refs: Covers openrouter/auto and nested refs across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Free-model scan/probe: Covers Free-model scan/probe across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Model list/picker cache: Covers Model list/picker cache across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.

Primary docs:

- `docs/providers/openrouter.md`
- `docs/concepts/model-providers.md`
- `docs/cli/configure.md`
- `docs/gateway/authentication.md`
- `docs/help/environment.md`
- `docs/cli/models.md`
- `docs/concepts/models.md`

### 2. Chat Runtime and Normalization

Search anchors: Chat completions route, Provider routing params, Per-model route overrides, Reasoning payload policy, Anthropic/Gemini/DeepSeek variants, Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization, Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions.

Category note: [Chat Runtime and Normalization](chat-completions-transport-routing-and-reasoning.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Chat completions route: Covers Chat completions route across OpenRouter chat completions transport, `models.providers.openrouter.params.provider` routing, per-model routing overrides, OpenRouter proxy reasoning payloads, and related chat routing and reasoning behavior.
- Provider routing params: Covers Provider routing params across OpenRouter chat completions transport, `models.providers.openrouter.params.provider` routing, per-model routing overrides, OpenRouter proxy reasoning payloads, and related chat routing and reasoning behavior.
- Per-model route overrides: Covers Per-model route overrides across OpenRouter chat completions transport, `models.providers.openrouter.params.provider` routing, per-model routing overrides, OpenRouter proxy reasoning payloads, and related chat routing and reasoning behavior.
- Reasoning payload policy: Covers Reasoning payload policy across OpenRouter chat completions transport, `models.providers.openrouter.params.provider` routing, per-model routing overrides, OpenRouter proxy reasoning payloads, and related chat routing and reasoning behavior.
- Anthropic/Gemini/DeepSeek variants: Covers Anthropic/Gemini/DeepSeek variants across OpenRouter chat completions transport, `models.providers.openrouter.params.provider` routing, per-model routing overrides, OpenRouter proxy reasoning payloads, and related chat routing and reasoning behavior.
- Streamed content parsing: Covers Streamed content parsing across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- reasoning_details visible output: Covers reasoning_details visible output across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Tool-call delta preservation: Covers Tool-call delta preservation across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Family-specific replay policy: Covers Family-specific replay policy across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Response-model and usage normalization: Covers Response-model and usage normalization across streamed response parsing, visible output extraction from OpenRouter `reasoning_details`, tool-call delta preservation, Mistral strict9 replay policy, and related streaming and tool-call replay behavior.
- Attribution headers: Covers Attribution headers across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Response-cache headers/TTL/clear: Covers Response-cache headers/TTL/clear across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Anthropic cache-control markers: Covers Anthropic cache-control markers across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Cache usage mapping: Covers Cache usage mapping across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Custom proxy exclusions: Covers Custom proxy exclusions across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.

Primary docs:

- `docs/providers/openrouter.md`
- `docs/concepts/model-providers.md`
- `docs/reference/prompt-caching.md`

### 3. Provider Recovery and Diagnostics

Search anchors: Timeout/retry classification, Auth/billing/key-limit classification, Context overflow, Model fallback notices, Guarded fetch/pricing warnings.

Category note: [Provider Recovery and Diagnostics](failover-errors-overflow-and-diagnostics.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (65%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Timeout/retry classification: Covers Timeout/retry classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Auth/billing/key-limit classification: Covers Auth/billing/key-limit classification across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Context overflow: Covers Context overflow across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Model fallback notices: Covers Model fallback notices across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.
- Guarded fetch/pricing warnings: Covers Guarded fetch/pricing warnings across OpenRouter timeout and retry classification, provider-specific generic errors, auth/billing/key-limit classification, context overflow parsing, and related failover and diagnostics behavior.

Primary docs:

- `docs/concepts/model-failover.md`
- `docs/providers/openrouter.md`
- `docs/cli/models.md`

### 4. Media Generation and Speech

Search anchors: image_generate OpenRouter route, video_generate async jobs/polling/download, music_generate audio route, Text-to-speech, Speech-to-text transcription, Inbound media understanding, Generated artifact delivery.

Category note: [Media Generation and Speech](media-generation-speech-and-media-understanding.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- image_generate OpenRouter route: Covers image_generate OpenRouter route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- video_generate async jobs/polling/download: Covers video_generate async jobs/polling/download across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- music_generate audio route: Covers music_generate audio route across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Text-to-speech: Covers Text-to-speech across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Speech-to-text transcription: Covers Speech-to-text transcription across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Inbound media understanding: Covers Inbound media understanding across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.
- Generated artifact delivery: Covers Generated artifact delivery across OpenRouter image, video, music, TTS, and related image, video, music, and speech behavior.

Primary docs:

- `docs/providers/openrouter.md`
- `docs/tools/image-generation.md`
- `docs/tools/music-generation.md`
- `docs/tools/media-overview.md`
- `docs/tools/video-generation.md`
- `docs/tools/tts.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/openrouter-provider-path/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/openrouter-provider-path`.
