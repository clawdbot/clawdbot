---
title: "Discord - Threads, Forums, and Delegated-agent Bindings Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Threads, Forums, and Delegated-agent Bindings Maturity Note

## Summary

Discord has a broad, documented thread surface: forum/media parent posts, explicit thread create/list/reply actions, auto-thread routing, thread parent/starter context, thread-bound subagent sessions, and ACP current/thread bindings. The implementation is substantial and generally well-factored, with explicit target parsing, forum/media request shaping, persisted binding records, webhook persona delivery, idle/max-age sweepers, ACP health reconciliation, and channel hook integration.

The score is held back by the evidence shape. Integration/runtime coverage exists for current-conversation binding, action routing, generic thread follow-up, subagent lifecycle hooks, and live/manual ACP bind probes, but the audit did not find a single always-on live Discord scenario that exercises forum/media thread creation plus ACP/subagent delegated follow-up end to end. Quality is also reduced by a dense lived bug record around Discord ACP thread binding, follow-up routing, prefixed targets, parent-channel keying, and operator confusion about `--bind here` versus `--thread auto|here`.

## Category Scope

- Discord forum/media channel posts created as threads from parent channel targets.
- CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`.
- Discord target parsing for `channel:<id>`, user targets, and bare IDs with a channel default.
- Thread context resolution: parent channel lookup, starter-message lookup, forum/media starter behavior, reply targeting, title sanitization, optional generated titles, and parent session/model inheritance.
- Thread-bound session routing for `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, `sessions_spawn({ thread: true })`, and subagent delivery targets.
- ACP current-conversation bindings and ACP thread spawns on Discord, including persistent configured ACP bindings.
- Binding lifecycle behavior: binding persistence, webhook delivery, activity touches, idle/max-age expiry, stale/deleted thread cleanup, and ACP startup reconciliation.

## Features

