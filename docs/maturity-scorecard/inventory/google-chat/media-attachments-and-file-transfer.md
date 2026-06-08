---
title: "Google Chat - Media and Rich Content Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Media and Rich Content Maturity Note

## Summary

Google Chat media support is structurally present for inbound downloads and outbound uploads, with size caps, local-root handling, upload tokens, and media receipts. It remains a low Alpha area because Google Chat attachment uploads need user OAuth for some real deployments, live proof is missing, and archive evidence ties media to open OAuth and typing/thread lifecycle problems.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Media and Rich Content`
- Merged from: `Message Delivery and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Inbound attachments: Covers Inbound attachments across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Outbound media replies: Covers Outbound media replies across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Message upload action: Covers Message upload action across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Media source and size controls: Covers Media source and size controls across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Media receipts and thread placement: Covers Media receipts and thread placement across inbound Google Chat attachment download, media store handoff, outbound media reply delivery, `upload-file`, and related media attachments and file transfer behavior.
- Text send action: Covers Text send action across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Upload-file action: Covers Upload-file action across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Reaction actions: Covers Reaction actions across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Action capability gates: Covers Action capability gates across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Approval sender matching: Covers Approval sender matching across Google Chat message tool action discovery, `send`, `upload-file`, `react`, and related message actions reactions and approval auth behavior.
- Thread-aware replies: Covers Thread-aware replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Streaming and chunked replies: Covers Streaming and chunked replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Typing placeholder lifecycle: Covers Typing placeholder lifecycle across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Message-tool current-source replies: Covers Message-tool current-source replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- NO_REPLY cleanup: Covers NO_REPLY cleanup across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.
- Markdown/text rendering: Covers Markdown/text rendering across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior.

## Features

- Media and Rich Content: Evidence scope for Media and Rich Content.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (55%)`
- Positive signals: Local tests verify local file loading with `mediaLocalRoots`, remote URL loading with size caps, attachment upload token propagation, media receipts, text captions, `upload-file` aliases, filename override, and inbound attachment download plumbing through monitor tests.
- Negative signals: I found no real Google Chat media live lane. The source can call Google Chat upload/download APIs, but coverage does not prove actual Google Chat OAuth scope behavior, large-file rejection, inbound media from spaces and DMs, text+media with typing placeholders, or multi-account media sends against the platform.
- Integration gaps: Add a live media suite for inbound attachment download, outbound local upload, outbound remote upload, oversized rejection, text+media reply, message-tool `upload-file`, and thread-preserving media delivery.

## Quality Score

- Score: `Alpha (50%)`
- Gitcrawl reports: #9764 is open because media uploads require user OAuth beyond the service-account path. #82014 and #39843 show media/action flows can interact badly with typing placeholders. #69422 and #42510 show thread metadata is fragile for streamed/chunked replies, which also affects media replies with captions.
- Discrawl reports: `discrawl search "Google Chat reactions media upload OAuth" --limit 10` returned #9764 comments confirming current main still lacks user OAuth and that media upload paths use the service-account token path. `discrawl search "Google Chat typing indicator" --limit 10` returned multiple media+text/typing cleanup PRs and issue comments.
- Good qualities: The implementation caps media bytes, uses shared outbound media loaders, supports local-root restricted reads, uploads through Google Chat's multipart attachment endpoint, records media delivery receipts, and saves inbound downloads through the shared media pipeline.
- Bad qualities: Product capability is constrained by Google auth scope: service-account auth is not enough for every media/upload use case. Text+media reply behavior has a recent history of silent text loss and placeholder cleanup fixes. Without live media evidence, operators cannot rely on file transfer as a first-class Google Chat capability.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (55%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Media and Rich Content.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add optional user OAuth or explicit unsupported diagnostics for upload paths that cannot work with service-account auth.
- Prove inbound and outbound media in a real Google Chat DM and space.
- Add operator docs for `mediaMaxMb`, Google Chat API upload scopes, and service-account limitations.
- Keep media replies tied to the same thread and typing-placeholder lifecycle as text replies.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents media attachments, `mediaMaxMb`, `upload-file`, `media`/`filePath`/`path` parameters, and attachment download through the Chat API.
- `/Users/kevinlin/code/openclaw/docs/cli/message.md`: includes Google Chat `message send` examples and channel target guidance.
- `/Users/kevinlin/code/openclaw/docs/nodes/media-understanding.md`: documents generic media handoff, which Google Chat uses after downloading inbound files.
- `/Users/kevinlin/code/openclaw/docs/reference/secretref-credential-surface.md`: notes Google Chat service account SecretRef surfaces that media API calls depend on.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/api.ts`: implements `uploadGoogleChatAttachment`, `downloadGoogleChatMedia`, and response-size-limited buffer reads.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.ts`: downloads the first inbound attachment and saves it to the shared media store before building message context.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-reply-delivery.ts`: uploads outbound reply attachments, deletes or updates typing placeholders, and sends captions with uploaded attachment tokens.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.adapters.ts`: implements attached media sends, local/remote media loading, account/channel `mediaMaxMb`, and media receipts.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/actions.ts`: implements `upload-file` and `send` media aliases for `media`, `filePath`, and `path`.

### Integration tests

- No dedicated Google Chat live/e2e media scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-build-entries.test.ts`: protects bundled plugin build entries, but not real media transfer.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: verifies Google Chat message adapter media capability proofs, local-root file loading, remote media byte caps, media receipts, and account config threading.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/actions.test.ts`: verifies media sends and `upload-file` through action handling, including local file reads and filename override.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.reply-delivery.test.ts`: covers media reply delivery and text/typing fallback behavior.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.test.ts`: covers inbound attachment download plumbing through the monitor pipeline.

### Gitcrawl queries

Query:

`gitcrawl gh issue view 9764 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #9764, stating reactions, media uploads, and proactive DMs require user-level OAuth scopes and are limited by the current service-account-only model.

Query:

`gitcrawl search issues "Google Chat media attachment upload reactions" --repo openclaw/openclaw --limit 15 --json number,title,state,updatedAt,url`

Results:

- Returned no direct hits. The relevant media signal came from #9764 and typing/thread issues found by broader Google Chat queries.

Query:

`gitcrawl gh issue view 82014 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #82014, which affects message-tool visible replies and typing placeholder cleanup, including media-bearing visible replies.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat reactions media upload OAuth" --limit 10`

Results:

- Returned #9764 discussion confirming Google Chat user OAuth is still missing and media upload paths still use service-account token paths.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat typing indicator" --limit 10`

Results:

- Returned #71498, #70923, and #65570 PR/issue context for silent text loss when Google Chat replies contain media plus text with typing indicators enabled.
