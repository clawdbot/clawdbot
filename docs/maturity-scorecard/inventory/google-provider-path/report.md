---
title: "Google provider path Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (73%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (73%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `google-provider-path` maturity evidence from `/Users/kevinlin/tmp/maturity/google-provider-path` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                    | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Provider Setup and Credentials](provider-auth-credentials-and-operator-setup.md)           | ❌  | `Beta (72%)`   | `Alpha (60%)`  | `Beta (72%)`   | API key onboarding, Auth choice metadata, Gemini CLI OAuth setup, Vertex ADC setup, Daemon and fallback credentials, CLI runtime selection, OAuth login and refresh, Canonical Google model refs, CLI usage normalization, OAuth diagnostics                           |
| [Model Routing and Endpoints](model-catalog-provider-routing-and-config-normalization.md)   | ❌  | `Alpha (68%)`  | `Alpha (62%)`  | `Alpha (68%)`  | Catalog rows and aliases, Dynamic model resolution, Provider routing, Google-native config normalization, Model picker availability, Vertex provider selection, ADC/service-account auth, Project/location endpoints, Custom base URL policy, Compatibility boundaries |
| [Direct Gemini Runtime](direct-gemini-api-transport-streaming-and-multimodal-payloads.md)   | ❌  | `Stable (82%)` | `Stable (80%)` | `Stable (82%)` | Direct Gemini chat, Multimodal inputs, Tool-call streaming, Usage and stop reasons, Thought-signature replay, Thinking-level mapping, Thought-signature replay, Tool turn ordering, Incomplete-turn recovery, Planning-only turn recovery                              |
| [Media, Search, and Realtime](plugin-distribution-and-cross-surface-capability-adapters.md) | ❌  | `Beta (76%)`   | `Alpha (65%)`  | `Beta (76%)`   | Bundled plugin distribution, Provider auto-enable metadata, Image and media adapters, Speech and realtime adapters, Search and generation tools, Realtime voice sessions, Constrained browser tokens, Audio and transcript events, Live tool calls, Session reconnects |
| [Prompt Caching](prompt-cache-cache-retention-and-usage-accounting.md)                      | ❌  | `Alpha (68%)`  | `Beta (74%)`   | `Alpha (68%)`  | Cache retention config, Managed cachedContents, Manual cachedContent handles, Cache usage accounting, Cache diagnostics and live proof                                                                                                                                 |

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

### 1. Provider Setup and Credentials

Search anchors: API key onboarding, Auth choice metadata, Gemini CLI OAuth setup, Vertex ADC setup, Daemon and fallback credentials, CLI runtime selection, OAuth login and refresh, Canonical Google model refs, CLI usage normalization, OAuth diagnostics.