- Forum and media-channel thread posts: Covers Forum and media-channel thread posts across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread actions: Covers Thread actions across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Target parsing: Covers Target parsing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread context resolution: Covers Thread context resolution across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread-bound session routing: Covers Thread-bound session routing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- ACP bindings: Covers ACP bindings across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Binding lifecycle: Covers Binding lifecycle across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Discord current-conversation ACP binding has an integration test that binds a Discord DM conversation and verifies the next turn routes to the bound ACP session key. Runtime tests cover message-tool thread creation, forum initial messages, action routing, subagent hook binding, bound-thread preflight routing, webhook echo suppression, idle/max-age binding lifecycle, and generic `sessions_spawn` lifecycle behavior. QA artifacts include a generic thread follow-up scenario and a manual Discord ACP thread smoke that sends a Discord prompt, waits for an ACP thread binding, and verifies an ACK inside the bound thread.
- Negative signals: Most Discord thread/forum proof is mocked REST or action-runtime coverage, not live Discord forum/media execution. The always-on live ACP bind test is generic and synthetic rather than Discord forum/thread-specific. Delegated subagent and ACP thread coverage is split across generic spawn tests, Discord hook tests, and manual smoke tooling instead of one canonical live Discord run.
- Integration gaps: No observed CI-live scenario proves forum/media thread creation, applied tags, delegated ACP/subagent spawn, follow-up routing, and cleanup in one Discord server flow. No broad runtime-flow proof was found for persistent configured ACP bindings across Discord gateway restart plus thread inheritance.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: The archive shows multiple open or recent reports directly in this component area, including #64199 for ACP configured bindings sharing a parent-channel session key across Discord threads, #81341 for ACP bound-thread follow-up delivery, #87599 for ACP session restore after metadata cleanup, #53548 for `mode="session"` being coupled to thread binding, and #79281 for third-party channel thread-binding plumbing complexity. It also shows fixed-but-recent regressions around prefixed Discord channel IDs and session thread binding failures (#63927, #70315, #68034).
- Discrawl reports: Discord archive results include operator discussions where `/acp spawn ... --bind here` succeeded but follow-up Discord thread messages or native `/acp` commands did not reach the bound session, plus repeated guidance that persistent Discord ACP sessions require a thread-bound path and that forum/media channels must be handled as thread posts.
- Good qualities: The implementation has explicit Discord target normalization, forum/media-specific request bodies, safe fallback behavior when thread creation or initial message delivery partially fails, thread starter and parent resolution, binding lifecycle expiry, stale-thread cleanup, webhook echo suppression, startup ACP health reconciliation with bounded concurrency, and clear operator docs for `--bind here`, `--thread auto|here`, `spawnSessions`, and forum/media limitations.
- Bad qualities: The component has high state and routing complexity, with separate current-conversation bindings, thread bindings, top-level configured ACP bindings, subagent lifecycle hooks, and Discord-native command paths. The lived bug record shows that small mismatches in conversation IDs, parent/thread IDs, account selection, or native command context can break routing while still looking successful to operators.
- Excluded from quality: Test coverage, lack of tests, and integration depth were not used as Quality inputs.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Forum and media-channel thread posts, Thread actions, Target parsing, Thread context resolution, Thread-bound session routing, ACP bindings, Binding lifecycle.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Discord has strong docs for forum/media thread creation, but the archive still shows user confusion around forum parents, `--message-id`, and whether a workflow is posting to a parent channel or thread.
- ACP and subagent thread routing is implemented through several adjacent contracts. The source is robust in places, but the operator model remains subtle: current binds, child-thread spawns, configured ACP bindings, and temporary thread bindings can overlap.
- The existing manual Discord ACP smoke is valuable, but the component would be easier to operate if its canonical runtime proof lived in the same QA/lab matrix as the baseline Discord transport scenarios.
- Open archive items around bound thread follow-up delivery and parent-channel session keying should be treated as active quality risk until closed or explicitly superseded by source evidence.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:318` documents forum/media channels as thread-only parents, two supported creation paths, and the `openclaw message thread create` syntax.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:748` documents Discord thread routing as channel sessions, parent channel config inheritance, parent model fallback, and optional transcript inheritance.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:760` documents thread-bound sessions for subagents, including `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, `spawnSessions`, and `defaultSpawnContext`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:809` documents persistent ACP channel bindings for Discord and states that `/acp spawn codex --bind here` binds the current channel/thread while `spawnSessions` gates child-thread creation via `--thread auto|here`.
- `/Users/kevinlin/code/openclaw/docs/tools/acp-agents.md:267` documents current-conversation ACP binds and follow-up routing, while `/Users/kevinlin/code/openclaw/docs/tools/acp-agents.md:286` separates `--bind here` from `--thread ...` and clarifies Discord `spawnSessions`.
- `/Users/kevinlin/code/openclaw/docs/tools/subagents.md:294` names Discord thread binding config keys for subagent thread-bound sessions.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/target-parsing.ts:16` parses Discord targets and `/Users/kevinlin/code/openclaw/extensions/discord/src/target-parsing.ts:67` resolves channel targets with `defaultKind: "channel"`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.messages.ts:136` implements `createThreadDiscord`; `/Users/kevinlin/code/openclaw/extensions/discord/src/send.messages.ts:160` detects forum/media parents, `/Users/kevinlin/code/openclaw/extensions/discord/src/send.messages.ts:166` passes `applied_tags`, and `/Users/kevinlin/code/openclaw/extensions/discord/src/send.messages.ts:179` sends initial content separately for non-forum threads.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.starter.ts:44` resolves Discord thread channels, `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.starter.ts:84` resolves parent info, and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.starter.ts:150` uses the thread ID itself for forum/media starter lookup.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.auto-thread.ts:38` builds auto-thread session context, `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.auto-thread.ts:71` records parent model/session linkage, and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.auto-thread.ts:123` creates auto-threads when configured.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.manager.ts:298` binds targets, creates or reuses webhooks, persists records, and registers a session-binding adapter at `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.manager.ts:528`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.lifecycle.ts:101` auto-binds spawned Discord subagents and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.lifecycle.ts:236` reconciles ACP thread bindings on startup with a bounded health-probe concurrency cap at `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.lifecycle.ts:52`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.ts:93` handles Discord subagent spawning, checks thread-binding spawn policy at `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.ts:108`, and returns a Discord thread delivery origin at `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.ts:156`.
- `/Users/kevinlin/code/openclaw/src/agents/subagent-spawn.ts:638` requires thread-binding hook success for thread-bound session spawns and `/Users/kevinlin/code/openclaw/src/agents/acp-spawn.ts:1338` maps prepared binding failures to `thread_binding_invalid`.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/acp-bind-here.integration.test.ts:133` covers the Discord ACP bind-here flow and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/acp-bind-here.integration.test.ts:213` asserts the next Discord turn routes to the bound ACP session and agent.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/actions/runtime.test.ts:1299` verifies action-runtime thread creation carries the initial forum post body into the Discord action.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:799` verifies bound-thread regular bot messages can flow when allowed, and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:996` verifies mention-gating is bypassed for bound threads.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-acp-bind.live.test.ts:563` defines a live ACP bind scenario, `/Users/kevinlin/code/openclaw/src/gateway/gateway-acp-bind.live.test.ts:730` asserts the bind announcement, and `/Users/kevinlin/code/openclaw/src/gateway/gateway-acp-bind.live.test.ts:912` verifies bound-session transcript continuity. This is generic/synthetic, not Discord-forum-specific.
- `/Users/kevinlin/code/openclaw/qa/scenarios/channels/thread-follow-up.md:4` defines a thread follow-up QA scenario, `/Users/kevinlin/code/openclaw/qa/scenarios/channels/thread-follow-up.md:40` creates a thread, and `/Users/kevinlin/code/openclaw/qa/scenarios/channels/thread-follow-up.md:72` asserts the reply did not leak to the root channel.
- `/Users/kevinlin/code/openclaw/scripts/dev/discord-acp-plain-language-smoke.ts:245` describes a manual live Discord ACP thread smoke; `/Users/kevinlin/code/openclaw/scripts/dev/discord-acp-plain-language-smoke.ts:846` waits for a new ACP thread binding and `/Users/kevinlin/code/openclaw/scripts/dev/discord-acp-plain-language-smoke.ts:925` reports a failure if the bound thread does not receive the expected ACK token.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/send.creates-thread.test.ts:144` covers forum thread creation with an initial message, `/Users/kevinlin/code/openclaw/extensions/discord/src/send.creates-thread.test.ts:157` covers media thread creation, and `/Users/kevinlin/code/openclaw/extensions/discord/src/send.creates-thread.test.ts:173` covers `applied_tags`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/threading.auto-thread.test.ts:162` covers generated auto-thread title behavior and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-title.generate.test.ts:95` covers title-generation model calls.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.test.ts:210` covers binding thread routing on `subagent_spawning`, `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.test.ts:249` covers disabled thread-bound subagent spawn errors, and `/Users/kevinlin/code/openclaw/extensions/discord/src/subagent-hooks.test.ts:426` resolves delivery targets from matching bound threads.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/thread-bindings.lifecycle.test.ts:294` covers idle/max-age intro text and lifecycle behavior, including auto-unfocus and stale/deleted thread cleanup in adjacent cases.
- `/Users/kevinlin/code/openclaw/src/cli/program/message/register.thread.test.ts:120` verifies CLI `message thread create` dispatches `thread-create`, while `/Users/kevinlin/code/openclaw/extensions/discord/src/channel-actions.test.ts:71` verifies Discord advertises `thread-create`, `thread-list`, and `thread-reply`.

