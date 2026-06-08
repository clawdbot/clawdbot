---
title: "Slack - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Conversation Routing and Delivery Maturity Note

## Summary

Slack channel and thread routing is one of the better-covered Slack families. Docs and source model channel IDs, mention gates, bot/user allowlists, `replyToMode`, `thread_ts`, session suffixes, thread starter context, and live thread follow-up/isolation. Quality remains Beta because archive history shows active fixes around thread session continuity, assistant DM thread fan-out, interaction thread status, and confusing `replyToMode` expectations.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Conversation Access and Routing`, `Message Delivery and Media`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Channel allowlists: Covers channel allowlists, `groupPolicy`, channel/user gates, mention gates, and subteam mention behavior.
- Thread routing: Covers Slack thread routing, thread-aware reply targeting, and session binding for channel threads.
- Session Isolation: Covers Session Isolation across channel allowlists, `groupPolicy`, channel/user gates, mention and subteam mention behavior, and related channel/thread routing and session isolation behavior.
- DM Pairing: Covers DM Pairing across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.
- Sender Authorization: Covers Sender Authorization across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.
- Outbound Delivery: Covers Outbound Delivery across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Streaming: Covers Streaming across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Reactions: Covers Reactions across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Media: Covers Media across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Attachments: Covers Attachments across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Files: Covers Files across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Vision: Covers Vision across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Outbound Delivery: Covers Outbound Delivery across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior
- Streaming: Covers Streaming across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior
- Reactions: Covers Reactions across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior
- Media: Covers Media across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior
- Attachments: Covers Attachments across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior
- Files: Covers Files across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior
- Vision: Covers Vision across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior

## Features

- Channel allowlists: Covers channel allowlists, `groupPolicy`, channel/user gates, mention gates, and subteam mention behavior.
- Thread routing: Covers Slack thread routing, thread-aware reply targeting, and session binding for channel threads.
- Session Isolation: Covers Session Isolation across channel allowlists, `groupPolicy`, channel/user gates, mention and subteam mention behavior, and related channel/thread routing and session isolation behavior.
- DM Pairing: Covers DM Pairing across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.
- Sender Authorization: Covers Sender Authorization across Slack DM routing, `dmPolicy`, `allowFrom`, pairing approvals, group DMs/MPIMs, account-level allowlist inheritance, command authorization in DMs, and sender identity normalization.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: The live Slack lane includes mention gating, allowlist block, top-level reply shape, restart-resume, thread follow-up, and thread isolation; unit tests cover thread routing, session keys, mention bypass, reply modes, channel gates, and assistant-thread context.
- Negative signals: Live coverage does not yet exercise user-group mentions, bot-authored room messages, channel-name migration, channel-audience membership failures, or all `replyToMode` variants.
- Integration gaps: Add live tests for `replyToMode=first|batched`, `thread.inheritParent`, `thread.requireExplicitMention`, bot-authored channel messages, subteam mention routing, and channel ID migration.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `#78061`, `#80632`, `#85904`, `#82895`, `#63230`, `#87019`, `#63840`, `#63904`, `#61502`, and `#62066` show active thread-routing, assistant-thread, reply-broadcast, and implicit-mention concerns.
- Discrawl reports: The Slack `replyToMode: all` support thread describes a real document-review workflow where the first channel turn and later thread session split context unexpectedly.
- Good qualities: Source now seeds eligible top-level roots into thread sessions, preserves Slack `thread_ts`, keeps top-level replies isolated, and records Slack thread participation.
- Bad qualities: Thread behavior is hard to reason about because Slack hides thread replies from the channel, assistant-thread events introduce extra `thread_ts` shapes, and operator expectations often differ from session-model semantics.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channel allowlists, Thread routing, Session Isolation, DM Pairing, Sender Authorization.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live document-review style scenario proving first channel mention plus file upload transitions cleanly to a thread-scoped session.
- Add a generated thread-routing decision trace for `replyToMode`, `thread.inheritParent`, and implicit mention bypass.
- Add explicit scorecard coverage for Slack assistant app DM thread collapse versus per-thread isolation.

## Evidence

### Docs

- `docs/channels/slack.md` documents channel policy, stable channel ID requirements, mention sources, per-channel controls, thread session keys, `replyToMode`, `thread.requireExplicitMention`, and manual reply tags.
- `docs/channels/bot-loop-protection.md` and `docs/channels/channel-routing.md` are linked shared behavior references.

### Source

- `extensions/slack/src/monitor/message-handler/prepare.ts` resolves authorization, mention state, seeded thread routing, assistant thread context, thread starter history, and final turn metadata.
- `extensions/slack/src/threading.ts`, `extensions/slack/src/thread-ts.ts`, `extensions/slack/src/threading-tool-context.ts`, and `extensions/slack/src/action-threading.ts` normalize Slack thread ids and action-thread inheritance.
- `extensions/slack/src/channel.ts` exposes Slack threading behavior to the channel plugin.
- `extensions/slack/src/monitor/message-handler/subteam-mentions.ts` handles Slack user-group mention behavior.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` defines `slack-mention-gating`, `slack-allowlist-block`, `slack-top-level-reply-shape`, `slack-thread-follow-up`, and `slack-thread-isolation`.
- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.test.ts` asserts the standard live transport scenario list includes thread follow-up and isolation.

### Unit tests

- `extensions/slack/src/action-threading.test.ts` covers same-channel auto-threading and fail-closed missing thread timestamps.
- `extensions/slack/src/action-runtime.test.ts` covers `replyToMode=all|first|off`, explicit thread overrides, reads in threads, and allowlisted target reads.
- `extensions/slack/src/monitor/message-handler/prepare-thread-context.test.ts`, `prepare-thread-context-root.test.ts`, `prepare.thread-session-key.test.ts`, `monitor.threading.missing-thread-ts.test.ts`, and `threading.test.ts` cover Slack thread preparation.
- `src/auto-reply/reply/session.test.ts`, `reply-plumbing.test.ts`, and `route-reply.test.ts` cover Slack session/thread routing from the shared reply path.

### Gitcrawl queries

Query:

- `gitcrawl search issues "Slack channel requireMention thread_ts replyToMode session routing" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "slack thread" --json`

Results:

- The focused issue search returned `[]`.
- The broader query returned open Slack thread/session items including `#80632`, `#85904`, `#49747`, `#82895`, `#78061`, `#82886`, `#63230`, `#87019`, `#63904`, `#61502`, and `#62066`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack thread replyToMode requireExplicitMention"`

Results:

- Returned a detailed support thread about `replyToMode: all` processing the first message in the channel main session, then creating a new thread session without prior tool/thinking context; also returned `#63389` about documented `thread.requireExplicitMention` being rejected by older config.
