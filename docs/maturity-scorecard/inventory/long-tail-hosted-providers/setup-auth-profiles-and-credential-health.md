---
title: "Long-tail hosted providers - Provider Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Long-tail hosted providers - Provider Operations Maturity Note

## Summary

Setup, auth profiles, and credential health is Alpha. The control-plane metadata
for auth and setup is broad and actively tested, but readiness for long-tail
hosted providers still depends on provider-specific OAuth/profile/env ordering,
regional account state, credential chains, and model availability.

## Category Scope

Included in this category:

- Provider directory: Covers Provider directory across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider install catalog: Covers Provider install catalog across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Model catalog metadata: Covers Model catalog metadata across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Catalog parity checks: Covers Catalog parity checks across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider setup descriptors: Covers Provider setup descriptors across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Auth profiles and aliases: Covers Auth profiles and aliases across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Credential health probes: Covers Credential health probes across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Key rotation and recovery: Covers Key rotation and recovery across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Direct provider smoke: Covers Direct provider smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Gateway live smoke: Covers Gateway live smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Models status probes: Covers Models status probes across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Fallback trace and repair: Covers Fallback trace and repair across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.

## Features

- Provider directory: Covers Provider directory across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider install catalog: Covers Provider install catalog across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Model catalog metadata: Covers Model catalog metadata across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Catalog parity checks: Covers Catalog parity checks across public provider directory, provider docs links, model provider overview tables, manifest provider metadata, and related provider catalog and discovery behavior.
- Provider setup descriptors: Covers Provider setup descriptors across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Auth profiles and aliases: Covers Auth profiles and aliases across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Credential health probes: Covers Credential health probes across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Key rotation and recovery: Covers Key rotation and recovery across provider setup descriptors, provider auth choices, auth env-var metadata, auth aliases, and related setup and credential health behavior.
- Direct provider smoke: Covers Direct provider smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Gateway live smoke: Covers Gateway live smoke across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Models status probes: Covers Models status probes across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.
- Fallback trace and repair: Covers Fallback trace and repair across direct live provider/model smoke, Gateway live profile smoke, `models status --probe`, auth/status buckets, and related provider diagnostics and fallback repair behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (66%)`
- Positive signals:
  - `docs/plugins/manifest.md` documents setup descriptors and states that `setup.providers[].envVars` is the preferred provider auth/status lookup surface.
  - `docs/concepts/model-providers.md` documents key source priority and rate-limit-only API key rotation.
  - `docs/cli/models.md` documents `models status`, auth overview, live probes, and auth/status buckets.
  - Source reads `providerAuthEnvVars`, `setup.providers[].envVars`, and auth aliases for provider env-var lookup.
  - Unit coverage preserves provider auth env metadata and checks secret-scrubbing behavior for provider env vars.
- Negative signals:
  - `models list` auth columns intentionally do not prove exact per-model execution readiness.
  - Hosted providers mix API keys, OAuth, local markers, AWS credential chains, profile stores, and plan-specific tokens.
  - Live probes are opt-in and may consume tokens or hit provider limits.

## Quality Score

- Score: `Alpha (62%)`
- Good qualities:
  - Descriptor-first setup keeps cheap auth facts available without loading provider runtime.
  - Auth diagnostics separate configured/default model state from OAuth profile health.
  - Key rotation is intentionally constrained to rate-limit-style failures and deduplicates sources.
  - Provider env-var lookup defends against prototype-chain keys and broad secret leakage.
- Bad qualities:
  - Providers still expose different readiness semantics: Bedrock credential chains, SuperGrok/X OAuth, MiniMax token-plan auth, and proxy/gateway API keys are not interchangeable.
  - `models status` can show usable auth evidence while a specific model or account plan remains unavailable.
  - Discord history shows users asking how provider keys, `.env`, auth profiles, and Bedrock credentials interact.
- Excluded from quality:
  - Unit, integration, and live evidence were used only for Coverage scoring.

## Completeness Score

- Score: `Alpha (66%)`
- Surface instructions: evaluated against `references/completeness/long-tail-hosted-providers.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider directory, Provider install catalog, Model catalog metadata, Catalog parity checks, Provider setup descriptors, Auth profiles and aliases, Credential health probes, Key rotation and recovery, Direct provider smoke, Gateway live smoke, Models status probes, Fallback trace and repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a provider-auth parity report that checks every hosted provider manifest
  has setup env vars, auth choices, docs, and status behavior.
