---
title: "Slack - Message Delivery and Media Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Message Delivery and Media Maturity Note

## Summary

Slack outbound delivery has substantial implementation breadth: text sends, Block Kit, chunking, reply threading, draft/progress streaming, native streaming/status, ack/typing reactions, delivery receipts, retry helpers, and identity controls. Coverage is Stable because the live lane verifies visible replies and threading behavior, while Quality stays Beta due to active delivery/streaming regressions and user-visible progress confusion in archive history.

## Category Scope

Included in this category:

- Outbound Delivery: Covers Outbound Delivery across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Streaming: Covers Streaming across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Reactions: Covers Reactions across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Media: Covers Media across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Attachments: Covers Attachments across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Files: Covers Files across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Vision: Covers Vision across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.

## Features

- Outbound Delivery: Covers Outbound Delivery across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Streaming: Covers Streaming across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Reactions: Covers Reactions across `message.send` text/block delivery, thread replies, `replyBroadcast`, chunking, and related outbound delivery, streaming, and reactions behavior.
- Media: Covers Media across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Attachments: Covers Attachments across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Files: Covers Files across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.
- Vision: Covers Vision across Slack inbound files, private URL download/auth, media size caps, thread-starter media context, and related media, attachments, files, and vision behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Source and tests cover Slack send/update/upload paths, threading, reply broadcast, streaming modes, preview fallback, reaction idempotency, user-token read/write selection, and live top-level/thread reply behavior.
- Negative signals: Live coverage does not yet cover every streaming mode, native progress task cards, reaction add/remove lifecycle, identity customization, long markdown/rich-text conversion, or reconnect-time delivery recovery.
- Integration gaps: Add live scenarios for progress/native task cards, reaction/typing cleanup, long chunked replies, delivery receipts through hooks, and retry behavior under Slack transient errors.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: `#78103`, `#78536`, `#82258`, `#87748`, `#85612`, `#84271`, `#78046`, `#80749`, `#72896`, `#66614`, and `#57708` show ongoing delivery, streaming, hook correlation, and Slack formatting work.
- Discrawl reports: Release and support discussions mention Slack thread/DM/interactive reply improvements, progress-preview churn, Slack non-DM verbose/tool-progress suppression, and channel delivery correlation fixes.
- Good qualities: Delivery paths have explicit receipt handling, retry wrappers, fallback from failed streaming to normal delivery, thread participation recording, and conservative defaults such as disabled unfurls.
- Bad qualities: Streaming/progress semantics still change frequently, delivery can appear successful while post-processing fails, and Slack-specific rich formatting is still partly pending.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Outbound Delivery, Streaming, Reactions, Media, Attachments, Files, Vision.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live coverage for Slack native task cards and draft preview fallback under failure.
- Add delivery correlation proof from Slack `chat.postMessage` through `message_sent` hooks.
- Add a Slack formatting/rich-text conversion plan for long, structured markdown replies.

## Evidence

### Docs

- `docs/channels/slack.md` documents ack reactions, typing reaction fallback, text streaming, native streaming, progress task cards, media/error fallback, text chunking, unfurls, and thread reply controls.
- `docs/concepts/qa-e2e-automation.md` documents Slack live lane output artifacts and observed-message reports.

### Source

- `extensions/slack/src/send.ts` implements Slack text/block/file sends, `thread_ts`, `reply_broadcast`, DM open behavior, upload completion, and thread participation recording.
- `extensions/slack/src/streaming.ts`, `extensions/slack/src/draft-stream.ts`, `extensions/slack/src/progress-blocks.ts`, and `extensions/slack/src/monitor/message-handler/dispatch.ts` implement draft/stream/progress behavior.
- `extensions/slack/src/actions.ts` and `extensions/slack/src/actions.reactions.test.ts` cover reaction operations.
- `extensions/slack/src/client.ts` centralizes Slack WebClient retry/proxy/write-client behavior.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` verifies canary echo, top-level reply shape, restart-resume, thread follow-up, and thread isolation in a live Slack workspace.
- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.test.ts` asserts scenario coverage and observed-message handling.

### Unit tests

- `extensions/slack/src/send.blocks.test.ts`, `send.identity-fallback.test.ts`, `send.unfurl.test.ts`, `send.upload.test.ts`, `outbound-delivery.test.ts`, and `outbound-payload.test.ts` cover send payload details.
- `extensions/slack/src/streaming.test.ts`, `stream-mode.test.ts`, `draft-stream.test.ts`, `progress-blocks.test.ts`, and `monitor/message-handler/dispatch.streaming.test.ts` cover streaming modes and preview fallback.
- `extensions/slack/src/actions.reactions.test.ts`, `action-runtime.test.ts`, and `client.test.ts` cover reactions, action delivery, and WebClient behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack streaming delivery" --json`
- `gitcrawl search openclaw/openclaw --query "Slack" --json`

Results:

- Returned delivery/streaming issues and PRs including `#87748`, `#78103`, `#78536`, `#82258`, `#66614`, `#57708`, `#85612`, `#80632`, `#84297`, `#72896`, `#80749`, and `#78046`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack streaming progress delivery"`

Results:

- Returned release/support notes about Slack progress-preview behavior, Slack thread/DM/interactive reply improvements, suppression of Slack non-DM verbose/tool-progress delivery, and implemented channel progress/final delivery direction.