### Gitcrawl queries

Query:

```text
gitcrawl doctor --json
```

Results:

- Succeeded; recorded freshness: version=0.2.1, last_sync_at=2026-05-28T19:09:52.784704Z, thread_count=29810, open_thread_count=11181, cluster_count=18594, repository_count=2.

Query:

```text
gitcrawl search --query "discord thread binding" openclaw/openclaw --json
```

Results:

- Returned open issue #64199, "ACP configured binding uses parent channel ID for session key — all threads under same channel share one persistent Claude Code process."
- Returned open PR #64322, "fix(acp): assign distinct session keys to Discord threads under the same parent channel."
- Returned open issue #53548, "Decouple mode=\"session\" from thread binding requirement."
- Returned open issue #50798, "Visible agent-to-agent messaging for ACP thread-bound sessions."
- Returned open PR #81341, "Fix ACP bound thread follow-up delivery."

Query:

```text
gitcrawl search --query "discord acp sessions_spawn thread binding" openclaw/openclaw --json
```

Results:

- Returned open issue #64199 and open issue #87599 as active Discord/ACP/thread-binding risks.
- Returned open issue #79281, "Default ACP thread-binding preset ... third-party channels currently re-implement ~870 LOC each."
- Returned open issue #53548, reinforcing operator/API ambiguity around `mode="session"` and thread binding.