- Add a low-cost credential health drill for cloud/gateway proxy providers.
- Surface clearer Bedrock and proxy credential-chain diagnostics in user-facing
  auth health output.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:490`: setup descriptors are for cheap setup/onboarding metadata before runtime loads.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:525`: `setup.providers` and `setup.cliBackends` are preferred descriptor-first lookup surfaces.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:531`: OpenClaw includes `setup.providers[].envVars` in generic provider auth and env-var lookups.
- `/Users/kevinlin/code/openclaw/docs/plugins/manifest.md:537`: OpenClaw can derive setup choices from `setup.providers[].authMethods`.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:61`: provider API key rotation supports live overrides, lists, primary keys, and numbered keys.
- `/Users/kevinlin/code/openclaw/docs/concepts/model-providers.md:75`: rotation is attempted only for rate-limit responses, while non-rate-limit failures fail immediately.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:28`: `models status` shows resolved defaults/fallbacks plus auth overview.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:37`: `--probe` runs live auth probes as real requests.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:51`: `models list` is read-only and does not prove exact per-model execution readiness.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md:138`: probe status buckets include `ok`, `auth`, `rate_limit`, `billing`, `timeout`, `format`, `unknown`, and `no_model`.

### Source

- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.ts:178`: provider env lookup reads manifest `providerAuthEnvVars`.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.ts:190`: provider env lookup reads `setup.providers[].envVars`.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.ts:205`: provider env lookup follows auth aliases.
- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:699`: manifest registry preserves provider auth env metadata from plugin manifests.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.test.ts:10`: auth scrubbing covers more provider env vars than the global secret list.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.test.ts:49`: provider env lookup ignores prototype-chain keys.

### Integration tests

- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:83`: direct live model tests can select providers with `OPENCLAW_LIVE_PROVIDERS`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:85`: live tests can use profile store and env fallbacks or require profile-store auth only.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:115`: Gateway live smoke can select providers with `OPENCLAW_LIVE_GATEWAY_PROVIDERS`.
- `/Users/kevinlin/code/openclaw/docs/help/testing-live.md:493`: media live suites can force profile-store auth with `OPENCLAW_LIVE_REQUIRE_PROFILE_KEYS=1`.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/manifest-registry.test.ts:699`: provider auth env metadata from plugin manifests is preserved.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.test.ts:10`: auth scrubbing includes provider-specific keys such as MiniMax.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.test.ts:49`: env-var collection ignores prototype-chain pollution and returns real provider keys.

### Gitcrawl queries

- `gitcrawl --json search issues -R openclaw/openclaw "provider auth setup env vars"` returned hits including #33329, #47684, #46184, #84804, and #84725.
- #47684 tracks auth sync/auto-sync for API key rotation across agents.
- #46184 describes Gemini CLI OAuth failures behind HTTP proxy, showing auth environment sensitivity outside simple API-key paths.
- #84804 reports Codex warm-turn auth/start-options setup latency, an adjacent profile/setup health signal.

### Discrawl queries

- `env DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json search "provider auth setup env vars" --limit 5` returned a Discord comment explaining `.env` fallback, OpenRouter/Venice manifest auth env vars, and auth profile fallback to env.
- The same Discrawl search returned PR #71226 context: descriptor-only setup providers declare env vars, and provider auth/env lookup had to include `setup.providers[].envVars`.
- The same Discrawl search returned Bedrock support guidance: Bedrock uses the AWS SDK credential chain rather than an OpenClaw API key.
- The same Discrawl search returned an image-tool review comment where configured `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `QWEN_API_KEY`, and `MOONSHOT_API_KEY` could affect provider auto-selection.
