---
title: "Signal - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Media and Rich Content Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Outbound Delivery, Media, Receipts, and Typing` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Message Delivery and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.

## Features

- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`

Coverage is Beta because docs, source, and tests cover text, media, chunking, delivery receipts, typing, and read receipts, but live Signal delivery proof is absent.

## Quality Score

- Score: `Alpha (68%)`

Quality is Alpha because the send path is structured, but operator history still shows missing link-preview support and unreliable user-visible typing behavior. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Text delivery targets, Media delivery and limits, Typing and read receipts, Styled/chunked output, Reaction action discovery, Add/remove reactions, Group reaction targeting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 263-278 document normalized receive/send behavior, media limits, attachment placeholders, and history capture.
- `docs/channels/signal.md` lines 280-284 document typing and read receipts.
- `docs/channels/signal.md` lines 324-329 document delivery targets for direct and group sends.
- `docs/channels/signal.md` lines 346-363 include outbound troubleshooting commands.

### Source

- `extensions/signal/src/send.ts` resolves account and target, applies approval-reaction hints, enforces media caps, resolves attachments, converts markdown, sends messages, registers reaction targets, and exposes typing/read-receipt helpers.
- `extensions/signal/src/format.ts` converts markdown to Signal text and chunks styled messages without splitting formatting state.
- `extensions/signal/src/channel.ts` implements durable final adapters for text and media and formats outbound chunks using configured limits.
- `extensions/signal/src/monitor/event-handler.ts` fetches attachments, builds placeholders, and sends read receipts after accepted inbound messages.

### Integration tests

- `extensions/signal/src/inbound-context.contract.test.ts` and approval runtime tests exercise internal context and routing contracts.
- No live direct send, group send, media send, typing, read-receipt, or delivery-receipt transcript was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/send.test.ts` covers text receipt timestamps, group media receipts, and avoiding invented platform IDs when Signal returns no timestamp.
- `extensions/signal/src/format.chunking.test.ts` covers basic chunking, style preservation across chunks, and trim/style handling.
- `extensions/signal/src/core.test.ts` covers outbound chunking and durable text/media adapter behavior.
- `extensions/signal/src/monitor.tool-result.pairs-uuid-only-senders-uuid-allowlist-entry.test.ts` covers attachment response caps from `mediaMaxMb`.
- `extensions/signal/src/monitor/event-handler.inbound-context.test.ts` covers typing and read receipt behavior for allowed direct messages.

### Gitcrawl queries

- Query: `Signal typing indicator official clients`
  - Results: open issue `#84120` reports that typing is sent successfully but official clients do not display the indicator.
- Query: `Signal linkPreview config`
  - Results: open issue `#24118` tracks missing `channels.signal.linkPreview` config and send-path pass-through.
- Query: `Signal live tool-call progress`
  - Results: open issue `#77202` tracks live tool-call progress behavior.
- Query: `Signal voice notes MediaPath transcription`
  - Results: issue `#48614` was closed/fixed for voice-note media path and media type population.

### Discrawl queries

- Query: `Signal linkPreview config`
  - Results: Discord GitHub mirror content for issue `#24118` says the gap remains open.
- Query: `Signal typing indicator official clients`
  - Results: no displayed operator transcript showed reliable typing visibility in official clients.
- Query: `Signal voice notes MediaPath transcription`
  - Results: Discord mirror content reported issue `#48614` closed with commit `537a8e25ed`, so that specific media-path issue was treated as fixed.
