---
title: "Web search tools - Web Provider Plugin Contracts Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Web search tools - Web Provider Plugin Contracts Maturity Note

## Summary

This note migrates archived maturity evidence for `Web search tools` / `Provider Registry, SDK Contracts, and Runtime Resolution` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Web search tools capability area represented by these taxonomy features:

- Provider Registry, SDK Contracts, and Runtime Resolution: Evidence scope for Provider Registry, SDK Contracts, and Runtime Resolution.

## Features

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

- Score: `Stable (84%)`

Coverage is Stable because the public SDK exports, manifest ownership contract, registry uniqueness, runtime provider resolution, public-artifact fallback, and late-bound agent tool path are covered in docs, source, contract suites, and runtime checks. The score is limited by active archive evidence around custom provider routing, startup snapshots, public-artifact cache behavior, and provider availability mismatches.

## Quality Score

- Score: `Beta (78%)`

Quality is Beta because the design cleanly separates manifest ownership, public artifacts, setup-mode discovery, and runtime registries, but the path remains highly stateful. Provider resolution crosses package exports, plugin manifests, config repair, runtime snapshots, and agent tool context, which creates brittle edges when plugins are missing, stale, or loaded through a different runtime path.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/web-search-tools.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for webSearchProviders, registerWebSearchProvider, webFetchProviders, registerWebFetchProvider, public-artifact loading, runtime resolution, contract tests.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:157` documents the web-search config contract SDK subpath.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:158` documents web-search contract helpers such as config and scoped credential helpers.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-subpaths.md:159` documents web-search registration and runtime helpers.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-overview.md:107` documents `api.registerWebSearchProvider(...)`.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:667` documents `contracts.webSearchProviders`.
- `/Users/kevinlin/code/openclaw/docs/tools/web.md:12` documents managed web_search using the configured provider.

### Source

- `/Users/kevinlin/code/openclaw/package.json:1252` exports `plugin-sdk/provider-web-search-config-contract`.
- `/Users/kevinlin/code/openclaw/package.json:1256` exports `plugin-sdk/provider-web-search-contract`.
- `/Users/kevinlin/code/openclaw/package.json:1260` exports `plugin-sdk/provider-web-search`.
- `/Users/kevinlin/code/openclaw/src/plugins/types.ts:2702` exposes `registerWebSearchProvider`.
- `/Users/kevinlin/code/openclaw/src/plugins/registry.ts:1376` enforces unique web-search provider registration.
- `/Users/kevinlin/code/openclaw/src/plugins/web-search-providers.runtime.ts:48` resolves plugin web-search providers.
- `/Users/kevinlin/code/openclaw/src/plugins/web-provider-public-artifacts.ts:105` resolves bundled web-search providers from public artifacts.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.ts:263` resolves the managed tool definition.
- `/Users/kevinlin/code/openclaw/src/agents/tools/web-search.ts:89` late-binds runtime context before execution.

### Integration tests

- `/Users/kevinlin/code/openclaw/package.json:1654` defines the Docker kitchen-sink plugin lane.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs:423` validates kitchen-sink web-search provider ids.
- `/Users/kevinlin/code/openclaw/extensions/google/google.live.test.ts:121` exercises Gemini web search in a live provider path.
- `/Users/kevinlin/code/openclaw/extensions/minimax/minimax.live.test.ts:38` exercises MiniMax web search in a live provider path.
- `/Users/kevinlin/code/openclaw/extensions/moonshot/moonshot.live.test.ts:22` exercises Kimi web search in a live provider path.
- `/Users/kevinlin/code/openclaw/extensions/ollama/ollama.live.test.ts:300` exercises Ollama web-search fallback in a live provider path.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/contracts/providers.contract.test.ts:17` runs web-search provider contract suites across bundled provider ids.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/test-helpers/web-search-provider-contract.ts:41` loads public-artifact providers in the contract path.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/test-helpers/provider-contract-suites.ts:130` asserts the base web-search provider contract.
- `/Users/kevinlin/code/openclaw/src/plugins/web-search-providers.runtime.test.ts:462` covers setup-mode manifest-declared provider loading.
- `/Users/kevinlin/code/openclaw/src/plugins/web-provider-public-artifacts.test.ts:47` checks public artifacts for bundled web providers.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.test.ts:753` covers scoped runtime provider loading.
- `/Users/kevinlin/code/openclaw/src/web-search/runtime.test.ts:950` covers prefer-runtime-provider execution behavior.

### Gitcrawl queries

Freshness: `gitcrawl doctor --json` reported version `0.2.1`, `last_sync_at` `2026-05-28T19:09:52.784704Z`, `29,810` threads, `11,181` open threads, and `18,594` clusters.

- `gitcrawl --json search prs -R openclaw/openclaw "provider-web-search"` returned active registry and provider-runtime items including #77736 custom provider routing, #86828 startup snapshots, #76146 SecretRef CLI path, #63571 fallback support, #85158 Parallel provider, and #86440 SerpApi provider.
- `gitcrawl --json search issues -R openclaw/openclaw "no provider available web_search"` returned #87347 no provider available despite Brave loaded, plus #80843 fallback chain and #85030 subagent tool injection.
- `gitcrawl --json search prs -R openclaw/openclaw "web provider public artifacts"` returned mostly adjacent metadata and runtime-load PRs, which suggests public-artifact regressions surface through broader provider/runtime queries rather than direct issue titles.

### Discrawl queries

Freshness: `discrawl status --json` reported state `current`, `generated_at` `2026-05-29T17:44:19Z`, `last_sync_at` `2026-05-29T15:59:50Z`, `1,487,061` messages, `25,819` channels, and zero embedding backlog.

- `discrawl search --mode hybrid --limit 12 "provider-web-search resolvePluginWebSearchProviders public artifacts"` returned no direct hybrid hits, so current Discord evidence is sparse for the internal helper names.
- Prior focused archive passes found custom provider guidance around `api.registerWebSearchProvider(...)` and review comments about runtime registry mismatch, cache staleness, and public-artifact fallback.
- `discrawl search --mode hybrid --limit 12 "web_fetch web_search config provider api key"` found review comments involving provider config and legacy config merge behavior.
