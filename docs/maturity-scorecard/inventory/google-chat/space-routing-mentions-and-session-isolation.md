---
title: "Google Chat - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Google Chat - Conversation Routing and Delivery Maturity Note

## Summary

Space routing is the main reason the surface remains Alpha. The implementation has shared ingress policy, stable `spaces/<id>` keys, mention extraction, group sender allowlists, access groups, group prompts, and bot loop protection, but archive evidence includes open or recent reports for spaces being silently ignored, add-on payloads failing, wildcard group configs blocking senders, and users needing optional user OAuth to receive non-mention traffic.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Conversation Access and Routing`, `Message Delivery and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM pairing approval: Covers DM pairing approval across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Sender allowlists: Covers Sender allowlists across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Google Chat identity matching: Covers Google Chat identity matching across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Direct session routing: Covers Direct session routing across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Pairing diagnostics: Covers Pairing diagnostics across Google Chat DMs, `dm.policy`, `dm.allowFrom`, pairing challenges, and related dm pairing and sender authorization behavior.
- Space allowlists: Covers Space allowlists across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Mention gating: Covers Mention gating across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Sender access groups: Covers Sender access groups across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Group session isolation: Covers Group session isolation across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Bot-loop protection: Covers Bot-loop protection across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
- Space diagnostics: Covers Space diagnostics across Google Chat spaces and group messages, `groupPolicy`, `groups`, wildcard groups, and related space routing mentions and session isolation behavior.
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
- Thread-aware replies: Covers Thread-aware replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior
- Streaming and chunked replies: Covers Streaming and chunked replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior
- Typing placeholder lifecycle: Covers Typing placeholder lifecycle across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior
- Message-tool current-source replies: Covers Message-tool current-source replies across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior
- NO_REPLY cleanup: Covers NO_REPLY cleanup across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior
- Markdown/text rendering: Covers Markdown/text rendering across inbound thread resource propagation, `replyToMode`, Google Chat `messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`, text chunking, and related threaded replies streaming and typing lifecycle behavior

## Features

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals: Local tests cover group mention gates, group sender allowlists, access-group expansion, `systemPrompt`, stable space-key enforcement, deprecated display-name key rejection, bot loop protection facts, bot-authored message suppression, and DM versus group context differences.
- Negative signals: There is no real Google Chat space live lane. Existing source and tests do not prove the full Google event delivery contract for spaces, especially the difference between service-account @mention delivery and desired all-message space delivery.
- Integration gaps: Add a live space scenario for allowlisted `spaces/<id>` groups, wildcard groups, mention-required and mention-disabled modes, sender allowlists, `botUser`, and a negative case for mutable display-name group keys.

## Quality Score

