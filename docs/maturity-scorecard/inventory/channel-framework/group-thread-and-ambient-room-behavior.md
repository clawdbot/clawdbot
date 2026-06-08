---
title: "Channel framework - Group Thread and Ambient Room Behavior Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Channel framework - Group Thread and Ambient Room Behavior Maturity Note

## Summary

Group, thread, and ambient room behavior is well documented and has a real cross-channel model: group sessions are isolated from DMs, mention and allowlist gates control activation, group history can be retained for context, ambient room events can listen silently, and thread/session policies route native threads and topics.

The maturity limit is uneven provider support and operational complexity. The model works across major channels, but archive evidence shows thread binding and ambient/group semantics continue to change, and docs still contain provider-specific exceptions that operators must reconcile.

## Category Scope

Included in this category:

- Group/channel session isolation: Group/channel session isolation and group history context
- Mention-required: Mention-required, always-on, and ambient room-event modes
- Native threads: Native threads, topics, parent-child bindings, and thread spawn behavior
- Broadcast groups: Broadcast groups and multi-agent group routing
- Bot-loop protection: Bot-loop protection for room behavior

## Features

- Group/channel session isolation: Group/channel session isolation and group history context
- Mention-required: Mention-required, always-on, and ambient room-event modes
- Native threads: Native threads, topics, parent-child bindings, and thread spawn behavior
- Broadcast groups: Broadcast groups and multi-agent group routing
- Bot-loop protection: Bot-loop protection for room behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals:
  - Docs cover group visible replies, group access, trigger authorization, context visibility, session keys, mention behavior, group history, ambient room events, and broadcast groups (`docs/channels/groups.md:21`, `docs/channels/groups.md:112`, `docs/channels/groups.md:149`, `docs/channels/groups.md:321`, `docs/channels/groups.md:373`, `docs/channels/ambient-room-events.md:11`, `docs/channels/broadcast-groups.md:21`).
  - Source covers thread binding policy, route projection, conversation resolution, turn-kernel group-history cleanup, bot-loop protection in dispatch, and session metadata.
  - Unit tests directly exercise thread binding policy, route projection, conversation resolution, and turn-kernel behavior for group history and bot-pair drops.
  - Provider docs for Discord and Matrix have detailed native thread behavior.
- Negative signals:
  - Ambient room-event support is explicitly limited to select channels.
  - Group behavior varies by channel and operator docs rely on multiple pages plus provider-specific sections.
  - Archive evidence shows thread/session binding remains active work, especially for Discord.
- Integration gaps:
  - No broad live group/ambient/thread matrix was found across Slack, Discord, Telegram, Matrix, WhatsApp, and Signal.
  - Broadcast groups have extensive docs, but stronger live proof was not found in this audit pass.

## Quality Score

- Score: `Alpha (68%)`
- Quality rationale:
  - The design is coherent but difficult: groups can be mention-gated, always-on, ambient-only, message-tool-only, broadcast, thread-bound, or provider-topic scoped.
  - The docs are detailed and honest about provider differences, but the surface remains easy to misconfigure.
  - Recent archive evidence around Discord thread binding and parent sessions indicates this area is still settling.
- Main quality risks:
  - Operators may confuse DM pairing with group authorization, or automatic visible replies with message-tool-only visible delivery.
  - Provider-specific thread grammars and parent fallbacks make cross-channel mental models fragile.
  - Ambient room support is not universal, which reduces predictability for "listen silently" use cases.
- Quality scoring excludes test quantity; tests are recorded only as coverage evidence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/channel-framework.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Group/channel session isolation, Mention-required, Native threads, Broadcast groups, Bot-loop protection.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a cross-channel room-mode matrix for group, channel, MPIM, thread, topic, and ambient support.
- Add a route/activation trace for group drops, ambient observation, and visible-reply suppression.
- Add live conformance for broadcast groups and ambient room events across all channels that claim support.

## Evidence

### Docs

