---
title: "OpenRouter provider path - Provider Setup and Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Provider Setup and Auth Maturity Note

## Summary

The OpenRouter setup path is well documented and registered as a bundled provider plugin with a default `openrouter/auto` route, static catalog rows, auth-choice metadata, endpoint classification, and media-provider contracts. Coverage is Stable because docs and plugin/runtime tests cover the ordinary setup path and catalog visibility.

Quality is Beta because Discord and GitHub evidence still show operator confusion around setup state, token/quota failures, stale model entries, and the difference between OpenRouter routing issues and OpenClaw configuration issues.

## Category Scope

Included in this category:

- First-run setup: Covers First-run setup across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Default model selection: Covers Default model selection across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Provider plugin registration: Covers Provider plugin registration across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Model-ref examples: Covers Model-ref examples across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- OPENROUTER_API_KEY: Covers OPENROUTER_API_KEY across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Auth profiles and auth order: Covers Auth profiles and auth order across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Status/probe and removal: Covers Status/probe and removal across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Provider-entry SecretRef/API-key resolution: Covers Provider-entry SecretRef/API-key resolution across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Gateway env inheritance: Covers Gateway env inheritance across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Static catalog rows: Covers Static catalog rows across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Dynamic /models discovery: Covers Dynamic /models discovery across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- openrouter/auto and nested refs: Covers openrouter/auto and nested refs across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Free-model scan/probe: Covers Free-model scan/probe across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Model list/picker cache: Covers Model list/picker cache across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.

## Features

- First-run setup: Covers First-run setup across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Default model selection: Covers Default model selection across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Provider plugin registration: Covers Provider plugin registration across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- Model-ref examples: Covers Model-ref examples across user-facing setup and provider registration: the `/providers/openrouter` docs, plugin manifest, provider registration hook, default model registration, and related operator setup and model selection behavior.
- OPENROUTER_API_KEY: Covers OPENROUTER_API_KEY across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Auth profiles and auth order: Covers Auth profiles and auth order across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Status/probe and removal: Covers Status/probe and removal across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Provider-entry SecretRef/API-key resolution: Covers Provider-entry SecretRef/API-key resolution across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Gateway env inheritance: Covers Gateway env inheritance across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Static catalog rows: Covers Static catalog rows across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Dynamic /models discovery: Covers Dynamic /models discovery across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- openrouter/auto and nested refs: Covers openrouter/auto and nested refs across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Free-model scan/probe: Covers Free-model scan/probe across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.
- Model list/picker cache: Covers Model list/picker cache across static catalog rows, dynamic model capability discovery, model-id normalization, `openrouter/<provider>/<model>` references, and related model catalog and dynamic discovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: The docs and provider plugin cover the default OpenRouter route, model-ref shape, setup command, static catalog, endpoint metadata, and setup auth choice. Plugin registration tests verify provider, media, image, music, video, and speech provider registration.
- Negative signals: The strongest runtime proof is mostly unit/contract and live-gated plugin tests rather than always-on release smoke for a full first-run onboarding journey.
- Integration gaps: Add a release scenario that installs OpenClaw, runs `openclaw onboard --auth-choice openrouter-api-key`, verifies `/model openrouter/auto`, and sends one successful tool-capable message through the gateway.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: The broad OpenRouter archive query returns setup-adjacent issues about dynamic discovery, stale/delisted model entries, provider auth routing, and OpenRouter-specific fallback behavior.
- Discrawl reports: Discord search shows recent users discussing setup, OpenRouter credits, free model availability, and cases where OpenRouter selection fails in confusing ways.
- Good qualities: The docs provide a direct setup command, config examples, model-ref examples, and links to model-selection documentation. The plugin manifest explicitly declares endpoint class, auth choice, model-id normalization, pricing passthrough, and provider contracts.
- Bad qualities: User-facing reports still mix setup failures, quota errors, stale sessions, and upstream model behavior into the same support path, which makes operator diagnosis harder than the docs imply.
- Excluded from quality: Unit-test breadth, plugin contract coverage, and live-test existence are Coverage inputs only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for First-run setup, Default model selection, Provider plugin registration, Model-ref examples, OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance, Static catalog rows, Dynamic /models discovery, openrouter/auto and nested refs, Free-model scan/probe, Model list/picker cache.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- First-run setup is documented, but the maintained evidence is stronger for registration and catalog mechanics than for an end-to-end onboarding smoke.
- `openrouter/auto` is useful as a default, but operator reports show that it can mask upstream model and quota behavior.
- Setup docs do not fully separate OpenRouter account quota problems from OpenClaw auth/config problems.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents OpenRouter setup, `openclaw onboard --auth-choice openrouter-api-key`, `openrouter/auto`, model-ref syntax, media paths, auth headers, caching, reasoning, and routing options.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md` lists OpenRouter as bundled provider id `openrouter`, auth env `OPENROUTER_API_KEY`, and default model `openrouter/auto`.
- `/Users/kevinlin/code/openclaw/docs/cli/configure.md` explains that reauthing OpenRouter preserves an existing primary model unless the operator explicitly sets the default.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openclaw.plugin.json` declares the bundled `openrouter` plugin, endpoint class, model-id normalization, pricing passthrough, setup provider, auth choice, and media/provider contracts.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` registers the provider, static catalog, dynamic model resolver, auth method, stream wrapper, media understanding, image, music, video, speech, and video catalog providers.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/provider-catalog.ts` defines `OPENROUTER_BASE_URL`, canonicalizes legacy `/v1`, and ships `openrouter/auto` plus Kimi static fallback rows.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/onboard.ts` adds the `openrouter/auto` model entry and alias during onboarding.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/openrouter.live.test.ts` live-gates a provider registration and completion smoke when `OPENROUTER_API_KEY` and `OPENCLAW_LIVE_TEST=1` are present.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers OpenRouter-native ids and model-list behavior through the command surface.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.e2e.test.ts` verifies embedded runs resolve explicit OpenRouter models through model resolution without generating a local `models.json`.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.test.ts` verifies provider registration, static catalog, base URL normalization, reasoning policy, provider routing params, and registered companion providers.
- `/Users/kevinlin/code/openclaw/extensions/openrouter/onboard.test.ts` covers OpenRouter onboarding config application.
- `/Users/kevinlin/code/openclaw/src/commands/auth-choice.test.ts` covers OpenRouter auth-choice metadata and default-model handling.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter onboarding openrouter-api-key OPENROUTER_API_KEY"`

Results:

- Returned #73496, an embedded runtime hang report where OpenRouter setup is not the primary root cause but appears in the surrounding runtime/setup cluster.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #10687 on dynamic model discovery, #80347 on stale/delisted model entries after configure, #67423 on provider-entry API-key routing, #83651 on OpenRouter Retry-After stalling fallback, #87170 on `Provider returned error` with `auto`, #86880 on OpenRouter context overflow, and #79535 on OpenRouter media generation failures.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OpenRouter"`

Results:

- Found May 2026 support discussion about buying OpenRouter credits, free models, OpenRouter quota/token exhaustion, `openclaw models scan`, and choosing specific OpenRouter models instead of relying on generic routing.
