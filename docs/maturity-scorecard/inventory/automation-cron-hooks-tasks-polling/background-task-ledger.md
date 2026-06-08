---
title: "Automation: cron, hooks, tasks, polling - Background Tasks and Flows Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Background Tasks and Flows Maturity Note

## Summary

The background task ledger is well specified and implemented: it tracks detached ACP, subagent, cron, CLI, and media jobs; persists SQLite state; reconciles runtime backing; exposes CLI and Gateway methods; handles terminal notifications; and includes audit/maintenance. Quality is limited by restart/lost-task edge cases and operator confusion about the difference between task records and durable execution.

## Category Scope

Included in this category:

- Task list/show/cancel: Covers Task list/show/cancel across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task notifications: Covers Task notifications across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task audit and maintenance: Covers Task audit and maintenance across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Chat task board: Covers Chat task board across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task pressure status: Covers Task pressure status across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Managed flows: Covers Managed flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Mirrored flows: Covers Mirrored flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- openclaw tasks flow: Covers openclaw tasks flow across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Flow audit and maintenance: Covers Flow audit and maintenance across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Plugin managedFlows: Covers Plugin managedFlows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.

## Features

- Task list/show/cancel: Covers Task list/show/cancel across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task notifications: Covers Task notifications across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task audit and maintenance: Covers Task audit and maintenance across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Chat task board: Covers Chat task board across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Task pressure status: Covers Task pressure status across task creation, status transitions, runtime types, owner/session access, and related background task ledger behavior.
- Managed flows: Covers Managed flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Mirrored flows: Covers Mirrored flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- openclaw tasks flow: Covers openclaw tasks flow across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Flow audit and maintenance: Covers Flow audit and maintenance across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Plugin managedFlows: Covers Plugin managedFlows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: The registry, store, maintenance, audit, reconcile, owner access, delivery, executor policy, status formatting, Gateway methods, and CLI commands all have focused tests.
- Negative signals: Coverage is weaker for full restart scenarios where the Gateway is killed during active tasks and then reconciles mixed ACP/subagent/cron/CLI backing state in a real process.
- Integration gaps: A restart-kill harness should create one task per runtime, force Gateway shutdown before drain, restart, and prove audit/maintenance outcomes, delivery notifications, and cleanup retention.

## Quality Score

- Score: `Beta (77%)`
- Gitcrawl reports: PR #59719 tracks background exec liveness with CLI tasks; issue #42767 was closed after stale active tasks gained lost-state reconciliation; issue #66909 asked whether tasks resume after Gateway restart; issue #42246 requests batching/aggregation of outbound notifications for background tasks.
- Discrawl reports: Maintainer reports mention PR #78575 for stale task audit entries after forced/timed-out restarts, and user discussions advise treating OpenClaw tasks/transcripts as an operator audit trail rather than the sole durable work queue.
- Good qualities: The docs clearly state tasks are records, not schedulers; the registry persists to SQLite; reconciliation is runtime-aware; terminal rows retain for seven days; and task status output sanitizes internal runtime text.
- Bad qualities: The lived record shows task `lost` behavior, restart semantics, and notification volume remain hard for users to reason about.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Task list/show/cancel, Task notifications, Task audit and maintenance, Chat task board, Task pressure status, Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Restart behavior should be summarized in CLI status and docs with one explicit table: what can resume, what becomes lost, and what TaskFlow adds.
- Notification aggregation or batching remains a user-facing need for busy background task deployments.
- Maintenance should remain strongly observable because `lost` is a normal recovery signal, not just an error.

## Evidence

### Docs

- `docs/automation/tasks.md` explains task sources, lifecycle, statuses, delivery, notify policies, audit, maintenance, chat `/tasks`, status integration, storage, and relation to cron/heartbeat/Task Flow.
- `docs/automation/index.md` positions tasks as the detached-work ledger rather than a scheduler.
- `docs/cli/tasks.md` documents CLI commands for listing, showing, cancelling, notifying, auditing, maintaining, and inspecting flows.

### Source

- `src/tasks/task-registry.ts`, `src/tasks/task-registry.store.ts`, `src/tasks/task-registry.store.sqlite.ts`, `src/tasks/task-registry.reconcile.ts`, `src/tasks/task-registry.audit.ts`, `src/tasks/task-registry.maintenance.ts`, and `src/tasks/task-registry.types.ts` implement task persistence, reconciliation, audit, and maintenance.
- `src/tasks/task-executor.ts`, `src/tasks/task-executor-policy.ts`, `src/tasks/task-registry-delivery-runtime.ts`, and `src/tasks/task-status.ts` implement cancellation, notifications, delivery, and status formatting.
- `src/gateway/server-methods/tasks.ts` and `src/commands/tasks.ts` expose Gateway and CLI task operations.

### Integration tests

- `src/gateway/server-methods/tasks.test.ts` covers Gateway methods for tasks.
- `test/scripts/openclaw-test-state.test.ts` exercises broader OpenClaw test state that includes runtime state management.
- No full process restart-kill e2e across all task runtime types was found.

### Unit tests

- `src/tasks/task-registry.test.ts`, `src/tasks/task-registry.store.test.ts`, `src/tasks/task-registry.audit.test.ts`, `src/tasks/task-registry.maintenance.issue-60299.test.ts`, and `src/tasks/task-registry.process-state.test.ts` cover registry behavior.
- `src/tasks/task-executor.test.ts`, `src/tasks/task-executor-policy.test.ts`, `src/tasks/detached-task-runtime.test.ts`, and `src/tasks/task-status.test.ts` cover executor, notification, runtime, and status behavior.
- `src/commands/tasks.test.ts`, `src/commands/tasks-json.test.ts`, and `src/commands/tasks-audit-system.ts` cover CLI formatting and system audit behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "tasks ledger stale lost maintenance cron subagent" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "background tasks lost" --json --limit 5`

Results:

- PR #59719 fixes background exec liveness through CLI tasks.
- Issue #42767 discusses long-running tasks stuck as running; current main reconciles orphaned active tasks to `lost`.
- Issue #66909 asks whether tasks automatically resume after Gateway restart.
- Issue #42246 requests configurable batching/aggregation for outbound background task notifications.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "background tasks lost"`

Results:

- Maintainers requested review of PR #78575, described as fixing stale task audit entries by marking running background tasks lost when forced/timed-out Gateway restart proceeds before drain completes.
- Maintainer/user discussions explain that background tasks can become `lost` and recommend treating OpenClaw tasks/transcripts as operator audit trail, with Postgres/Redis for a durable external work ledger when needed.
- Issue #66909 was closed after docs clarified that tasks persist tracking records but not execution state.
