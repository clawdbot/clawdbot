---
title: "Microsoft Teams - Webhook and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Webhook and Delivery Maturity Note

## Summary

Teams outbound delivery has a broad source surface for text, media, payloads,
semantic presentation cards, polls, native progress streams, receipts, and
error hints. Coverage remains Alpha because the audit found strong unit and
runtime code but not durable live Teams send/stream/card scenarios. Quality is
also Alpha because recent SDK migration history explicitly fixed user-visible
streaming, adaptive-card, edit/delete, and feedback behavior.

## Category Scope

Included in this category:

- Text formatting and chunking: Covers Text formatting and chunking across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Adaptive and presentation cards: Covers Adaptive and presentation cards across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Progress streaming: Covers Progress streaming across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Delivery receipts and errors: Covers Delivery receipts and errors across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Queued and proactive replies: Covers Queued and proactive replies across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.

## Features

- Text formatting and chunking: Covers Text formatting and chunking across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Adaptive and presentation cards: Covers Adaptive and presentation cards across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Progress streaming: Covers Progress streaming across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Delivery receipts and errors: Covers Delivery receipts and errors across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Queued and proactive replies: Covers Queued and proactive replies across outbound text chunking, markdown table conversion, payload media sequencing, semantic presentation rendering, and related outbound delivery and rendering behavior.
- Webhook Runtime: Covers Webhook Runtime across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- SDK Lifecycle: Covers SDK Lifecycle across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.
- Proactive Cloud Boundary: Covers Proactive Cloud Boundary across webhook server startup, SDK auth/JWT handling, bearer pre-gate, JSON body limits, and related webhook runtime, sdk lifecycle, and proactive cloud boundary behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: Docs and source cover durable text/media/payload delivery,
  native DM progress streams, block fallback, Adaptive Cards, presentation
  cards, and receipts; focused tests cover many outbound seams.
- Negative signals: No checked-in Teams live/e2e scenario was found for actual
  sends, native streaming, cards, presentations, or proactive final replies.
- Integration gaps: Missing live scenario proof for DM native stream close,
  channel/group fallback, Adaptive Card send, presentation send, edit/delete,
  and long-running queued replies.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `msteams streaming adaptive card Action.Execute feedback`
  returned `#76262`, which claims Teams SDK migration fixes around adaptive
  card poll votes, adaptive card CLI sends, feedback, streaming cards, and
  edit/delete behavior.
- Discrawl reports: Focused streaming/adaptive-card search returned no lines,
  but broad `msteams` search included maintainer discussion that `#76262`
  fixes streaming finalization, adaptive card buttons, edit/delete silent
  failures, and Stop mid-stream crash.
- Good qualities: The outbound adapter uses shared payload helpers, supports
  presentation cards, emits receipts, classifies errors, and handles DM native
  progress separately from channel/group fallback behavior.
- Bad qualities: Teams rendering differs from Slack/Discord, select menus
  downgrade to text, native stream support is narrower than all outbound modes,
  and the SDK migration churn is recent.
- Excluded from quality: Unit-test depth, outbound test count, and lack of live
  e2e proof.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Text formatting and chunking, Adaptive and presentation cards, Progress streaming, Delivery receipts and errors, Queued and proactive replies, Webhook Runtime, SDK Lifecycle, Proactive Cloud Boundary.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live Teams outbound scenarios for text chunking, native progress, channel
  fallback, Adaptive Cards, presentation cards, edit/delete, and final queued
  replies.
- Add operator docs for when native stream versus block/progress fallback is
  used.
- Add release proof that SDK migration regressions are closed in a real tenant.

## Evidence

### Docs

- `docs/channels/msteams.md` documents formatting limits, presentation cards,
  target formats, proactive messaging, reply style, and webhook timeout risks.
- `docs/concepts/progress-drafts.md` documents native Teams progress stream in
  personal chats and block delivery behavior.
- `docs/concepts/streaming.md` documents Teams as the native progress-stream
  exception.

### Source

- `extensions/msteams/src/outbound.ts` declares durable text/media/payload
  delivery, text chunking, poll support, presentation capabilities, media
  sequencing, and attached channel receipts.
- `extensions/msteams/src/send.ts` sends messages, polls, cards, media, and
  returns receipts and error hints.
- `extensions/msteams/src/reply-dispatcher.ts` routes in-turn and proactive
  replies and pipes agent events into streaming/progress behavior.
- `extensions/msteams/src/reply-stream-controller.ts` manages native Teams
  stream state, deltas, final close, feedback metadata, and fallback behavior.
- `extensions/msteams/src/presentation.ts` renders semantic presentation
  payloads as Teams Adaptive Cards.

### Integration tests

- No Teams live/e2e outbound lane was found by `rg`.
- The Teams vitest config scopes tests to `extensions/msteams/**/*.test.ts`,
  which is broad but not a live tenant lane.

### Unit tests

- `extensions/msteams/src/outbound.test.ts` covers outbound adapter behavior.
- `extensions/msteams/src/reply-dispatcher.test.ts` covers reply dispatch,
  fallback, and error messages.
- `extensions/msteams/src/reply-stream-controller.test.ts` covers native stream
  delta, close, cancellation, and fallback behavior.
- `extensions/msteams/src/channel.actions.test.ts` covers presentation-card
  rendering and action target validation.
- `extensions/msteams/src/presentation.test.ts` was not present; presentation
  behavior is exercised through channel/action tests.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "msteams streaming adaptive card Action.Execute feedback" --json --limit 10`

Results:

- Returned `#76262`, "fix(msteams): rebase TeamsSDK patterns to simplify Teams
  Integration", with adaptive card and feedback snippets.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams streaming adaptive card outbound proactive"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams"`

Results:

- The focused streaming query returned no lines.
- The broad `msteams` query returned Teams SDK migration discussion that
  referenced user-visible streaming, adaptive card, edit/delete, and feedback
  fixes.
