---
title: "Discord - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Discord - Conversation Routing and Delivery Maturity Note

## Summary

Discord guild channel routing is a real, documented runtime path with fail-closed guild/channel policy, mention gating, per-channel session keys, thread inheritance, configured/runtime bindings, role-aware routing, and inbound context isolation. The strongest live proof covers canary, mention-gating, and guild-channel round trips. The main limitation is that several important negative and recovery flows are still not proven by live or E2E scenarios, especially allowlist-block behavior, role-routing in a guild channel, restart/resume, top-level reply shape, and history-window behavior.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Channel and Thread Routing`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Guild and channel admission: Covers Guild and channel admission across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Mention gating: Covers Mention gating across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Session key isolation: Covers Session key isolation across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Configured and runtime routing: Covers Configured and runtime bindings across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Inbound context visibility: Covers Inbound context visibility across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Forum and media-channel thread posts: Covers Forum and media-channel thread posts across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread actions: Covers Thread actions across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Target parsing: Covers Target parsing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread context resolution: Covers Thread context resolution across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread-bound session routing: Covers Thread-bound session routing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- ACP agent routing: Covers ACP bindings across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Routing lifecycle: Covers Binding lifecycle across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Discord forum/media channel posts created as: Covers Discord forum/media channel posts created as threads from parent channel targets behavior.
- CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`
- Discord target parsing for `channel:<id>`: Covers Discord target parsing for `channel:<id>`, user targets, and bare IDs with a channel default behavior.
- Thread context resolution: parent channel lookup, starter-message lookup, forum/media starter behavior, reply targeting, title sanitization, optional generated titles, and parent session/model inheritance
- Thread-bound session routing for `/focus`, `/unfocus`, `/agents`, `/session idle`, `/session max-age`, `sessions_spawn({ thread: true })`, and subagent delivery targets
- ACP current-conversation bindings and ACP thread: Covers ACP current-conversation bindings and ACP thread spawns on Discord, including persistent configured ACP bindings behavior.
- Binding lifecycle behavior: binding persistence, webhook delivery, activity touches, idle/max-age expiry, stale/deleted thread cleanup, and ACP startup reconciliation
- Direct and thread sends: Covers Direct and thread sends across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Text chunking and reply mode: Covers Text chunking and reply mode across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Draft and progress edits: Covers Draft and progress edits across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- Mention and embed rendering: Covers Mention and embed rendering across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- REST retry and final delivery: Covers REST retry and final delivery across This note scores the Discord outbound message path: direct sends, thread replies, text chunking, media follow-up, and related outbound message rendering and delivery behavior
- File uploads: Outbound file uploads from URLs and local paths, including delivery constraints and follow-up behavior
- Component file and media-gallery blocks: Component v2 file and media-gallery blocks for Discord media delivery
- Video caption follow-up: Video caption handling and follow-up media-only delivery in Discord conversations
- Voice-message upload: Discord voice-message sends with OGG/Opus conversion, waveform generation, duration metadata, and upload URL handling
- Inbound attachment context: Inbound attachment context made available to Discord replies and agent turns

## Features