Query:

```text
gitcrawl search --query "Discord forum media thread create" openclaw/openclaw --json
```

Results:

- Returned no hits. Given the successful freshness check, absence is treated as neutral for Quality, not positive evidence.

Query:

```text
gitcrawl search --query "Discord bound thread follow-up delivery" openclaw/openclaw --json
```

Results:

- Returned open PR #81341, "Fix ACP bound thread follow-up delivery."
- Returned open PR #80008, "feat(plugins): expose ACP spawn and prompt in plugin runtime," with a snippet about delivering agent responses into a bound Discord thread.

### Discrawl queries

Query:

```text
discrawl status --json
```

Results:

- Succeeded; recorded freshness: generated_at=2026-05-28T20:13:14Z, state=current, last_sync_at=2026-05-28T19:15:50Z, messages=1485267, channels=25766, threads=25539, members=173089, embedding_backlog=0, share remote `git@github.com-personal:openclaw/discord-store.git`.

Query:

```text
discrawl search --mode hybrid --limit 10 "Discord thread binding ACP spawn"
```

Results:

- Returned maintainer guidance on 2026-05-13 saying native Codex app-server binding and ACP binding exist, but attaching a Discord/chat session to an arbitrary already-running paired-node Codex CLI session is not a documented workflow.
- Returned OpenClaw issue mirror entries for #65801, #63927, #63354, and #55569, each tied to Discord ACP/thread-binding or gateway readiness fixes.
- Returned issue mirror #43756 noting Slack parity is still missing while Discord/Telegram already implement thread-binding spawn lifecycle.

Query:

```text
discrawl search --mode hybrid --limit 10 "forum media channel thread create Discord"
```

Results:

- Returned issue mirror #40262, "message action=thread-create silently fails on Discord forum channels (type 15)," closed as implemented after current `main` handled forum/media thread creation with initial messages and tags.
- Returned a support thread "Claw cannot create new Discord threads or forum channel posts" with guidance to send to forum/media parents as thread posts and not pass `--message-id` for forum channels.
- Returned PR/issue mirror entries #30358, #33857, and #33930 about `applied_tags` support for forum/media threads.

Query:

```text
discrawl search --mode hybrid --limit 10 "Discord ACP bind here thread follow-up"
```

Results:

- Returned issue mirror #65801, "Messages are not passed to ACP," closed as implemented after review of current Discord current-conversation ACP binding.
- Returned Discord discussions "acp commands not working in threads" and "messages re not reaching ACP" where `/acp spawn ... --bind here` succeeded but follow-up thread messages or native `/acp` commands did not reliably reach the bound ACP session.
- Returned guidance explaining that `--bind here` and `--thread ...` are distinct paths and that persistent work commonly uses a control room plus per-task Discord threads.

Query:

```text
discrawl search --mode hybrid --limit 10 "Discord sessions_spawn thread binding fails"
```

Results:

- Returned issue mirror #63927, closed as implemented after current `main` normalized `channel:<snowflake>` targets before Discord thread binding.
- Returned issue #70315 and PR #68034 for `thread_binding_invalid` failures caused by prefixed Discord channel IDs.
- Returned issue #40077 for `sessions_spawn thread=true` failing on Discord guild channels, later closed as implemented after thread-binding manager and account-routing fixes.
