---
title: "Automation: cron, hooks, tasks, polling - Event Ingress Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Event Ingress Maturity Note

## Summary

Channel ingress polling and webhook monitors are mature for high-traffic channels such as Telegram and Zalo, with detailed docs, startup behavior, lease/session handling, watchdogs, and tests. The quality ceiling is limited by the lived record: polling stall detection, webhook/polling mutual exclusion, schema drift, startup blocking, and network failures are frequent operational hazards.

## Category Scope

Included in this category:

- Telegram long polling: Covers Telegram long polling across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Telegram webhook mode: Covers Telegram webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Zalo polling/webhook mode: Covers Zalo polling/webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Polling stall diagnostics: Covers Polling stall diagnostics across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- iMessage watch fallback: Covers iMessage watch fallback across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Gmail setup wizard: Covers Gmail setup wizard across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Watcher start/serve: Covers Watcher start/serve across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Tailscale/public routing: Covers Tailscale/public routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Push token validation: Covers Push token validation across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Gmail event routing: Covers Gmail event routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- POST /hooks/wake: Covers POST /hooks/wake across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- POST /hooks/agent: Covers POST /hooks/agent across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Mapped hooks: Covers Mapped hooks across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Hook auth policy: Covers Hook auth policy across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Async dispatch: Covers Async dispatch across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.

## Features

- Telegram long polling: Covers Telegram long polling across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Telegram webhook mode: Covers Telegram webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Zalo polling/webhook mode: Covers Zalo polling/webhook mode across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Polling stall diagnostics: Covers Polling stall diagnostics across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- iMessage watch fallback: Covers iMessage watch fallback across channel-level long polling and webhook modes, especially Telegram and Zalo; polling liveness, leases, watchdog thresholds, and related channel polling and webhooks behavior.
- Gmail setup wizard: Covers Gmail setup wizard across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Watcher start/serve: Covers Watcher start/serve across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Tailscale/public routing: Covers Tailscale/public routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Push token validation: Covers Push token validation across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- Gmail event routing: Covers Gmail event routing across `openclaw webhooks gmail setup`, `hooks.gmail` config, `gog gmail watch start/serve`, watcher startup and renewal, and related gmail pub/sub watchers behavior.
- POST /hooks/wake: Covers POST /hooks/wake across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- POST /hooks/agent: Covers POST /hooks/agent across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Mapped hooks: Covers Mapped hooks across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Hook auth policy: Covers Hook auth policy across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.
- Async dispatch: Covers Async dispatch across `/hooks/wake`, `/hooks/agent`, mapped hooks under `/hooks/<name>`, token extraction, and related http webhooks behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Telegram and Zalo have focused coverage for polling status, transport state, liveness, leases, sessions, webhook status, webhook handlers, lifecycle, and polling media replies.
- Negative signals: Long polling depends on real network behavior, host sleep, proxy/DNS/TLS state, Telegram/Zalo API behavior, and gateway event-loop load. Local tests cannot cover every failure mode.
- Integration gaps: Add a network-fault harness for Telegram/Zalo monitors that simulates long-poll timeout, host sleep, active webhook conflict, schema config drift, and restart after event-loop stalls.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: PR #73884 fixes false Telegram polling-stall restarts; query fallback found issue #86535 where Telegram polling stall detector treats sleep as active `getUpdates` stall.
- Discrawl reports: Review comments on PRs #41153, #70579, and #57737 focus on polling stall watchdog thresholds and schema metadata drift; user reports mention startup sequentially blocking on first Telegram poll under event-loop load.
- Good qualities: Telegram has a configurable `pollingStallThresholdMs`, lease protection for one active poller per token, transport-dirty restart behavior, and docs for webhook vs long-polling. Zalo documents and tests polling/webhook mutual exclusion and media reply behavior.
- Bad qualities: Polling health is sensitive to event-loop stalls, sleep, schema drift, and network failures. The real-world bug record is active and channel-specific.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Telegram long polling, Telegram webhook mode, Zalo polling/webhook mode, Polling stall diagnostics, iMessage watch fallback, Gmail setup wizard, Watcher start/serve, Tailscale/public routing, Push token validation, Gmail event routing, POST /hooks/wake, POST /hooks/agent, Mapped hooks, Hook auth policy, Async dispatch.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Polling watchdogs should distinguish host sleep/event-loop pause from active API request stalls.
- Channel config schema generation must stay tied to runtime fields like `pollingStallThresholdMs`.
- Startup should avoid serial channel polling dependencies that can block the whole gateway under event-loop load.