- Score: `Alpha (55%)`
- Gitcrawl reports: #58514 is open for space/group messages returning HTTP 200 but no session and no agent response while DMs work. #65007 is open for add-on payload parsing and wildcard group allowlist behavior. #44347 asks for receiving all messages in spaces rather than only @mentions, which requires optional user OAuth or a different delivery model.
- Discrawl reports: `discrawl search "Google Chat space messages ignored" --limit 10` returned #58514 comments identifying space type misclassification and silent drops. `discrawl search "channels.googlechat groups requireMention" --limit 10` returned a user config with multiple `spaces/...` entries, `requireMention: false`, `groupPolicy: "allowlist"`, `botUser`, and `actions.reactions`, where the channel appeared configured/running but messages still did not trigger useful logs.
- Good qualities: The code no longer relies on mutable room names for routing, defaults groups to allowlist, can require mentions, exposes group prompts, can restrict senders per space, suppresses bot-authored events by default, and uses shared bot loop protection when bots are allowed.
- Bad qualities: Space behavior is operationally fragile. Google Chat's service-account model only delivers mention traffic in spaces, `botUser` is easy to miss, app/add-on payload variants have been a failure source, and current archives still include silent drop reports. This is product/operator risk, not just implementation complexity.
- Excluded from quality: Unit, integration, e2e, live, and runtime-flow test presence/depth were not used to raise or lower this Quality score.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/google-chat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Conversation Routing and Delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a real space smoke that proves session key creation as `agent:<id>:googlechat:group:<spaceId>`.
- Document the service-account @mention delivery limitation beside `requireMention`, not only in issue history.
- Make silent space drops observable with reason-coded logs/status for group route, sender, mention, and payload parsing decisions.
- Decide whether wildcard `groups["*"]` means route all spaces with mention gating or route all spaces plus sender allowlist, then keep docs/source/tests aligned.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/googlechat.md`: documents DMs versus spaces, group session keys, @mention requirement, `botUser`, `groupPolicy`, `groups`, per-space `requireMention`, `systemPrompt`, `allowBots`, and bot loop protection.
- `/Users/kevinlin/code/openclaw/docs/channels/bot-loop-protection.md`: documents Google Chat bot-loop facts keyed by account, space, and bot pair.
- `/Users/kevinlin/code/openclaw/docs/channels/access-groups.md`: documents Google Chat entries in generic message sender access groups.
- `/Users/kevinlin/code/openclaw/docs/channels/channel-routing.md`: lists Google Chat as a configurable message channel.

### Source

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-access.ts`: resolves group config by stable space id, rejects mutable display-name matches, evaluates group route and sender policy, extracts mentions, computes command authorization, and returns group prompt/bot-loop settings.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.ts`: distinguishes group versus direct events, computes bot loop facts, resolves inbound route/session keys, builds context with `ChatType`, `WasMentioned`, `CommandAuthorized`, and group prompt data.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/group-policy.ts`: delegates mention requirement resolution to shared channel policy helpers.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.adapters.ts`: exposes the groups adapter and security warning collector.
- `/Users/kevinlin/code/openclaw/src/config/types.googlechat.ts`: defines `groupPolicy`, `groupAllowFrom`, `groups`, `requireMention`, `botLoopProtection`, and per-space `systemPrompt`.

### Integration tests

- No dedicated Google Chat live/e2e space scenario was found under `/Users/kevinlin/code/openclaw/extensions/qa-lab` or `qa/scenarios`.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/contracts/channel-import-guardrails.test.ts`: includes Google Chat in plugin contract guardrails, but does not prove real space routing.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor-access.test.ts`: covers group allowlists, mention gates, access groups, empty sender allowlist behavior, control-command authorization, stable space IDs, deprecated mutable group keys, wildcard fallback behavior, and group prompt trimming.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/monitor.test.ts`: covers bot loop protection facts, bot-loop suppression before typing messages, and DM thread-context separation.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/config-schema.test.ts`: covers group-policy defaults and config validation.
- `/Users/kevinlin/code/openclaw/extensions/googlechat/src/channel.test.ts`: covers plugin capability/config behavior adjacent to group routing.

### Gitcrawl queries

Query:

`gitcrawl gh issue view 58514 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #58514, where group messages received HTTP 200 but no group sessions or agent responses were created while DMs worked.

Query:

`gitcrawl gh issue view 65007 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #65007, which reports valid add-on payloads rejected as invalid, wildcard group allowlists blocking senders, and thread resource errors in spaces.

Query:

`gitcrawl gh issue view 44347 --repo openclaw/openclaw --json number,title,state,updatedAt,url,body`

Results:

- Returned open #44347, requesting Google Chat threaded replies and optional receive-all space messages beyond @mentions, noting service-account `chat.bot` delivery limitations.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "Google Chat space messages ignored" --limit 10`

Results:

- Returned #58514 issue comments describing DMs working, spaces being misclassified/dropped, and a fix path checking newer Google Chat space type fields.

Query:

`/Users/kevinlin/.local/bin/discrawl search "channels.googlechat groups requireMention" --limit 10`

Results:

- Returned a real config with `groupPolicy: "allowlist"`, multiple `spaces/...` entries, `requireMention: false`, `botUser`, and `dm.policy: "pairing"` where status reported working but messages did not produce useful logs, highlighting operator visibility gaps.
