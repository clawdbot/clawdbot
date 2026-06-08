---
title: "OpenAI / Codex provider path - Doctor Diagnostics and Operator Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# OpenAI / Codex provider path - Doctor Diagnostics and Operator Repair Maturity Note

## Summary

Diagnostics and repair are heavily represented in docs and source, but they are also the main visible weakness of the OpenAI/Codex provider path. `openclaw doctor --fix`, `/status`, `models status`, `models auth list`, provider probes, OAuth sidecar repair, stale route/session pin cleanup, and auth-profile metadata protection all exist. Coverage is Beta because repair flows have real tests and docs but span many config/session stores. Quality is Alpha because recent GitHub and Discord evidence shows doctor/status can still leave users with provider/runtime mismatches or partially repaired OAuth state.

## Category Scope

This category covers operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.

## Features

- Doctor Diagnostics: Covers Doctor Diagnostics across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.
- Operator Repair: Covers Operator Repair across operator-facing repair and diagnosis for OpenAI/Codex provider path problems: stale route migration, persisted session pins, runtime pins, auth-profile sidecars, profile metadata, status/probe output, and recovery commands.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Repair docs name exact commands; doctor source scans config, models, sessions, auth profiles, stale sidecars, and runtime policy; tests cover specific repair cases.
- Negative signals: Repair spans config files, session stores, auth stores, plugin install state, and external Codex app-server/account state.
- Integration gaps: There is no single release proof that exercises stale `openai-codex/*` refs, stale runtime pins, sidecar OAuth shadows, and Codex app-server plugin repair in one upgrade scenario.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: Open issues #87436, #80628, #87650, #84252, and #84038 show doctor/status/update repair behavior is still active risk.
- Discrawl reports: 2026-05-17 discussion says direct OpenAI Responses selection for `openai/gpt-5.5` should trigger checks for session pins, auth-profile pins, and doctor planned repair; 2026-05-09 notes say doctor fixed stale whole-agent runtime pins but not a remaining OAuth-only route failure.
- Good qualities: Repair is explicit, source-owned, and mostly fail-closed; docs give concrete commands for checking model, runtime, auth route, and stale config.
- Bad qualities: Current repair output can still require maintainer interpretation across several state stores.
- Excluded from quality: Doctor and status test coverage was used only for Coverage.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/openai-codex-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Doctor Diagnostics, Operator Repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Doctor/status should report the exact effective provider, auth profile, runtime, and session pin source for the current turn.
- Upgrade repair needs more end-to-end fixture coverage for OAuth-only installs.
- Stale route repair should avoid silently rewriting intentionally protected routes.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/openai.md` documents `openclaw models status`, `models auth list`, `config get`, `doctor --fix`, `config validate`, and status indicator behavior for Codex runtime.
- `/Users/kevinlin/code/openclaw/docs/plugins/codex-harness.md` documents `/status`, `/codex status`, `/codex models`, `/new`, `/reset`, and troubleshooting entry points.
- `/Users/kevinlin/code/openclaw/docs/automation/auth-monitoring.md` documents auth monitoring and repair surfaces.

### Source

- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/codex-route-warnings.ts` detects and repairs legacy model refs, stale runtime pins, unsupported Codex compaction overrides, and persisted session route state.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/stale-oauth-profile-shadows.ts` scans and repairs stale OAuth profile shadow stores.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-auth-profile-config.ts` protects active auth profile metadata during config repair.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.status-command.ts` and `src/commands/models/list.auth-overview.ts` back model status and auth overview output.
- `/Users/kevinlin/code/openclaw/src/commands/provider-auth-guidance.ts` provides provider auth guidance.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers model list/status behavior and provider catalog availability.
- `/Users/kevinlin/code/openclaw/src/commands/onboard-non-interactive.gateway-health-auth.test.ts` covers auth-related onboarding/gateway health behavior.
- `/Users/kevinlin/code/openclaw/src/commands/configure.gateway-auth.test.ts` covers gateway auth configuration behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/codex-route-warnings.test.ts` covers Codex route repair behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor/shared/stale-oauth-profile-shadows.test.ts` covers stale OAuth profile shadow detection/repair.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-auth.profile-health.test.ts` covers auth profile health handling.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.status.test.ts` covers status command output.
- `/Users/kevinlin/code/openclaw/src/commands/models/auth-list.test.ts` covers auth list behavior.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned open issues #87436, #80628, #84637, #87650, #84200, #84038, #83223, #84252, and #81213, including route recreation after doctor, protected-route drift, runtime/model confusion, provider/runtime mismatch after update, and partial OAuth sidecar repair.

Query: `gitcrawl --json search prs -R openclaw/openclaw "openai-codex doctor route auth profile Codex harness"`

Results:

- Returned PR #81700, `fix(auth): drop stale Codex OAuth routing`.

### Discrawl queries

Query: `discrawl search --limit 10 "openai gpt-5.5 codex runtime openai/gpt openai-codex route doctor"`

Results:

- Returned 2026-05-17 diagnostic guidance to check `/status`, persisted session route state, `providerOverride/modelOverride`, `agentHarnessId`, `agentRuntimeOverride`, CLI binding, auth-profile pins, and doctor repair when `openai/gpt-5.5` unexpectedly routes to direct OpenAI Responses.
- Returned 2026-05-09 note that doctor fixed stale whole-agent runtime pins but an OAuth-only migrated `openai/gpt-5.5` route still failed through direct OpenAI API-key auth.

Query: `discrawl search --limit 10 "openai-codex oauth auth order usage limit profile"`

Results:

- Returned discussions where `models status --json`, profile ids, auth order, and cooldown/disabled state were required to diagnose rate/usage-limit failures.
