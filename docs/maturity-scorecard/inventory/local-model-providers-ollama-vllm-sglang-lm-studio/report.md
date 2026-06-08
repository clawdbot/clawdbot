---
title: "Local model providers: Ollama, vLLM, SGLang, LM Studio Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Local model providers: Ollama, vLLM, SGLang, LM Studio Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (77%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (77%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `local-model-providers-ollama-vllm-sglang-lm-studio` maturity evidence from `/Users/kevinlin/tmp/maturity/local-model-providers-ollama-vllm-sglang-lm-studio` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                    | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | --- | -------------- | -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Provider Setup, Lifecycle, and Diagnostics](provider-selection-and-onboarding.md)          | ❌  | `Beta (74%)`   | `Beta (72%)`   | `Beta (74%)`   | Provider Selection, Onboarding, localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes, Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs |
| [Native Provider Plugins](ollama-native-provider.md)                                        | ❌  | `Beta (78%)`   | `Beta (78%)`   | `Beta (78%)`   | Ollama setup and model pulling, Model discovery, Streaming and vision, Ollama embeddings, Web-search support, LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings                                                                                |
| [OpenAI-Compatible Runtime Compatibility](request-stream-compatibility-and-tool-calling.md) | ❌  | `Beta (74%)`   | `Alpha (68%)`  | `Beta (74%)`   | Bundled provider setup, Model Discovery Endpoint, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance, Request Stream Compatibility, Tool Calling                                                                                        |
| [Local Memory and Embeddings](local-embeddings-and-memory-provider-usage.md)                | ❌  | `Beta (76%)`   | `Alpha (68%)`  | `Beta (76%)`   | Embedding provider selection, Memory search readiness, memoryFlush model override, Fallback lexical search, Provider mismatch guidance                                                                                                                                                                               |
| [Network Safety and Prompt Controls](safety-network-and-prompt-pressure-controls.md)        | ❌  | `Stable (82%)` | `Stable (82%)` | `Stable (82%)` | Safety Network, Prompt Pressure Controls                                                                                                                                                                                                                                                                             |

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

### 1. Provider Setup, Lifecycle, and Diagnostics

Search anchors: Provider Selection, Onboarding, local model providers: ollama, vllm, sglang, lm studio provider selection and onboarding, provider selection and onboarding, localService configuration, Process startup and readiness, Request leases and idle shutdown, Health checks and restart, Provider recipes, Local provider status, Backend reachability probes, Model availability errors, Memory readiness diagnostics, Provider troubleshooting docs.