- `docs/channels/groups.md:21` through `docs/channels/groups.md:29` describe visible replies and group access controls.
- `docs/channels/groups.md:46` through `docs/channels/groups.md:54` describe automatic versus message-tool visible replies.
- `docs/channels/groups.md:112` through `docs/channels/groups.md:126` distinguish trigger authorization from context visibility.
- `docs/channels/groups.md:149` through `docs/channels/groups.md:152` define group/channel/topic/direct-chat session behavior and skipped group heartbeats.
- `docs/channels/groups.md:321` through `docs/channels/groups.md:323` document mention-required groups and implicit mentions.
- `docs/channels/groups.md:371` through `docs/channels/groups.md:373` document room-event storage and uniform group history context.
- `docs/channels/group-messages.md:11` through `docs/channels/group-messages.md:27` documents WhatsApp-specific activation, per-group sessions, pending context, and group prompt behavior.
- `docs/channels/ambient-room-events.md:11` through `docs/channels/ambient-room-events.md:15` define ambient room events and supported channels.
- `docs/channels/ambient-room-events.md:177` through `docs/channels/ambient-room-events.md:191` describe visible reply modes, history limits, and Discord room-event history retention.
- `docs/channels/broadcast-groups.md:21` and `docs/channels/broadcast-groups.md:179` define broadcast evaluation after allowlists/activation and non-bypass semantics.
- `docs/channels/discord.md:736` through `docs/channels/discord.md:868` and `docs/channels/matrix.md:504` through `docs/channels/matrix.md:532` document native thread behavior.

### Source

- `src/channels/thread-bindings-policy.ts:50` through `src/channels/thread-bindings-policy.ts:257` implements thread placement, idle state, spawn policy, and errors.
- `src/channels/conversation-resolution.ts:265` through `src/channels/conversation-resolution.ts:294` handles threading context and default binding placement.
- `src/channels/route-projection.ts:84` through `src/channels/route-projection.ts:153` projects routes from conversations and compares delivery targets.
- `src/channels/turn/kernel.ts:188` through `src/channels/turn/kernel.ts:225` handles dropped history with media; `src/channels/turn/kernel.ts:768` clears pending group history after successful prepared turns.
- `src/channels/turn/kernel.ts:669` and `src/channels/turn/kernel.ts:964` drop bot-loop-protected prepared/direct turns before record and dispatch.
- `src/channels/session.ts:32` through `src/channels/session.ts:80` records inbound session metadata used by group/thread route persistence.

### Integration tests

- `src/gateway/gateway-acp-bind.live.test.ts:565` covers a live Slack-shaped conversation binding and reroute path, adjacent to thread/session routing.
- `scripts/e2e/mcp-channels-docker-client.ts:254` and `scripts/e2e/mcp-channels-docker-client.ts:311` exercise channel conversation and attachment paths through the MCP channel harness.
- No all-channel live ambient/group/thread matrix was found.

### Unit tests

- `src/channels/thread-bindings-policy.test.ts:11` through `src/channels/thread-bindings-policy.test.ts:110` covers child placement, thread-here, default thread-bound spawns, `spawnSessions`, and account overrides.
- `src/channels/conversation-resolution.test.ts:140` through `src/channels/conversation-resolution.test.ts:437` covers parent/thread fallback, topic normalization, inbound thread IDs, Matrix room casing, rejection, and placement metadata.
- `src/channels/route-projection.test.ts:80` through `src/channels/route-projection.test.ts:164` covers parent-child projections, session binding records, last-route priority, and delivery-target comparison.
- `src/channels/turn/kernel.test.ts:669` through `src/channels/turn/kernel.test.ts:1023` covers bot-loop drops, observe-only admission, group history cleanup, preflight drops, repeated bot-pair drops, and observe-only room-event-style flow.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --query "channel groups threads ambient room events mention gating" --json --limit 8`

Results:

- Returned no hits, which is neutral after freshness checks for that exact cross-channel query.

Query: `gitcrawl search openclaw/openclaw --query "Discord thread binding channel parent session" --json --limit 8`

Results:

- Returned issue #64199, PR #64322, issue #53548, PR #81341, issue #87599, PR #82023, PR #81402, and PR #74163, showing a substantial archive cluster around Discord thread binding and parent-session behavior.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl --json search "channel groups threads ambient room events mention gating" --limit 8`

Results:

- Returned null, which is neutral after freshness checks.

Query: `/Users/kevinlin/.local/bin/discrawl --json search "Discord thread binding channel parent session" --limit 8`

Results:

- Found implementation discussion for parent binding inheritance and thread-bound subagent spawning.
- Found a live user error around session binding adapter failure and review discussion around Discord thread binding behavior.
