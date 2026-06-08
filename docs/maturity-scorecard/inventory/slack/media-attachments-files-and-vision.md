---
title: "Slack - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Media and Rich Content Maturity Note

## Summary

Slack media support includes inbound private-file downloads, file placeholders, media-store writes, thread-root attachment inheritance, multi-attachment handling, `download-file`, outbound uploads, upload caps, and image/vision handoff. This is the weakest Slack coverage family because the live Slack QA standard lane does not currently exercise files/media, and archive evidence shows repeated attachment failures, download auth bugs, thread media rehydration bugs, and silent media-delivery confusion.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Message Delivery and Media`
- Score carry-forward: conservative minimum of merged source category scores.

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

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: Unit/runtime tests cover inbound Slack media resolution, download-file auth, upload-file routing, scope checks, media caps, non-image metadata, and thread-root media handling.
- Negative signals: The standard Slack live lane omits media, file upload/download, multi-attachment, PDF, image vision, oversized rejection, and root-thread media inheritance scenarios.
- Integration gaps: Add live media cases for image, PDF, multiple files, expired private URLs, oversized files, thread-root media inheritance, outbound upload with `thread_ts`, and `download-file` through user-token/bot-token variants.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `#63905`, `#62792`, `#60335`, `#60353`, `#83165`, `#63588`, `#41657`, and `#53932` show active and recurring media/download/thread issues.
- Discrawl reports: The feature-specific Slack media searches returned no focused recent Discord-archive messages, while broader GitHub mirrored discussions show Slack file upload/download and missing-scope setup confusion.
- Good qualities: The implementation bounds downloads, keeps processing when one attachment fails, exposes file IDs for `download-file`, and separates image attachments from generic file/PDF metadata.
- Bad qualities: Media failure modes are user-visible and hard to diagnose, thread starter media has regressed before, and live proof trails the number of file and media combinations users actually try.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media and Rich Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a Slack live media lane or optional scenarios for inbound image/PDF/files, multi-attachment, outbound upload, and `download-file`.
- Add clearer user-facing copy when Slack private URL download fails or only a placeholder reaches the agent.
- Add release-gate evidence for thread-root media inheritance and "do not reattach parent media on every reply."

## Evidence

### Docs

- `docs/channels/slack.md` documents inbound attachments, outbound text/files, delivery targets, attachment vision reference, supported media types, thread-root attachment inheritance, multi-attachment behavior, size caps, download failures, and known limits.
- `docs/channels/slack.md` links media understanding and PDF tool references for downstream handling.

### Source

- `extensions/slack/src/monitor/media.ts` handles inbound Slack media resolution.
- `extensions/slack/src/file-reference.ts`, `extensions/slack/src/actions.ts`, and `extensions/slack/src/send.ts` support file references, download-file, and outbound uploads.
- `extensions/slack/src/monitor/message-handler/prepare.ts` selects direct media or thread-starter media and adds media context to turns.
- `extensions/slack/src/limits.ts` and `extensions/slack/src/media-types.ts` support payload limits and type handling.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` has no standard media scenario.
- `docs/concepts/qa-e2e-automation.md` says the QA SUT manifest omits reaction scopes/events; the documented scenario list also lacks media coverage.

### Unit tests

- `extensions/slack/src/monitor/media.test.ts`, `monitor/monitor.media.test.ts`, `media.runtime.ts`, and `actions.download-file.test.ts` cover media resolution and download behavior.
- `extensions/slack/src/action-runtime.test.ts` covers `downloadFile`, `uploadFile`, media-before-blocks behavior, file-download authorization, user-token reads, and reply broadcast rejection for uploads.
- `extensions/slack/src/send.upload.test.ts` and `outbound-payload.test.ts` cover upload payload behavior.
- `src/auto-reply/reply/get-reply-run.media-only.test.ts` covers Slack media-only reply context through shared reply runtime.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack media" --json`

Results:

- Returned `#63905` inbound attachments fail in container sandbox, `#62792` Slack file access fix, `#60335` thread replies reattach parent media, `#60353` never hydrate thread starter media for thread replies, `#83165` long-running runs appear silent when media delivery partially fails, `#53932` image optimization concern, `#63588` Slack download auth, and `#41657` file attachment metadata feature request.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack media attachment download-file"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack file upload download auth missing_scope"`

Results:

- Both feature-specific searches returned no focused messages in the Discord archive.
- Related setup searches returned Slack image upload/support discussion about `files:read`, `files:write`, bot-token scope reinstall, and missing-scope diagnosis.
