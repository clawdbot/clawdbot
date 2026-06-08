---
title: "Automation: cron, hooks, tasks, polling - Task Flow Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Task Flow Maturity Note

## Summary

Task Flow provides durable orchestration above individual background tasks. The source includes a registry, owner access, audit, maintenance, plugin runtime APIs, and Lobster integration. The component is promising but less mature than the plain task ledger: docs explain concepts, but archive evidence shows users still ask how flows are actually triggered and when to choose TaskFlow, background tasks, cron, or an external durable queue.

## Category Scope

This category covers managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, flow audit/maintenance, `openclaw tasks flow` CLI commands, plugin runtime `managedFlows`, Lobster workflow integration, cancellation, and relation to cron/background tasks.

## Features

- Managed flows: Covers Managed flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Mirrored flows: Covers Mirrored flows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- openclaw tasks flow: Covers openclaw tasks flow across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Flow audit and maintenance: Covers Flow audit and maintenance across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.
- Plugin managedFlows: Covers Plugin managedFlows across managed and mirrored flow modes, flow registry persistence, revision tracking, owner-scoped access, and related task flow behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (73%)`
- Positive signals: The registry, SQLite store, owner access, audit, maintenance, plugin runtime API, and Lobster flow integration have focused tests.
- Negative signals: Coverage is thinner for real multi-step workflow execution across Gateway restart, external task mirroring, user CLI inspection, and approval/resume paths in one scenario.
- Integration gaps: Add a worked e2e flow: cron triggers a persistent session, plugin creates a managed flow with child tasks, one step waits for approval, Gateway restarts, and `openclaw tasks flow show` proves state and revision continuity.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: PR #68687 routes durable agent work through TaskFlow; issue #78019 reports `inconsistent_timestamps`; PR #60183 improves TaskFlow audit freshness; PR #61242 improves managed child-task UX; issue #79038 reports webhook `run_task` route-session authority concerns.
- Discrawl reports: Maintainer reports say users ask how TaskFlow is triggered or built, and recommend adding a concrete "hello world" with trigger, state, resume, failure, and audit trail.
- Good qualities: The architecture separates orchestration from individual task execution, tracks revisions, has cancellation intent, and exposes owner-scoped access and maintenance.
- Bad qualities: The operational workflow is still under-documented, and archive reports show both UX gaps and consistency bugs in flow audit/timestamps/authority.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Beta (73%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Managed flows, Mirrored flows, openclaw tasks flow, Flow audit and maintenance, Plugin managedFlows.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish a concrete TaskFlow tutorial with trigger, state transitions, resume, failure, audit, and relation to background tasks.
- Strengthen restart/resume examples for managed flows and mirrored external tasks.
- Keep authority boundaries explicit for webhook-created tasks and route session trees.

## Evidence

### Docs

- `docs/automation/taskflow.md` documents Task Flow as an orchestration layer, managed and mirrored modes, durable state, revision tracking, cancellation, and CLI commands.
- `docs/automation/tasks.md` explains how tasks relate to Task Flow and links `openclaw tasks flow list|show|cancel`.
- `docs/plugins/sdk-runtime.md` references `api.runtime.tasks.managedFlows` and says Task Flow is not itself a scheduler.

### Source

- `src/tasks/task-flow-registry.ts`, `src/tasks/task-flow-registry.store.ts`, `src/tasks/task-flow-registry.store.sqlite.ts`, `src/tasks/task-flow-registry.audit.ts`, `src/tasks/task-flow-registry.maintenance.ts`, and `src/tasks/task-flow-registry.types.ts` implement the flow registry.
- `src/tasks/task-flow-owner-access.ts` enforces owner-scoped flow access.
- `src/plugins/runtime/runtime-taskflow.ts` exposes plugin runtime APIs for managed flows.
- `extensions/lobster/src/lobster-taskflow.ts` binds Lobster workflow execution to Task Flow.
- `src/commands/tasks.ts` implements `openclaw tasks flow` CLI operations.

### Integration tests

- `extensions/lobster/src/lobster-taskflow.test.ts` exercises a real plugin integration with the Task Flow API.
- `src/plugins/runtime/runtime-taskflow.test.ts` exercises plugin runtime Task Flow behavior.
- No full Gateway restart/resume e2e for Task Flow was found.

### Unit tests

- `src/tasks/task-flow-registry.test.ts`, `src/tasks/task-flow-registry.store.test.ts`, `src/tasks/task-flow-registry.audit.test.ts`, `src/tasks/task-flow-registry.maintenance.test.ts`, and `src/tasks/task-flow-owner-access.test.ts` cover core Task Flow behavior.
- `src/tasks/task-registry.maintenance.ts` and `src/commands/tasks.ts` also include flow maintenance paths.
- `src/plugins/runtime/runtime-taskflow.test.ts` covers plugin API shape and behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "task flow registry managed mirrored tasks flow" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "TaskFlow" --json --limit 5`

Results:

- PR #68687 routes durable agent work through TaskFlow.
- Issue #78019 reports `TaskFlow inconsistent_timestamps`.
- PR #60183 improves TaskFlow audit freshness.
- PR #61242 improves managed child-task flow UX.
- Issue #79038 reports webhook `run_task` authority problems around route session trees.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "TaskFlow"`

Results:

- Maintainer/user discussion says users ask how TaskFlow is actually triggered or built, and recommends a concrete TaskFlow hello-world with trigger, state, resume, failure, and audit trail.
- Same report frames TaskFlow as durable flow visibility above background tasks, with external Postgres/Redis still preferred for a hard durable work ledger in complex multi-agent deployments.
