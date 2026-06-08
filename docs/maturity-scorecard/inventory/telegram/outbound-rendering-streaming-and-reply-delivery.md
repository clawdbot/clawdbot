---
title: "Telegram - Message Delivery and Rich Media Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Message Delivery and Rich Media Maturity Note

## Summary

Outbound text, formatting, streaming previews, reply threading, and durable
delivery are among the best-covered Telegram areas. The implementation handles
HTML rendering, fallback, chunking, preview edits, progress lanes, native quote
replies, reply fences, and delivery receipts. Quality remains Beta because recent
issues still show attachment/drop behavior, preview-stream dedupe changes, table
chunking fixes, and user-visible progress behavior churn.

## Category Scope

Included in this category:

- Inbound media download: Inbound media download, placeholders, file-size handling, media groups, local
- Voice notes: Voice notes, audio files, video notes, captions, stickers, sticker cache, and media download handling.
- Location: Location and venue extraction into channel context
- Poll sending: Poll sending, poll action gates, Telegram poll duration/privacy flags, and answer routing.
- Reactions: Reactions, ack reactions, reaction notifications, and sent-message cache
- Text: Text and HTML rendering, Markdown-ish conversion, parse fallback, link preview
- Preview streaming: Preview streaming, progress mode, native tool-progress drafts, reasoning
- Reply threading tags: Reply threading tags, native quotes, reply parameters, reply-chain context, and message targeting.
- Durable outbound message recording: Durable outbound message recording, message cache, delivery results, retry, and delivery state.

## Features

- Inbound media download: Inbound media download, placeholders, file-size handling, media groups, local
- Voice notes: Voice notes, audio files, video notes, captions, stickers, sticker cache, and media download handling.
- Location: Location and venue extraction into channel context
- Poll sending: Poll sending, poll action gates, Telegram poll duration/privacy flags, and answer routing.
- Reactions: Reactions, ack reactions, reaction notifications, and sent-message cache
- Text: Text and HTML rendering, Markdown-ish conversion, parse fallback, link preview
- Preview streaming: Preview streaming, progress mode, native tool-progress drafts, reasoning
- Reply threading tags: Reply threading tags, native quotes, reply parameters, reply-chain context, and message targeting.
- Durable outbound message recording: Durable outbound message recording, message cache, delivery results, retry, and delivery state.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  the codebase has dedicated tests for send, delivery, formatting, draft stream,
  reply parameters, preview streaming, reply fences, lane delivery, and live QA
  streaming scenarios.
- Negative signals:
  live proof is opt-in for some long-final and streaming paths, and it does not
  cover every media-plus-text, reply mode, and error-fallback branch.
- Integration gaps:
  add release proof for selected quote replies, media-bearing final fallback,
  native tool-progress drafts, long chunking, and progress mode under real
  Telegram latency.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  #72860, #75156, #75498, #85098, #83161, #77211, #84558, and #87425 show recent
  churn in media/text delivery, streaming, tables, and tool-only replies.
- Discrawl reports:
  release notes for 2026.5.26 and 2026.5.27 mention Telegram typing/progress,
  durable action replies, and visible reply hardening; contributor chat also
  reported `/verbose`/tool-progress degradation.
- Good qualities:
  delivery is explicit about fallback modes, reply threading, parse failure,
  stale preview cleanup, and durable message recording.
- Bad qualities:
  outbound behavior has many visible modes and recent user-facing regressions,
  so operators can see incorrect delivery even when the gateway remains alive.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound media download, Voice notes, Location, Poll sending, Reactions, Text, Preview streaming, Reply threading tags, Durable outbound message recording.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Keep streaming, reply-threading, and media-bearing final delivery in the
  release smoke set.
- Add user-facing diagnostics for when preview editing is intentionally skipped.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents live stream
  preview, formatting and HTML fallback, reply threading tags, error controls,
  text chunk limits, chunk mode, retry, and reply-chain context.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-dispatch.ts`
  owns reply dispatch, preview streaming, progress lanes, native tool-progress
  drafts, reasoning stream, and delivery fallback.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/send.ts` owns Telegram
  text send, HTML fallback, chunking, retries, typing, edits, and thread params.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/format.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/draft-stream.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/lane-delivery.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/telegram-reply-fence.ts`
  implement rendering, streaming, lanes, and reply fence behavior.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot/delivery.ts` and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot/reply-threading.ts`
  handle final delivery and reply tags.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  includes stream-final, long-final preview reuse, three-chunk final, exact
  marker, and mentioned-message scenarios.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-driver.mjs`
  measures Telegram group reply RTT and observed SUT messages.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/send.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/telegram-outbound.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot/delivery.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/draft-stream.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/format.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/reply-parameters.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/lane-delivery.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/telegram-reply-fence.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/native-tool-progress-draft.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "telegram outbound streaming reply media" --json`

Results:

- #72860 issue open: ordinary assistant replies can lose image attachments while
  text still delivers.
- #75156 issue open: first assistant reply can deliver text but drop attachment.
- #85098 PR open: honor table mode while chunking.
- #83161 PR open: move preview-streamed dedup to channel layer.

Query:

`gitcrawl search openclaw/openclaw --query "telegram" --json`

Results:

- #77211 PR open: preserve default tool progress when preview streaming is off.
- #87425 PR open: preserve `/usage` footer for tool-only replies.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram commands"`

Results:

- `maintainers`, 2026-05-29: release-adjacent fixes included stale Telegram
  wording around `/reasoning stream`.
- `clawtributors`, 2026-05-29: users reported Telegram `/verbose` degradation
  after updating from 5.22 to 5.27.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram media attachment"`

Results:

- `releases`, 2026-05-28: release notes highlighted Telegram durable
  `sendMessage` replies.
- `general`, 2026-05-28: beta-testing call asked users to test Telegram durable
  `sendMessage` replies.
