---
title: "Long-tail hosted providers Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (64%)`
- Quality: `Alpha (60%)`
- Completeness: `Alpha (64%)`
- LTS Features: `0/3`

## Summary

This report promotes the archived `long-tail-hosted-providers` maturity evidence from `/Users/kevinlin/tmp/maturity/long-tail-hosted-providers` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                            | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Hosted LLM Providers](openai-compatible-hosted-text-adapters.md)   | ❌  | `Alpha (58%)` | `Alpha (56%)` | `Alpha (58%)` | Bedrock setup, Gateway/proxy routing, Copilot/OpenCode hosted access, Proxy capability diagnostics, Hosted text completion, Tool-call and streaming compatibility, Model catalog resolution, Provider-specific request shaping, Regional provider setup, Region and plan routing, Regional live smoke, Account prerequisite diagnostics |
| [Hosted Media Providers](hosted-media-generation-providers.md)      | ❌  | `Beta (70%)`  | `Alpha (64%)` | `Beta (70%)`  | Image generation providers, Video generation providers, Music generation providers, Media mode coverage, Text-to-speech providers, Speech-to-text providers, Realtime transcription providers, Audio format diagnostics                                                                                                                 |
| [Provider Operations](setup-auth-profiles-and-credential-health.md) | ❌  | `Alpha (64%)` | `Alpha (60%)` | `Alpha (64%)` | Provider directory, Provider install catalog, Model catalog metadata, Catalog parity checks, Provider setup descriptors, Auth profiles and aliases, Credential health probes, Key rotation and recovery, Direct provider smoke, Gateway live smoke, Models status probes, Fallback trace and repair                                     |

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

### 1. Hosted LLM Providers

Search anchors: Bedrock setup, Gateway/proxy routing, Copilot/OpenCode hosted access, Proxy capability diagnostics, Hosted text completion, Tool-call and streaming compatibility, Model catalog resolution, Provider-specific request shaping, Regional provider setup, Region and plan routing, Regional live smoke, Account prerequisite diagnostics.

Category note: [Hosted LLM Providers](openai-compatible-hosted-text-adapters.md)

Score decisions:

- Coverage: `Alpha (58%)`
- Quality: `Alpha (56%)`
- Completeness: `Alpha (58%)`
- LTS: ❌

Features:

- Bedrock setup: Covers Bedrock setup across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Gateway/proxy routing: Covers Gateway/proxy routing across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Copilot/OpenCode hosted access: Covers Copilot/OpenCode hosted access across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Proxy capability diagnostics: Covers Proxy capability diagnostics across Amazon Bedrock, Bedrock Mantle, Cloudflare AI Gateway, Vercel AI Gateway, and related cloud and gateway providers behavior.
- Hosted text completion: Covers Hosted text completion across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Tool-call and streaming compatibility: Covers Tool-call and streaming compatibility across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Model catalog resolution: Covers Model catalog resolution across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Provider-specific request shaping: Covers Provider-specific request shaping across hosted text providers that mostly use OpenAI-compatible routes or close variants: DeepSeek, Groq, Mistral, Together, and related openai-compatible hosted text providers behavior.
- Regional provider setup: Covers Regional provider setup across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Region and plan routing: Covers Region and plan routing across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Regional live smoke: Covers Regional live smoke across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.
- Account prerequisite diagnostics: Covers Account prerequisite diagnostics across Qwen, Alibaba, Tencent, Qianfan, and related regional hosted llm providers behavior.

Primary docs:

- `docs/providers/index.md`
- `docs/concepts/model-providers.md`
- `docs/help/testing-live.md`
- `docs/cli/onboard.md`

### 2. Hosted Media Providers

Search anchors: Image generation providers, Video generation providers, Music generation providers, Media mode coverage, Text-to-speech providers, Speech-to-text providers, Realtime transcription providers, Audio format diagnostics.

Category note: [Hosted Media Providers](hosted-media-generation-providers.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (64%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Image generation providers: Covers Image generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Video generation providers: Covers Video generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Music generation providers: Covers Music generation providers across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Media mode coverage: Covers Media mode coverage across hosted image, video, and music generation provider paths, including DeepInfra, and related hosted media generation providers behavior.
- Text-to-speech providers: Covers Text-to-speech providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Speech-to-text providers: Covers Speech-to-text providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Realtime transcription providers: Covers Realtime transcription providers across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.
- Audio format diagnostics: Covers Audio format diagnostics across text-to-speech, speech-to-text, realtime transcription, telephony audio, and related hosted speech, transcription, and audio providers behavior.

Primary docs:

- `docs/plugins/manifest.md`
- `docs/help/testing-live.md`
- `docs/providers/index.md`

### 3. Provider Operations

Search anchors: Provider directory, Provider install catalog, Model catalog metadata, Catalog parity checks, Provider setup descriptors, Auth profiles and aliases, Credential health probes, Key rotation and recovery, Direct provider smoke, Gateway live smoke, Models status probes, Fallback trace and repair.

Category note: [Provider Operations](setup-auth-profiles-and-credential-health.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (60%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Provider directory: Covers Provider directory across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider install catalog: Covers Provider install catalog across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Model catalog metadata: Covers Model catalog metadata across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Catalog parity checks: Covers Catalog parity checks across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider setup descriptors: Covers Provider setup descriptors across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Auth profiles and aliases: Covers Auth profiles and aliases across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Credential health probes: Covers Credential health probes across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Key rotation and recovery: Covers Key rotation and recovery across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Direct provider smoke: Covers Direct provider smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Gateway live smoke: Covers Gateway live smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Models status probes: Covers Models status probes across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Fallback trace and repair: Covers Fallback trace and repair across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.

Primary docs:

- `docs/providers/index.md`
- `docs/concepts/model-providers.md`
- `docs/plugins/manifest.md`
- `docs/help/testing-live.md`
- `docs/cli/models.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/long-tail-hosted-providers/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/long-tail-hosted-providers`.