- Guild and channel admission: Covers Guild and channel admission across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Mention gating: Covers Mention gating across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Session key isolation: Covers Session key isolation across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Configured and runtime routing: Covers Configured and runtime bindings across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Inbound context visibility: Covers Inbound context visibility across Guild allowlist and `groupPolicy` admission for Discord guild channels and threads. `requireMention`, bot-loop prevention, command/mention bypasses, and unmentioned room-event history. Channel, and related guild channel routing and session isolation behavior.
- Forum and media-channel thread posts: Covers Forum and media-channel thread posts across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread actions: Covers Thread actions across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Target parsing: Covers Target parsing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread context resolution: Covers Thread context resolution across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Thread-bound session routing: Covers Thread-bound session routing across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- ACP agent routing: Covers ACP bindings across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.
- Routing lifecycle: Covers Binding lifecycle across Discord forum/media channel posts created as threads from parent channel targets. CLI and message-tool thread actions: `thread-create`, `thread-list`, and `thread-reply`. Discord target parsing for `channel:<id>`, user targets, and related threads, forums, and delegated-agent bindings behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`

This score is based only on integration, E2E, live, and runtime-flow evidence. Coverage is strong enough for beta because the repo has live Discord runtime scenarios and cross-OS guild-channel round trips that configure `groupPolicy: "allowlist"`, target a real guild/channel, restart the gateway, send outbound Discord channel messages, and read inbound channel messages back through the installed CLI. Mention-gating also has a live QA scenario, and ACP binding has an integration-level runtime flow that proves bound session routing survives the next turn.

The score stops short of stable because the QA live scenario list itself records missing standard scenarios for `allowlist-block`, `top-level-reply-shape`, and `restart-resume`, and I did not find E2E/live proof for role-based guild routing, channel allowlist denial, or history-window/thread-context behavior. Those areas are covered in docs, source, and unit-level checks, but not enough runtime evidence exists to score them higher.

## Quality Score

- Score: `Stable (84%)`

The implementation quality is stable. The source uses explicit guild/channel policy resolution, defaults guild participation toward allowlist behavior, keeps `requireMention` enabled by default unless a guild/channel override disables it, treats name matching as dangerous opt-in behavior, uses role IDs for route matching, resolves parent channels for threads, and builds deterministic per-channel session keys. Inbound context treats channel metadata as untrusted, and the preflight path records skipped mention-gated guild messages as room history instead of silently losing context.

The quality risks are mostly complexity and operational edge cases, not missing test quantity. Admission, route resolution, mention gating, configured bindings, runtime bindings, history recording, and context construction are spread across several Discord and core routing modules. Archive evidence also shows current user-visible friction in this area: guild channel messages working in DMs but not channels, allowlist messages being silently ignored, gateway readiness regressions, channel reply drops, and group-session harness divergence. The docs also explicitly warn that channel allowlists are trigger gates rather than a universal redaction boundary, so secure context isolation depends on the newer context-visibility machinery and operator configuration.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/discord.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Guild and channel admission, Mention gating, Session key isolation, Configured and runtime routing, Inbound context visibility, Forum and media-channel thread posts, Thread actions, Target parsing, Thread context resolution, Thread-bound session routing, ACP agent routing, Routing lifecycle.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live QA lists `allowlist-block`, `top-level-reply-shape`, and `restart-resume` as missing standard Discord scenarios.
- Role-based guild routing is well specified and unit-checked, but I did not find direct live/E2E evidence for a member role causing a Discord guild-channel route to a different agent.
- History-window and skipped-mention room-event behavior are implemented and unit-checked, but I did not find live/E2E proof or gitcrawl hits for `historyLimit` on Discord channel threads.
- Gitcrawl and discrawl archives show repeated operator confusion and regressions around `groupPolicy`, `requireMention`, gateway readiness, channel replies, and group-session runtime selection.
- The local ingress decision tree remains Discord-specific and complex; the live maintainer archive contains a channel-ingress refactor plan to centralize policy semantics while keeping platform facts plugin-owned.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:215` documents the recommended guild workspace shape, with `groupPolicy: "allowlist"` and per-guild `requireMention`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:285` says guild channels do not auto-load `MEMORY.md` and each channel gets its own isolated session.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:302` defines the runtime model, including direct chats sharing main by default and guild channels using isolated `agent:<agentId>:discord:channel:<channelId>` session keys.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:531` documents `open`, `allowlist`, and `disabled` guild policy, the secure baseline, channel allowlists, and fallback allowlist behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:577` documents mention gating, per-guild/channel `requireMention`, reply-to-bot behavior, and group DM defaults.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:599` documents role-based routing through `bindings[].match.roles`.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:736` documents guild history defaults, channel/thread inheritance, thread routing, and the warning that allowlists are trigger gates rather than a redaction boundary.
- `/Users/kevinlin/code/openclaw/docs/channels/discord.md:760` and `/Users/kevinlin/code/openclaw/docs/channels/discord.md:809` document thread-bound sessions and persistent ACP bindings.
- `/Users/kevinlin/code/openclaw/docs/channels/channel-routing.md:30` documents Discord session key shapes, including isolated channel and thread keys.
- `/Users/kevinlin/code/openclaw/docs/channels/channel-routing.md:75` documents route precedence: peer, parent peer, guild plus roles, guild, team, account, channel, default.
- `/Users/kevinlin/code/openclaw/docs/channels/groups.md:17` documents group defaults, mention requirements, and visible reply behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/groups.md:108` documents context visibility limits and notes that allowlists do not create a universal redaction boundary.
- `/Users/kevinlin/code/openclaw/docs/channels/access-groups.md:149` documents `discord.channelAudience` and its fail-closed behavior when member lookup or channel matching fails.

### Source

- `/Users/kevinlin/code/openclaw/extensions/discord/src/group-policy.ts:21` resolves guild and channel policy entries, including account-aware guild lookup and channel-over-guild `requireMention` overrides.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:360` resolves parent threads, member role IDs, configured/runtime bindings, base session keys, and route state before access checks.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:450` denies guild messages when the guild is not configured; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:531` applies `requireMention`; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:543` blocks unauthorized members before expensive media work.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:633` handles mention/skip decisions and records pending history for mention-gated guild messages.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.ts:767` returns the effective route, binding, allowlist, mention, history, and inbound-event state used by dispatch.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight-channel-access.ts:10` evaluates channel disabled state, group DM allowlists, configured channel allowlists, and `groupPolicy` admission.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/allow-list.ts:56` normalizes Discord allowlist entries; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/allow-list.ts:427` resolves channel/thread configs and parent fallback; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/allow-list.ts:529` applies allowlist/disabled policy.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.routing-preflight.ts:21` builds the Discord conversation route with guild ID, member roles, peer, and parent peer.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/route-resolution.ts:28` calls core route resolution with Discord channel, guild, roles, peer, and parent peer; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/route-resolution.ts:84` handles bound session keys.
- `/Users/kevinlin/code/openclaw/src/routing/resolve-route.ts:610` normalizes bindings and session keys; `/Users/kevinlin/code/openclaw/src/routing/resolve-route.ts:722` implements the route-tier order.
- `/Users/kevinlin/code/openclaw/src/routing/session-key.ts:200` builds direct and non-direct session keys; non-direct Discord channels use `agent:<agentId>:<channel>:<peerKind>:<peerId>`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.context.ts:120` builds inbound access context with untrusted channel metadata; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.context.ts:167` includes pending channel history; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.context.ts:212` handles thread starter and parent session context; `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.context.ts:321` builds final inbound event context.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/channel.conversation.ts:98` resolves command conversation IDs across current channel, parent thread, and inbound conversation.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/outbound-session-route.ts:16` parses outbound Discord targets and returns thread-aware route/session details.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/inbound-event-delivery.ts:26` separates room-event correlation from normal message delivery correlation.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/acp-bind-here.integration.test.ts:133` exercises a runtime flow where a Discord conversation is bound to an ACP session and the next turn resolves `boundSessionKey`, `boundAgentId`, and route state.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:108` injects live Discord QA config with `groupPolicy: "allowlist"`, guild/channel `requireMention: true`, and a user allowlist.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:195` configures a tool-only/status scenario with `requireMention: false` and message-tool visible replies.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:288` includes live `discord-canary`, `discord-mention-gating`, and command/status/thread/attachment scenarios.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/discord/discord-live.runtime.test.ts:472` records the current standard live coverage as canary plus mention-gating and lists `allowlist-block`, `top-level-reply-shape`, and `restart-resume` as missing.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/internal/live-smoke.live.test.ts:7` gates a Discord live smoke against `DISCORD_LIVE_TEST` and validates bot identity/gateway metadata.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/macos-discord.ts:27` configures a VM Discord guild/channel with `groupPolicy: "allowlist"` and `requireMention: false`, then `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/macos-discord.ts:48` performs outbound and inbound channel round trips.
- `/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2368` configures release-smoke Discord guild/channel policy, and `/Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts:2601` sends outbound, waits for Discord visibility, posts inbound, waits for installed-CLI readback, and cleans up.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/routing/resolve-route.test.ts:348` checks Discord channel peer binding precedence and session key shape.
- `/Users/kevinlin/code/openclaw/src/routing/resolve-route.test.ts:683` checks parent-peer binding inheritance for threaded conversations.
- `/Users/kevinlin/code/openclaw/src/routing/resolve-route.test.ts:898` checks guild plus role routing, specificity, peer/parent precedence, multiple roles, and guild-only fallback.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:315` checks mention requirement resolution.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:1180` checks authorized unmentioned command behavior under `requireMention`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:1387` and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:1423` check allowlisted guild and thread behavior when guild objects are missing.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:1553` checks recording local image media for skipped mention-gated guild history.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:2010` checks unauthorized guild audio is not transcribed, and `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.preflight.test.ts:2070` checks configured binding plus `requireMention`.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/inbound-context.test.ts:10` checks guild access context from channel config and topic.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/inbound-context.test.ts:71` checks supplemental context sender matching through role allowlists.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/monitor/message-handler.inbound-context.test.ts:14` checks channel metadata stays out of `GroupSystemPrompt` and remains structured untrusted context.
- `/Users/kevinlin/code/openclaw/extensions/discord/src/inbound-context.contract.test.ts:5` checks the finalized Discord inbound context contract.

### Gitcrawl queries

- `gitcrawl doctor --json`: matched `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, and `repository_count=2`.
- `gitcrawl search openclaw/openclaw --query '"Discord" "groupPolicy" "requireMention" guild channel' --json`: surfaced open issues for channel messages not working while DMs work (#87753), allowlist users being silently ignored (#79043), gateway READY never firing for guild messages (#79794), and channel replies dropped under allowlist/`requireMention: false` multi-agent config (#87157).
- `gitcrawl search openclaw/openclaw --query '"Discord" "sessionKey" "guild"' --json`: surfaced channel reply drop (#87157), voice-as-IO needing Discord route session keys (#73699), pre-routing hook discussion for canonical channel session keys (#81061), and inbound activity hook work (#79855).
- `gitcrawl search openclaw/openclaw --query '"Discord" "bindings" "roles" guild' --json`: surfaced a routing/mention-gating issue involving configured Discord bindings (#44502).
- `gitcrawl search openclaw/openclaw --query '"Discord" "historyLimit" thread channel' --json`: returned no hits, which supports the history-window live-evidence gap.

### Discrawl queries

- `discrawl status --json`: requested freshness recorded above; local recheck had the same state, counts, backlog, and share remote with a later generated timestamp.
- `discrawl search --mode fts --limit 10 "discord requireMention"`: showed live maintainer operations toggling guild/channel `requireMention`, enabling unmentioned room events, and discussing bot-loop-safe `allowBots: "mentions"` behavior.
- `discrawl search --mode fts --limit 10 "discord groupPolicy"`: showed user support cases where DMs worked but Discord group/channel sessions failed due to harness/runtime route divergence, plus config examples using `groupPolicy: "allowlist"` and guild user allowlists.
- `discrawl search --mode fts --limit 10 "discord guild session"`: showed archive references that guild channels use isolated `agent:<agentId>:discord:channel:<channelId>` sessions, plus debugging guidance for thread-specific behavior, `requireMention`, allowlists, and session routing.
- `discrawl search --mode fts --limit 10 "discord channel binding"`: showed live discussion of Discord channel replies working in one channel while a specific agent/session looked like a routing or session-binding bug, and another case framed as a channel/agent binding configuration issue.
