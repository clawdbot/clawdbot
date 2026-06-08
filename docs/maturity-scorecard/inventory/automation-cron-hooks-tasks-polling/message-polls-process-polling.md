---
title: "Automation: cron, hooks, tasks, polling - Polling Controls Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Polling Controls Maturity Note

## Summary

This component covers two user-visible meanings of polling: channel poll creation through the message tool/CLI, and process polling for long-running commands. Message poll actions are supported for several channels, while process polling has guardrails for long waits and repeated no-progress loops. Quality is limited by archive reports around infinite/repeated polling loops and operators needing to pick the right `exec`/`process` pattern for long work.

## Category Scope

Included in this category:

- openclaw message poll: Covers openclaw message poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Telegram polls: Covers Telegram polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Teams polls: Covers Teams polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Poll flags: Covers Poll flags across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Channel capability gates: Covers Channel capability gates across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process poll: Covers process poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process log: Covers process log across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Background process status: Covers Background process status across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- No-progress loop detection: Covers No-progress loop detection across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Process input controls: Covers Process input controls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.

## Features

- openclaw message poll: Covers openclaw message poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Telegram polls: Covers Telegram polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Teams polls: Covers Teams polls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Poll flags: Covers Poll flags across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Channel capability gates: Covers Channel capability gates across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process poll: Covers process poll across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- process log: Covers process log across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Background process status: Covers Background process status across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- No-progress loop detection: Covers No-progress loop detection across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.
- Process input controls: Covers Process input controls across `openclaw message poll`, channel poll adapters, poll parameter normalization, Teams/Matrix/Telegram poll support, and related message polls and process polling behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Poll parameter parsing, message poll command registration, outbound poll actions, channel-specific poll adapters, process polling, command-poll backoff, and polling-loop detection have targeted tests.
- Negative signals: Channel poll support is fragmented by channel capabilities, and process polling behavior depends on real child-process timing, terminal/PTY state, and agent prompting.
- Integration gaps: Add an e2e that starts a long-running process, polls it with progress and no-progress cases, then sends a channel poll through one live-capable adapter and verifies the returned message/poll id.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Issue #62432 reports agents repeatedly relaunching exec instead of switching to process poll; PR #81157 fixes invalid `process.action` causing infinite retry loops; issue #65223 discusses aborting process poll loops while keeping underlying exec alive; issue #69582 reports parameter injection causing an infinite tool loop.
- Discrawl reports: May 17 cron discussion says long deterministic cron work should use OpenClaw `exec` plus `process` polling rather than Codex-native shell babysitting. Clawsweeper report mentions a poll hang closed quickly as a notable issue.
- Good qualities: The process tool has explicit `poll` actions, timeout clamping, backoff state, no-progress loop detection, and system-prompt guidance against busy polling. Message poll actions go through channel capability gates.
- Bad qualities: The surface remains easy for agents to misuse: repeated exec relaunch, malformed process action loops, and no-progress polls all appear in archive reports.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw message poll, Telegram polls, Teams polls, Poll flags, Channel capability gates, process poll, process log, Background process status, No-progress loop detection, Process input controls.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Agent guidance should more directly say when to switch from `exec` to `process poll` and when to stop polling.
- Channel poll docs should make support/capability differences more discoverable from the automation index.
- Loop detection should continue to block malformed or no-progress polling patterns before they burn runtime.

## Evidence

### Docs

- `docs/automation/poll.md` redirects to `docs/cli/message.md` for poll documentation.
- `docs/cli/message.md` documents message poll usage.
- `docs/channels/telegram.md` documents Telegram `openclaw message poll` usage and Telegram-specific poll flags.
- `docs/channels/msteams.md` documents Teams polls as Adaptive Cards.
- `docs/gateway/background-process.md` documents process polling/logging for background processes.

### Source

- `src/polls.ts`, `src/poll-params.ts`, `src/cli/program/message/register.poll.ts`, and `src/infra/outbound/message-action-runner.poll.test.ts` cover message poll data and action execution.
- `src/agents/bash-tools.process.ts`, `src/agents/command-poll-backoff.ts`, and `src/agents/tool-loop-detection.ts` implement process polling and anti-loop behavior.
- `extensions/msteams/src/polls.ts`, `extensions/matrix/src/matrix/actions/polls.ts`, and Telegram channel action support implement channel-specific poll behavior.

### Integration tests

- `src/agents/agent-tools.before-tool-call.e2e.test.ts` includes poll-loop behavior through agent tool execution.
- `src/infra/outbound/message-action-runner.poll.test.ts` exercises outbound poll action execution.
- Channel poll tests are mostly adapter-level rather than live channel e2e.

### Unit tests

- `src/polls.test.ts` and `src/poll-params.test.ts` cover poll primitives.
- `src/agents/bash-tools.process.poll-timeout.test.ts`, `src/agents/command-poll-backoff.test.ts`, and `src/agents/tool-loop-detection.test.ts` cover process polling and loop detection.
- `extensions/msteams/src/polls.test.ts`, `extensions/matrix/src/matrix/actions/polls.test.ts`, and `extensions/matrix/src/matrix/poll-types.test.ts` cover channel poll adapters.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "message poll process poll polling loop no progress" --json --limit 5`

Results:

- No hits for the exact query.

Fallback query:

`gitcrawl search openclaw/openclaw --query "poll loop" --json --limit 5`

Results:

- Issue #65223 discusses process poll abort signal handling.
- PR #81157 fixes invalid `process.action` at the tool invocation boundary to prevent infinite loops.
- Issue #62432 reports repeated exec relaunch instead of switching to process poll.
- Issue #69582 reports parameter injection causing an infinite tool invocation loop.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "poll loop"`

Results:

- Clawsweeper report calls out issue #86477 as a poll hang closed quickly.
- May 17 cron thread recommends `exec` plus `process` polling for long deterministic work and warns against Codex owning the shell loop.