Category note: [Provider Setup, Lifecycle, and Diagnostics](provider-selection-and-onboarding.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Provider Selection: Covers Provider Selection across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- Onboarding: Covers Onboarding across provider choice, `openclaw onboard`, model-picker contributions, non-interactive setup, and related provider selection and onboarding behavior.
- localService configuration: Covers localService configuration across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Process startup and readiness: Covers Process startup and readiness across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Request leases and idle shutdown: Covers Request leases and idle shutdown across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Health checks and restart: Covers Health checks and restart across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Provider recipes: Covers Provider recipes across `localService` config contract, process startup, readiness probes, lease/release behavior during provider requests, and related local service lifecycle and readiness behavior.
- Local provider status: Covers Local provider status across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Backend reachability probes: Covers Backend reachability probes across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Model availability errors: Covers Model availability errors across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Memory readiness diagnostics: Covers Memory readiness diagnostics across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.
- Provider troubleshooting docs: Covers Provider troubleshooting docs across user-facing diagnostic commands, provider HTTP error normalization, model-not-found classification, direct local backend probes, and related diagnostics and troubleshooting behavior.

Primary docs:

- `docs/gateway/local-models.md`
- `docs/providers/lmstudio.md`
- `docs/providers/ollama.md`
- `docs/providers/vllm.md`
- `docs/gateway/local-model-services.md`
- `docs/gateway/config-agents.md`
- `docs/gateway/troubleshooting.md`
- `docs/gateway/doctor.md`

### 2. Native Provider Plugins

Search anchors: Ollama setup and model pulling, Model discovery, Streaming and vision, Ollama embeddings, Web-search support, LM Studio setup, Model discovery and auth, Model preload and JIT loading, Streaming compatibility, LM Studio embeddings.

Category note: [Native Provider Plugins](ollama-native-provider.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (78%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Ollama setup and model pulling: Covers Ollama setup and model pulling across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Model discovery: Covers Model discovery across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Streaming and vision: Covers Streaming and vision across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Ollama embeddings: Covers Ollama embeddings across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- Web-search support: Covers Web-search support across native Ollama chat/model discovery, cloud+local/local-only setup, local auth markers, model pulling, and related ollama native provider behavior.
- LM Studio setup: Covers LM Studio setup across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model discovery and auth: Covers Model discovery and auth across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Model preload and JIT loading: Covers Model preload and JIT loading across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- Streaming compatibility: Covers Streaming compatibility across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.
- LM Studio embeddings: Covers LM Studio embeddings across LM Studio provider plugin, `/providers/lmstudio` docs, model discovery from LM Studio APIs, auth behavior for local and authenticated instances, preload/JIT behavior, OpenAI-compatible streaming, and LM Studio memory embeddings.

Primary docs:

- `docs/providers/ollama.md`
- `docs/providers/lmstudio.md`

### 3. OpenAI-Compatible Runtime Compatibility

Search anchors: Bundled provider setup, /v1/models discovery, Non-interactive configuration, vLLM thinking controls, OpenAI-compatible chat and tool semantics, SGLang compatibility guidance, Request Stream Compatibility, Tool Calling, local model providers: ollama, vllm, sglang, lm studio request stream compatibility and tool calling, request stream compatibility and tool calling.

Category note: [OpenAI-Compatible Runtime Compatibility](request-stream-compatibility-and-tool-calling.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Bundled provider setup: Covers Bundled provider setup across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Model Discovery Endpoint: Covers Model Discovery Endpoint across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Non-interactive configuration: Covers Non-interactive configuration across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- vLLM thinking controls: Covers vLLM thinking controls across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- OpenAI-compatible chat and tool semantics: Covers OpenAI-compatible chat and tool semantics across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- SGLang compatibility guidance: Covers SGLang compatibility guidance across bundled `vllm` and `sglang` provider plugins, docs, default env/base URL behavior, `/v1/models` discovery, and related vllm and sglang openai-compatible providers behavior.
- Request Stream Compatibility: Covers Request Stream Compatibility across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.
- Tool Calling: Covers Tool Calling across chat and Responses-style request shaping, streaming normalization, tool-call compatibility, local-model reasoning controls, and related request stream compatibility and tool calling behavior.

Primary docs:

- `docs/providers/vllm.md`
- `docs/providers/sglang.md`
- `docs/gateway/local-models.md`
- `docs/providers/lmstudio.md`

### 4. Local Memory and Embeddings

Search anchors: Embedding provider selection, Memory search readiness, memoryFlush model override, Fallback lexical search, Provider mismatch guidance.

Category note: [Local Memory and Embeddings](local-embeddings-and-memory-provider-usage.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Embedding provider selection: Covers Embedding provider selection across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Memory search readiness: Covers Memory search readiness across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- memoryFlush model override: Covers memoryFlush model override across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Fallback lexical search: Covers Fallback lexical search across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.
- Provider mismatch guidance: Covers Provider mismatch guidance across local embedding provider registration for Ollama and LM Studio, memory host embedding behavior, memory search readiness, local `memoryFlush` model overrides, and related local embeddings and memory behavior.

Primary docs:

- `docs/concepts/memory.md`
- `docs/gateway/doctor.md`

### 5. Network Safety and Prompt Controls

Search anchors: Safety Network, Prompt Pressure Controls, local model providers: ollama, vllm, sglang, lm studio safety network and prompt pressure controls, safety network and prompt pressure controls.

Category note: [Network Safety and Prompt Controls](safety-network-and-prompt-pressure-controls.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Stable (82%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Safety Network: Covers Safety Network across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.
- Prompt Pressure Controls: Covers Prompt Pressure Controls across private-network and exact-origin trust for local provider base URLs, SSRF protections for self-hosted setup, special-token sanitization, local-model lean prompt behavior, and related safety network and prompt pressure controls behavior.

Primary docs:

- `docs/gateway/security/index.md`
- `docs/gateway/config-tools.md`
- `docs/gateway/local-models.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/local-model-providers-ollama-vllm-sglang-lm-studio/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/local-model-providers-ollama-vllm-sglang-lm-studio`.
