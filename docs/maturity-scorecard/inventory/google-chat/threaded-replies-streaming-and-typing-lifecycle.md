---
title: "Google Chat - Threaded Replies Streaming and Typing Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Threaded Replies Streaming and Typing Lifecycle Maturity Note

## Summary

Threaded reply and typing lifecycle is the weakest high-traffic Google Chat family. The source has explicit thread fields, API fallback options, durable reply behavior, and typing placeholder update/fallback logic, but current archive evidence is dense with open thread leakage, stale typing placeholder, raw markdown, `replyToMode`, and message-tool delivery issues.

## Category Scope

This note covers inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, block streaming coalescing, durable final replies, typing indicator modes, placeholder update/delete/fallback behavior, `NO_REPLY` lifecycle, and message-tool current-source reply placement. It excludes setup/auth, space admission policy, media upload auth, and generic reply-pipeline behavior outside the Google Chat adapter.

## Features

- Thread-aware replies: Covers Thread-aware replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Streaming and chunked replies: Covers Streaming and chunked replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Typing placeholder lifecycle: Covers Typing placeholder lifecycle across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Message-tool current-source replies: Covers Message-tool current-source replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- NO_REPLY cleanup: Covers NO_REPLY cleanup across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Markdown/text rendering: Covers Markdown/text rendering across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (57%)`
- Positive signals: Local tests cover DM thread metadata omission, bot-loop suppression before typing, reaction-mode fallback warnings, and reply-delivery paths such as typing placeholder update/delete and media+text fallback. The API sender sets Google Chat's threaded-message fallback option when a thread is provided.
- Negative signals: I found no live Google Chat threaded-reply scenario and no standard release smoke proving long streamed replies, message-tool visible replies, queued follow-ups, `replyToMode: "off"`, and `NO_REPLY` cleanup in a real Google Chat space thread.
- Integration gaps: Add live thread scenarios for short reply, long chunked reply, block streaming, message-tool reply to current source, explicit `replyToMode: "off"`, media+text reply, and `NO_REPLY` after reaction/action-only output.

## Quality Score

- Score: `Alpha (52%)`
- Gitcrawl reports: Open issues include #80995 for message-tool replies escaping threads, #82014 for message-tool replies not editing typing placeholders, #44347 for basic threaded replies and all-message space delivery, #42510 for `replyToMode: "off"` not suppressing threads, #69422 for thread metadata leaking across streamed block replies, #39843 for typing indicators persisting after `NO_REPLY` plus reaction, and #49350 for raw markdown plus wrong typing identity. Closed #64313/#70041 show recent thread retry/chunk-placement fixes but do not erase the active open set.
- Discrawl reports: `discrawl search "Google Chat thread replies" --limit 10` returned beta release testing requests for Google Chat DM thread behavior, #69422 reproduction comments, #70041 chunk leakage, and #64313 thread fallback discussion. `discrawl search "Google Chat typing indicator" --limit 10` returned #39843, #71498, #70923, #67055, #65570, and related comments around stale typing and silent text-loss fixes.
- Good qualities: The adapter uses Google Chat's thread name in context, sets `messageReplyOption` for thread fallback, can update a typing placeholder into the first chunk, deletes placeholders before media sends, falls back to fresh sends if edits fail, and makes reaction typing mode explicit as unsupported with service-account auth.
- Bad qualities: The reply model still leaks channel-specific lifecycle details. Message-tool replies bypass normal placeholder cleanup, block-streamed chunks can lose thread identity, `NO_REPLY` can leave visible typing messages, markdown rendering does not match Google Chat expectations, and reply mode semantics have drifted from user expectation.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (57%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Make thread identity a first-class outbound field across reply payloads, block coalescing, follow-up queues, message-tool sends, and delivery receipts.
- Clean typing placeholders for current-source message-tool replies and exact `NO_REPLY` paths.
- Ensure `replyToMode: "off"` suppresses all Google Chat thread propagation, including typing messages and media replies.
- Convert or strip Markdown consistently for Google Chat's plain-text rendering rules.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents group/DM session keys, `replyToMode`, `typingIndicator`, message actions, threading target fields, and troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/gateway/config-agents.md`: documents `blockStreamingCoalesce` and notes Google Chat defaults among channel overrides.
- `/Users/kevinlin/code/openclaw/docs/concepts/message-lifecycle-refactor.md`: calls out Google Chat receive/send adapter behavior with thread relations mapped to spaces and thread ids.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.ts`: extracts inbound `message.thread.name`, builds reply context, sends typing messages, and routes delivery through the shared channel inbound runner.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-durable.ts`: only enables durable final fallback when no typing placeholder owns visible delivery.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-reply-delivery.ts`: updates or deletes typing placeholders, chunks text, sends media replies, uploads attachments, and falls back when placeholder edits fail.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/api.ts`: sends messages with optional `thread` body and `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.adapters.ts`: configures outbound chunking, direct delivery mode, and thread/reply target handling for attached results.

### Integration tests

- No dedicated live Google Chat thread/typing scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-flow.e2e.test.ts` covers WebChat, not Google Chat, and was treated as out of scope.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.test.ts`: covers bot-loop suppression before typing and DM reply context omitting thread metadata.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.reply-delivery.test.ts`: covers Google Chat reply-delivery behavior around typing messages, text/media delivery, and fallback paths.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: covers channel plugin metadata/capabilities adjacent to threading and block streaming.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/actions.test.ts`: covers message-tool sends with `threadId`, which is relevant to current-source reply placement.

### Gitcrawl queries

Query:

`gitcrawl search issues "Google Chat" --repo openclaw/openclaw --limit 20 --json number,title,state,updatedAt,url`

Results:

- Returned open thread/typing issues #80995, #82014, #44347, #49350, #42510, #69422, and #39843.

Query:

`gitcrawl gh issue view 69422 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #69422, reporting streamed Google Chat chunks landing outside the original thread because outbound/coalescer identity does not carry thread metadata.

Query:

`gitcrawl gh issue view 82014 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #82014, reporting message-tool replies bypass the Google Chat placeholder update lifecycle and leave stale `_BotName is typing..._` messages.

Query:

`gitcrawl gh issue view 39843 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #39843, reporting a persistent typing indicator after a reaction plus `NO_REPLY` flow.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat thread replies" --limit 10`

Results:

- Returned release-testing guidance for Google Chat DM thread behavior, #69422 reproduction discussion, #70041 chunk leakage, and #64313 thread fallback comments.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat typing indicator" --limit 10`

Results:

- Returned active and recent typing-lifecycle discussions including #39843, #71498, #70923, #67055, and #65570, covering stale placeholders, silent text loss, replyToMode, and media+text cleanup.
