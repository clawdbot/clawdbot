---
title: "Observability - Channel Health Monitor Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Observability - Channel Health Monitor Maturity Note

## Summary

The channel health monitor gives operators automatic restart behavior for stale, disconnected, stopped, and stuck channel runtimes. It has strong policy logic, rate limits, cooldowns, and per-account overrides, but lived archive evidence shows this area is still a frequent source of channel-specific confusion and repair requests.

## Category Scope

- Background health-monitor loop for configured channel accounts.
- Per-account enable/disable settings.
- Startup grace, connect grace, stale transport activity detection, busy/stuck handling, restart cooldowns, and max restarts per hour.
- Restart logging and runtime snapshot evaluation.
- Adjacent but out of scope: manual `channels.start` / `channels.stop` / `channels.restart` proposals, which are not yet the same feature.

## Features

- Background health-monitor loop: Background health-monitor loop for configured channel accounts
- Per-account enable/disable settings: Per-account enable/disable settings behavior, status, and operator-visible verification.
- Startup grace: Startup grace, connect grace, stale transport activity detection, busy/stuck handling, restart cooldowns, and max restarts per hour
- Restart logging: Restart logging and runtime snapshot evaluation

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: The monitor and policy have focused tests for grace windows, stale sockets, stuck busy channels, disabled accounts, manual stops, cooldowns, and hourly caps.
- Negative signals: Live proof varies by upstream channel and is not equally represented across every provider that exposes health monitor settings.
- Integration gaps: The archive shows real Discord, Telegram, WhatsApp, Weixin, and Feishu degradation scenarios that need recurring release smoke proof.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Multiple live issues and PRs cluster around channel health state, stuck/disconnected restarts, and operator requests for manual channel recovery.
- Discrawl reports: Support threads show health-monitor restarts can be helpful but also hard to interpret when a gateway stays up while one channel/account is degraded.
- Good qualities: The implementation uses provider-neutral policy, explicit transport-activity timestamps, single-flight checks, cooldowns, and restart caps.
- Bad qualities: Health-monitor behavior still surfaces as a support topic because channel runtimes can be noisy, upstream-specific, and hard to repair without full gateway restart.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow proof are counted only under Coverage, not Quality.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telemetry-diagnostics-and-observability.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Background health-monitor loop, Per-account enable/disable settings, Startup grace, Restart logging.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Operators still lack a fully documented manual channel restart workflow for wedged accounts.
- Some older builds lacked per-channel monitor config keys, which appears in the Discord archive as schema-validation friction.

## Evidence

### Docs

- `docs/gateway/health.md` documents `gateway.channelHealthCheckMinutes`, `gateway.channelStaleEventThresholdMinutes`, `gateway.channelMaxRestartsPerHour`, and provider/account monitor overrides.
- Channel docs such as `docs/channels/telegram.md` and `docs/channels/discord.md` describe polling stalls, runtime READY timeouts, and monitor-driven restarts.

### Source

- `src/gateway/channel-health-monitor.ts` implements the background loop, account iteration, restart cooldown, hourly cap, restart logging, and stop/start calls.
- `src/gateway/channel-health-policy.ts` implements managed-account checks, busy/stuck classification, startup grace, disconnected state, stale transport activity, and restart reason mapping.
- `src/gateway/server-channels.ts` wires monitor enablement and account resolution into channel runtime snapshots.
- `src/config/types.gateway.ts` and channel config schemas expose monitor timing and per-provider settings.

### Integration tests

- `src/gateway/server-reload-handlers.ts` and related tests cover restart of the health monitor when config reload changes monitored fields.
- Live channel e2e scripts such as `scripts/e2e/npm-telegram-live-docker.sh` and release-user-journey scripts run doctor and channel flows that can surface monitor regressions.

### Unit tests

- `src/gateway/channel-health-monitor.test.ts` covers restart, skip, grace, cap, cooldown, stale socket, and stop behavior.
- `src/gateway/channel-health-policy.test.ts` covers evaluation reasons and restart reason mapping.
- `src/config/schema.test.ts` includes gateway channel health config schema entries.

### Gitcrawl queries

Query:

`gitcrawl search --json openclaw/openclaw --query "gateway health status probe channel health monitor" --limit 5`

Results:

- 5 hits. Relevant signals include PR #80805 restoring channel responsiveness health, issue #75153 requesting manual channel recovery after health-monitor restarts, issue #79304 on Weixin runtime initialization timeouts, and PR #76701 suppressing Feishu bot-ping timeout noise.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "gateway health status probe channel health monitor"`

Results:

- 5 hits. Discord archive examples include `health-monitor: restarting (reason: stuck)`, `health-monitor: restarting (reason: disconnected)`, `Polling stall detected`, and older-build schema failures for `channels.telegram.healthMonitor.enabled` and `channels.discord.healthMonitor.enabled`.
