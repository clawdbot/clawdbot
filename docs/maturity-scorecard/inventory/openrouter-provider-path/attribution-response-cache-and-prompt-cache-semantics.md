---
title: "OpenRouter provider path - Attribution and Caching Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Attribution and Caching Maturity Note

## Summary

OpenRouter attribution and cache behavior is explicitly implemented: verified OpenRouter routes receive documented app-attribution headers, optional response-cache headers, route-gated Anthropic `cache_control` markers, DeepSeek/Moonshot/ZAI cache-TTL eligibility, and OpenRouter-specific cache-read/write usage mapping. Coverage is Beta because wrapper tests are focused, but live cache proof is gated and prompt-cache behavior remains provider-dependent.

Quality is Beta because current source is careful, yet archives show recent cache-control regressions, user-facing cache payload errors, and startup/pricing cache coupling concerns.

## Category Scope

This category covers OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.

## Features

- Attribution headers: Covers Attribution headers across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Response-cache headers/TTL/clear: Covers Response-cache headers/TTL/clear across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Anthropic cache-control markers: Covers Anthropic cache-control markers across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Cache usage mapping: Covers Cache usage mapping across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.
- Custom proxy exclusions: Covers Custom proxy exclusions across OpenRouter app attribution, response cache headers, TTL and clear behavior, Anthropic cache-control markers, prompt-cache retention, cache-read/cache-write usage mapping, verified-route gating, and custom proxy exclusions.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Tests cover attribution headers, response-cache enable/disable/refresh/TTL behavior, verified-route exclusions, Anthropic cache-control markers, and cache usage mapping.
- Negative signals: Live cache behavior is gated by environment and provider support; prompt-cache semantics vary across OpenRouter-routed upstreams.
- Integration gaps: Add scheduled live cache proof for OpenRouter Anthropic and DeepSeek routes, including response-cache headers, cached-token observation, and custom proxy negative cases.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: The broad OpenRouter query returned #63034 for cache-control not applying to conversation messages and #68066 for OpenRouter streamed usage cost mismatch; PR search returned #63062, #79370, and #87562 as related fixes.
- Discrawl reports: Discord search found a May 2026 user-facing `cache_control: Extra inputs are not permitted` report and discussion about OpenRouter/LiteLLM pricing catalog fetches slowing startup.
- Good qualities: The implementation scopes OpenRouter-specific headers to verified OpenRouter routes, supports explicit response-cache params, and avoids injecting OpenRouter markers into arbitrary custom proxies.
- Bad qualities: Cache behavior is still sensitive to upstream provider semantics, model family, route class, and payload compatibility.
- Excluded from quality: Unit-test depth and live-gated cache tests are Coverage inputs only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Attribution headers, Response-cache headers/TTL/clear, Anthropic cache-control markers, Cache usage mapping, Custom proxy exclusions.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Response caching, prompt-cache markers, and cache-token usage are separate concepts that docs explain but users can still conflate.
- Cache-control payload compatibility depends on the actual upstream provider behind OpenRouter.
- Pricing/cache catalog fetching has generated operator concern when unrelated gateway startup paths contact OpenRouter.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents app-attribution headers, response caching, Anthropic cache markers, verified-route gating, custom proxy exclusions, and cache-control distinctions.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` summarizes OpenRouter route-gated attribution and cache marker behavior.
- `/Users/kevinlin/code/openclaw/docs/reference/prompt-caching.md` documents prompt-cache concepts adjacent to this surface.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/provider-attribution.ts` defines OpenRouter's documented attribution headers and verified endpoint gating.
- `/Users/kevinlin/code/openclaw/src/llm/providers/stream-wrappers/proxy.ts` resolves OpenRouter response-cache headers, TTL clamping, cache clear, Anthropic cache markers, and reasoning payload normalization.
- `/Users/kevinlin/code/openclaw/src/llm/providers/openai-completions.ts` applies Anthropic cache control and maps `cached_tokens` / `cache_write_tokens` to usage.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` marks OpenRouter model families eligible for cache TTL behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/model-pricing-cache.ts` fetches and canonicalizes OpenRouter pricing metadata.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates cache-read observation for an OpenRouter DeepSeek model when `OPENCLAW_LIVE_CACHE_TEST=1`.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.e2e.test.ts` covers OpenRouter model resolution into the embedded runtime.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/llm/providers/stream-wrappers/proxy.test.ts` covers OpenRouter attribution headers, response-cache headers, TTL clamping, clear, preset opt-outs, custom proxy exclusions, and Anthropic cache-control marker gating.
- `/Users/kevinlin/code/openclaw/src/agents/provider-attribution.test.ts` covers OpenRouter attribution and endpoint classification.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/extra-params.openrouter-cache-control.test.ts` covers OpenRouter Anthropic cache-control behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/model-pricing-cache.test.ts` covers OpenRouter pricing lookup and failure handling.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter cache headers attribution cache_control cached_tokens"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search prs -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #63062 on applying cache_control to conversation messages on the OpenRouter path, #79370 on explicit cache retention for OpenRouter Anthropic models, #87562 on streamed cost reconciliation, and #71807 on pricing catalog plugin discovery.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter cache"`

Results:

- Found May 2026 support discussion with `messages.30.content.1.text.cache_control: Extra inputs are not permitted`, plus April 2026 discussion about OpenRouter/LiteLLM pricing model fetching causing gateway startup delays and #7006 comments about `openrouter/auto` usage/cost visibility.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter cache_control cached_tokens"`

Results:

- Returned no results.
