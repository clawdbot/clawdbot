---
title: "Observability - Health and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Health and Repair Maturity Note

## Summary

The health and status probe surface is a mature operator entry point for checking gateway reachability, per-channel state, account state, agent availability, session-store summaries, model-pricing health, and event-loop health. The main gap is not the probe contract itself, but recurring operator reports where a channel appears healthy while a specific account or delivery path is degraded.

## Category Scope

Included in this category:

- Background health-monitor loop: Background health-monitor loop for configured channel accounts
- Per-account enable/disable settings: Per-account enable/disable settings behavior, status, and operator-visible verification.
- Startup grace: Startup grace, connect grace, stale transport activity detection, busy/stuck handling, restart cooldowns, and max restarts per hour
- Restart logging: Restart logging and runtime snapshot evaluation
- openclaw doctor: openclaw doctor, openclaw doctor --fix, --repair, --yes, --non-interactive, --deep, and --lint
- Structured health checks: Structured health checks, findings, repair results, check selection, JSON lint output, severity filtering, and exit behavior
- Core doctor checks: Core doctor checks for gateway config, services, auth, state integrity, skills, plugins, sandbox, migrations, and provider route health
- Plugin SDK doctor/health contracts: Plugin SDK doctor/health contracts behavior, status, and operator-visible verification.
- openclaw status: openclaw status, openclaw status --all, and openclaw status --deep
- openclaw health: openclaw health, openclaw health --verbose, and openclaw health --json
- Gateway RPC health: Gateway RPC health and status
- Cached health snapshots: Cached health snapshots, live probe refresh, sensitive fields gated by operator admin scope, and event-loop health attachment

## Features

- Background health-monitor loop: Background health-monitor loop for configured channel accounts
- Per-account enable/disable settings: Per-account enable/disable settings behavior, status, and operator-visible verification.
- Startup grace: Startup grace, connect grace, stale transport activity detection, busy/stuck handling, restart cooldowns, and max restarts per hour
- Restart logging: Restart logging and runtime snapshot evaluation
- openclaw doctor: openclaw doctor, openclaw doctor --fix, --repair, --yes, --non-interactive, --deep, and --lint
- Structured health checks: Structured health checks, findings, repair results, check selection, JSON lint output, severity filtering, and exit behavior
- Core doctor checks: Core doctor checks for gateway config, services, auth, state integrity, skills, plugins, sandbox, migrations, and provider route health
- Plugin SDK doctor/health contracts: Plugin SDK doctor/health contracts behavior, status, and operator-visible verification.
- openclaw status: openclaw status, openclaw status --all, and openclaw status --deep
- openclaw health: openclaw health, openclaw health --verbose, and openclaw health --json
- Gateway RPC health: Gateway RPC health and status
- Cached health snapshots: Cached health snapshots, live probe refresh, sensitive fields gated by operator admin scope, and event-loop health attachment

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Health and status are exposed in docs, CLI, gateway RPC, Control UI-facing RPC methods, and server/auth suites; live probe and cached-probe paths are both exercised.
- Negative signals: Real-environment proof is strongest for core gateway status and weaker for per-provider account probes across every channel.
- Integration gaps: Operator workflows still rely on per-channel follow-up commands when a channel runtime is partially degraded despite a healthy gateway process.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: Open health/status reports show channel-account mismatch and runtime degradation cases rather than a broken health API.
- Discrawl reports: Discord archive reports repeatedly recommend `openclaw status --all`, `openclaw gateway status`, and `openclaw channels status --probe` for channel instability triage.
- Good qualities: The source separates cached snapshots from live probes, hides sensitive fields unless the caller has admin scope, and attaches event-loop health where available.
- Bad qualities: The probe vocabulary still leaves room for operator confusion when a gateway is reachable but a specific channel/account is stalled or desynced.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Background health-monitor loop, Per-account enable/disable settings, Startup grace, Restart logging, openclaw doctor, Structured health checks, Core doctor checks, Plugin SDK doctor/health contracts, openclaw status, openclaw health, Gateway RPC health, Cached health snapshots.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Cross-channel health semantics are not equally rich for every provider.
- The status wording could better distinguish gateway reachability from account-level delivery health.

## Evidence

### Docs

- `docs/gateway/health.md` documents quick checks, deep diagnostics, health monitor config, failure handling, and dedicated `openclaw health` output.
- `docs/cli/health.md` documents `openclaw health` flags and the cached versus live probe behavior.
- `docs/gateway/protocol.md` documents `health` and related system/status RPC methods.

### Source

- `src/gateway/server-methods/health.ts` implements RPC `health` and `status`, cached snapshot refresh, runtime-diff detection, model-pricing health merge, and sensitive-field scope checks.
- `src/commands/health.ts`, `src/commands/health-format.ts`, and `src/commands/status.ts` provide CLI-facing health/status formatting and probing.
- `src/gateway/server-methods/channels.ts` contributes per-channel status and event-loop health details to the operator surface.

### Integration tests

- `src/gateway/server.auth.control-ui.suite.ts` exercises authenticated status and health access through the gateway server.
- `src/gateway/server.roles-allowlist-update.test.ts` exercises node/client health calls through the gateway path.
- `scripts/e2e/kitchen-sink-rpc-walk.mjs` includes gateway RPC walk coverage for operator-facing diagnostics methods.

### Unit tests

- `src/gateway/server-methods/server-methods.test.ts` exercises health cache refresh, live probes, event-loop handling, and `logs.tail` adjacent RPC behavior.
- `src/commands/health.test.ts` exercises health snapshot behavior and formatting.
- `src/commands/health.snapshot.test.ts` keeps health snapshot rendering stable.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "gateway health status probe channel health monitor" --limit 5`

Results:

- 5 hits. The most relevant open items were PR #80805 `SUP-1563 restore channel responsiveness health`, issue #75153 requesting channel start/stop/restart CLI recovery, issue #79304 on Weixin runtime race after gateway restart, PR #76701 on Feishu startup timeout noise, and PR #78186 using `openclaw health` as gateway responsiveness proof.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "gateway health status probe channel health monitor"`

Results:

- 5 hits. The archive included Discord and Telegram runtime instability threads where support asks operators for `openclaw --version`, `openclaw status --all`, `openclaw gateway status`, and `openclaw channels status --probe`; one thread reports a gateway process that remains healthy while Telegram and Discord channel runtimes restart or disconnect.
