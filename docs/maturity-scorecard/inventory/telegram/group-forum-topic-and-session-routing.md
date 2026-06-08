---
title: "Telegram - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Telegram - Conversation Routing and Delivery Maturity Note

## Summary

Telegram group, supergroup, forum-topic, and session-routing support is broad but
still one of the riskiest Telegram components. Source and docs cover group IDs,
mention gates, topic config, per-topic agents, ACP topic binding, and thread
aware session keys. Recent archive evidence still shows group and forum-topic
responses routing to the wrong place, so Quality stays Alpha.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Access and Conversation Routing`, `Message Delivery and Rich Media`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- dmPolicy modes: pairing, allowlist, open, and disabled
- Pairing-code approval: Pairing-code approval, first-owner bootstrap, and commands.ownerAllowFrom
- Numeric Telegram user ID normalization with telegram: and tg: prefixes
- allowFrom: allowFrom, groupAllowFrom, access groups, and DM-versus-group boundaries
- Unauthorized DM: Unauthorized DM, group, command, callback, and reaction handling
- Group allowlists: Group allowlists, groupPolicy, groupAllowFrom, and mention gating
- Supergroup negative chat IDs: Supergroup negative chat IDs and group/topic config inheritance
- Forum topic session keys: Forum topic session keys, message_thread_id, General topic behavior, and topic routing.
- ACP topic routing: ACP topic binding and /acp spawn --thread
- Session key construction: Session key construction, conversation route matching, and reply target
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

## Features

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  group config, group access, topic conversation IDs, thread bindings, route
  tests, and live group mention scenarios are all present.
- Negative signals:
  live proof is strong for bot-to-bot group mentions but thinner for forum
  topics, per-topic agents, ACP topic binding, group migration, and reply-chain
  recovery.
- Integration gaps:
  add recurring live proof for supergroup topics, General topic, DM topics,
  per-topic `agentId`, ACP topic binding, group migration, and route recovery
  after restart.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  #77576 and #86262 report Telegram group/topic replies routing through webchat
  or DM instead of Telegram; #80804 reports forum topic `sendMessage` failing
  with `chat not found`.
- Discrawl reports:
  release notes and user discussion call out Telegram forum-topic reliability,
  topic/progress fixes, and users relying on 1:1 groups with threads to work
  around DM-topic behavior.
- Good qualities:
  the routing model is explicit, deterministic, and topic-aware; docs warn about
  group IDs versus sender IDs and explain topic inheritance.
- Bad qualities:
  wrong-route regressions directly break the user-visible channel contract, and
  topic/session behavior is complex enough that operator expectations remain
  fragile.
- Excluded from quality:
  unit coverage, integration coverage, live QA breadth, and test count were not
  used as Quality inputs.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/telegram.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Conversation Routing and Delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Promote forum-topic and per-topic-agent live scenarios into release smoke.
- Add direct diagnostics for "why did this group or topic reply route here?"
- Keep group/topic routing below core DM maturity until the open route
  regressions are closed.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/telegram.md` documents group
  policy, mention behavior, forum topics, topic inheritance, per-topic agents,
  ACP topic binding, and DM topic routing.
- `/Users/kevinlin/code/openclaw/docs/channels/groups.md` and
  `/Users/kevinlin/code/openclaw/docs/channels/channel-routing.md` provide the
  shared group and routing context.
- `/Users/kevinlin/code/openclaw/docs/concepts/multi-agent.md` is linked for
  multi-agent routing.

### Source

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.ts`
  resolves forum flags, topic IDs, group/topic config, route, and session
  metadata.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/conversation-route.ts`
  and `/Users/kevinlin/code/openclaw/extensions/telegram/src/topic-conversation.ts`
  define Telegram route/session shapes.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/thread-bindings.ts`
  and `/Users/kevinlin/code/openclaw/extensions/telegram/src/threading-tool-context.ts`
  implement topic-bound tool context and ACP bindings.
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-policy.ts`,
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-access.ts`, and
  `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-config-helpers.ts`
  implement group/topic policy.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/telegram/telegram-live.runtime.ts`
  includes `telegram-mentioned-message-reply`, `telegram-mention-gating`, and
  current-session status scenarios.
- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-telegram-rtt-driver.mjs` sends
  group mentions and verifies SUT replies in the target Telegram group.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/telegram/src/topic-conversation.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.thread-binding.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.topic-agentid.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.dm-topic-threadid.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/bot-message-context.acp-bindings.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/session-route.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/thread-bindings.test.ts`
- `/Users/kevinlin/code/openclaw/extensions/telegram/src/group-migration.test.ts`

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Telegram group session responses route webchat" --json`

Results:

- #77576 issue open: Telegram group session responses route to webchat instead
  of back to Telegram.
- #80804 issue open: Telegram `sendMessage` fails with `chat not found` for a
  supergroup forum topic.

Query:

`gitcrawl search openclaw/openclaw --query "telegram forum topic routing session webchat dm" --json`

Results:

- #86262 issue open: Telegram forum topic responses route to DM instead of
  group.
- #80804 issue open: forum topic send failure despite admin permissions and a
  working direct API call.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram forum topic"`

Results:

- `general`, 2026-05-26: user called out Telegram/forum-topic reliability as
  adding value.
- `releases`, 2026-05-27: release notes stated Telegram keeps
  typing/progress and forum-topic context.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "telegram group routing"`

Results:

- `maintainer-security-ops`, 2026-05-27: discussion described group-history and
  tool authorization as cross-channel trust semantics.
- `clawtributors`, 2026-05-08: release/regression sweep listed Telegram group
  routing among pressing issues.
