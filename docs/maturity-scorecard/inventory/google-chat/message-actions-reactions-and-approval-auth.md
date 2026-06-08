---
title: "Google Chat - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Native Controls and Approvals Maturity Note

## Summary

Google Chat exposes useful action primitives: text sends, `upload-file`, reaction add/list/remove, target normalization, and approval sender matching through stable user ids. The maturity is Alpha because several action capabilities depend on user OAuth that is not implemented, message-tool replies interact poorly with threading and typing placeholders, and the channel does not have native command or rich interactive surface parity with Slack/Discord.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
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

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals: Local tests verify action discovery, account-scoped reaction gating, message sends with uploaded media, `upload-file` filename overrides, removal of only app-owned reactions, target normalization, and channel message adapter capability proofs for text/media/thread/message-sending hooks.
- Negative signals: There is no real Google Chat action live lane proving reaction scopes, approval sender matching, message-tool current-source delivery, or attachment action behavior against Google Chat API permissions.
- Integration gaps: Add a live action suite for `message(action=send)`, threaded current-source sends, reaction add/remove/list with user OAuth or explicit unsupported warnings, and approval authorization from a real Google Chat user id.

## Quality Score

- Score: `Alpha (58%)`
- Gitcrawl reports: #9764 is open because reactions, media uploads, and proactive DMs require optional user OAuth beyond the current service-account token. #82014 reports message-tool replies do not consume typing placeholders. #80995 reports message-tool replies escaping threads. #39843 reports reaction-only plus `NO_REPLY` leaves typing indicators visible.
- Discrawl reports: `discrawl search "Google Chat reactions media upload OAuth" --limit 10` returned #9764 discussion that current main still has no Google Chat user OAuth credential surface and that reaction/upload/proactive-DM paths still use service-account `chat.bot` tokens. `discrawl search "Google Chat message tool" --limit 10` returned message-tool/current-source context, including Google Chat mention in channel release testing and adjacent message-tool delivery concerns.
- Good qualities: The action adapter is small, account-aware, and explicit about enabled accounts and action gates. It uses the shared channel-actions parameter readers, resolves targets through Google Chat space lookup, supports local and remote media parameter aliases, and only removes reactions made by the app identities.
- Bad qualities: The action surface advertises capabilities that are structurally implemented but constrained by Google auth scope realities. Current-source message-tool delivery is not integrated enough with Google Chat's provisional typing lifecycle, and native commands are declared unsupported. Operators can see actions in tool descriptions without a clear enough distinction between service-account-supported and user-OAuth-required operations.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Inbound attachments, Outbound media replies, Message upload action, Media source and size controls, Media receipts and thread placement, Text send action, Upload-file action, Reaction actions, Action capability gates, Approval sender matching, Thread-aware replies, Streaming and chunked replies, Typing placeholder lifecycle, Message-tool current-source replies, NO_REPLY cleanup, Markdown/text rendering.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add optional user OAuth for reactions, attachment upload, and proactive DM operations or hide/deny those actions with clear per-action diagnostics when unavailable.
- Route current-source message-tool sends through the same thread and typing-placeholder lifecycle as automatic replies.
- Add Google Chat approval scenarios using stable `users/<id>` approvers and rejecting mutable email approver entries.
- Make action discovery distinguish text sends that work with service-account auth from operations that require user OAuth.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents `actions.reactions`, `typingIndicator`, message actions `send` and `upload-file`, upload parameters, and service-account limitations for reaction typing mode.
- `/Users/kevinlin/code/openclaw/docs/tools/reactions.md`: documents Google Chat reaction semantics for empty emoji removal and `remove: true`.
- `/Users/kevinlin/code/openclaw/docs/cli/message.md`: includes Google Chat `openclaw message send --channel googlechat --target spaces/AAA...` examples and target format guidance.
- `/Users/kevinlin/code/openclaw/docs/tools/slash-commands.md`: notes Google Chat lacks native commands and uses text commands where enabled.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/actions.ts`: implements action discovery and handling for `send`, `upload-file`, `react`, and `reactions`, including media aliases and app-owned reaction removal.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.ts`: registers the action adapter, message tool description, channel capabilities, and approval auth adapter.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/approval-auth.ts`: normalizes stable `users/<id>` approvers and rejects mutable email approver entries.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/api.ts`: implements message send, attachment upload, direct-message lookup, and reaction create/list/delete calls.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/targets.ts`: normalizes `spaces/...`, `users/...`, prefixes, and raw email targets before action sends.

### Integration tests

- No dedicated live Google Chat action/reaction/approval scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/test/scripts/bundled-plugin-build-entries.test.ts`: includes Google Chat in bundled plugin build-entry checks.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/actions.test.ts`: covers action discovery, account-scoped reaction gates, media send/upload paths, upload-file aliases, filename override, and app-owned reaction removal.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/approval-auth.test.ts`: covers Google Chat approval auth normalization and approver matching.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: verifies message adapter capability proofs, target resolution, outbound send text/media behavior, and account threading.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/targets.test.ts`: covers target normalization and direct-message lookup behavior.

### Gitcrawl queries

Query:

`gitcrawl gh issue view 9764 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #9764, which states service-account auth limits reactions, media uploads, and proactive DMs and proposes optional user OAuth.

Query:

`gitcrawl gh issue view 82014 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #82014, reporting Google Chat current-source message-tool replies bypass typing placeholder cleanup.

Query:

`gitcrawl gh issue view 80995 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #80995, reporting Google Chat message-tool replies can post outside the original thread.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat reactions media upload OAuth" --limit 10`

Results:

- Returned #9764 discussion that user OAuth is still absent and that reaction/upload/proactive-DM paths continue using the service-account token path.

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat message tool" --limit 10`

Results:

- Returned release and issue context where Google Chat message-tool/thread behavior is part of the active channel testing and debugging record.
