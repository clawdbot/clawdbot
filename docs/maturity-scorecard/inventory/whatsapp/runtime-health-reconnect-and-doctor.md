---
title: "WhatsApp - Runtime Health Reconnect and Doctor Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Runtime Health Reconnect and Doctor Maturity Note

## Summary

WhatsApp runtime health, reconnect, and doctor behavior are Beta. The source has
a real connection controller with auth-state snapshots, reconnect backoff,
heartbeat/watchdog logic, stale transport/app silence detection, status issues,
shutdown, and doctor responsiveness checks. Quality remains Beta because archive
evidence still shows stale-socket, reconnect storm, and Baileys session
volatility in current operator workflows.

## Category Scope

- Baileys socket lifecycle, connection controller state, reconnect decisions,
  heartbeat and watchdog policy, status adapter, active listener activity,
  Gateway restart behavior, and doctor responsiveness checks.
- Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime
  caveats, and no-active-listener/provider-accepted states.
- Out of scope: first-time QR login itself and message feature semantics after a
  healthy listener exists.

## Features

- Baileys socket lifecycle: Baileys socket lifecycle, connection controller state, reconnect decisions, and repair status.
- Operator troubleshooting: Operator troubleshooting for reconnect loops, stale sockets, Bun/Node runtime

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs describe reconnect behavior and troubleshooting; source
  centralizes controller state, reconnect decisions, heartbeat/watchdog, active
  listener activity, shutdown, auth status, and doctor status issues; runtime
  tests cover reconnect and watchdog behavior.
- Negative signals: current archive evidence includes event-loop blocking,
  reconnect storms, stale sockets, and WSL2/timeout flaps.
- Integration gaps: no located live scenario continuously proves stale socket
  detection, app-silence restart, transport-silence restart, Gateway restart,
  doctor responsiveness, and operator recovery in one lane.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `whatsapp reconnect watchdog Baileys gateway restart`
  surfaced #78165 for `channels.whatsapp.start-account` blocking the event loop
  and triggering reconnect storms, plus #73602 for WSL2 Baileys 405/timeout
  reconnect flaps.
- Discrawl reports: the same query returned stale-socket discussion where a
  30-minute watchdog emits status 499 and stale-socket logic can restart even if
  the socket is healthy, with workaround `gateway.channelHealthCheckMinutes: 0`.
- Good qualities: reconnect policy is explicit, heartbeat thresholds are
  clamped, status snapshots distinguish auth and controller state, active
  listener activity is tracked, and doctor docs connect stale sockets to
  operator actions.
- Bad qualities: the runtime sits on WhatsApp Web and Baileys behavior outside
  OpenClaw control, and stale-socket heuristics can be noisy on slow hosts,
  WSL2, or hosts with event-loop stalls.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Baileys socket lifecycle, Operator troubleshooting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add long-running live health proof for stale sockets, Gateway restarts,
  heartbeat restarts, and doctor output.
- Reduce false positives in stale-socket heuristics or make health-check tuning
  easier for constrained hosts.
- Separate Baileys provider errors, host event-loop stalls, and Gateway listener
  failures in operator-facing diagnostics.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:155` documents the Gateway-owned socket, reconnect loop, active listener requirement, and proxy behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:592` documents troubleshooting for reconnect loops, QR proxy, no active listener, provider acceptance, group ignored, and Bun warnings.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:149` documents legacy WhatsApp auth migration warnings.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:173` and `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:354` document WhatsApp responsiveness checks.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:553` documents Node versus Bun/version-manager warnings.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/session.ts:132` creates the Baileys socket, auth store, fetches version, handles proxy agent, QR, connection update, and logout state.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/session.ts:313` waits for connection.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/connection-controller.ts:189` handles login wait, 515 restart, and logged-out clearing.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/connection-controller.ts:262` maintains controller state and reconnect snapshots.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/connection-controller.ts:487` decides reconnect and backoff behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/connection-controller.ts:607` implements heartbeat and watchdog checks for transport and app silence.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/reconnect.ts:14` defines default heartbeat and reconnect policy.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/status-issues.ts:1` exposes WhatsApp status issues.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/doctor.ts:1` implements WhatsApp doctor checks.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:147` covers reconnect behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:522` covers watchdog and quiet/transport/app silence behavior.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:489` waits for channel running and stable state.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:1192` runs live QA with credential lease, auth archive unpack, driver retry, and artifacts.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/connection-controller.test.ts:47` covers connection controller state, auth barrier, snapshots, transport activity, and stall behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/reconnect.test.ts:1` covers reconnect policy.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/status-issues.test.ts:1` covers status issue behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/doctor.test.ts:1` covers doctor behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-whatsapp-responsiveness.test.ts:19` covers doctor responsiveness checks and local TUI process behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp reconnect watchdog Baileys gateway restart" --json`

Results:

- Surfaced #78165 where `channels.whatsapp.start-account` blocks the event loop for about 40 seconds and triggers a reconnect storm.
- Surfaced #73602 where WhatsApp flaps and Telegram polling stalls on WSL2 with Baileys 405/timeout reconnects.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp reconnect watchdog Baileys gateway restart" --limit 5`

Results:

- Returned stale-socket discussion where a 30-minute watchdog emits status 499 and stale-socket logic can restart even if the socket is healthy; workaround noted as `gateway.channelHealthCheckMinutes: 0`.
