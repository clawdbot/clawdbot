---
title: "Web search tools - Provider Reliability and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Provider Reliability and Diagnostics Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Error Handling, Quotas, Caching, and Diagnostics` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Web search tools capability area represented by these taxonomy features:

- Error Handling, Quotas, Caching, and Diagnostics: Evidence scope for Error Handling, Quotas, Caching, and Diagnostics.

## Features

- Quota errors: Covers Quota errors status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Cache controls: Covers Cache controls status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Provider diagnostics: Covers Provider diagnostics status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Retry and fallback: Covers Retry and fallback status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Operator repair: Covers Operator repair status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`

Coverage is Beta because missing keys, provider API errors, malformed responses, cache keys, bounded diagnostics, timeout handling, and provider fallback have source and focused checks across major paths. The score remains Beta because quota/rate-limit behavior is inconsistent by provider, fallback chains are still active work, and archive evidence shows current timeout, auth, and no-provider failures.

## Quality Score

- Score: `Beta (70%)`

Quality is Beta because each provider reports different auth, quota, freshness, rate-limit, and payload-shape failures. OpenClaw wraps many of these into provider errors and diagnostics, but the family still lacks a uniform operator-facing failure model for quota exhaustion, fallback selection, and degraded provider health.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Quota errors, Cache controls, Provider diagnostics, Retry and fallback, Operator repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/reference/api-usage-costs.md:129` documents web_search provider cost and Brave credit behavior.
- `/Users/kevinlin/code/openclaw/docs/reference/api-usage-costs.md:155` documents web_fetch Firecrawl/local fallback cost behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:100` documents credential requirements and provider cost differences.
- `/Users/kevinlin/code/openclaw/docs/tools/brave-search.md:122` documents Brave troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/tools/perplexity-search.md:198` documents Perplexity troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/tools/tavily.md:127` documents Tavily troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/tools/firecrawl.md:139` documents Firecrawl troubleshooting and safety notes.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search-provider-common.ts:53` defines common count, cache, and freshness defaults.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search-provider-common.ts:71` resolves SecretRef and env credential values.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search-provider-common.ts:127` wraps provider API errors.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search-provider-common.ts:188` builds freshness, date, and cache helpers.
- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.runtime.ts:152` emits missing-key payloads.
- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.runtime.ts:336` handles Brave execution diagnostics and cache behavior.
- `/Users/kevinlin/code/openclaw/extensions/perplexity/src/perplexity-web-search-provider.runtime.ts:312` handles unsupported filters, missing keys, and provider errors.
- `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-client.ts:100` handles Tavily search responses.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-client.ts:181` wraps Firecrawl guarded POST errors.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.ts:424` runs provider fallback behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-search.md:43` covers success and failure runtime expectations.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-fetch.md:43` covers fetch success and failure runtime expectations.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/openai-web-search-minimal/assertions.mjs:132` checks native OpenAI minimal-reasoning rejection behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/brave/src/brave-web-search-provider.test.ts:309` covers malformed JSON and later cases cover bounded errors, cache isolation, validation, and diagnostics.
- `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-client.test.ts:44` covers Tavily API failure behavior.
- `/Users/kevinlin/code/openclaw/extensions/exa/src/exa-web-search-provider.test.ts:147` covers Exa error and response edge cases.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-tools.test.ts:652` covers Firecrawl failure behavior.
- `/Users/kevinlin/code/openclaw/extensions/perplexity/src/perplexity-web-search-provider.test.ts:93` covers Perplexity unsupported and error paths.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.test.ts:614` covers runtime fallback behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.provider-fallback.test.ts:104` covers provider fallback responses.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "web_search"` returned #79384 hardcoded maxResults, #80843 fallback chain, #87505 timeout regression, #13615 rate limiting, #87347 no provider available, and #79670 quota-limit validation.
- `gitcrawl --json search issues -R openclaw/openclaw "Perplexity"` returned #84872, #85800, #80843, #87347, and other provider-specific failure or feature requests.
- `gitcrawl --json search prs -R openclaw/openclaw "web_search"` returned #86338 Perplexity context size, #86622 Tavily auth, #63571 fallback support, #77859 runtime metadata, #76146 SecretRefs, and #86965 progress surfacing.
- `gitcrawl --json search issues -R openclaw/openclaw "SSRF web_fetch"` returned #87505 timeout regression in the guarded fetch path.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "Tavily Firecrawl Perplexity Brave SearXNG DuckDuckGo web_search"` found Perplexity provider CLI output and a 401 provider error case.
- `discrawl search --mode hybrid --limit 12 "web_search no provider available Brave loaded web_fetch"` found no-provider and allowlist warnings when web_search is not configured.
- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found setup and config review discussions involving provider keys and failure modes.
