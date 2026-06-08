---
title: "Web search tools - Provider-Native Grounded Search Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Provider-Native Grounded Search Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Provider-native Grounded Search Providers` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Web search tools capability area represented by these taxonomy features:

- Provider-native Grounded Search Providers: Evidence scope for Provider-native Grounded Search Providers.

## Features

- OpenAI native web_search: Covers OpenAI native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Codex native web_search: Covers Codex native web_search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Gemini grounding: Covers Gemini grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Grok web grounding: Covers Grok web grounding routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Kimi web search: Covers Kimi web search routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Provider-native citations: Covers Provider-native citations routing, session binding, history, and conversation context for Provider-Native Grounded Search.
- Model and filter routing: Covers Model and filter routing routing, session binding, history, and conversation context for Provider-Native Grounded Search.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`

Coverage is Beta because docs, source, and focused checks exist for OpenAI/Codex native search, Gemini grounding, Grok X search, Kimi, MiniMax, and Ollama search. The score is limited by provider-specific API variance, live-credential dependence, native-provider feature requests still open, and active PRs for metadata, time-range, SSRF-bypass, and provider-specific behavior.

## Quality Score

- Score: `Beta (72%)`

Quality is Beta because native grounded search depends on model-provider semantics instead of one uniform web_search contract. Implementations must translate filters, citations, metadata, credentials, local/cloud fallback, OAuth or API-key auth, and unsupported provider capabilities into a common OpenClaw tool result.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for OpenAI native web_search, Codex native web_search, Gemini grounding, Grok web grounding, Kimi web search, Provider-native citations, Model and filter routing.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/web.md:117` documents native OpenAI web search.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:123` documents native Codex web search.
- `/Users/kevinlin/code/openclaw/docs/tools/gemini-search.md:10` documents Gemini grounded search.
- `/Users/kevinlin/code/openclaw/docs/tools/grok-search.md:9` documents Grok web and X search.
- `/Users/kevinlin/code/openclaw/docs/tools/kimi-search.md:9` documents Kimi web search.
- `/Users/kevinlin/code/openclaw/docs/tools/minimax-search.md:10` documents MiniMax Search.
- `/Users/kevinlin/code/openclaw/docs/tools/ollama-search.md:11` documents Ollama Web Search.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openai/native-web-search.ts:16` determines OpenAI native search eligibility.
- `/Users/kevinlin/code/openclaw/extensions/openai/native-web-search.ts:57` injects the native OpenAI web_search tool and minimal-reasoning behavior.
- `/Users/kevinlin/code/openclaw/src/agents/codex-native-web-search-core.ts:79` activates Codex native web search.
- `/Users/kevinlin/code/openclaw/extensions/google/src/gemini-web-search-provider.runtime.ts:179` implements guarded Gemini grounding requests and citation redirect handling.
- `/Users/kevinlin/code/openclaw/extensions/xai/src/web-search-provider.runtime.ts:211` implements Grok OAuth/profile/API fallback.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/src/kimi-web-search-provider.runtime.ts:214` implements Kimi web-search tool call handling.
- `/Users/kevinlin/code/openclaw/extensions/minimax/src/minimax-web-search-provider.runtime.ts:120` implements MiniMax guarded search.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/web-search-provider.ts:129` implements Ollama local/cloud fallback attempts.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/models/openai-native-web-search-live.md:4` defines the OpenAI native web-search live scenario.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/openai-web-search-minimal/scenario.sh:57` starts the gateway and asserts native OpenAI web_search injection.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/openai-web-search-minimal/assertions.mjs:96` validates native web-search payload behavior.
- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:121` exercises Gemini web search.
- `/Users/kevinlin/code/openclaw/extensions/minimax/minimax.live.test.ts:38` exercises MiniMax search.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/moonshot.live.test.ts:22` exercises Kimi search.
- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:300` exercises Ollama web search fallback.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/codex-native-web-search.test.ts:26` covers Codex native web-search activation and payload shaping.
- `/Users/kevinlin/code/openclaw/test/scripts/openai-web-search-minimal-assertions.test.ts:15` covers native OpenAI assertion helpers.
- `/Users/kevinlin/code/openclaw/extensions/google/web-search-provider.test.ts:87` covers Gemini search behavior.
- `/Users/kevinlin/code/openclaw/extensions/xai/web-search.test.ts:175` covers Grok and X search behavior.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/src/kimi-web-search-provider.test.ts:55` covers Kimi provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/minimax/src/minimax-web-search-provider.test.ts:44` covers MiniMax provider behavior.
- `/Users/kevinlin/code/openclaw/extensions/ollama/src/web-search-provider.test.ts:152` covers Ollama provider behavior.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "Gemini web search"` returned #17925 native Anthropic request, #79876, #49949 native Gemini/OpenAI work, #78573 Copilot, #72527, #85937, #79670, #51593, and #85030.
- `gitcrawl --json search prs -R openclaw/openclaw "Gemini web search"` returned #85317 Gemini SSRF bypass, #85195 Gemini timestamp fix, #86828 startup snapshots, #55485 SSRF policy, #76146 SecretRefs, and #77859 runtime metadata.
- `gitcrawl --json search prs -R openclaw/openclaw "provider-web-search"` returned #78574 Copilot native web search, #62126 Codex native onboarding, #85148 Codex metadata preservation, #85317 Gemini fix, and #85195 Gemini timestamp fix.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "Gemini Grok Kimi MiniMax Ollama web_search"` found public discussion listing these providers in the configure picker and Perplexity/Gemini/Ollama provider status output.
- `discrawl search --mode hybrid --limit 12 "Tavily Firecrawl Perplexity Brave SearXNG DuckDuckGo web_search"` also surfaced X/Grok guidance that web_search fallback supports multiple providers, while xAI-specific X data requires x_search.