## Evidence

### Docs

- `docs/channels/telegram.md` documents long polling as default, webhook mode, `pollingStallThresholdMs`, getUpdates conflicts, liveness troubleshooting, and doctor/status probes.
- `docs/channels/zalo.md` documents long-polling by default, webhook mode, and mutual exclusion between polling and webhook modes.
- `docs/channels/troubleshooting.md` includes polling stall diagnostics.
- `docs/channels/imessage-from-bluebubbles.md` notes iMessage watch behavior with a polling fallback.

### Source

- `extensions/telegram/src/monitor.ts`, `extensions/telegram/src/monitor-polling.runtime.ts`, `extensions/telegram/src/polling-liveness.ts`, `extensions/telegram/src/polling-lease.ts`, `extensions/telegram/src/polling-session.ts`, `extensions/telegram/src/polling-status.ts`, and `extensions/telegram/src/webhook-status.ts` implement Telegram polling/webhook monitoring.
- `extensions/zalo/src/monitor.ts`, `extensions/zalo/src/monitor.webhook.ts`, `extensions/zalo/src/monitor-durable.ts`, and `extensions/zalo/src/outbound-media.ts` implement Zalo polling/webhook behavior.
- `extensions/imessage/src/approval-reaction-poller.ts` implements an iMessage approval polling path.

### Integration tests

- `extensions/zalo/src/monitor.webhook-e2e.test.ts` covers Zalo webhook behavior.
- `extensions/zalo/src/monitor.polling.media-reply.test.ts` covers Zalo polling with media replies.
- Telegram monitor tests are mostly focused runtime tests rather than live API e2e.

### Unit tests

- `extensions/telegram/src/polling-status.test.ts`, `extensions/telegram/src/polling-transport-state.test.ts`, `extensions/telegram/src/polling-session.test.ts`, `extensions/telegram/src/polling-liveness.test.ts`, `extensions/telegram/src/polling-lease.test.ts`, and `extensions/telegram/src/webhook-status.test.ts` cover Telegram monitor pieces.
- `extensions/zalo/src/monitor.lifecycle.test.ts`, `extensions/zalo/src/monitor.webhook.test.ts`, `extensions/zalo/src/monitor.polling.media-reply.test.ts`, and `extensions/zalo/src/monitor.image.polling.test.ts` cover Zalo behavior.
- `extensions/imessage/src/approval-reaction-poller.test.ts` covers iMessage reaction polling.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "channel polling webhook getUpdates polling stall Zalo Telegram" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "pollingStallThresholdMs" --json --limit 5`

Results:

- PR #73884 fixes Telegram false polling-stall restarts.

Fallback query:

`gitcrawl search openclaw/openclaw --query "poll loop" --json --limit 5`

Results:

- Issue #86535 reports Telegram polling stall detector treating host sleep/event-loop pause as an active `getUpdates` stall.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "pollingStallThresholdMs"`

Results:

- PR #41153 closure says current main hardens Telegram polling-stall detection with a 120s default and configurable per-account override.
- PR #70579 review warns that schema validation drift could reject tuned `pollingStallThresholdMs` configs.
- PR #57737 review warns bundled schema metadata must be regenerated when adding `pollingStallThresholdMs`.

Fallback query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "poll loop"`

Results:

- Discord user report says Telegram account startup can block sequentially on first poll when event-loop load is high, causing timeouts and multi-minute stalls.
