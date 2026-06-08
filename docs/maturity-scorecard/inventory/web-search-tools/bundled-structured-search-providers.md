---
title: "Web search tools - Search Providers Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Search Providers Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Bundled Structured Search Providers` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- API-backed providers: Covers API-backed providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Keyless and self-hosted providers: Covers Keyless and self-hosted providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider comparison and auto-detection: Covers Provider comparison and auto-detection provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider-specific filters and extraction: Covers Provider-specific filters and extraction provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Result normalization: Covers Result normalization provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- OpenAI native web_search: Covers OpenAI native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Codex native web_search: Covers Codex native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Gemini grounding: Covers Gemini grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Grok web grounding: Covers Grok web grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Kimi web search: Covers Kimi web search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Provider-native citations: Covers Provider-native citations routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Model and filter routing: Covers Model and filter routing routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- webSearchProviders: Defines webSearchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebSearchProvider: Defines registerWebSearchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- webFetchProviders: Defines webFetchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebFetchProvider: Defines registerWebFetchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- public-artifact loading: Defines public-artifact loading setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- runtime resolution: Defines runtime resolution setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- contract tests: Defines contract tests setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.

## Features

- API-backed providers: Covers API-backed providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Keyless and self-hosted providers: Covers Keyless and self-hosted providers provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider comparison and auto-detection: Covers Provider comparison and auto-detection provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Provider-specific filters and extraction: Covers Provider-specific filters and extraction provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- Result normalization: Covers Result normalization provider routing, request shaping, streaming, and response normalization for Structured Search Providers.
- OpenAI native web_search: Covers OpenAI native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Codex native web_search: Covers Codex native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Gemini grounding: Covers Gemini grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Grok web grounding: Covers Grok web grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Kimi web search: Covers Kimi web search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Provider-native citations: Covers Provider-native citations routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Model and filter routing: Covers Model and filter routing routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- webSearchProviders: Defines webSearchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebSearchProvider: Defines registerWebSearchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- webFetchProviders: Defines webFetchProviders setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- registerWebFetchProvider: Defines registerWebFetchProvider setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- public-artifact loading: Defines public-artifact loading setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- runtime resolution: Defines runtime resolution setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.
- contract tests: Defines contract tests setup, credential, configuration, and operator verification behavior for Web Provider Plugin Contracts.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`

Coverage is Beta because provider docs and source exist for Brave, Tavily, Exa, Firecrawl, Perplexity, DuckDuckGo, and SearXNG, with credential handling, result normalization, guarded requests, caching, and provider errors represented. The score stays below Stable because proof is uneven across providers, several providers are keyless or experimental, and archive evidence shows ongoing provider-specific auth, fallback, and result-quality work.

## Quality Score

- Score: `Beta (74%)`

Quality is Beta because the structured-provider shape is reusable, but implementation quality varies by upstream API. The provider family mixes official APIs, self-hosted endpoints, keyless scraping, fallback extraction, model-like search APIs, and provider-specific error semantics, so the runtime has to normalize many divergent failure modes.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for API-backed providers, Keyless and self-hosted providers, Provider comparison and auto-detection, Provider-specific filters and extraction, Result normalization, OpenAI native web_search, Codex native web_search, Gemini grounding, Grok web grounding, Kimi web search, Provider-native citations, Model and filter routing, webSearchProviders, registerWebSearchProvider, webFetchProviders, registerWebFetchProvider, public-artifact loading, runtime resolution, contract tests.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/web.md:57` lists the provider cards for bundled web_search providers.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:100` compares providers, credentials, source type, freshness, and cost.
- `/Users/kevinlin/code/openclaw/docs/tools/brave-search.md:9` documents Brave Search.
- `/Users/kevinlin/code/openclaw/docs/tools/tavily.md:11` documents Tavily search and extract.
- `/Users/kevinlin/code/openclaw/docs/tools/exa-search.md:10` documents Exa Search.
- `/Users/kevinlin/code/openclaw/docs/tools/firecrawl.md:11` documents Firecrawl Search and Fetch.
- `/Users/kevinlin/code/openclaw/docs/tools/perplexity-search.md:9` documents Perplexity Search.
- `/Users/kevinlin/code/openclaw/docs/tools/duckduckgo-search.md:10` documents DuckDuckGo Search as experimental and keyless.
- `/Users/kevinlin/code/openclaw/docs/tools/searxng-search.md:10` documents SearXNG Search.

### Source

- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.runtime.ts:88` resolves Brave credentials and env.
- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.runtime.ts:336` executes Brave search with validation, caching, diagnostics, and error wrapping.
- `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-client.ts:68` issues guarded Tavily requests.
- `/Users/kevinlin/code/openclaw/extensions/exa/src/exa-web-search-provider.runtime.ts:363` issues guarded Exa search requests.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-client.ts:335` implements Firecrawl search.
- `/Users/kevinlin/code/openclaw/extensions/perplexity/src/perplexity-web-search-provider.runtime.ts:200` implements the native Perplexity Search API path.
- `/Users/kevinlin/code/openclaw/extensions/duckduckgo/src/ddg-client.ts:115` implements DuckDuckGo search, caching, and guarded endpoint use.
- `/Users/kevinlin/code/openclaw/extensions/searxng/src/searxng-client.ts:105` validates SearXNG base URL and endpoint mode.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/tavily-search.md:4` defines a Tavily search runtime scenario.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/tavily-extract.md:4` defines a Tavily extract runtime scenario.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs:423` checks plugin web-search provider ids in an E2E plugin path.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.test.ts:154` covers Brave missing-key behavior and later cases cover base URL, malformed JSON, bounded errors, cache isolation, and diagnostics.
- `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-tools.test.ts:74` covers Tavily tool behavior, and `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-client.test.ts:44` covers client errors.
- `/Users/kevinlin/code/openclaw/extensions/exa/src/exa-web-search-provider.test.ts:24` covers Exa provider behavior and error handling.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-tools.test.ts:80` covers Firecrawl search and fetch tools.
- `/Users/kevinlin/code/openclaw/extensions/perplexity/src/perplexity-web-search-provider.test.ts:33` covers Perplexity provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/duckduckgo/src/ddg-search-provider.test.ts:34` covers DuckDuckGo provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/searxng/src/searxng-search-provider.test.ts:30` and `/Users/kevinlin/code/openclaw/extensions/searxng/src/searxng-client.test.ts:47` cover SearXNG provider and client behavior.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "Perplexity"` returned #84872, #85800, #6792, #80843, #17925, #75562, #72527, #49949, and #87347.
- `gitcrawl --json search prs -R openclaw/openclaw "Perplexity"` returned #86338 search context size, #85828 model override, #86622 Tavily auth fix, #62126 native search onboarding, #85158 Parallel provider, and related provider work.
- `gitcrawl --json search prs -R openclaw/openclaw "provider-web-search"` returned #85158 Parallel, #86440 SerpApi, #40311 Brave Goggles, #52207 SearXNG and Tavily freshness, #86622 Tavily auth, and #63571 fallback.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "Tavily Firecrawl Perplexity Brave SearXNG DuckDuckGo web_search"` found provider-choice discussion, public lists of available providers, Perplexity provider CLI output, and Perplexity 401 user-facing failure evidence.
- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found setup guidance for Brave API keys and notes that web_fetch only fetches known URLs.
