---
title: "Automation: cron, hooks, tasks, polling - Cron Jobs Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Cron Jobs Maturity Note

## Summary

Cron job authoring and schedule management are documented and implemented across CLI, Gateway RPC, and agent-tool entrypoints. The scheduler supports one-shot, interval, and cron-expression jobs with timezone and stagger controls, plus durable job and runtime state files. The main risk is not basic feature absence; it is schedule-state edge behavior, where the archives show recurring reports around unresolved or stale `nextRunAtMs`, manual-run deletion, and long-uptime scheduler behavior.

## Category Scope

Included in this category:

- Create/edit/remove jobs: Covers Create/edit/remove jobs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Schedule types: Covers Schedule types across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Timezone and stagger: Covers Timezone and stagger across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Cron RPCs: Covers Cron RPCs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Agent cron tool: Covers Agent cron tool across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Manual cron runs: Covers Manual cron runs across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Isolated cron execution: Covers Isolated cron execution across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Model/provider preflight: Covers Model/provider preflight across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Run history: Covers Run history across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Timeout and denial diagnostics: Covers Timeout and denial diagnostics across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Chat announce delivery: Covers Chat announce delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Webhook delivery: Covers Webhook delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Failure destinations: Covers Failure destinations across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Skipped-run alerts: Covers Skipped-run alerts across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Delivery previews: Covers Delivery previews across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.

## Features

- Create/edit/remove jobs: Covers Create/edit/remove jobs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Schedule types: Covers Schedule types across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Timezone and stagger: Covers Timezone and stagger across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Cron RPCs: Covers Cron RPCs across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Agent cron tool: Covers Agent cron tool across cron job creation, listing, inspection, editing, and related cron job lifecycle behavior.
- Manual cron runs: Covers Manual cron runs across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Isolated cron execution: Covers Isolated cron execution across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Model/provider preflight: Covers Model/provider preflight across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Run history: Covers Run history across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Timeout and denial diagnostics: Covers Timeout and denial diagnostics across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Chat announce delivery: Covers Chat announce delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Webhook delivery: Covers Webhook delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Failure destinations: Covers Failure destinations across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Skipped-run alerts: Covers Skipped-run alerts across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Delivery previews: Covers Delivery previews across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (85%)`
- Positive signals: CLI, Gateway RPC, and agent-tool paths share normalization through `src/cron/normalize.ts` and `src/gateway/server-methods/cron.ts`; targeted unit coverage exists for schedule parsing, schedule options, store migration, `nextRunAtMs` repair, top-of-hour staggering, list pagination, and manual runs.
- Negative signals: Coverage is strongest at unit and focused service level; the evidence found fewer end-to-end proofs that create/edit/run flows survive long-running gateway uptime, hand-edited stores, and UI/CLI/agent-tool parity in one scenario.
- Integration gaps: No single live/e2e scenario was found that starts a real Gateway, creates all three schedule types through different user surfaces, restarts the Gateway, and proves the same persisted jobs still compute the correct next run.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Open threads include PR #52109 for high-frequency `every` schedule refire gaps, issue #81691 for exact-second future-slot repair, PR #75970 for malformed persisted jobs, issue #83538 for manual-run `deleteAfterRun` data loss, and issue #73166 for long-uptime scheduler stoppage.
- Discrawl reports: Discord archive shows operator confusion around main-session cron rows that appeared enabled but had `lastError: "disabled"`, plus review discussion on unresolved next-run refire loops and schedule errors leaving timers idle.
- Good qualities: The source has a clear service boundary, schema validation before service mutation, a job/state file split, timestamp validation, schedule identity tracking, and explicit docs for timezone, day-of-month/day-of-week OR behavior, stagger, and state-file handling.
- Bad qualities: The lived bug record shows schedule-state repair remains subtle, and manual-run/delete semantics can surprise operators. Quality is limited by these operational edge cases, not by the test inventory.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (85%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Create/edit/remove jobs, Schedule types, Timezone and stagger, Cron RPCs, Agent cron tool, Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics, Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- A single operator-facing scenario proof should cover creating `at`, `every`, and `cron` jobs through CLI/Gateway/agent-tool paths, editing non-schedule metadata, preserving/repairing state, restarting the Gateway, and manually running a due and non-due job.
- Manual run semantics need sharper operator visibility around `deleteAfterRun` and no-op due checks.
- Schedule-state repair should remain a regression focus because multiple archive entries cluster around `nextRunAtMs` corruption, zero values, unresolved schedules, and exact-second slot identity.

## Evidence

### Docs

- `docs/automation/cron-jobs.md` documents job persistence at `~/.openclaw/cron/jobs.json`, runtime state in `jobs-state.json`, schedule kinds, timezone, stagger, manual run, run history, and management commands.
- `docs/cli/cron.md` provides the CLI reference for `openclaw cron add`, `list`, `get`, `show`, `edit`, `run`, `runs`, and `remove`.
- `docs/gateway/protocol.md` lists automation RPCs including `cron.get`, `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, and `cron.runs`.

