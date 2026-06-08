---
title: "Anthropic provider path - Provider Auth and Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Provider Auth and Recovery Maturity Note

## Summary

Anthropic auth has first-class docs and source paths for API keys, Claude CLI
credential reuse, setup-token profiles, auth profile ordering, and doctor hints.
Coverage is Stable because the direct API-key and Claude CLI paths are present
in docs, plugin registration, provider auth choices, config defaults, and
focused tests. Quality is Beta because GitHub and Discord archive evidence still
shows users hitting orphaned profiles, gateway-host credential mismatch, stale
setup-token or OAuth behavior, and "No API key found" confusion.

## Category Scope

Included in this category:

- API-key onboarding: Covers API-key onboarding across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Claude CLI credential reuse: Covers Claude CLI credential reuse across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Setup-token auth: Covers Setup-token auth across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Auth profile health: Covers Auth profile health across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Model status: Covers Model status across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Usage windows: Covers Usage windows across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Cooldown/profile reporting: Covers Cooldown/profile reporting across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Long-context recovery: Covers Long-context recovery across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Fallback guidance: Covers Fallback guidance across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.

## Features

- API-key onboarding: Covers API-key onboarding across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Claude CLI credential reuse: Covers Claude CLI credential reuse across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Setup-token auth: Covers Setup-token auth across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Auth profile health: Covers Auth profile health across Anthropic credential surface before a model request is made: onboarding choices, API-key storage, Claude CLI credential migration, setup-token validation, and related credential setup and health behavior.
- Model status: Covers Model status across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Usage windows: Covers Usage windows across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Cooldown/profile reporting: Covers Cooldown/profile reporting across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Long-context recovery: Covers Long-context recovery across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Fallback guidance: Covers Fallback guidance across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Anthropic docs describe API-key, Claude CLI, and setup-token style paths; `extensions/anthropic/openclaw.plugin.json` publishes auth choices and setup env vars; `extensions/anthropic/register.runtime.ts` implements API-key auth, setup-token auth, Claude CLI migration, synthetic auth, and doctor hints.
- Negative signals: Setup-token live proof is env-gated, and profile health depends on per-agent auth stores and gateway-host runtime state.
- Integration gaps: The audit found strong focused tests and one live setup-token lane, but not a repeated release artifact proving API-key, setup-token, and Claude CLI migration across fresh hosts every release.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: #83268 reports Anthropic API keys being registered under an orphan `claude` provider and silently falling back to OAuth; #72255 reports orphaned per-agent credentials after config declarations are removed; #80514 reports a Claude Pro Max cap warning being classified as billing failure.
- Discrawl reports: Discord archive results include "No API key found for provider anthropic" cases tied to shell versus daemon runtime mismatch, stale/broken auth stores, setup-token policy failures, and profile order confusion.
- Good qualities: The provider owns explicit auth methods, validates setup-token shape, writes auth profiles with locks, resolves Claude CLI native auth only for the synthetic `claude-cli` provider, and emits doctor guidance for legacy profile repair.
- Bad qualities: Users still need to understand several credential planes: gateway token, Anthropic API key, Anthropic setup-token, Claude CLI native auth, per-agent auth store, profile order, cooldown, and daemon environment.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for API-key onboarding, Claude CLI credential reuse, Setup-token auth, Auth profile health, Model status, Usage windows, Cooldown/profile reporting, Long-context recovery, Fallback guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Setup-token behavior can be upstream-policy dependent and less predictable
  than API-key auth.
- Per-agent auth store routing and daemon environment mismatch remain frequent
  support themes.
- Anthropic API-key and Claude CLI routes share the provider label but have
  materially different billing and operational behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` documents API-key setup, Claude CLI setup, setup-token-style troubleshooting, `openclaw models list --provider anthropic`, and states that API keys are the clearest production path for long-lived gateways.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md` documents OAuth expiry and stale Anthropic profile repair guidance.
- `/Users/kevinlin/code/openclaw/docs/gateway/configuration-examples.md` includes Anthropic API-key profile examples and model/fallback config.

### Source

- `/Users/kevinlin/code/openclaw/extensions/anthropic/openclaw.plugin.json` declares `providers: ["anthropic"]`, setup env vars `ANTHROPIC_OAUTH_TOKEN` and `ANTHROPIC_API_KEY`, and provider auth choices for Claude CLI, setup-token, and API key.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/register.runtime.ts` implements `runAnthropicSetupTokenAuth`, `runAnthropicSetupTokenNonInteractive`, `runAnthropicCliMigration`, `runAnthropicCliMigrationNonInteractive`, `resolveClaudeCliSyntheticAuth`, `createProviderApiKeyAuthMethod`, and `buildAnthropicAuthDoctorHint`.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/config-defaults.ts` resolves Anthropic default auth mode from profile order, API-key profiles, OAuth/token profiles, and env vars before seeding cache/heartbeat/default model behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.ts` inspects Claude CLI command, credential readability, workspace/project directory health, and selected `claude-cli` runtime agents.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/anthropic.setup-token.live.test.ts` env-gates a live setup-token profile smoke that resolves Anthropic models, extracts the profile API key, and completes a simple prompt.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies package-acceptance workflow wiring for Anthropic credentials and live Anthropic profiles.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers provider catalog/auth rows that include configured provider behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/anthropic/index.test.ts` covers Claude CLI auth profile migration, synthetic OAuth/token auth, API defaulting, Anthropic config defaults, and doctor-profile hooks.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/provider-policy-api.test.ts` covers provider policy normalization, API-key defaults, Claude CLI config normalization, and thinking profile exposure.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.test.ts` covers Claude CLI doctor behavior.
- `/Users/kevinlin/code/openclaw/src/llm/utils/oauth/anthropic.test.ts` covers Anthropic OAuth login and refresh utilities.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic API key auth profile setup-token claude-cli"`

Results:

- #83268 `[Bug]: Anthropic API key pasted via wizard is registered under provider claude (orphan), silently falling back to OAuth`.
- #72255 `[Bug]: Pi runtime silently uses orphaned credentials from per-agent auth-profiles.json after their declarations are removed from openclaw.json`.

Query: `gitcrawl --json search issues -R openclaw/openclaw "anthropic claude-cli auth login setup token"`

Results:

- #70279 `claude-cli backend silently skipped on systemd-managed root gateway, never spawns subprocess`.
- #72255 also appeared as an auth-store leak issue.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic usage status API key Claude"`

Results:

- #83268 repeated the orphaned provider registration issue.
- #80514 reported Claude Pro Max cap warning classification causing a false billing cooldown.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic API key no credentials profile"`

Results:

- Returned support threads for "No API key found for provider anthropic" where shell status and daemon runtime disagreed, setup-token paths were confused with API keys, auth profiles won over env vars, and profile order/cooldown affected fallback behavior.

Query: `discrawl search --limit 10 "Anthropic usage status Claude API key"`

Results:

- Returned discussions where users confused Claude account usage, Anthropic API-key billing, extra-usage errors, and active profile source in `openclaw models status`.
