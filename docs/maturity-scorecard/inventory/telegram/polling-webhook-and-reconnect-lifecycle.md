---
title: "Telegram - Runtime Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Runtime Lifecycle Maturity Note

## Summary

Telegram runtime lifecycle is a real Beta component. Long polling is the default,
webhook mode is documented and implemented, and the runtime now includes leases,
offset persistence, isolated ingress, watchdog liveness, network fallback, and
status issues. The component remains below Stable because archive evidence shows
recent regressions around polling stalls, IPv6/transport behavior, and host
specific recovery.

## Category Scope

Included in this category:

- Long polling runner startup: Long polling runner startup, duplicate-poller protection, update offsets, and account lifecycle.
- Webhook listener startup: Webhook listener startup, secret validation, async event dispatch, and local
- Reconnect: Reconnect, recoverable network errors, stalled getUpdates, timeout clamps, and recovery handling.
- Restart: Restart and recovery behavior after token rotation, process aborts, and account reloads.

## Features

- Long polling runner startup: Long polling runner startup, duplicate-poller protection, update offsets, and account lifecycle.
- Webhook listener startup: Webhook listener startup, secret validation, async event dispatch, and local
- Reconnect: Reconnect, recoverable network errors, stalled getUpdates, timeout clamps, and recovery handling.
- Restart: Restart and recovery behavior after token rotation, process aborts, and account reloads.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals:
  polling, webhook, timeout, lease, liveness, status, network, and gateway
  startup paths have focused tests, and package/live harnesses exercise real
  Telegram Bot API round trips.
- Negative signals:
  recurring live proof is concentrated on group mention replies and command
  paths, not the full restart matrix across hosts, webhook ingress, proxy
  environments, and token rotation.
- Integration gaps:
  add release proof for webhook mode, active webhook conflict recovery, IPv6
  fallback, WSL2/VPS network behavior, and stalled long-poll recovery.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  polling and network lifecycle remains active: #86535, #86541, #73884, #75498,
  #73602, and #86031.
- Discrawl reports:
  users reported long-poll crashes after 20-30 minutes, maintainers tied those
  reports to Telegram polling and channel stability release work, and release
  notes repeatedly call out Telegram inbox/recovery hardening.
- Good qualities:
  the runtime persists offsets only after dispatch, refuses duplicate pollers,
  rebuilds dirty transports, scopes network recovery to polling errors, and
  surfaces stale polling status.
- Bad qualities:
  host networking, proxy behavior, sleep gaps, and Bot API transport behavior
  still create operator-facing instability and support load.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Long polling runner startup, Webhook listener startup, Reconnect, Restart.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live webhook proof and conflict recovery proof next to the long-poll proof.
- Record host-class release smoke for VPS, WSL2, IPv6-first networks, and
  proxied Telegram Bot API egress.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents long
  polling defaults, webhook mode, offset persistence, polling stall thresholds,
  timeout clamps, proxy/DNS controls, and troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/channels/troubleshooting.md` is linked for
  cross-channel diagnostics.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/monitor.ts` selects
  webhook or polling mode, registers approval runtime context, acquires polling
  leases, persists offsets, and restarts after recoverable network failures.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/monitor-polling.runtime.ts`
  owns the polling session and watchdog.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/monitor-webhook.runtime.ts`
  owns webhook startup and dispatch.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/polling-lease.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/polling-status.ts`,
  and `/Users/kevinlin/code/openclaw/extensions/telegram/src/status-issues.ts`
  implement lease and operator-status surfaces.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/fetch.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/network-errors.ts`
  implement transport, proxy, DNS, and recoverable-error policy.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-driver.mjs`
  checks Bot API `getMe`, `sendMessage`, and `getUpdates` against real Telegram
  credentials.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-live-runner.ts`
  runs package-installed Telegram live scenarios.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  defines live canary, command, mention, reply, and streaming scenarios.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/monitor.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/polling-session.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/polling-liveness.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/polling-lease.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/webhook.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/webhook-status.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/request-timeouts.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "polling stall" --json`

Results:

- #86535 issue open: polling stall detector treats sleep as active
  `getUpdates` stall.
- #86541 PR open: ignore polling sleep gaps.
- #73884 PR open: avoid false polling stall restarts.
- #75498 issue open: Telegram Web UI-only replies, partial streaming, polling
  stall, and session pollution after upgrade.
- #73602 issue open: WhatsApp flaps and Telegram polling stalls on WSL2.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram polling stall"`

Results:

- `users-helping-users`, 2026-05-12: Telegram long polling stopped responding
  repeatedly after 20-30 minutes on a VPS.
- `maintainers`, 2026-05-12: maintainers linked several Telegram setup reports
  to issue #78473.
- `releases`, 2026-05-14: release notes called out isolated worker, durable
  local spool, and `getUpdates`-based stall detection.
