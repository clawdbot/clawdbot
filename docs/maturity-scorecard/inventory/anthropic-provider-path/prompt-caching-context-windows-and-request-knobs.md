---
title: "Anthropic provider path - Prompt Cache and Context Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Prompt Cache and Context Maturity Note

## Summary

Anthropic prompt caching and request shaping are first-class: docs explain
`cacheRetention`, 1M context windows, fast mode, and long-context troubleshooting;
source injects cache markers, strips retired betas, applies service-tier knobs,
and normalizes GA 1M context metadata. Coverage is Stable because docs, source,
and tests cover the main knobs. Quality is Beta because Discord/GitHub archives
show users still need help with cache TTL expectations, custom-provider long
TTL limits, long-context 429s, and setup-token/API-key eligibility.

## Category Scope

Included in this category:

- Cache retention: Covers Cache retention across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- System-prompt cache boundary: Covers System-prompt cache boundary across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- 1M context: Covers 1M context across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Fast mode/service tier: Covers Fast mode/service tier across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Cache diagnostics: Covers Cache diagnostics across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.

## Features

- Cache retention: Covers Cache retention across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- System-prompt cache boundary: Covers System-prompt cache boundary across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- 1M context: Covers 1M context across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Fast mode/service tier: Covers Fast mode/service tier across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.
- Cache diagnostics: Covers Cache diagnostics across Anthropic-specific request knobs outside the core content stream: prompt cache retention, cache-control markers, system-prompt cache boundary, 1M context sizing, and related prompt cache and context behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docs cover prompt caching, cacheRetention merge order, direct Anthropic 5-minute and 1-hour TTL behavior, 1M context, fast mode, and 429 remediation; source and tests cover cache markers, context window overrides, beta stripping, service-tier behavior, and cache defaults.
- Negative signals: Live proof for cache-hit behavior and 1M context eligibility depends on upstream account state and is not fully covered by deterministic local tests.
- Integration gaps: The audit found docs/source/test proof but not a repeated live Anthropic cache-hit and 1M-context release smoke artifact.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: #37966 reports `cacheRetention` ignored for LiteLLM-proxied Anthropic models; #62475 requests prompt-cache keep-warm pings; #63030 reports system prompt assembly drift causing Anthropic cache invalidation; PR #79370 fixes explicit cacheRetention for OpenRouter to Anthropic models.
- Discrawl reports: Discord archive results include custom provider 1-hour cache questions, Haiku cache-hit confusion, system-prompt cache-boundary guidance, and 1M context 429 extra-usage troubleshooting.
- Good qualities: Cache policy is centralized, long TTL is endpoint-gated, retired 1M beta headers are stripped, API-key auth gets conservative defaults, and docs distinguish direct Anthropic from custom/proxy behavior.
- Bad qualities: Users still need to reason about TTLs, heartbeat, context pruning, long-context account eligibility, API-key versus setup-token behavior, and custom endpoint limitations.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Cache retention, System-prompt cache boundary, 1M context, Fast mode/service tier, Cache diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- 1M context can be correctly sized locally while still failing upstream for
  account eligibility.
- Long cache TTL does not apply uniformly to arbitrary Anthropic-compatible
  custom hosts, which is easy to misconfigure.
- Cache-hit proof is mostly usage-derived and needs repeated live scenario
  captures for release readiness.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents Claude 4.6 thinking defaults, `cacheRetention`, fast mode, media, 1M context, and troubleshooting for invalid/no credentials.
- `/Users/kevinlin/code/openclaw/docs/reference/prompt-caching.md` documents Anthropic direct API caching, `cacheRetention` merge order, cache-ttl pruning, heartbeat keep-warm, direct Anthropic 1-hour TTL, OpenRouter Anthropic cache handling, and system-prompt cache boundaries.
- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md` documents `HTTP 429: rate_limit_error: Extra usage is required for long context requests` and fixes.
- `/Users/kevinlin/code/openclaw/docs/gateway/heartbeat.md` documents heartbeat intervals, including a longer interval for Anthropic OAuth/token auth.

### Source

- `/Users/kevinlin/code/openclaw/extensions/anthropic/config-defaults.ts` seeds `contextPruning.mode: "cache-ttl"`, heartbeat intervals, API-key `cacheRetention: "short"`, and Claude CLI runtime defaults.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/stream-wrappers.ts` strips retired context-1m betas, adds Anthropic beta headers, injects service-tier/fast-mode params for API keys, and strips unsafe thinking prefill.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-payload-policy.ts` applies Anthropic cache-control markers to system and trailing user turns, respects system-prompt cache boundaries, gates long TTL by endpoint, and injects service tier.
- `/Users/kevinlin/code/openclaw/src/llm/providers/anthropic.ts` resolves cache retention, applies cache control to system/tool/message payloads, and records cache usage counters.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/register.runtime.ts` applies GA 1M context metadata to modern Claude 4.x models.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` includes live Anthropic model profiles that exercise modern Claude model refs.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic.setup-token.live.test.ts` env-gates live setup-token completion, indirectly proving request knobs can coexist with resolved token auth.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/stream-wrappers.test.ts` covers beta stripping, OAuth beta preservation, service-tier injection/skips, fast mode behavior, and thinking prefill stripping.
- `/Users/kevinlin/code/openclaw/src/agents/anthropic-payload-policy.test.ts` covers cache marker application, endpoint gating, system prompt boundary handling, and service-tier policy.
- `/Users/kevinlin/code/openclaw/src/llm/providers/stream-wrappers/anthropic-cache-control-payload.test.ts` covers cache-control payload marker behavior.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner/extra-params.cache-retention-default.test.ts` covers Anthropic-family cache semantics and explicit retention.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers 1M context normalization and API-key cacheRetention defaults.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic 429 long context extra usage required fallback"`

Results:

- Returned no direct results for that exact GitHub issue query.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic prompt caching cacheRetention"`

Results:

- #37966 `[Bug]: cacheRetention ignored for LiteLLM-proxied Anthropic models`.
- #62475 requests prompt cache keep-warm pings.
- #63030 reports system prompt assembly differences causing continuous Anthropic cache invalidation.

Query: `gitcrawl --json search prs -R openclaw/openclaw "anthropic cacheRetention"`

Results:

- #79370 `fix(cache): honour explicit cacheRetention for OpenRouter to Anthropic models`.
- #76741 `fix(kimi): strip anthropic cache markers`.

### Discrawl queries

Query: `discrawl search --limit 10 "Claude 4.6 1M context Anthropic 429"`

Results:

- Returned March 2026 support threads explaining `HTTP 429: rate_limit_error: Extra usage is required for long context requests`, extra-usage requirements, API-key eligibility, and config changes to remove `context1m`.

Query: `discrawl search --limit 10 "Anthropic prompt caching cacheRetention OpenClaw"`

Results:

- Returned prompt caching support threads about Haiku cache-hit rates, configurable `cacheRetention`, static/dynamic system-prompt split, custom provider 1-hour cache limitations, and cache write spikes.
