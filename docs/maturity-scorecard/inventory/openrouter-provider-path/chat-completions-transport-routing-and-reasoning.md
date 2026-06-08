---
title: "OpenRouter provider path - Chat Runtime and Normalization Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Chat Runtime and Normalization Maturity Note

## Summary

OpenRouter chat transport is implemented through the OpenAI-compatible completions path, provider-owned stream wrappers, sanitized routing params, OpenRouter reasoning payloads, DeepSeek V4 thinking policy, Anthropic prefill stripping, Hunter Alpha reasoning suppression, and verified-route checks. Coverage is Beta because the component has substantial focused tests but fewer end-to-end release smokes across representative OpenRouter backends.

Quality is Beta because the implementation has explicit guardrails, but archived reports show provider/model-specific reasoning behavior can still shift underneath OpenClaw.

## Category Scope

Included in this category:

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

## Features

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

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Routing-param merge, reasoning profiles, prefill stripping, base URL normalization, and DeepSeek V4 thinking behavior have focused tests.
- Negative signals: Coverage is strongest at wrapper and transport seams; there is less always-on proof that the same behavior works live across Anthropic, DeepSeek, Google, OpenAI, MiniMax, and OpenRouter `auto` routes.
- Integration gaps: Add live-gated chat transport scenarios for one Anthropic, one DeepSeek V4, one Gemini, and one non-reasoning OpenRouter model with routing params enabled.

## Quality Score

- Score: `Beta (71%)`
- Gitcrawl reports: The broad OpenRouter query returned routed-model and error reports, while exact routing/reasoning queries returned no direct new hits.
- Discrawl reports: Discord search found April 2026 reports where OpenRouter reasoning models returned visible text in reasoning fields or `content: null`, leading to fallback or empty output on older builds.
- Good qualities: The implementation sanitizes provider-routing objects, strips dangerous object keys, scopes routing to OpenRouter chat-completions routes, normalizes stale base URLs, and suppresses proxy reasoning for known-bad Hunter Alpha refs.
- Bad qualities: OpenRouter backend behavior varies by underlying provider; reasoning output fields, content shape, and provider-side model behavior have changed enough to require repeated special cases.
- Excluded from quality: Wrapper and transport test depth is scored only under Coverage.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Chat completions route, Provider routing params, Per-model route overrides, Reasoning payload policy, Anthropic/Gemini/DeepSeek variants, Streamed content parsing, reasoning_details visible output, Tool-call delta preservation, Family-specific replay policy, Response-model and usage normalization, Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- OpenRouter `auto` and provider routing can select backends with different reasoning and tool-call semantics than the configured model suggests.
- Reasoning support is modeled for specific families but still depends on OpenRouter metadata and observed backend behavior.
- Custom proxy routes intentionally skip some OpenRouter-specific handling, which is correct but increases operator surprise when a copied OpenRouter config is repointed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents OpenRouter provider routing metadata, proxy reasoning, DeepSeek V4 reasoning replay, Anthropic prefill handling, Gemini-backed route behavior, and native OpenAI-only shaping exclusions.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` summarizes OpenRouter's verified-route app attribution, cache marker, proxy-style OpenAI-compatible behavior, and Gemini thought-signature handling.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/provider-routing.ts` sanitizes and merges provider-wide, model-level, and request-level OpenRouter routing params.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/stream.ts` injects routing, strips Anthropic prefill messages when reasoning is enabled, patches DeepSeek V4 thinking, and gates behavior to verified OpenRouter routes.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/thinking-policy.ts` defines DeepSeek V4 thinking levels and `xhigh` support.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-completions.ts` maps OpenRouter reasoning to nested `reasoning` payloads and forwards OpenRouter provider-routing preferences.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates a real OpenRouter completion and dynamic model resolution.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.e2e.test.ts` covers explicit OpenRouter model resolution through embedded agent execution.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.test.ts` verifies provider routing merge/sanitization, Hunter Alpha reasoning suppression, DeepSeek V4 thinking levels, Anthropic prefill stripping, custom-route exclusions, and base URL normalization.
- `/Users/kevinlin/code/openclaw/src/llm/providers/stream-wrappers/proxy.test.ts` covers OpenRouter wrapper behavior, response cache headers, and Anthropic cache marker gating.
- `/Users/kevinlin/code/openclaw/src/agents/openai-transport-stream.test.ts` covers OpenRouter reasoning-details parsing and visible output behavior.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter provider routing reasoning DeepSeek Hunter Alpha"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #87170 on `Provider returned error` with `auto`, #86880 on OpenRouter context overflow, #79047 on cross-backend model switches, and #7006 on routed model transparency.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter provider routing reasoning"`

Results:

- Found April 2026 reports about OpenRouter models returning answer text in reasoning fields, stale provider metadata causing provider fallback, and later fixes for `reasoning_details.response.output_text` / `response.text` parsing.
