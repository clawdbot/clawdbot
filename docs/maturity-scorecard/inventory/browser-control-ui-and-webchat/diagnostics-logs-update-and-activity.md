---
title: "Gateway Web App - Operator Console Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Operator Console Maturity Note

## Summary

Control UI exposes operational diagnostics through health/status/debug snapshots, event logs, gateway log tail, update actions/status, model status, usage, activity summaries, and performance/long-task browser entries. Coverage is Beta because many controllers and Gateway RPCs are tested, but full operator runbooks through the browser are less complete than CLI diagnostics. Quality is Beta because the UI surfaces useful state, while archive traffic shows operators still often need support to interpret gateway health, hosted access, active runs, and panel state.

## Category Scope

Included in this category:

- Health/status/models: Covers Health/status/models across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Live log tail: Covers Live log tail across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Update run/status: Covers Update run/status across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Activity summaries: Covers Activity summaries across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- RPC timing telemetry: Covers RPC timing telemetry across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Channels/login: Covers Channels/login across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Session manager and history: Covers browser Control UI session manager, session history, instance presence, approvals, diagnostics, and log tabs.
- Cron: Covers Cron across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Skills/nodes: Covers Skills/nodes across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Exec approvals/agents: Covers Exec approvals/agents across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.

## Features

- Health/status/models: Covers Health/status/models across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Live log tail: Covers Live log tail across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Update run/status: Covers Update run/status across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Activity summaries: Covers Activity summaries across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- RPC timing telemetry: Covers RPC timing telemetry across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Channels/login: Covers Channels/login across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Session manager and history: Covers browser Control UI session manager, session history, instance presence, approvals, diagnostics, and log tabs.
- Cron: Covers Cron across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Skills/nodes: Covers Skills/nodes across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Exec approvals/agents: Covers Exec approvals/agents across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Gateway tests cover health/status/log/update methods; UI controller/view tests cover logs, usage, debug, activity, overview, provider quota, and performance helpers.
- Negative signals: Browser diagnostic flows are mostly tested as individual controllers/views. Full "something is wrong, use the UI to diagnose and update" scenarios are less mature than CLI doctor/log/status workflows.
- Integration gaps: Add browser scenario proof for stuck run diagnosis, live log tail, channel health confusion, update run/reconnect/status, usage scoping, and activity clear/export behavior.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Specific logs/health/update query returned `[]`; broad Control UI PRs returned #84290 for UI freshness health findings, #80192 for safe native Codex activity in Control UI, #87147 for usage page scoping, and #73836 for responsiveness regression.
- Discrawl reports: Discord search found support where operators were told to use `status`, `health`, `logs`, and the Control UI to distinguish hosted auth, gateway health, and agent state.
- Good qualities: Logs are stripped and parsed defensively, activity hides arguments and stores only sanitized previews, channel probes retain previous snapshots under timeout, and update status banners include actionable reasons.
- Bad qualities: Diagnostics are spread across several tabs, and operator-facing "what should I look at first" guidance in the browser is still weaker than command-line runbooks.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Health/status/models, Live log tail, Update run/status, Activity summaries, RPC timing telemetry, Channels/login, Session manager and history, Cron, Skills/nodes, Exec approvals/agents.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Control UI needs a tighter diagnostic path from "chat is stuck" to session state, activity, logs, health, and recovery.
- Update flows need stronger proof for restart/reconnect/status banners in package-installed gateways.
- Activity is intentionally ephemeral and browser-local, so it does not replace durable diagnostics.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents Debug, Logs, Update, event log, RPC timings, slow chat/config render timings, browser responsiveness entries, and Activity tab privacy behavior.
- `/Users/kevinlin/code/openclaw/docs/gateway/health.md`, `/Users/kevinlin/code/openclaw/docs/gateway/diagnostics.md`, and `/Users/kevinlin/code/openclaw/docs/gateway/logging.md` document the underlying Gateway diagnostic capabilities.

### Source

- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/logs.ts` loads and parses `logs.tail`.
- `/Users/kevinlin/code/openclaw/ui/src/ui/views/activity.ts` renders browser-local tool activity with hidden arguments and truncated previews.
- `/Users/kevinlin/code/openclaw/ui/src/ui/activity-model.ts` builds activity entries from tool events.
- `/Users/kevinlin/code/openclaw/ui/src/ui/control-ui-performance.ts` tracks browser responsiveness and render timing entries.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/health.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/debug.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/usage.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/provider-quota-summary.ts` back diagnostic views.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/logs.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/health.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update.ts` expose the Gateway methods.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.health.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/usage.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/diagnostics.test.ts` cover Gateway diagnostic methods.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-stability.test.ts` covers stability diagnostics.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/logs.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/usage.node.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/debug.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/usage.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/views/activity.test.ts`, `/Users/kevinlin/code/openclaw/ui/src/ui/control-ui-performance.test.ts`, and `/Users/kevinlin/code/openclaw/ui/src/ui/usage-cache-status.test.ts` cover UI diagnostics.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI logs health update debug activity"`

Results:

- Returned `[]`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "Control UI"`

Results:

- Returned diagnostic-adjacent PRs #84290, #80192, #87147, #73894, and #80670.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI logs health update debug activity"`

Results:

- Found support guidance that treats Gateway WebSocket as the source of truth for chat, sessions, cron, channels, debug, models, logs, and live events.
- Found setup triage examples asking users to run status, health, and logs to distinguish gateway health from channel/setup issues.
