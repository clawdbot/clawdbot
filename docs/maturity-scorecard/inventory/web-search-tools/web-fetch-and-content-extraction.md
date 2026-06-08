---
title: "Web search tools - Web Fetch and Content Extraction Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Web Fetch and Content Extraction Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Web Fetch and Content Extraction` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Web search tools capability area represented by these taxonomy features:

- Web Fetch and Content Extraction: Evidence scope for Web Fetch and Content Extraction.

## Features

- URL fetch: Covers URL fetch tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- HTML extraction: Covers HTML extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- PDF/text extraction: Covers PDF/text extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Safe truncation: Covers Safe truncation tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Content citation handoff: Covers Content citation handoff tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`

Coverage is Stable because web_fetch has dedicated docs, runtime source, provider fallback paths, runtime scenarios, sandbox boundaries, SSRF-focused checks, extraction behavior, and archive coverage. The score is limited by active feature requests around private-network opt-in, extraction body fidelity, progress surfacing, and third-party provider fallback behavior.

## Quality Score

- Score: `Stable (80%)`

Quality is Stable because web_fetch has a narrow, understandable contract: fetch a supplied URL, apply network safety policy, extract readable content, wrap untrusted content, and optionally use provider fallback. The quality score sits at the low end of Stable because extraction fidelity, provider fallback, and private-network policy are still changing.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for URL fetch, HTML extraction, PDF/text extraction, Safe truncation, Content citation handoff.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:11` describes web_fetch as plain HTTP GET plus readability extraction with no JavaScript execution.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:19` documents default enablement.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:40` documents fetch, extract, fallback, cache, and redirect behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:60` documents timeout, redirect, response-size, readability, proxy, and SSRF policy config.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:88` documents Firecrawl fallback setup.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:135` documents runtime and sandbox behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:243` documents that web_fetch provider selection is separate from web_search.

### Source

- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.ts:107` resolves web_fetch provider IDs.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.ts:163` resolves provider definitions and sandbox choice.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:136` clamps max response and redirect options.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:313` normalizes provider fallback payloads.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:399` constructs cache keys and SSRF opt-ins.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:418` validates URLs and uses guarded fetch.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:498` extracts content and applies provider fallback.
- `/Users/kevinlin/code/openclaw/extensions/firecrawl/src/firecrawl-client.ts:518` implements Firecrawl scrape.
- `/Users/kevinlin/code/openclaw/extensions/tavily/src/tavily-client.ts:207` implements Tavily extract.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-fetch.md:4` defines the runtime web_fetch scenario.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/tavily-extract.md:4` defines Tavily extract coverage.
- `/Users/kevinlin/code/openclaw/src/gateway/server-startup-web-fetch-bind.test.ts:78` verifies startup with credential-free web_fetch config.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.test.ts:108` covers SecretRef handling.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.test.ts:168` covers env and fallback credentials.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.test.ts:275` covers sandboxed bundled-provider boundaries.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.provider-fallback.test.ts:40` covers provider fallback behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.cf-markdown.test.ts:51` covers markdown/extraction behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ssrf.test.ts:103` covers SSRF behavior from the tool path.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch-visibility.test.ts:5` covers visibility and transcript behavior.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "web_fetch"` returned #39604 private network opt-in, #82685 extraction full body, #45049, #76260 SSRF parity, #41993 IPv6 special-use, #48486 visibility sanitizer, #87505 timeout, and #77826 runtime dropping plugin web tools.
- `gitcrawl --json search prs -R openclaw/openclaw "web_fetch"` returned #67421 per-agent SSRF policy, #86965 progress, #39630 allowPrivateNetwork, #75218 Tavily fetch provider, #87758 injection hardening, #55485 SSRF policy, #77859 runtime metadata, and #85993 browser capability expansion.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "web_fetch ssrf private internal redirect injection"` found security guidance explaining that web_fetch does a plain HTTP GET, does not execute JavaScript, blocks private/internal hosts, rechecks redirects, and treats fetched content as untrusted.
- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found user-facing guidance that web_fetch can retrieve supplied URLs without a search key, but cannot discover URLs.
