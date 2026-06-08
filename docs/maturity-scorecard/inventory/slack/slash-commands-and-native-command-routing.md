---
title: "Slack - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Native Controls and Approvals Maturity Note

## Summary

Slack slash command support includes a single `/openclaw` command path, explicit native command mode, native argument menus, command target session routing, plugin and skill command loaders, HTTP versus Socket Mode URL differences, and authorization copy. The component is Beta: native commands are implemented and documented, but they require manual Slack app registration, auto mode is intentionally off, and archive evidence shows unresolved command-prefix, stale-config, and session-routing edge cases.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Commands, Actions, and Approvals`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Slash Commands: Covers Slash Commands across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Native Command Routing: Covers Native Command Routing across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Interactive Replies: Covers Interactive Replies across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- App Home: Covers App Home across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Assistant Events: Covers Assistant Events across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Native Approvals: Covers Native Approvals across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Actions: Covers Actions across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Security-sensitive Ops: Covers Security-sensitive Ops across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Interactive Replies: Covers Interactive Replies across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior
- App Home: Covers App Home across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior
- Assistant Events: Covers Assistant Events across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior
- Native Approvals: Covers Native Approvals across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior
- Actions: Covers Actions across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior
- Security-sensitive Ops: Covers Security-sensitive Ops across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior

## Features

- Slash Commands: Covers Slash Commands across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Native Command Routing: Covers Native Command Routing across configured slash command mode, native slash commands, command registration expectations, session keys, and related slash commands and native command routing behavior.
- Interactive Replies: Covers Interactive Replies across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- App Home: Covers App Home across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Assistant Events: Covers Assistant Events across App Home publish/open behavior, Slack assistant thread started/context-changed events, block actions, modal submissions, and related interactive replies, app home, and assistant events behavior.
- Native Approvals: Covers Native Approvals across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Actions: Covers Actions across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.
- Security-sensitive Ops: Covers Security-sensitive Ops across Slack native exec and plugin approvals, Block Kit approval prompts, approval auth, approval routing, and related native approvals, actions, and security-sensitive ops behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docs, source, and unit/runtime tests cover configured command mode, native explicit mode, native argument menus, command target session keys, authorization, plugin commands, skill commands, and HTTP URL requirements.
- Negative signals: The standard Slack live lane does not include a slash-command scenario, and manual Slack-side command registration is not automatically verified.
- Integration gaps: Add live scenarios for `/openclaw /help`, native `/help`, `/stop`, `/approve`, `/model` menu behavior, unauthorized command senders, HTTP command URLs, and native plugin/skill command visibility.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `#38302`, `#39605`, `#71665`, `#63059`, `#44297`, `#64578`, and `#74077` show command routing, native registration, external menu, and progress-mode command work.
- Discrawl reports: Maintainer comments say Slack native command handling is implemented for explicit native mode, while `commands.native: "auto"` remains intentionally off and issue `#39605` remains open for Discord/Slack captured-config routing.
- Good qualities: Slack docs explicitly warn that Slack does not create or remove slash commands automatically and explain different Socket/HTTP URL requirements.
- Bad qualities: Manual Slack app registration is easy to drift from OpenClaw config, and native/plugin command visibility has enough gates to confuse both users and reviewers.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Slash Commands, Native Command Routing, Interactive Replies, App Home, Assistant Events, Native Approvals, Actions, Security-sensitive Ops.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live native slash command lane that proves command target session routing in DMs, channels, and threads.
- Add generated Slack app manifest fragments for every enabled native command set.
- Add status output that compares configured `commands.native` against actual Slack app registration expectations.

## Evidence

### Docs

- `docs/channels/slack.md` documents optional native slash commands, HTTP-mode URL requirements, `channels.slack.slashCommand`, `commands.native`, native argument menus, isolated slash session keys, and troubleshooting for native/slash commands.
- `docs/tools/slash-commands.md` is the linked shared command catalog reference.

### Source

- `extensions/slack/src/monitor/slash.ts` parses slash payloads, resolves access, command target session keys, native mode, plugin commands, skill commands, and interactive argument menus.
- `extensions/slack/src/monitor/commands.ts`, `slash-commands.runtime.ts`, `slash-dispatch.runtime.ts`, `slash-plugin-commands.runtime.ts`, and `slash-skill-commands.runtime.ts` implement command matching and dispatch.
- `extensions/slack/src/http/plugin-routes.ts` routes HTTP slash command payloads.

### Integration tests

- No standard live Slack slash-command scenario was found in `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts`.
- Shared reply/session tests exercise Slack slash session keys and command routing behavior in process-level tests.

### Unit tests

- `extensions/slack/src/monitor/slash.test.ts` and `slash.test-harness.ts` cover Slack slash command behavior.
- `extensions/slack/src/monitor/slash-commands.runtime.ts` is exercised through runtime command tests.
- `src/auto-reply/reply/session.test.ts` covers Slack slash session keys and target session handling.
- `src/plugins/commands.test.ts` covers Slack provider-native plugin command specs.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack slash command" --json`

Results:

- Returned `#38302` per-account native command prefix, `#39605` native slash commands ignoring `session.dmScope`, `#39617` reload-config routing PR, `#44297` external arg-menu fallback health signal, `#71665` Slack native commands via Socket Mode, `#63059` Slack `/stop`, and plugin-command review comments on `#64578`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack slash command native commands"`

Results:

- Returned maintainer/GitHub mirrored comments confirming Slack native command handling for explicit native mode, keeping `#39605` open for Slack/Discord captured-config routing, and preserving manual command registration caveats.
