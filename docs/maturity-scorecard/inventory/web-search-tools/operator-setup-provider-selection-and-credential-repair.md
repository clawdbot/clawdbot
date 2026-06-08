---
title: "Web search tools - Setup and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Setup and Diagnostics Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Operator Setup, Provider Selection, and Credential Repair` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Provider credentials: Defines Provider credentials setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Default provider selection: Defines Default provider selection setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Credential repair: Defines Credential repair setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Status checks: Defines Status checks setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Quota errors: Covers Quota errors status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Cache controls: Covers Cache controls status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Provider diagnostics: Covers Provider diagnostics status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Retry and fallback: Covers Retry and fallback status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Operator repair: Covers Operator repair status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.

## Features

- Provider credentials: Defines Provider credentials setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Default provider selection: Defines Default provider selection setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Credential repair: Defines Credential repair setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Status checks: Defines Status checks setup, credential, configuration, and operator verification behavior for Setup and Credential Repair.
- Quota errors: Covers Quota errors status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Cache controls: Covers Cache controls status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Provider diagnostics: Covers Provider diagnostics status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Retry and fallback: Covers Retry and fallback status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.
- Operator repair: Covers Operator repair status, diagnostics, failure handling, and operator repair for Provider Reliability and Diagnostics.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`

Coverage is Stable because the docs and source cover first-run configuration, provider choice, env/API-key alternatives, keyless providers, SecretRefs, canonical plugin-owned config, stale provider validation, doctor migration, and separate web_fetch selection. The score is limited by missing always-on end-to-end proof for configure plus doctor repair plus gateway restart across every provider, and archive hits still show operator confusion around keys, allowlists, and no-provider states.

## Quality Score

- Score: `Beta (76%)`

Quality is Beta because the canonical config direction is sound, but the operator path spans many credential classes, legacy config migration, service env loading, plugin enablement, allowlists, keyless experimental providers, and restart-sensitive gateway state. Current archive evidence shows those edges still leak into user-visible setup failures.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider credentials, Default provider selection, Credential repair, Status checks, Quota errors, Cache controls, Provider diagnostics, Retry and fallback, Operator repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/tools/web.md:27` documents `openclaw configure --section web`, provider choice, and credential storage.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:100` lists supported providers and credential requirements.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:170` documents auto-detection order, env/plugin key paths, keyless fallback, and SecretRefs.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:227` documents canonical plugin-owned config, validation for stale providers, `doctor --fix`, and separate web_fetch provider selection.
- `/Users/kevinlin/code/openclaw/docs/tools/web-fetch.md:19` documents web_fetch as enabled by default.
- `/Users/kevinlin/code/openclaw/docs/help/faq.md:732` gives operator guidance for enabling web_search/web_fetch, env vars, plugin-owned config, allowlists, and daemon env loading.

### Source

- `/Users/kevinlin/code/openclaw/src/flows/search-setup.ts:403` implements provider selection, defaults, credential prompts, keyless provider handling, OAuth-backed Grok setup, SecretRef mode, and setup finalization.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.ts:153` resolves explicit and auto-detected web_search providers from credentials, auth profiles, and keyless fallback.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.ts:424` executes the selected provider and fallback behavior.
- `/Users/kevinlin/code/openclaw/src/web-fetch/runtime.ts:107` resolves web_fetch provider selection.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-web-search-migrate.ts:12` maps legacy web_search config to plugin owners.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-web-fetch-migrate.ts:38` migrates Firecrawl fetch config.
- `/Users/kevinlin/code/openclaw/src/config/validation.ts:1337` validates configured web_search providers and emits install or doctor guidance.

### Integration tests

- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-search.md:11` defines runtime parity coverage for web_search.
- `/Users/kevinlin/code/openclaw/qa/scenarios/runtime/tools/web-fetch.md:11` defines runtime parity coverage for web_fetch.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/openai-web-search-minimal/scenario.sh:57` runs the native OpenAI web-search gateway path.
- `/Users/kevinlin/code/openclaw/src/gateway/server-startup-web-fetch-bind.test.ts:78` verifies gateway startup with credential-free web_fetch config.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-web-search-migrate.test.ts:9` covers migration from legacy `tools.web.search.*` config.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/legacy-web-fetch-migrate.test.ts:9` covers Firecrawl fetch migration.
- `/Users/kevinlin/code/openclaw/src/config/config.web-search-provider.test.ts:305` covers provider config acceptance.
- `/Users/kevinlin/code/openclaw/src/config/config.web-search-provider.test.ts:597` covers env auto-detection.
- `/Users/kevinlin/code/openclaw/src/flows/search-setup.test.ts:212` covers provider-owned and OAuth-backed setup.
- `/Users/kevinlin/code/openclaw/src/flows/search-setup.test.ts:406` covers install-catalog provider setup.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search issues -R openclaw/openclaw "web_search"` returned open setup and runtime issues including #87347 no provider available despite Brave loaded, #77826 plugin web tools dropped at runtime, #80843 fallback chain, and #87505 timeout regression.
- `gitcrawl --json search issues -R openclaw/openclaw "web_fetch"` returned open fetch setup and safety issues including #39604 private-network opt-in, #82685 extraction body limits, #41993 IPv6 special-use failures, and #87505 timeout regression.
- `gitcrawl --json search prs -R openclaw/openclaw "web_search"` returned active provider routing, startup snapshot, SecretRef, fallback, and proxy work including #77736, #86828, #76146, #63571, and #61413.
- `gitcrawl --json search prs -R openclaw/openclaw "web_fetch"` returned active Firecrawl/Tavily fetch, private-network, progress, injection hardening, and runtime metadata work including #75218, #39630, #86965, #87758, and #77859.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "web_search no provider available Brave loaded web_fetch"` found support guidance distinguishing web_fetch from web_search and explaining that search needs a configured provider key.
- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found setup threads for enabling both tools, Brave key placement, `group:web` allowlists, and provider config review comments.
- `discrawl search --mode hybrid --limit 12 "openclaw configure --section web Brave API key web_search web_fetch"` found repeated operator guidance to use `openclaw configure --section web`, restart the gateway, and put keys in gateway env.
- `discrawl search --mode hybrid --limit 12 "web_search migration doctor --fix tools.web.search"` found migration discussions where legacy `tools.web.search` state required doctor repair.
