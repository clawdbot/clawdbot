---
title: "OpenAI / Codex provider path Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (78%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (78%)`
- LTS Features: `3/5`

## Summary

This report promotes the archived `openai-codex-provider-path` maturity evidence from `/Users/kevinlin/tmp/maturity/openai-codex-provider-path` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                   | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                   |
| ------------------------------------------------------------------------------------------ | --- | -------------- | ------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Model and Auth](canonical-openai-model-routing-and-catalog.md)                            | ✅  | `Beta (78%)`   | `Alpha (66%)` | `Beta (78%)`   | Canonical OpenAI Model Routing, Catalog, Codex OAuth Profiles, Subscription Usage, Doctor Diagnostics, Operator Repair |
| [Responses and Tool Compatibility](codex-responses-transport-and-payload-compatibility.md) | ✅  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Codex Responses Transport, Payload Compatibility, Tool Context, Capability Compatibility                               |
| [Native Codex Harness](native-codex-app-server-harness-and-thread-lifecycle.md)            | ✅  | `Stable (82%)` | `Beta (72%)`  | `Stable (82%)` | Native Codex App-server Harness, Thread Lifecycle                                                                      |
| [Image and Multimodal Input](image-generation-editing-and-multimodal-input.md)             | ❌  | `Stable (80%)` | `Beta (72%)`  | `Stable (80%)` | Image Generation Editing, Multimodal Input                                                                             |
| [Voice and Realtime Audio](realtime-voice-transcription-and-speech.md)                     | ❌  | `Beta (72%)`   | `Alpha (68%)` | `Beta (72%)`   | Realtime Voice Transcription, Speech                                                                                   |

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

### 1. Model and Auth

Search anchors: Canonical OpenAI Model Routing, Catalog, openai / codex provider path canonical openai model routing and catalog, canonical openai model routing and catalog, Codex OAuth Profiles, Subscription Usage, openai / codex provider path codex oauth profiles and subscription usage, codex oauth profiles and subscription usage, Doctor Diagnostics, Operator Repair, openai / codex provider path doctor diagnostics and operator repair, doctor diagnostics and operator repair.

Category note: [Model and Auth](canonical-openai-model-routing-and-catalog.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Canonical OpenAI Model Routing: Covers Canonical OpenAI Model Routing across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Catalog: Covers Catalog across user/operator-facing model route contract: canonical `openai/gpt-*` refs, legacy `openai-codex/*` model refs, model catalog rows, context limits, and related canonical openai model routing and catalog behavior.
- Codex OAuth Profiles: Covers Codex OAuth Profiles across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Subscription Usage: Covers Subscription Usage across `openai-codex` auth profiles, profile ordering, profile metadata repair, token refresh, account-id propagation, usage/cooldown handling, and auth selection for Codex-backed OpenAI agent turns.
- Doctor Diagnostics: Covers Doctor Diagnostics across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.
- Operator Repair: Covers Operator Repair across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.

Primary docs:

- `docs/providers/openai.md`
- `docs/plugins/codex-harness.md`
- `docs/concepts/models.md`
- `docs/concepts/oauth.md`
- `docs/plugins/codex-harness-reference.md`
- `docs/automation/auth-monitoring.md`

### 2. Responses and Tool Compatibility

Search anchors: Codex Responses Transport, Payload Compatibility, openai / codex provider path codex responses transport and payload compatibility, codex responses transport and payload compatibility, Tool Context, Capability Compatibility, openai / codex provider path tool context and capability compatibility, tool context and capability compatibility.

Category note: [Responses and Tool Compatibility](codex-responses-transport-and-payload-compatibility.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- Codex Responses Transport: Covers Codex Responses Transport across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Payload Compatibility: Covers Payload Compatibility across low-level provider request/streaming path for `openai-codex-responses` and the shared OpenAI Responses conversion code used by direct OpenAI and Codex-auth compatibility routes.
- Tool Context: Covers Tool Context across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.
- Capability Compatibility: Covers Capability Compatibility across provider-facing tools, context injection, media inputs, native-vs-client tool ownership, OpenAI Responses compatibility, and how OpenAI/Codex models receive OpenClaw runtime context.

Primary docs:

- `docs/providers/openai.md`
- `docs/gateway/openresponses-http-api.md`
- `docs/gateway/openai-http-api.md`
- `docs/plugins/codex-native-plugins.md`

### 3. Native Codex Harness

Search anchors: Native Codex App-server Harness, Thread Lifecycle, openai / codex provider path native codex app-server harness and thread lifecycle, native codex app-server harness and thread lifecycle.

Category note: [Native Codex Harness](native-codex-app-server-harness-and-thread-lifecycle.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Native Codex App-server Harness: Covers Native Codex App-server Harness across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.
- Thread Lifecycle: Covers Thread Lifecycle across native Codex app-server runtime path used by OpenAI agent turns when the Codex harness owns thread identity, native model loop, compaction, native tools, and native app-server controls.

Primary docs:

- `docs/plugins/codex-harness.md`
- `docs/plugins/codex-harness-runtime.md`
- `docs/plugins/codex-harness-reference.md`
- `docs/plugins/codex-native-plugins.md`

### 4. Image and Multimodal Input

Search anchors: Image Generation Editing, Multimodal Input, openai / codex provider path image generation editing and multimodal input, image generation editing and multimodal input.

Category note: [Image and Multimodal Input](image-generation-editing-and-multimodal-input.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (80%)`
- LTS: ❌

Features:

- Image Generation Editing: Covers Image Generation Editing across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.
- Multimodal Input: Covers Multimodal Input across OpenAI image generation and editing, Codex OAuth image backend, transparent-background routing, Azure/private OpenAI image endpoints, and related image generation editing and multimodal input behavior.

Primary docs:

- `docs/providers/openai.md`
- `docs/tools/image-generation.md`
- `docs/nodes/images.md`

### 5. Voice and Realtime Audio

Search anchors: Realtime Voice Transcription, Speech, openai / codex provider path realtime voice transcription and speech, realtime voice transcription and speech.

Category note: [Voice and Realtime Audio](realtime-voice-transcription-and-speech.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Realtime Voice Transcription: Covers Realtime Voice Transcription across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.
- Speech: Covers Speech across OpenAI text-to-speech, batch speech-to-text, Realtime transcription, Realtime voice, browser Talk/WebRTC, backend WebSocket bridges, OAuth-backed client secret minting, Azure Realtime deployments, and voice-control behavior.

Primary docs:

- `docs/providers/openai.md`
- `docs/channels/discord.md`
- `docs/plugins/voice-call.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/openai-codex-provider-path/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/openai-codex-provider-path`.
