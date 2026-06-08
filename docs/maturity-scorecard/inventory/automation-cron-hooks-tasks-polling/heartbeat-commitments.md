---
title: "Automation: cron, hooks, tasks, polling - Heartbeat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Heartbeat Maturity Note

## Summary

Heartbeat and inferred commitments form the approximate polling/follow-up side of automation. The implementation includes scheduling, active-hours gates, wake cooldowns, event filtering, busy-session deferral, delivery routing, response-tool handling, and commitment extraction/runtime. It is featureful, but archive evidence shows behavior around active hours, group wakes, first post-heartbeat messages, and activity-based idle expectations still confuses users.

## Category Scope

Included in this category:

- Heartbeat scheduling: Covers Heartbeat scheduling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Active hours: Covers Active hours across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Wake and cooldown handling: Covers Wake and cooldown handling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Due-only heartbeat tasks: Covers Due-only heartbeat tasks across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Commitment check-ins: Covers Commitment check-ins across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.

## Features

- Heartbeat scheduling: Covers Heartbeat scheduling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Active hours: Covers Active hours across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Wake and cooldown handling: Covers Wake and cooldown handling across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Due-only heartbeat tasks: Covers Due-only heartbeat tasks across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.
- Commitment check-ins: Covers Commitment check-ins across periodic heartbeat runs, active-hours and variable schedule behavior, wake/cooldown handling, heartbeat prompts and due-only task mode, and related heartbeat and commitments behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Heartbeat scheduling, active hours, cooldowns, event filtering, busy-session guards, delivery routing, model overrides, commitments, ghost reminders, and active-hours e2e scheduling have focused tests.
- Negative signals: Full live behavior depends on active channels, long-running sessions, and user message timing after heartbeat; those are hard to prove with unit-only fixtures.
- Integration gaps: A live scenario should cover heartbeat active hours, due-only task skip, cron wake event, exec completion wake, subagent busy deferral, commitment check-in, and group-channel delivery.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Issue #14051 requests activity-based heartbeat idle timeout; PR #58683 adds time-of-day variable intervals; issue #40611 reports heartbeat drift retries blocking Telegram; issue #85614 reports the first user message after heartbeat poll misidentified as heartbeat continuation; PR #78718 fixes agent-level fallback defaults.
- Discrawl reports: Dreaming cron thread shows operators can be surprised that main-target managed jobs run through heartbeat and can be skipped by `activeHours`; group wake issue #47578 was closed after current main fixed exec/ACP completion wakes.
- Good qualities: Heartbeat has explicit skip reasons, active-hours logic, cooldown/flood guards, delivery target preservation, response-tool support, and commitment-specific runtime policy.
- Bad qualities: Heartbeat participates in many adjacent flows - cron, exec completions, commitments, dreaming, groups, and task completions - and users still misread why runs skip or route through heartbeat.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Heartbeat scheduling, Active hours, Wake and cooldown handling, Due-only heartbeat tasks, Commitment check-ins.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Docs should make the "main-session cron uses heartbeat lane" relationship more prominent.
- Activity-based idle timeout remains an open product request.
- The first-message-after-heartbeat boundary should remain a regression focus because it can corrupt normal user interaction.

## Evidence

### Docs

- `docs/automation/index.md` compares cron and heartbeat, explains heartbeat as approximate periodic awareness, and notes task records are not created for heartbeat turns.
- `docs/gateway/heartbeat.md` documents heartbeat configuration, active hours, wake behavior, skip reasons, and troubleshooting.
- `docs/concepts/commitments.md` documents inferred commitments and heartbeat delivery of due check-ins.

### Source

- `src/infra/heartbeat-runner.ts`, `src/infra/heartbeat-schedule.ts`, `src/infra/heartbeat-active-hours.ts`, `src/infra/heartbeat-cooldown.ts`, `src/infra/heartbeat-events-filter.ts`, `src/infra/heartbeat-wake.ts`, and `src/infra/heartbeat-visibility.ts` implement heartbeat scheduling and event handling.
- `src/commitments/runtime.ts`, `src/commitments/extraction.ts`, `src/commitments/store.ts`, and `src/commitments/model-selection.runtime.ts` implement inferred commitments.
- `src/auto-reply/heartbeat.ts`, `src/auto-reply/heartbeat-filter.ts`, and `src/agents/heartbeat-system-prompt.ts` connect heartbeat to agent prompting and response behavior.

### Integration tests

- `src/infra/heartbeat-runner.active-hours-schedule.e2e.test.ts` tests active-hours-aware scheduling.
- `src/commitments/commitments-full-chain.integration.test.ts` and `src/commitments/commitments-heartbeat-policy.e2e.test.ts` cover commitment-to-heartbeat flows.
- `src/infra/heartbeat-runner.ghost-reminder.test.ts` covers cron/exec event routing through heartbeat.

### Unit tests

- `src/infra/heartbeat-schedule.test.ts`, `src/infra/heartbeat-active-hours.test.ts`, `src/infra/heartbeat-cooldown.test.ts`, `src/infra/heartbeat-events-filter.test.ts`, `src/infra/heartbeat-runner.skips-busy-session-lane.test.ts`, `src/infra/heartbeat-runner.subagent-session-guard.test.ts`, and `src/infra/heartbeat-runner.model-override.test.ts` cover heartbeat mechanics.
- `src/commitments/extraction.test.ts`, `src/commitments/store.test.ts`, and `src/commitments/runtime.test.ts` cover commitments.
- `src/auto-reply/heartbeat.test.ts` and `src/auto-reply/heartbeat-filter.test.ts` cover auto-reply heartbeat behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "heartbeat commitments skipWhenBusy activeHours no-tasks-due" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "heartbeat activeHours" --json --limit 5`

Results:

- Issue #14051 requests activity-based heartbeat with idle timeout.
- PR #58683 adds time-of-day scheduling for variable intervals.
- Issue #40611 reports heartbeat drift retry blocking Telegram during active conversations.
- Issue #85614 reports first user message after heartbeat poll misidentified as heartbeat continuation.
- PR #78718 fixes agent-level heartbeat fallback defaults.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "heartbeat activeHours"`

Results:

- Issue #14051 automated review keeps activity-based heartbeat idle timeout open.
- Issue #47578 closure says current main implements group-session exec/ACP wake path with targeted heartbeat wakes preserving session keys.
- Dreaming issue thread explains a managed dreaming cron targeted at `main` runs through heartbeat and can be skipped by active-hours quiet windows.
