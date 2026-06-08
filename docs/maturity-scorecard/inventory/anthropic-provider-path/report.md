---
title: "Anthropic provider path Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (80%)`
- Quality: `Beta (74%)`
- Completeness: `Stable (80%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `anthropic-provider-path` maturity evidence from `/Users/kevinlin/tmp/maturity/anthropic-provider-path` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                     | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Provider Auth and Recovery](auth-onboarding-and-credential-profile-health.md)               | ❌  | `Beta (78%)`   | `Beta (70%)`   | `Beta (78%)`   | API-key onboarding, Claude CLI credential reuse, Setup-token auth, Auth profile health, Model status, Usage windows, Cooldown/profile reporting, Long-context recovery, Fallback guidance                                     |
| [Model and Runtime Selection](model-catalog-aliases-and-runtime-policy.md)                   | ❌  | `Stable (82%)` | `Alpha (68%)`  | `Stable (82%)` | Bundled Claude catalog, Canonical anthropic refs, Claude CLI compatibility, Model picker availability, Capability metadata, Runtime selection, Session continuity, MCP/tool bridge, Permission-mode mapping, Fallback prelude |
| [Request Transport and Turn Semantics](direct-anthropic-messages-transport-and-streaming.md) | ❌  | `Stable (82%)` | `Beta (72%)`   | `Stable (82%)` | API-key/OAuth transport, Messages payloads, Streaming decode, Usage and stop reasons, Abort/error handling, Tool-use blocks, Tool-result replay, Partial JSON recovery, Native thinking, Signed/redacted thinking replay      |
| [Prompt Cache and Context](prompt-caching-context-windows-and-request-knobs.md)              | ❌  | `Stable (82%)` | `Beta (76%)`   | `Stable (82%)` | Cache retention, System-prompt cache boundary, 1M context, Fast mode/service tier, Cache diagnostics                                                                                                                          |
| [Media Inputs](media-understanding-and-document-inputs.md)                                   | ❌  | `Beta (74%)`   | `Stable (82%)` | `Beta (74%)`   | Image input, PDF document input, Media model fallback, Image tool results                                                                                                                                                     |

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

### 1. Provider Auth and Recovery

Search anchors: API-key onboarding, Claude CLI credential reuse, Setup-token auth, Auth profile health, Model status, Usage windows, Cooldown/profile reporting, Long-context recovery, Fallback guidance.

Category note: [Provider Auth and Recovery](auth-onboarding-and-credential-profile-health.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- API-key onboarding: Covers API-key onboarding across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Claude CLI credential reuse: Covers Claude CLI credential reuse across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Setup-token auth: Covers Setup-token auth across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Auth profile health: Covers Auth profile health across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Model status: Covers Model status across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Usage windows: Covers Usage windows across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Cooldown/profile reporting: Covers Cooldown/profile reporting across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Long-context recovery: Covers Long-context recovery across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Fallback guidance: Covers Fallback guidance across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.

Primary docs:

- `docs/providers/anthropic.md`
- `docs/gateway/doctor.md`
- `docs/gateway/configuration-examples.md`
- `docs/gateway/troubleshooting.md`
- `docs/reference/prompt-caching.md`

### 2. Model and Runtime Selection

Search anchors: Bundled Claude catalog, Canonical anthropic refs, Claude CLI compatibility, Model picker availability, Capability metadata, Runtime selection, Session continuity, MCP/tool bridge, Permission-mode mapping, Fallback prelude.

Category note: [Model and Runtime Selection](model-catalog-aliases-and-runtime-policy.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Alpha (68%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Bundled Claude catalog: Covers Bundled Claude catalog across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Canonical anthropic refs: Covers Canonical anthropic refs across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Claude CLI compatibility: Covers Claude CLI compatibility across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Model picker availability: Covers Model picker availability across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Capability metadata: Covers Capability metadata across Anthropic model catalog and policy layer: bundled model rows, model aliases, current and future Claude model id normalization, runtime-provider selection, and related model catalog and policy behavior.
- Runtime selection: Covers Runtime selection across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Session continuity: Covers Session continuity across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- MCP/tool bridge: Covers MCP/tool bridge across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Permission-mode mapping: Covers Permission-mode mapping across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.
- Fallback prelude: Covers Fallback prelude across OpenClaw's host-local Claude CLI path after auth is available: the `claude-cli` backend, its command/args/env defaults, MCP tool bridge, native tool mode, and related claude cli backend behavior.

Primary docs:

- `docs/providers/anthropic.md`
- `docs/gateway/config-agents.md`
- `docs/concepts/models.md`
- `docs/gateway/cli-backends.md`

### 3. Request Transport and Turn Semantics

Search anchors: API-key/OAuth transport, Messages payloads, Streaming decode, Usage and stop reasons, Abort/error handling, Tool-use blocks, Tool-result replay, Partial JSON recovery, Native thinking, Signed/redacted thinking replay.

Category note: [Request Transport and Turn Semantics](direct-anthropic-messages-transport-and-streaming.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (72%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- API-key/OAuth transport: Covers API-key/OAuth transport across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Messages payloads: Covers Messages payloads across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Streaming decode: Covers Streaming decode across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Abort/error handling: Covers Abort/error handling across direct Anthropic `api: "anthropic-messages"` request and stream behavior: API-key and OAuth transport setup, Anthropic beta headers, model-id normalization for direct hosts, payload construction, and related direct anthropic api behavior.
- Tool-use blocks: Covers Tool-use blocks across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Tool-result replay: Covers Tool-result replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Partial JSON recovery: Covers Partial JSON recovery across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Native thinking: Covers Native thinking across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.
- Signed/redacted thinking replay: Covers Signed/redacted thinking replay across Anthropic-specific turn semantics inside agent runs: tool declarations, tool-use block conversion, tool-result conversion, tool-call id normalization, and related tools and thinking behavior.

Primary docs:

- `docs/providers/anthropic.md`
- `docs/reference/prompt-caching.md`
- `docs/gateway/troubleshooting.md`
- `docs/gateway/cli-backends.md`
- `docs/concepts/model-providers.md`

### 4. Prompt Cache and Context

Search anchors: Cache retention, System-prompt cache boundary, 1M context, Fast mode/service tier, Cache diagnostics.

Category note: [Prompt Cache and Context](prompt-caching-context-windows-and-request-knobs.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Cache retention: Covers Cache retention across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- System-prompt cache boundary: Covers System-prompt cache boundary across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- 1M context: Covers 1M context across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Fast mode/service tier: Covers Fast mode/service tier across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Cache diagnostics: Covers Cache diagnostics across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.

Primary docs:

- `docs/providers/anthropic.md`
- `docs/reference/prompt-caching.md`
- `docs/gateway/troubleshooting.md`
- `docs/gateway/heartbeat.md`

### 5. Media Inputs

Search anchors: Image input, PDF document input, Media model fallback, Image tool results.

Category note: [Media Inputs](media-understanding-and-document-inputs.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Stable (82%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Image input: Covers Image input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- PDF document input: Covers PDF document input across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Media model fallback: Covers Media model fallback across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.
- Image tool results: Covers Image tool results across Anthropic media understanding as part of the provider path: image input support, PDF native document input metadata, default media model selection, auto-priority, and related media inputs behavior.

Primary docs:

- `docs/providers/anthropic.md`
- `docs/gateway/config-agents.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/anthropic-provider-path/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/anthropic-provider-path`.