Category note: [Provider Setup and Credentials](provider-auth-credentials-and-operator-setup.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (60%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- API key onboarding: Covers API key onboarding across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Auth choice metadata: Covers Auth choice metadata across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Gemini CLI OAuth setup: Covers Gemini CLI OAuth setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Vertex ADC setup: Covers Vertex ADC setup across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- Daemon and fallback credentials: Covers Daemon and fallback credentials across direct `GEMINI_API_KEY` and `GOOGLE_API_KEY` auth, setup provider metadata, setup auth choices, provider config fields, and related provider auth and setup behavior.
- CLI runtime selection: Covers CLI runtime selection across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth login and refresh: Covers OAuth login and refresh across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- Canonical Google model refs: Covers Canonical Google model refs across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- CLI usage normalization: Covers CLI usage normalization across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.
- OAuth diagnostics: Covers OAuth diagnostics across `google-gemini-cli` provider, canonical `google/*` model refs using `agentRuntime.id: "google-gemini-cli"`, legacy `google-gemini-cli/*` refs, Gemini CLI command invocation, and related gemini cli oauth behavior.

Primary docs:

- `docs/providers/google.md`
- `docs/concepts/model-providers.md`

### 2. Model Routing and Endpoints

Search anchors: Catalog rows and aliases, Dynamic model resolution, Provider routing, Google-native config normalization, Model picker availability, Vertex provider selection, ADC/service-account auth, Project/location endpoints, Custom base URL policy, Compatibility boundaries.

Category note: [Model Routing and Endpoints](model-catalog-provider-routing-and-config-normalization.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Catalog rows and aliases: Covers Catalog rows and aliases across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Dynamic model resolution: Covers Dynamic model resolution across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Provider routing: Covers Provider routing across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Google-native config normalization: Covers Google-native config normalization across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Model picker availability: Covers Model picker availability across model catalog rows, model ID normalization, dynamic model resolution, provider hooks, and related model catalog and routing behavior.
- Vertex provider selection: Covers Vertex provider selection across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- ADC/service-account auth: Covers ADC/service-account auth across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Project/location endpoints: Covers Project/location endpoints across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Custom base URL policy: Covers Custom base URL policy across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.
- Compatibility boundaries: Covers Compatibility boundaries across `google-vertex`, Vertex ADC/service-account auth, project/location endpoint construction, custom Google-compatible base URL handling, and related vertex ai and custom endpoints behavior.

Primary docs:

- `docs/providers/google.md`
- `docs/concepts/model-providers.md`
- `docs/plugins/reference/google.md`
- `docs/tools/gemini-search.md`

### 3. Direct Gemini Runtime

Search anchors: Direct Gemini chat, Multimodal inputs, Tool-call streaming, Usage and stop reasons, Thought-signature replay, Thinking-level mapping, Tool turn ordering, Incomplete-turn recovery, Planning-only turn recovery.

Category note: [Direct Gemini Runtime](direct-gemini-api-transport-streaming-and-multimodal-payloads.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Stable (80%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Direct Gemini chat: Covers Direct Gemini chat across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Multimodal inputs: Covers Multimodal inputs across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Tool-call streaming: Covers Tool-call streaming across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Usage and stop reasons: Covers Usage and stop reasons across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thought-signature replay: Covers Thought-signature replay across direct `google-generative-ai` Gemini transport and shared Google message/stream conversion: request URL construction, request config, text/image/audio/video/tool payload conversion, function response handling, and related direct gemini api behavior.
- Thinking-level mapping: Covers Thinking-level mapping across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Thought-signature replay: Covers Thought-signature replay across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Tool turn ordering: Covers Tool turn ordering across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Incomplete-turn recovery: Covers Incomplete-turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.
- Planning-only turn recovery: Covers Planning-only turn recovery across Gemini thinking-level mapping, adaptive thinking request shape, `thoughtSignature` capture/replay/sanitization, Google replay policy, and related thinking and turn recovery behavior.

Primary docs:

- `docs/providers/google.md`
- `docs/concepts/model-providers.md`
- `docs/help/faq-models.md`
- `docs/help/testing-live.md`

### 4. Media, Search, and Realtime

Search anchors: Bundled plugin distribution, Provider auto-enable metadata, Image and media adapters, Speech and realtime adapters, Search and generation tools, Realtime voice sessions, Constrained browser tokens, Audio and transcript events, Live tool calls, Session reconnects.

Category note: [Media, Search, and Realtime](plugin-distribution-and-cross-surface-capability-adapters.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (65%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Bundled plugin distribution: Covers Bundled plugin distribution across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Provider auto-enable metadata: Covers Provider auto-enable metadata across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Image and media adapters: Covers Image and media adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Speech and realtime adapters: Covers Speech and realtime adapters across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Search and generation tools: Covers Search and generation tools across bundled `@openclaw/google-plugin` package, plugin manifest distribution, auto-enable metadata, capability-provider registration, and related google plugin adapters behavior.
- Realtime voice sessions: Covers Realtime voice sessions across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Constrained browser tokens: Covers Constrained browser tokens across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Audio and transcript events: Covers Audio and transcript events across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Live tool calls: Covers Live tool calls across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.
- Session reconnects: Covers Session reconnects across Gemini Live realtime voice provider behavior, Talk relay integration, constrained browser websocket tokens, audio queueing, and related gemini live talk behavior.

Primary docs:

- `docs/plugins/reference/google.md`
- `docs/providers/google.md`

### 5. Prompt Caching

Search anchors: Cache retention config, Managed cachedContents, Manual cachedContent handles, Cache usage accounting, Cache diagnostics and live proof.

Category note: [Prompt Caching](prompt-cache-cache-retention-and-usage-accounting.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Beta (74%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- Cache retention config: Covers Cache retention config across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Managed cachedContents: Covers Managed cachedContents across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Manual cachedContent handles: Covers Manual cachedContent handles across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache usage accounting: Covers Cache usage accounting across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache diagnostics and live proof: Covers Cache diagnostics and live proof across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.

Primary docs:

- `docs/reference/prompt-caching.md`
- `docs/providers/google.md`
- `docs/concepts/model-providers.md`
- `docs/reference/token-use.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/google-provider-path/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/google-provider-path`.
