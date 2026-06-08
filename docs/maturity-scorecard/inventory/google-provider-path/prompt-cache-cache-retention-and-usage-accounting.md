---
title: "Google provider path - Prompt Caching Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google provider path - Prompt Caching Maturity Note

## Summary

Direct Gemini has a managed `cachedContents` path for `cacheRetention`, manual
`cachedContent` request handling, and usage normalization from
`cachedContentTokenCount` into OpenClaw `cacheRead`. Coverage is Alpha because
the live cache regression lane found in this audit is Anthropic/OpenAI-only and
no Google-specific live proof was found for managed cache create/reuse/refresh.
Quality is Beta because source behavior is well-contained, but archives show
cache-tool conflicts, 429/backoff confusion, and reporting misunderstandings.

## Category Scope

Included in this category:

- Cache retention config: Covers Cache retention config across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Managed cachedContents: Covers Managed cachedContents across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Manual cachedContent handles: Covers Manual cachedContent handles across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache usage accounting: Covers Cache usage accounting across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache diagnostics and live proof: Covers Cache diagnostics and live proof across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.

## Features

- Cache retention config: Covers Cache retention config across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Managed cachedContents: Covers Managed cachedContents across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Manual cachedContent handles: Covers Manual cachedContent handles across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache usage accounting: Covers Cache usage accounting across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.
- Cache diagnostics and live proof: Covers Cache diagnostics and live proof across direct `google-generative-ai` Gemini prompt cache eligibility, `cacheRetention`, managed `cachedContents` create/reuse/refresh, manual `cachedContent` config, and related prompt caching behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Source covers cache eligibility, cache-retention policy,
  managed cached-content creation/reuse/refresh, payload patching, retry
  backoff, and usage normalization; unit tests cover the main paths.
- Negative signals: No Google lane was found in the live cache regression
  runner, and no Google-specific live/e2e proof was found for managed cache
  create/reuse/refresh.
- Integration gaps: Manual `cachedContent` and managed `cacheRetention` need
  live validation with tool turns and cache-hit reporting.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: #51372 requested Gemini `cachedContents` support and is
  closed; #71441 fixed Google cached-content conflicts with system/tools; #62475
  remains open for prompt-cache keep-warm; #86932 remains open for stale
  prompt-cache config warnings.
- Discrawl reports: Searches for `Gemini cachedContent`, `Google
cachedContents`, and `cacheRetention google` found #71441, #51372, Gemini
  429/backoff discussions, and a P1 review concern about preserving tools with
  managed cached content.
- Good qualities: The source scopes eligibility to direct Gemini families,
  separates manual handles from managed cache injection, persists cache state,
  and maps provider-native cache-read counters into OpenClaw usage.
- Bad qualities: Cache behavior remains operationally hard to reason about,
  especially when tools, TTL, 429/backoff, and large `cacheRead` counters are
  involved.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow
  test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/google-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Cache retention config, Managed cachedContents, Manual cachedContent handles, Cache usage accounting, Cache diagnostics and live proof.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Google is absent from the live cache regression gate found during this audit.
- Managed cached content with tool turns needs recurring proof after the prior
  #71441 conflict.
- Manual `cachedContent` is documented and accepted by extra params, but should
  keep being checked against current request-builder paths.
- Large `cacheRead` values can still confuse operator interpretation of context
  accounting.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/reference/prompt-caching.md:151`
  documents Gemini `cachedContentTokenCount` mapping to `cacheRead` and managed
  `cachedContents` resources for `cacheRetention`.
- `/Users/kevinlin/code/openclaw/docs/providers/google.md:409` documents direct
  Gemini cache reuse, `cachedContent` and `cached_content`, and `cacheRead`.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:215`
  documents direct Gemini `cachedContent` config.
- `/Users/kevinlin/code/openclaw/docs/reference/token-use.md:90` documents
  normalized provider-native usage fields and cache counters.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/prompt-cache-retention.ts:6`
  limits Google cache eligibility to direct Gemini 2.5 and Gemini 3 models.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/google-prompt-cache.ts:77`
  computes TTL and system-prompt cache digests.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/google-prompt-cache.ts:268`
  implements cached-content TTL patching and POST creation.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/google-prompt-cache.ts:329`
  handles persisted ready/failed entries, reuse, refresh, and retry backoff.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/google-prompt-cache.ts:444`
  wraps the stream function and patches outgoing payloads with `cachedContent`.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.ts:542` maps
  `cachedContentTokenCount` to `cacheRead`.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/prompt-cache-observability.ts:144`
  begins prompt-cache observation and later detects cache-break behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/package.json:1739` defines `test:live:cache`.
- `/Users/kevinlin/code/openclaw/src/agents/live-cache-regression-baseline.ts:14`
  defines live cache baselines for Anthropic and OpenAI only.
- `/Users/kevinlin/code/openclaw/src/agents/live-cache-regression-runner.ts:329`
  types repeated cache lanes as `anthropic | openai`.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-models.profiles.live.test.ts:99`
  includes Google models in broader live provider coverage, but not
  cache-specific coverage.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/google-prompt-cache.test.ts:147`
  verifies create/reuse/refresh and managed payload injection.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/prompt-cache-retention.test.ts:5`
  verifies direct Google retention mapping and eligibility.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/prompt-cache-retention.test.ts:127`
  verifies direct Google family eligibility and excludes Gemini Live.
- `/Users/kevinlin/code/openclaw/src/llm/providers/google-shared.test.ts:84`
  verifies `cachedContentTokenCount` becomes `cacheRead`.

### Gitcrawl queries

Query: `gitcrawl search prs "Google prompt cache cachedContent" -R openclaw/openclaw --state all`

Results:

- Returned #71441, a closed fix for Google `cachedContent` conflicts with
  system/tools.

Query: `gitcrawl search issues "Google prompt cache cachedContent cacheRetention" -R openclaw/openclaw --state all`

Results:

- Exact query returned no direct issue results.

Query: `gitcrawl search issues "cachedContents cacheRetention Gemini" -R openclaw/openclaw --state all`

Results:

- Returned #51372 requesting Gemini cached-content support, #62475 for
  prompt-cache keep-warm, and #86932 for stale prompt-cache config warnings.

### Discrawl queries

Query: `discrawl search --limit 5 "Google prompt cache cachedContent cacheRetention"`

Results:

- Returned PR #71441 review history and P1 concern about preserving tools with
  managed cached content.

Query: `discrawl search --limit 5 "Gemini cachedContent"`

Results:

- Returned #51372 support history plus Gemini 429/backoff and cache TTL
  discussions.

Query: `discrawl search --limit 5 "cachedContentTokenCount cacheRead"`

Results:

- Returned review history for Google usage mapping and cache double-counting
  fixes.
