---
title: Plugins - Provider and Tool Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Provider and Tool Plugins Maturity Note

## Summary

This category is Stable, with broad current evidence across provider registration, provider auth and model-catalog ownership, capability-provider runtime loading, tool-plugin metadata generation, and mixed provider-plus-tool manifests. Coverage stays below Lovable because live and end-to-end runtime proof is representative rather than exhaustive across every bundled provider family and generated tool-plugin lifecycle. Quality is Stable because the docs and source now describe a clear cold-manifest versus runtime boundary, but archive evidence still shows active fixes and maintainer caution around provider auth metadata, custom provider routing, schema hardening, and SDK surface sprawl.

## Category Scope

This category covers the provider and tool plugin architecture for the Plugins surface:

- Provider plugin authoring through `defineSingleProviderPluginEntry`, `api.registerProvider(...)`, provider auth methods, model-catalog providers, provider aliases, runtime hooks, and provider-owned schema normalization.
- Provider-owned capability contracts such as web search, web fetch, speech, realtime transcription, realtime voice, media understanding, image generation, video generation, music generation, embeddings, and related manifest ownership paths.
- Tool-plugin authoring through `defineToolPlugin`, static metadata generation, optional tool metadata, runtime factories, manifest contract generation, and tool discovery without loading plugin runtime code.
- Mixed provider-and-tool plugin shapes where one bundled plugin owns providers plus `contracts.tools`, such as Tavily and xAI.

Out of scope: channel-plugin architecture, plugin distribution and release readiness as a separate category, ClawHub publishing flows, and provider-specific product quality beyond the shared provider/tool architecture seams.

## Features

