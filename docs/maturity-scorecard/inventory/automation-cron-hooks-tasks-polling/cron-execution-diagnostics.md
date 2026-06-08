---
title: "Automation: cron, hooks, tasks, polling - Cron Runs and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Cron Runs and Diagnostics Maturity Note

## Summary

Cron execution has a mature service and isolated-agent implementation: it records run history, maps run outcomes, supports manual and due-only runs, enforces model selection, checks local provider reachability, records diagnostics, and creates task-ledger entries. Coverage is broad but mostly focused and simulated. Quality is limited by live reports around model preflight/fallback semantics and long-running deterministic jobs.

## Category Scope

This category covers scheduler dispatch, timer arming, manual/due runs, isolated agent execution, session identity, model selection, fallback policy, provider preflight, run timeouts, run diagnostics, run history, and task-ledger creation. It excludes delivery/alerts, which are scored separately.

## Features

- Manual cron runs: Covers Manual cron runs across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Isolated cron execution: Covers Isolated cron execution across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Model/provider preflight: Covers Model/provider preflight across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Run history: Covers Run history across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.
- Timeout and denial diagnostics: Covers Timeout and denial diagnostics across scheduler dispatch, timer arming, manual/due runs, isolated agent execution, and related cron runs and diagnostics behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (83%)`
- Positive signals: The `src/cron/service.*.test.ts` and `src/cron/isolated-agent/*.test.ts` suites cover dispatch, timer rearming, restart catchup, model overrides, fallback policy, local model preflight, run diagnostics, timeout policy, meta-error status propagation, session-key isolation, and task-ledger creation.
- Negative signals: The component has less live/e2e proof for real provider stalls, real Gateway restarts during active isolated runs, and long-running deterministic process supervision through the embedded tool path.
- Integration gaps: A live scenario should prove a due isolated run through a real Gateway, a model-preflight skip, a timeout, a manual `cron.run --wait`, and durable `cron.runs` recovery after restart.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports: Issue #79329 reports cron model preflight skipping an entire run when a local primary is unreachable instead of trying configured cloud fallbacks.
- Discrawl reports: A maintainer/user thread on May 17 describes long-running deterministic cron work where Codex-native shell ownership can end before OpenClaw receives command output; the recommended pattern is embedded OpenClaw tools with `exec` plus `process` polling and an adequate `timeoutSeconds`.
- Good qualities: Execution paths separate main-session system events from isolated/current/custom `agentTurn` jobs, enforce model allowlists before runner start, persist run logs and diagnostics, and classify skipped/error/timeout states instead of treating every assistant reply as success.
- Bad qualities: Provider preflight and long-running process ownership remain operator-sensitive. The runtime has many guardrails, but the operational model still requires users to choose the right agent/tool execution path for deterministic shell work.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (83%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Manual cron runs, Isolated cron execution, Model/provider preflight, Run history, Timeout and denial diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Model preflight should align with fallback expectations or make strict-primary skip behavior unmistakable to operators.
- Long-running deterministic work needs a clearer first-class pattern or stronger docs that distinguish agent-turn orchestration from deterministic execution.
- A restart-resume proof for active isolated cron runs would reduce uncertainty around timeout and task reconciliation behavior.

## Evidence

### Docs

- `docs/automation/cron-jobs.md` documents execution styles, isolated session behavior, model/thinking/fallback precedence, local-provider preflight, timeout handling, run history, and manual `cron run --wait`.
- `.mem/main/ref/cron-run-diagnostics.md` and `.mem/main/pkg/claw/flow/cron-run-diagnostics.md` describe diagnostic expectations and recent repair context for cron run failures.
- `docs/automation/tasks.md` states that every cron execution creates a background task and explains cron-specific lost-state reconciliation.

### Source

- `src/cron/service/timer.ts`, `src/cron/service/ops.ts`, `src/cron/service/timeout-policy.ts`, and `src/cron/service/task-ledger.ts` own dispatch, manual runs, timeout policy, and task creation.
- `src/cron/run-log.ts`, `src/cron/run-diagnostics.ts`, and `src/cron/retry-hint.ts` implement durable run history and diagnostic summaries.
- `src/cron/isolated-agent/run.ts`, `src/cron/isolated-agent/model-selection.ts`, `src/cron/isolated-agent/model-preflight.runtime.ts`, `src/cron/isolated-agent/run-fallback-policy.ts`, and `src/cron/isolated-agent/session-key.ts` implement isolated agent execution, model choice, preflight, fallbacks, and session identity.

### Integration tests

- `src/cron/cron-protocol-conformance.test.ts` covers protocol-level cron behavior.
- `src/cron/isolated-agent/model-preflight.runtime.test.ts` exercises runtime provider-preflight behavior rather than only pure functions.
- `src/cron/isolated-agent/run.runtime-plugins.test.ts` exercises runtime plugin integration during cron runs.

### Unit tests

- `src/cron/service.restart-catchup.test.ts`, `src/cron/service.rearm-timer-when-running.test.ts`, `src/cron/service.prevents-duplicate-timers.test.ts`, `src/cron/service.every-jobs-fire.test.ts`, and `src/cron/service/timeout-policy.test.ts` cover scheduler execution mechanics.
- `src/cron/isolated-agent/run.cron-model-override.test.ts`, `src/cron/isolated-agent/run.payload-fallbacks.test.ts`, `src/cron/isolated-agent/run.meta-error-status.test.ts`, `src/cron/isolated-agent/run.interim-retry.test.ts`, `src/cron/isolated-agent/run.live-session-model-switch.test.ts`, and `src/cron/isolated-agent/run.tools-allow.test.ts` cover isolated run behavior.
- `src/cron/run-log.test.ts`, `src/cron/run-log.error-reason.test.ts`, and `src/cron/run-diagnostics.test.ts` cover run history and diagnostics.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "cron timeout diagnostics model preflight run history" --json --limit 5`

Results:

- Issue #79329, `Cron model preflight skips entire run when local primary is unreachable, ignoring configured cloud fallbacks [AI]`, is the only hit and directly lowers quality for model-preflight semantics.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "cron timeout diagnostics model preflight run history"`

Results:

- No matching Discord messages returned for this exact query.

Fallback query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "poll loop"`

Results:

- May 17 maintainer/user discussion recommends embedded OpenClaw execution with `exec` plus `process` for long-running deterministic cron work, and warns that Codex-native shell ownership can end before the final result is observed.
