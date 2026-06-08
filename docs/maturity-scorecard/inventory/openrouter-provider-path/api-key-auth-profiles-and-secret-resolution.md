---
title: "OpenRouter provider path - Credentials and Auth Profiles Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenRouter provider path - Credentials and Auth Profiles Maturity Note

## Summary

OpenRouter API-key auth is explicitly modeled through auth choices, `OPENROUTER_API_KEY`, `openrouter:default` auth profiles, status/probe output, and gateway auth-status methods. Coverage is Beta because the auth surfaces have broad unit and command evidence, but the release proof is fragmented across command, gateway, and runner paths. Quality is Alpha because GitHub and Discord archives show repeated real-user confusion around `401 Missing Authentication header`, env/profile mismatch, service environment inheritance, and provider-entry key selection.

## Category Scope

This category covers `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, provider API-key resolution, provider-entry secret handling, gateway environment behavior, and auth removal/status methods.

## Features

- OPENROUTER_API_KEY: Covers OPENROUTER_API_KEY across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Auth profiles and auth order: Covers Auth profiles and auth order across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Status/probe and removal: Covers Status/probe and removal across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Provider-entry SecretRef/API-key resolution: Covers Provider-entry SecretRef/API-key resolution across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.
- Gateway env inheritance: Covers Gateway env inheritance across `OPENROUTER_API_KEY` discovery, onboarding/auth-choice storage, `auth-profiles.json`, status/probe visibility, and related credentials and auth profiles behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Auth-choice tests cover OpenRouter API-key prompts, env reuse, profile writes, default model behavior, and existing-default preservation. Gateway status tests cover auth profile removal and OpenRouter env markers.
- Negative signals: Coverage is spread across generic provider-auth infrastructure and OpenRouter plugin metadata; there is not a single always-on integration test for auth profile creation, gateway restart, status/probe, and a real OpenRouter completion.
- Integration gaps: Add a gateway-level auth smoke that writes `openrouter:default`, restarts the gateway, probes `openrouter/auto`, and verifies the outgoing Authorization header path.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: The broad OpenRouter issue query returned #67423, where auth routing ignores a provider entry's `apiKey` field and resolves via canonical provider id, plus related setup/runtime reports.
- Discrawl reports: Discord search found April 2026 support reports where OpenClaw saw `OPENROUTER_API_KEY` and/or `openrouter:default`, but users still hit `401 Missing Authentication header` or needed to reason about whether the gateway service inherited shell env.
- Good qualities: Docs explain the canonical auth profile shape and `OPENROUTER_API_KEY`; command tests preserve existing defaults and avoid clobbering model config during reauth.
- Bad qualities: Real support reports show that status/probe output can prove profile visibility while the runtime request still fails, which is a high-friction operator experience.
- Excluded from quality: Auth test breadth and probe test coverage are Coverage inputs only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/openrouter-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for OPENROUTER_API_KEY, Auth profiles and auth order, Status/probe and removal, Provider-entry SecretRef/API-key resolution, Gateway env inheritance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operator docs still require users to understand shell env versus gateway process env when OpenRouter auth fails.
- Provider-entry API-key routing and auth-profile routing can diverge for split provider entries.
- Status/probe output can be technically correct but insufficient to prove the exact request path used by the failing run.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openrouter.md` documents `OPENROUTER_API_KEY`, `openclaw onboard --auth-choice openrouter-api-key`, and bearer-token semantics.
- `/Users/kevinlin/code/openclaw/docs/gateway/authentication.md` documents auth profiles, provider API keys, SecretRef constraints, `OPENROUTER_API_KEY`, legacy flat-profile migration, status/probe behavior, auth order, and auth removal.
- `/Users/kevinlin/code/openclaw/docs/help/environment.md` shows `OPENROUTER_API_KEY` in the environment variable examples.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md` explains that OpenRouter scan probes require an OpenRouter key from auth profiles or `OPENROUTER_API_KEY`.

### Source

- `/Users/kevinlin/code/openclaw/extensions/openrouter/index.ts` registers the OpenRouter API-key auth method with provider id `openrouter`, env var `OPENROUTER_API_KEY`, default model `openrouter/auto`, and expected provider `openrouter`.
- `/Users/kevinlin/code/openclaw/src/llm/env-api-keys.ts` maps provider id `openrouter` to `OPENROUTER_API_KEY`.
- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/*` implements auth-profile storage, ordering, state, and credential resolution used by OpenRouter.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/models-auth-status.ts` exposes gateway-side auth status and profile removal behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers command-level model list/status behavior that includes provider auth and OpenRouter-native refs.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.e2e.test.ts` verifies embedded OpenRouter runs enter model resolution with the expected provider/model.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/models-auth-status.test.ts` covers auth-profile removal and cache invalidation through gateway server methods.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/auth-choice.test.ts` verifies the OpenRouter auth choice, `OPENROUTER_API_KEY`, env reuse, `openrouter:default`, and default-model preservation behavior.
- `/Users/kevinlin/code/openclaw/src/agents/agent-auth-json.test.ts` covers `openrouter:default` API-key profile parsing and updates.
- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/usage.test.ts` covers OpenRouter profile usage state, including cooldown marker handling.
- `/Users/kevinlin/code/openclaw/src/secrets/provider-env-vars.test.ts` covers provider env-var registration including `OPENROUTER_API_KEY`.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "OPENROUTER_API_KEY auth profile openrouter No API key"`

Results:

- Returned no direct hits for the exact phrase.

Query: `gitcrawl --json search issues -R openclaw/openclaw "OpenRouter"`

Results:

- Returned #67423 on auth router/provider-entry key mismatch, #73496 in the setup/runtime cluster, and additional OpenRouter setup/runtime reports.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 10 "OPENROUTER_API_KEY auth profile"`

Results:

- Found April 2026 support reports showing `OPENROUTER_API_KEY` present in env and `openrouter:default` present in `auth-profiles.json`, while users still saw `401 Missing Authentication header`, empty OpenRouter turns, or needed to move the key into the gateway host environment.
- Found status/probe snippets where OpenRouter probes succeeded but default model state, env inheritance, or runtime replies remained confusing.
