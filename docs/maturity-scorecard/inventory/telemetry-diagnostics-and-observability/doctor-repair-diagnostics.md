---
title: "Observability - Doctor Repair Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Doctor Repair Diagnostics Maturity Note

## Summary

`openclaw doctor` is the broadest operator diagnostics surface: it explains health findings, migrations, repair policy, service state, gateway auth, plugin state, skills readiness, and structured lint output. The implementation has a clear health-check contract, but the surface is large enough that newly migrated checks and plugin-owned checks can still drift.

## Category Scope

- `openclaw doctor`, `openclaw doctor --fix`, `--repair`, `--yes`, `--non-interactive`, `--deep`, and `--lint`.
- Structured health checks, findings, repair results, check selection, JSON lint output, severity filtering, and exit behavior.
- Core doctor checks for gateway config, services, auth, state integrity, skills, plugins, sandbox, migrations, and provider route health.
- Plugin SDK doctor/health contracts.

## Features

- openclaw doctor: openclaw doctor, openclaw doctor --fix, --repair, --yes, --non-interactive, --deep, and --lint
- Structured health checks: Structured health checks, findings, repair results, check selection, JSON lint output, severity filtering, and exit behavior
- Core doctor checks: Core doctor checks for gateway config, services, auth, state integrity, skills, plugins, sandbox, migrations, and provider route health
- Plugin SDK doctor/health contracts: Plugin SDK doctor/health contracts behavior, status, and operator-visible verification.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: Doctor has dedicated docs, structured health-check source, many command tests, e2e doctor tests, and release/update scripts that run repair paths.
- Negative signals: The doctor surface is wide, and not every plugin-owned check has the same runtime-flow proof.
- Integration gaps: Structured `doctor --lint` is strong for core checks, while plugin package lifecycle and channel-specific doctor checks need recurring scenario proof.

## Quality Score

- Score: `Stable (81%)`
- Gitcrawl reports: Current reports are mostly active hardening and migration PRs, including configured plugin repair, health contribution ordering, and schema/metadata fuzz boundaries.
- Discrawl reports: The feature-specific Discord query returned no direct doctor-diagnostics hits, so archive silence is treated as neutral after freshness checks.
- Good qualities: The docs and source separate read-only diagnosis from repair mutation, expose stable check IDs, and support machine-readable lint output.
- Bad qualities: The breadth of checks means a new migration or plugin contract can be present in code but less obvious to operators until docs and repair hints catch up.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw doctor, Structured health checks, Core doctor checks, Plugin SDK doctor/health contracts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Plugin-owned checks do not yet read as uniformly documented as the core doctor checks.
- `doctor --fix --dry-run` and richer diff reporting are described as future-friendly by the structured contract but are not a complete operator workflow today.

## Evidence

### Docs

- `docs/cli/doctor.md` documents operator-facing doctor postures, structured lint mode, JSON findings, check selection, and structured health check fields.
- `docs/gateway/doctor.md` documents repair and migration behavior, core check groups, service and supervisor audits, and non-interactive modes.
- `docs/plugins/sdk-subpaths.md` lists `plugin-sdk/health` and `plugin-sdk/runtime-doctor` as doctor/health-check surfaces for plugin authors.

### Source

- `src/commands/doctor.ts`, `src/commands/doctor-lint.ts`, `src/flows/doctor-core-checks.ts`, `src/flows/health-checks.ts`, and `src/flows/doctor-repair-flow.ts` implement core doctor detection and repair flow.
- `src/plugin-sdk/health.ts` and `src/plugin-sdk/runtime-doctor.ts` expose SDK-facing health and doctor contracts.
- `src/channels/plugins/doctor-contract-api.ts` and channel plugin doctor contracts attach provider-specific diagnostics.

### Integration tests

- `src/flows/doctor-core-checks.e2e.test.ts` exercises core health checks through an e2e-style path.
- `src/commands/doctor.runs-legacy-state-migrations-yes-mode-without.e2e.test.ts` and `src/commands/doctor.warns-state-directory-is-missing.e2e.test.ts` exercise doctor command flows.
- `scripts/e2e/doctor-install-switch-docker.sh` and release-user-journey e2e scripts run doctor repair in install/update scenarios.

### Unit tests

- `src/commands/doctor-lint.test.ts`, `src/commands/doctor-config-flow.test.ts`, `src/commands/doctor-gateway-services.test.ts`, `src/commands/doctor-security.test.ts`, and many `src/commands/doctor/shared/*.test.ts` files cover focused checks and migrations.
- `src/flows/doctor-core-checks.test.ts`, `src/flows/doctor-health-contributions.test.ts`, and `src/flows/bundled-health-checks.test.ts` cover structured check behavior.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "openclaw doctor diagnostics repair health check" --limit 5`

Results:

- 5 hits. Relevant items include PR #77219 repairing configured plugins with broken runtime entries, PR #86627 preserving doctor health contribution order, PR #80455 suppressing stale `--fix` trailers, PR #86210 touching memory resolution/status diagnostics, and PR #87141 hardening plugin schema and metadata boundaries.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "openclaw doctor diagnostics repair health check"`

Results:

- 0 hits returned for the exact feature query.
