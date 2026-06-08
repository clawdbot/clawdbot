---
title: "Security, auth, pairing, and secrets - Provider Auth Profiles and API Key Health Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Provider Auth Profiles and API Key Health Maturity Note

## Summary

OpenClaw exposes a mature provider-auth surface across OAuth, API keys, auth profiles, auth order, probes, status, and doctor repair. Coverage is Beta because many provider-auth flows are tested, including e2e credential rotation, but the complete operator journey across login, status, compaction, subagents, and provider-specific fallbacks is still fragmented. Quality is Alpha because current GitHub and Discord archives show many active `openai-codex` OAuth/API-key routing failures and confusing status/doctor repair behavior.

## Category Scope

This category covers provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, model status/probe output, provider fallback, credential removal, subagent credential propagation, and user-facing missing-key repair guidance.

## Features

- Provider Auth Profiles: Covers Provider Auth Profiles across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.
- API Key Health: Covers API Key Health across provider credentials and auth health as a security/secrets surface: API keys, OAuth profiles, `auth-profiles.json`, auth order, and related provider auth profiles and api key health behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Provider auth docs are extensive; auth profile runtime, OAuth refresh, auth order, profile state, auth choice, status/probe, and credential rotation have broad tests.
- Negative signals: Coverage is spread across provider-specific and runtime-specific files. OpenAI/Codex OAuth has strong attention, but cross-provider release proof is uneven and long-tail provider auth metadata depends on plugin manifests.
- Integration gaps: Add a release scenario matrix for login, paste-key, OAuth refresh, status/probe, compaction, subagents, credential removal, and provider fallback across OpenAI/Codex, Anthropic, Google, OpenRouter, and at least one plugin provider.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: The exact issue query returned many active auth-profile failures, including #84252, #87677, #85797, #86820, #75739, #86470, #76690, #87051, #83223, and related runtime parity tracking.
- Discrawl reports: Discord search found repeated user reports where Codex OAuth appears valid but runtime still fails with `No API key found`, status/probe gives contradictory output, compaction loses OAuth routing, and users need manual profile/config repair.
- Good qualities: The docs distinguish gateway auth from provider auth, define the canonical credential store shape, document SecretRef constraints, provide probe/status checks, and explain provider-auth removal behavior.
- Bad qualities: Active reports show route naming, auth order, subagent propagation, compaction, and image-generation path drift still break real users in confusing ways.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider Auth Profiles, API Key Health.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Codex OAuth route repair and provider alias migration still produce active issues.
- Auth profile state can be lost or misinterpreted in subagents, compaction, and provider-specific capability paths.
- Status and probe output can be technically precise but still confusing when metadata and runtime credential paths disagree.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/authentication.md` documents provider API keys, OAuth, `auth-profiles.json`, SecretRef constraints, status/probe behavior, auth order, session pinning, and auth removal.
- `/Users/kevinlin/code/openclaw/docs/cli/models.md` documents model auth and status flows.
- `/Users/kevinlin/code/openclaw/docs/providers/openai.md`, `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md`, and `/Users/kevinlin/code/openclaw/docs/providers/google.md` document representative provider setup.
- `/Users/kevinlin/code/openclaw/docs/concepts/oauth.md` documents OAuth storage and flow semantics.

### Source

- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles.runtime.ts` and `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/*` implement auth profile storage, OAuth refresh, ordering, state, and credential resolution.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-auth-profile.ts` and `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.ts` carry selected auth profile state into runtime execution.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.status.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/models-auth-status.ts` expose auth status through CLI and Gateway methods.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-auth-profile-config.ts` repairs legacy or stale auth profile config.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-runner.run-embedded-agent.auth-profile-rotation.e2e.test.ts` covers auth-profile rotation in embedded agent runs.
- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers model list/status presentation through CLI flows.
- `/Users/kevinlin/code/openclaw/src/auto-reply/reply/agent-runner-execution.test.ts` covers missing-key guidance, stale `openai-codex` failures, retries, and auth-profile fallback state.
- `/Users/kevinlin/code/openclaw/extensions/codex/src/app-server/auth-profile-runtime-contract.test.ts` covers Codex app-server auth-profile contracts.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/auth-profiles/*.test.ts` covers OAuth refresh, ordering, session overrides, state observation, portability, and profile store behavior.
- `/Users/kevinlin/code/openclaw/src/commands/models.auth.provider-resolution.test.ts` covers provider auth resolution for model commands.
- `/Users/kevinlin/code/openclaw/src/commands/auth-choice.apply.api-providers.test.ts` covers provider auth choice mapping.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/models-auth-status.test.ts` covers Gateway auth-status methods.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "No API key found openai-codex auth profile OAuth"`

Results:

- Returned active issues #84252, #87677, #85797, #86820, #75739, #86470, #76690, #87051, #84110, #77467, #59405, #86567, #83223, and #80171.
- The results cluster around Codex OAuth repair, memory embeddings, image generation, compaction fallback, auth profile propagation to subagents, migrated route lookup, and runtime parity.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "No API key found openai-codex auth profile OAuth"`

Results:

- Found April 2026 support reports where users completed OAuth onboarding but agent runs still failed with `No API key found`, status/probe displayed contradictory auth state, and maintainers identified release regressions around `openai-codex` provider auth.
- Found older setup guidance requiring explicit `openai-codex:default` auth profile metadata and login.