### Source

- `src/gateway/server-methods/cron.ts` implements validated Gateway methods for `cron.list`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, and `cron.runs`.
- `src/cli/cron-cli/register.cron-add.ts`, `src/cli/cron-cli/register.cron-edit.ts`, `src/cli/cron-cli/schedule-options.ts`, and `src/cli/cron-cli/shared.ts` implement CLI flag parsing, schedule construction, and display.
- `src/agents/tools/cron-tool.ts` exposes the agent cron tool, recovers flat params into job objects, handles self-scope introspection, and calls Gateway cron methods.
- `src/cron/normalize.ts`, `src/cron/schedule.ts`, `src/cron/stagger.ts`, `src/cron/service/jobs.ts`, `src/cron/service/ops.ts`, and `src/cron/service/store.ts` normalize, compute, persist, and mutate jobs.

### Integration tests

- `test/gateway.multi.e2e.test.ts` is broad gateway e2e coverage but not specific to all cron schedule-management paths.
- `src/gateway/tools-invoke-http.cron-regression.test.ts` exercises cron through Gateway tool invocation.
- `src/cron/cron-protocol-conformance.test.ts` and `src/cron/cron-protocol-schema.test.ts` exercise protocol shape and compatibility.

### Unit tests

- `src/cron/schedule.test.ts`, `src/cron/parse.test.ts`, `src/cron/normalize.test.ts`, `src/cron/stagger.test.ts`, and `src/cron/validate-timestamp.ts` cover schedule parsing and normalization.
- `src/cron/service.jobs.test.ts`, `src/cron/service.jobs.top-of-hour-stagger.test.ts`, `src/cron/service.issue-regressions.test.ts`, `src/cron/service.store-load-invalid-main-job.test.ts`, and `src/cron/service/ops.test.ts` cover job creation, mutation, repair, and store behavior.
- `src/cli/cron-cli/register.cron-simple.test.ts`, `src/cli/cron-cli/register.cron-edit.test.ts`, `src/cli/cron-cli/shared.test.ts`, and `src/agents/tools/cron-tool.schema.test.ts` cover CLI and agent-tool surfaces.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "cron add schedule nextRunAtMs" --json --limit 5`

Results:

- PR #52109, `fix(cron): apply MIN_REFIRE_GAP_MS to every-schedule jobs`, reports high-frequency `every` schedule refire risk.
- Issue #81691, `Cron future-slot repair misclassifies exact second cron slots`, reports exact-second state repair trouble.
- PR #75970, `fix(cron): ignore malformed persisted jobs`, points to malformed persisted job handling.
- Issue #83538, `cron: deleteAfterRun fires on manual run even when no run executes`, reports manual-run data-loss risk.
- Issue #73166, `Cron scheduler silently stops firing after ~2.5 days of gateway uptime`, reports long-uptime scheduling failure.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "cron add schedule nextRunAtMs"`

Results:

- PR #66083 discussion: unresolved `computeJobNextRunAtMs` results previously caused refire loops; current fix adds maintenance wake behavior for enabled jobs without a next run.
- PR #63507 discussion: `nextRunAtMs=0` on non-schedule edits required repair.
- User thread `Triggering main to do something in a cron.` includes a concrete main-session cron job that did not fire and showed `lastError: "disabled"`.
- Review comment on PR #52619 warns that schedule computation errors could leave an enabled job with no armed timer.
