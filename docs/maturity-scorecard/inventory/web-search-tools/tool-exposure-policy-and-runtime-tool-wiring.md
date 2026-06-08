---
title: "Web search tools - Tool Availability and Fetch Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Tool Availability and Fetch Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Tool Exposure, Policy, and Runtime Tool Wiring` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- web_search exposure: Defines web_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- web_fetch exposure: Defines web_fetch exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- x_search exposure: Defines x_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- group:web policy: Defines group:web policy setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- disabled-state diagnostics: Defines disabled-state diagnostics setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- provider/model gating: Defines provider/model gating setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- URL fetch: Covers URL fetch tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- HTML extraction: Covers HTML extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- PDF/text extraction: Covers PDF/text extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Safe truncation: Covers Safe truncation tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Content citation handoff: Covers Content citation handoff tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.

## Features

- web_search exposure: Defines web_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- web_fetch exposure: Defines web_fetch exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- x_search exposure: Defines x_search exposure setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- group:web policy: Defines group:web policy setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- disabled-state diagnostics: Defines disabled-state diagnostics setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- provider/model gating: Defines provider/model gating setup, credential, configuration, and operator verification behavior for Tool Availability and Policy.
- URL fetch: Covers URL fetch tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- HTML extraction: Covers HTML extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- PDF/text extraction: Covers PDF/text extraction tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Safe truncation: Covers Safe truncation tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.
- Content citation handoff: Covers Content citation handoff tool invocation, host execution, sandbox policy, and artifact handling for Web Fetch and Content Extraction.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`

Coverage is Stable because docs, agent tool source, runtime checks, allowlist behavior, gateway startup behavior, and archive evidence cover how web_search and web_fetch are exposed to agents. The score is limited by active archive evidence that subagents and provider-specific allowlists can still drop tools in ways operators do not expect.

## Quality Score

- Score: `Stable (82%)`

Quality is Stable because tool exposure is built around explicit profile and allowlist policy, late-bound runtime context, and provider/model gating instead of eagerly exposing unavailable tools. The remaining risk is that availability depends on multiple runtime inputs, so the user-visible reason a tool is missing can still be hard to diagnose.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for web_search exposure, web_fetch exposure, x_search exposure, group:web policy, disabled-state diagnostics, provider/model gating, URL fetch, HTML extraction, PDF/text extraction, Safe truncation, Content citation handoff.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:23` documents the coding profile and `group:web`.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-tools.md:35` maps `group:web` to `web_search`, `x_search`, and `web_fetch`.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:178` documents tool profile and allowlist use for web_fetch and `group:web`.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:19` explains when to use web_search, browser, or web_fetch.
- `/Users/kevinlin/code/openclaw/docs/help/faq.md:732` covers enabling tools and allowlists in operator-facing terms.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.ts:9` defines the web_search tool schema.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.ts:67` builds the disabled-state response.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.ts:83` late-binds runtime context before web_search execution.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-fetch.ts:616` creates the web_fetch tool with runtime defaults and provider fallback.
- `/Users/kevinlin/code/openclaw/src/agents/codex-native-web-search-core.ts:177` patches native tool behavior and suppresses managed web_search where needed.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.ts:263` resolves the managed web_search tool definition.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.ts:163` resolves web_fetch runtime provider definitions.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-search.md:43` checks runtime web_search behavior.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-fetch.md:43` checks runtime web_fetch behavior.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/openai-web-search-minimal/assertions.mjs:132` checks native web-search injection and minimal-reasoning behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-startup-web-fetch-bind.test.ts:78` covers startup binding without early provider discovery.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/tools/web-tools.enabled-defaults.test.ts:117` covers web tool default enablement behavior.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.late-bind.test.ts:65` covers late-bound web_search context.
- `/Users/kevinlin/code/openclaw/src/agents/tool-policy.test.ts:121` covers group aliases and policy behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/plugin-tool-allowlist-warnings.test.ts:316` covers warnings for explicit allowlists and plugin tools.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.test.ts:753` covers scoped runtime provider loading.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.test.ts:275` covers sandbox/runtime web_fetch boundaries.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "no provider available web_search"` returned #87347 no provider available, #85030 subagent tool injection, and #80843 fallback chain.
- `gitcrawl --json search issues -R openclaw/openclaw "web_search"` returned #77826 runtime drops plugin web tools, #85030 subagent tool injection, #87347 no provider available, and #87505 timeout.
- `gitcrawl --json search prs -R openclaw/openclaw "web_fetch"` returned #77859 runtime metadata preservation, #85993 browser capability expansion, and #86965 progress surfacing.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found a GitHub issue thread where subagents spawned via sessions could not access browser, web_search, or web_fetch despite allowlist config.
- `discrawl search --mode hybrid --limit 12 "web_search no provider available Brave loaded web_fetch"` found operator guidance explaining allowlist warnings when web_search is unavailable and Brave is not configured.
