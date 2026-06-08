---
title: "Matrix - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Media and Rich Content Maturity Note

## Summary

Matrix outbound delivery has wide feature support: text chunking, media upload,
encrypted media payloads, polls, typing, read receipts, edits, mentions,
reactions, payload metadata, draft previews, quiet mode, block streaming, and
fallback delivery. Coverage is Beta because docs, source, unit tests, and Matrix
QA cover many paths. Quality is Alpha because gitcrawl has open reports for
image handling, send queue failures, reasoning delivery, and mention rendering.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Messaging and Room Tools`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Channel action discovery: Channel action discovery, account-scoped action gates, and tool schemas
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools.
- Profile media loading: Profile media loading from URL or local path.
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior.
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior.
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies.

## Features

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs cover streaming previews, quiet mode push rules, approval metadata,
    reactions, history context, and reply behavior config.
  - Source implements text chunking, media upload, encrypted media, polls,
    typing/read receipts, live markers, edits, reactions, and target
    resolution.
  - Unit tests cover outbound text/media, media fanout, message presentation,
    encrypted media, mentions, chunked sends, edits, polls, draft stream, and
    media failure fallbacks.
  - Matrix QA covers streaming previews, tool progress, block streaming, image
    understanding, image generation, and every Matrix media msgtype with
    caption-triggered replies.
- Negative signals:
  - Open archive reports show outbound/media behavior remains a major
    user-facing risk.
  - Coverage is broad but fragmented across outbound adapter tests, send tests,
    monitor handler tests, and QA scenarios.
- Integration gaps:
  - Add a single release-critical live media lane that covers upload, download,
    encrypted media, caption mentions, and final delivery.
  - Add a live reasoning-delivery lane for Matrix when reasoning is enabled.
  - Tie Matrix send queue diagnostics to failed outbound QA artifacts.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "matrix outbound media streaming mention rendering"` returned no hits.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned open issue #85620 for inbound image unresolved turns and send queue fetch failures, open issue #81892 for reasoning not delivered, open issue #80432 for outbound mention rendering without Matrix pills or mention metadata, and open PR #83156 for bracketed display-name mention labels.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix outbound media streaming"` returned March 2026 release/changelog discussion mentioning Matrix draft streaming plus room history as a user-visible feature.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned release chatter mentioning Matrix mention behavior.
- Good qualities:
  - Send code separates payload conversion, target resolution, media upload,
    content construction, chunks, edits, reactions, and receipts.
  - Draft streaming has explicit throttling, single-event limits, no-op skips,
    stop/finalize behavior, and fallback markers.
  - Mention rendering intentionally creates `m.mentions` and Matrix.to anchors
    for qualified user and room mentions while avoiding active mentions in
    unsafe contexts.
  - Encrypted media upload includes thumbnail and file payload handling.
- Bad qualities:
  - Media and streaming have open user-facing issues and operational reports.
  - Matrix mention rendering is subtle and has recent active fixes.
  - Send queue/fetch failures can cascade into unresolved turns and gateway
    reloads.
  - Reasoning delivery has a direct open Matrix report.
- Excluded from quality:
  - I did not raise or lower Quality because of unit, integration, e2e, live, or
    runtime test coverage.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media and Rich Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Close or retest #85620, #81892, and #80432 before raising Quality above Alpha.
- Add direct QA coverage for reasoning payload delivery on Matrix.
- Record failure artifacts for Matrix send queue fetch failures and unresolved
  media turns.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:183` documents
  streaming preview modes, quiet mode push rules, and approval metadata.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:568` documents Matrix
  reactions.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:589` documents
  history context and context visibility.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:831` documents reply
  behavior, reaction settings, and tooling config.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.ts:160`
  prepares and chunks Matrix text.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.ts:211`
  sends text and media with resolved rooms, relations, upload media, content,
  followups, and receipts.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.ts:366`
  sends Matrix poll events.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.ts:450`
  handles single-message sends, text limits, and live markers.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.ts:542`
  edits Matrix messages with mention diffing and live markers.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send/media.ts:61`
  builds media content and metadata.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send/media.ts:203`
  uploads encrypted media.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/draft-stream.ts:49`
  implements the Matrix draft stream and single-event preview limit.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/outbound.ts:96`
  adapts shared outbound payloads to Matrix text, media, polls, and
  presentation metadata.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2875`
  captures quiet preview notices before the finalized Matrix reply.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:2957`
  captures partial preview text messages before the finalized reply.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:3091`
  captures Matrix tool progress inside the quiet preview before finalizing.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4074`
  preserves separate finalized block events when block streaming is enabled.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4181`
  sends a real Matrix image attachment for image-understanding prompts.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4277`
  waits for a real Matrix image attachment after image generation.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4366`
  covers every Matrix media msgtype with caption-triggered replies.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/outbound.test.ts:65`
  covers resolved config for text sends.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/outbound.test.ts:93`
  covers resolved config for media sends.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/outbound.test.ts:381`
  covers sending all media URLs via `sendPayload`.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/outbound.test.ts:468`
  guards against silently dropped media URLs.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.test.ts:225`
  covers media upload with URL payloads.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.test.ts:249`
  covers encrypted media with file payloads.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.test.ts:486`
  covers Matrix mention anchors and `m.mentions`.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/send.test.ts:596`
  covers thread relation metadata.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/draft-stream.test.ts:212`
  covers normal text previews.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/draft-stream.test.ts:507`
  covers fallback when preview text exceeds one Matrix event.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/media.test.ts:54`
  covers encrypted media download.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/monitor/handler.media-failure.test.ts:157`
  covers fallback markers for failed image downloads.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "matrix outbound media streaming mention rendering"`
  returned no hits.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned #85620,
  #81892, #80432, #83156, and other Matrix outbound-adjacent hits.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix outbound media streaming"`
  returned release discussion for Matrix draft streaming and room history.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned release chatter mentioning Matrix mention behavior.