- Provider plugins: Provider plugins register models and capabilities with the runtime.
- Tool plugins: Tool plugins register discoverable tools and static metadata without ambiguous runtime ownership.
- Model catalogs: Provider model catalogs are discoverable and merge cleanly into global listings.
- Provider auth: Provider auth configuration and secret handling are supported.
- Web search and fetch: Provider or tool plugins can expose web search and fetch capabilities.
- Mixed plugins: Mixed provider and tool plugins are supported without ambiguous ownership.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with `generated_at=2026-05-30T00:38:20Z`, `state=current`, `summary=1487536 messages across 25831 channels`, `last_sync_at=2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals:
  - Runtime integration tests cover provider hook lookup, provider-prepared runtime auth, catalog and config-driven provider resolution, and safe runtime reuse in `src/plugins/provider-runtime.test.ts`.
  - Capability-provider runtime tests cover metadata-snapshot discovery, enabled external capability loading, bundled fallback capture, and manifest-contract resolution in `src/plugins/capability-provider-runtime.test.ts` and `src/plugins/manifest-contract-runtime.test.ts`.
  - Web-search and media-provider runtime tests cover bundled provider loading, scoped runtime discovery, allowlist behavior, configured-provider execution, credential auto-detect, and provider fail-fast paths in `src/plugins/web-search-providers.runtime.test.ts`, `src/web-search/runtime.test.ts`, and `src/video-generation/runtime.test.ts`.
  - Tool-hook integration and e2e tests cover before-tool-call mutation and blocking plus after-tool-call dispatch and isolation in `src/agents/agent-tools.before-tool-call.integration.e2e.test.ts`, `src/agents/agent-tools.before-tool-call.e2e.test.ts`, and `src/plugins/wired-hooks-after-tool-call.e2e.test.ts`.
  - Live provider coverage exists for bundled provider families and capability paths in `extensions/openai/openai.live.test.ts`, `extensions/openrouter/openrouter.live.test.ts`, `extensions/xai/xai.live.test.ts`, `extensions/xai/x-search.live.test.ts`, and `extensions/video-generation-providers.live.test.ts`.
- Negative signals:
  - Coverage is strongest for provider runtime, web search, media-generation capabilities, and hook dispatch, but not for every bundled provider auth onboarding path or every catalog variant.
  - Generated `defineToolPlugin` flows have good authoring and manifest validation evidence, but there is still limited full install-build-inspect-run proof for third-party-style packages.
  - Mixed provider-plus-tool plugins are exercised through specific plugin suites rather than a single category-wide runtime matrix.
- Integration gaps:
  - Add a cross-provider smoke matrix that enables each bundled provider or provider-plus-tool plugin, resolves ownership from manifests, and executes a harmless runtime path where applicable.
  - Add replay-backed or live-smoke coverage for provider auth onboarding plus model-catalog listing across more bundled providers, not only selected OpenAI, OpenRouter, xAI, and media-provider paths.
  - Add an end-to-end generated tool-plugin package flow that covers scaffold, build, metadata generation, inspect, enablement, and real runtime execution.
  - Add explicit mixed-plugin regression coverage that keeps `contracts.tools`, capability ownership, and runtime metadata aligned after install and update.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports:
  - `gitcrawl search openclaw/openclaw --query "provider plugin sdk tool web search" --json` returned current work on bundled provider growth and routing repairs, including #85158 (Parallel as bundled `web_search` provider), #77736 (explicit custom `web_search` provider routing fix), #86440 (SerpApi plugin with provider plus tools), #75218 (Tavily `web_fetch` provider), and #87486 (beta feedback touching plugin display names, lazy runtime surfaces, and catalog metadata).
  - `gitcrawl search openclaw/openclaw --query "plugin sdk provider auth model catalog" --json` returned ongoing quality pressure around provider thinking profiles, metadata-only catalog loading, provider onboarding, catalog headers, runtime-resolution migration, schema hardening, stale cooldown repair, OAuth migration, and SDK surface consolidation (#84902, #75022, #84997, #78951, #77700, #87141, #87697, #82056, #80219).
- Discrawl reports:
  - Current maintainer discussion says plugin API contracts, extension loading, provider naming, auth, sandbox, and deprecation plans are all change areas that should get extra review before hardening.
  - Maintainer review notes on embedding-provider evolution explicitly call out coexistence of legacy and newer capability seams, which is good for compatibility but shows this architecture is still mid-transition.
  - Maintainer discussion on xAI auth metadata argues that cold manifest `providerAuthChoices` and runtime provider `auth` are intentionally distinct contracts, and warns against one-off SDK escape hatches such as broad `extraAuth` patterns.
  - Recent release messages describe faster plugin and catalog scanning, profile-aware provider auth improvements, and new provider plugins, which is a positive operational signal but also evidence of active churn.
- Good qualities:
  - Current docs and source make the cold-manifest versus runtime split explicit: manifest metadata powers discovery and validation, while runtime registration owns actual provider and tool behavior.
  - `defineToolPlugin` keeps tool metadata static and discoverable without executing runtime code, and the authoring command path preserves manifest-owned metadata while regenerating tool contracts.
  - The architecture docs, provider-plugin guide, tool-plugin guide, and generated inventory give plugin authors a coherent path from authoring through runtime ownership.
- Bad qualities:
  - Archive evidence still shows frequent repairs in provider routing, auth-profile handling, catalog metadata, schema fuzz boundaries, and cooldown behavior.
  - Maintainer archive feedback treats provider security contracts and SDK-surface changes as high-risk review areas, which keeps this category below Lovable.
  - The provider and tool architecture remains broad enough that new bundled providers or mixed plugins can add pressure at multiple seams at once.
- Excluded from quality:
  - Unit, integration, e2e, and live test coverage were used only as Coverage inputs.
  - The shared plugin-surface validation failures were treated as a local environment blocker, not as product-quality evidence.

## Known Gaps

- Provider auth onboarding and catalog-listing flows still need broader end-to-end proof across the bundled provider set.
- Mixed provider-plus-tool plugins need stronger category-wide regression checks so manifest ownership, runtime registration, and tool metadata stay aligned together.
- The public SDK surface is still large enough that maintainers are explicitly tracking export and lifecycle consolidation debt.
- Tool-plugin packaging has strong contract validation but still lacks more real third-party installation and runtime-smoke evidence.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-provider-plugins.md` documents provider manifests, provider auth, model catalogs, runtime hooks, provider-tool compatibility helpers, and `defineSingleProviderPluginEntry`.
- `/Users/kevinlin/code/openclaw/docs/plugins/tool-plugins.md` documents `defineToolPlugin`, optional tools, factory tools, metadata generation, and authoring/build/validate flow.
- `/Users/kevinlin/code/openclaw/docs/plugins/architecture.md` documents the capability model, manifest-versus-runtime ownership split, plugin shapes, metadata snapshots, and activation planning.
- `/Users/kevinlin/code/openclaw/docs/plugins/plugin-inventory.md` records bundled and external plugin inventory, including provider, provider-plus-tool, and tool-only plugin surfaces.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md` documents legacy capability-key migration into `contracts`, which matters for provider-owned capability contracts.

### Source

- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-entry.ts` implements `defineSingleProviderPluginEntry`, env-var normalization, provider auth wiring, and live/static catalog projection.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/tool-plugin.ts` implements `defineToolPlugin`, static metadata export, optional-tool handling, and runtime tool registration.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-tools.ts` implements provider-family tool-schema normalization and inspection hooks.
- `/Users/kevinlin/code/openclaw/src/plugins/provider-runtime.ts` owns runtime provider hook resolution, provider auth/profile handling, prompt overlays, and provider runtime loading.
- `/Users/kevinlin/code/openclaw/src/plugins/capability-provider-runtime.ts` owns manifest-contract discovery and runtime loading for capability providers.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-contract-runtime.ts` resolves metadata-snapshot-backed manifest contract runtime ownership.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-authoring-command.ts` builds and validates generated tool-plugin metadata.
- `/Users/kevinlin/code/openclaw/extensions/brave/openclaw.plugin.json`, `/Users/kevinlin/code/openclaw/extensions/tavily/openclaw.plugin.json`, and `/Users/kevinlin/code/openclaw/extensions/xai/openclaw.plugin.json` show current bundled provider-only and provider-plus-tool manifest ownership patterns.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/plugins/provider-runtime.test.ts` covers provider runtime hook lookup, prepared runtime auth, config mutation invalidation, and safe runtime resolution.
- `/Users/kevinlin/code/openclaw/src/plugins/capability-provider-runtime.test.ts` covers manifest-snapshot capability discovery, bundled fallback capture, enabled external providers, and cold-loading of external capability providers.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-contract-runtime.test.ts` covers manifest-contract runtime resolution from metadata snapshots.
- `/Users/kevinlin/code/openclaw/src/plugins/web-search-providers.runtime.test.ts` and `/Users/kevinlin/code/openclaw/src/web-search/runtime.test.ts` cover bundled web-search provider loading, setup-mode discovery, scoped runtime loading, configured-provider execution, and provider fail-fast paths.
- `/Users/kevinlin/code/openclaw/src/video-generation/runtime.test.ts` covers active provider execution, fallback behavior, provider-option schema guards, and mode-specific capability handling.
- `/Users/kevinlin/code/openclaw/src/agents/agent-tools.before-tool-call.integration.e2e.test.ts`, `/Users/kevinlin/code/openclaw/src/agents/agent-tools.before-tool-call.e2e.test.ts`, and `/Users/kevinlin/code/openclaw/src/plugins/wired-hooks-after-tool-call.e2e.test.ts` cover before-tool-call and after-tool-call hook behavior across runtime flows.
- `/Users/kevinlin/code/openclaw/extensions/openai/openai.live.test.ts`, `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts`, `/Users/kevinlin/code/openclaw/extensions/xai/xai.live.test.ts`, `/Users/kevinlin/code/openclaw/extensions/xai/x-search.live.test.ts`, and `/Users/kevinlin/code/openclaw/extensions/video-generation-providers.live.test.ts` provide live-provider evidence for representative bundled-provider paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-entry.test.ts` covers provider registration, env-var and auth wiring, and wizard metadata defaults.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/tool-plugin.test.ts` covers wrapped results, optional tools, runtime factories, strict empty config defaults, and static metadata export.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-tools.test.ts` covers provider-family schema normalization and inspection behavior for DeepSeek, Gemini, and OpenAI tool schemas.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/provider-auth-runtime.test.ts` covers OAuth state generation, callback parsing, and callback CORS handling.
- `/Users/kevinlin/code/openclaw/src/cli/plugins-authoring-command.test.ts` covers manifest generation from tool metadata, optional tool metadata, package-entry alignment, and stale-contract validation.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-tool-contracts.test.ts` covers alignment between runtime `registerTool` ownership and `contracts.tools`.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/provider-family-plugin-tests.test.ts` covers bundled provider-family hook boundaries.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but local dependency installation failed before real validation on 403 registry auth errors for `@microsoft/teams.cards` and `@microsoft/teams.api` with `No authorization header was set for the request`; this command would verify generated public SDK exports against the checked-in entrypoint inventory.
- `pnpm plugin-sdk:api:check`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but the same local dependency-install blocker prevented execution; this command would detect public API drift in the packaged Plugin SDK surface.
- `pnpm plugin-sdk:surface:check`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but the same local dependency-install blocker prevented execution; this command would enforce surface-size budgets and deprecated-export limits for the public Plugin SDK.
- `pnpm plugins:boundary-report:ci`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but the same local dependency-install blocker prevented execution; this command would validate reserved-import boundaries, unclassified subpaths, and due compatibility debt across plugin-owned code.
- `pnpm release:plugins:npm:check`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but the same local dependency-install blocker prevented execution; this command would validate publishable plugin npm metadata and release readiness.
- `pnpm release:plugins:clawhub:check`: `blocked` - attempted from `/Users/kevinlin/code/openclaw`, but the same local dependency-install blocker prevented execution; this command would validate publishable plugin ClawHub metadata and release readiness.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "provider plugin sdk tool web search" --json`

Results:

- Returned open work on bundled provider growth and routing quality: #85158 (Parallel as a bundled `web_search` provider), #77736 (explicit custom `web_search` provider routing fix), #86440 (SerpApi plugin with provider plus tools), #75218 (Tavily `web_fetch` provider), #87486 (beta feedback touching plugin display names, lazy runtime surfaces, and catalog metadata), plus adjacent extension pressure from #86155 and #80388.

Query:

`gitcrawl search openclaw/openclaw --query "plugin sdk provider auth model catalog" --json`

Results:

- Returned current quality-pressure items around provider thinking profiles, metadata-only catalog loading, provider onboarding, catalog headers, prepared runtime migration, schema hardening, stale cooldown repair, OAuth migration, and SDK-surface consolidation (#84902, #75022, #84997, #78951, #77700, #87141, #87697, #82056, #80219).

### Discrawl queries

Query:

`discrawl --json search "provider plugin sdk" --limit 10`

Results:

- Returned current maintainer discussion that treats plugin API contracts, SDK surface, extension loading semantics, provider naming, auth boundaries, and deprecation plans as areas needing extra review before hardening.
- Returned a recent maintainer update that a plugin-surface change added reusable provider-stream shared helpers, which is a positive signal for active maintenance but also confirms ongoing SDK expansion.
- Returned maintainer concern that a proposed change added a new provider security contract with limited repro detail, which is direct negative quality evidence for this category.

Query:

`discrawl --json search "tool plugin provider auth model catalog" --limit 10`

Results:

- Returned maintainer commentary that cold manifest `providerAuthChoices` and runtime provider `auth` are intentionally separate contracts, and that preserving that split matters for onboarding and discovery.
- Returned maintainer commentary that legacy and newer embedding-provider seams currently coexist for compatibility, which is good for existing plugins but evidence that capability migration is still active.
- Returned recent release messaging that calls out faster plugin and model-auth metadata lookup plus broader provider-plugin coverage, which is a positive operational signal for this category.
