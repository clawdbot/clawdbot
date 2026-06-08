---
title: "Telegram - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Media and Rich Content Maturity Note

## Summary

Telegram media and rich input support is broad: photos, documents, audio, voice,
video, stickers, media groups, reactions, locations, venues, and polls all have
source anchors. It is still Beta because Bot API media limits, SSRF protections,
sticker hydration, text-plus-media delivery, and forum-topic poll behavior create
a large edge matrix.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Message Delivery and Rich Media`
- Score carry-forward: conservative minimum of merged source category scores.

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
- Voice notes: Voice notes, audio files, video notes, captions, stickers, sticker cache, and media download handling
- Poll sending: Poll sending, poll action gates, Telegram poll duration/privacy flags, and answer routing
- Reply threading tags: Reply threading tags, native quotes, reply parameters, reply-chain context, and message targeting
- Durable outbound message recording: Durable outbound message recording, message cache, delivery results, retry, and delivery state
- Inbound media download: Covers Inbound media download, placeholders, file-size handling, media groups, local behavior.
- Voice notes: Covers Voice notes, audio files, video notes, captions, stickers, sticker cache, and behavior.
- Location and venue extraction into channel context: Evidence scope for Location and venue extraction into channel context
- Poll sending: Covers Poll sending, poll action gates, Telegram poll duration/privacy flags, and behavior.
- Reactions: Covers Reactions, ack reactions, reaction notifications, and sent-message cache behavior.

## Features

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  many media branches have unit and runtime tests, and docs explain user-visible
  audio, video, sticker, reaction, location, and poll behavior.
- Negative signals:
  live package scenarios do not cover the whole media/location/poll matrix, and
  several media paths are known to depend on Bot API limits or host networking.
- Integration gaps:
  add live proof for image, document, voice, video note, sticker, location,
  venue, media group, poll, oversized file, and topic-targeted poll delivery.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports:
  #75156, #55917, #40991, #41779, #83748, #86161, #86176, and #80243 show recent
  or open media, sticker, attachment, and edit-action risks.
- Discrawl reports:
  release notes call out channel media fixes, but maintainer/user traffic still
  treats Telegram media and attachment paths as a regression-prone area.
- Good qualities:
  media download is bounded, SSRF policy is explicit, placeholders preserve
  message continuity, poll gates are explicit, and rich inputs are normalized
  into channel context.
- Bad qualities:
  Telegram Bot API file limits, proxy/private-network exceptions, media
  placeholder fallbacks, and sticker/video variants keep operator behavior
  variable.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media and Rich Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Promote location, poll, sticker, and media-group proof into recurring release
  scenarios.
- Add a user-facing media support table for inbound and outbound Telegram types.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents audio,
  video, stickers, reactions, ack reactions, media limits, media group flush,
  Telegram polls, topic targets, and media/network configuration.
- `/Users/kevinlin/code/openclaw/docs/channels/location.md` covers shared
  location behavior.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot/delivery.resolve-media.ts`
  downloads Telegram media with SSRF policy, retry, size handling, trusted local
  roots, and placeholder fallback.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot/body-helpers.ts`
  extracts locations and venues.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.ts`
  carries location and media context into turns.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/send.ts` implements
  media sends, voice/video-note behavior, and `sendPollTelegram`.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/sticker-cache.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/voice.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/poll-visibility.ts`
  implement sticker, voice, and poll-specific behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  records observed media kinds and inline button metadata in live artifacts.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-driver.mjs`
  exercises live Bot API send/getUpdates mechanics used by message and media
  scenarios, though not every media variant.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot.media.downloads-media-file-path-no-file-download.e2e.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot.media.stickers-and-fragments.e2e.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-dispatch.media-dedup.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-dispatch.sticker-media.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/sticker-cache.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/voice.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/poll-visibility.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/send.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Telegram attachment media" --json`

Results:

- #75156 issue open: first assistant reply can deliver text but drop attachment.
- #55917 issue open: Telegram documents sometimes arrive only as
  `<media:document>`.
- #40991 issue open: inbound video can degrade to `<media:video>` placeholder
  when `getFile()` fails.
- #41779 issue open: message action send ignores buffer/filename for Telegram
  attachments.
- #83748 issue open: inbound stickers are not hydrated as agent-readable media.

Query:

`gitcrawl search openclaw/openclaw --query "inline keyboard" --json`

Results:

- #86161 issue open and #86176 PR open: Telegram media message edits need
  caption/reply-markup support.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram media attachment"`

Results:

- `releases`, 2026-05-28: channel delivery cleanup called out Telegram durable
  action replies.
- `general`, 2026-05-28: beta-test request included Telegram durable
  `sendMessage` replies under channel testing.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram"`

Results:

- `clawtributors`, 2026-05-29: user said Telegram DM topics break more often
  and described using 1:1 groups with threads for persistent communication.
