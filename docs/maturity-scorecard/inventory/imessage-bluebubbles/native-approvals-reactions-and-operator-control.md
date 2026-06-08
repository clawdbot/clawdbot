---
title: "iMessage / BlueBubbles - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iMessage / BlueBubbles - Native Controls and Approvals Maturity Note

## Summary

Native approvals, reactions, and operator control are Beta. The component is
well structured: iMessage can deliver native exec/plugin approvals, add
reaction-choice hints, resolve tapbacks to approval decisions, require explicit
approvers, persist reaction targets, poll for reactions after restart, and
suppress duplicate local prompts. It remains Beta because the user experience
depends on structured tapback metadata from Apple clients and on careful
operator `allowFrom` configuration.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Approvals and Operator Control`, `Rich Messages and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Native Approvals: Covers Native Approvals across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Reactions: Covers Reactions across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Operator Control: Covers Operator Control across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Media: Covers Media across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Attachments: Covers Attachments across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Remote Fetch: Covers Remote Fetch across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Chunking: Covers Chunking across `includeAttachments`, attachment root allowlists, remote attachment roots, `remoteHost` SCP fetches, HEIC conversion, size caps, outbound media sends, `send-attachment`, text chunking, and media receipts.
- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors.
- Native Actions: Covers Native Actions across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors
- Private API: Covers Private API across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors
- Message Tool: Covers Message Tool across private API probing, action availability, action config gates, tapback mapping, edit/unsend/reply/effects/group management, `send-rich --file`, message-tool visibility/target grammar, and action dispatch errors

## Features

- Native Approvals: Covers Native Approvals across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Reactions: Covers Reactions across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.
- Operator Control: Covers Operator Control across native approval delivery, exec/plugin approval routing, reaction-based approval decisions, `/approve` authorization changes, and related native approvals, reactions, and operator control behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - Docs describe native approval routing, tapback decisions, explicit
    approvers, `/approve` auth, persistence, cross-device tapback handling, and
    legacy tapback limits.
  - Source has separate modules for native approval delivery, authorization,
    reaction state, reaction polling, and monitor shortcut routing.
  - Tests are extensive across approval delivery availability, target matching,
    group-origin safety, prompt rendering, fallback suppression, reaction
    resolution, persistence, polling, and authorization.
  - Discord archive shows product discussion and maintainer reporting around
    approval reactions.
- Negative signals:
  - No live iMessage approval prompt/tapback lane was found.
  - Legacy text-style tapbacks cannot resolve approvals.
  - Approval reaction shortcuts depend on exact message GUID binding and Apple
    structured reaction payloads.
- Integration gaps:
  - Add a gated Mac lane for native exec approval, plugin approval, Like/Dislike
    tapback resolution, unauthorized tapback denial, restart-before-tapback, and
    group-origin approver requirement.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports:
  - `iMessage approval reactions` returned #85954 for attributed-body approval
    prompt formatting and context from prior reaction work.
  - `iMessage send-rich` also returned #85954.
  - `iMessage approval reaction approve allowFrom` returned no direct hits in
    the latest gitcrawl pass.
- Discrawl reports:
  - `iMessage approval reactions` returned a 2026-05 maintainer report
    mentioning iMessage approval reactions and a discussion about supporting
    approvals through reactions in clients without better approval UX.
  - `iMessage approval reaction approve allowFrom` returned no snippets.
- Good qualities:
  - Explicit approver authorization is separate from broader DM/group admission.
  - Group-origin approval routing requires configured approvers before allowing
    reaction approval.
  - Persistent binding protects short restart windows.
  - Removed tapbacks and self-approval edge cases are handled.
  - Fallback suppression reduces duplicate local prompts when native delivery
    has the same target.
- Bad qualities:
  - The operator must configure `allowFrom` carefully; wildcard approvers are
    powerful and risky.
  - Structured tapback metadata is required for robust reaction approval.
  - Prompt formatting and action affordances are still being refined in archive
    issues.
- Excluded from quality:
  - Unit, integration, e2e, live, and runtime-flow test evidence is recorded
    under Coverage only.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/imessage-bluebubbles.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Approvals, Reactions, Operator Control.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Live approval/tapback proof is missing.
- Approval resolution depends on tapback metadata and GUID binding.
- Operator allowlist mistakes can make approvals too broad or unavailable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:576`: exec/plugin approval prompts can route to iMessage and accept tapbacks.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:582`: reaction handling requires the reacting user to be an explicit approver from `allowFrom`.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:584`: `/approve` text command authorization now uses the approver list when non-empty.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:587`: reaction bindings are stored in memory and persistent keyed state.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:588`: cross-device self tapbacks are ignored.
- `/Users/kevinlin/code/openclaw/docs/channels/imessage.md:589`: legacy text-style tapbacks cannot resolve approvals.

### Source

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:487`: approval reaction shortcut routes matching tapbacks before normal dispatch.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:1042`: monitor registers native approval runtime context.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/monitor/monitor-provider.ts:1058`: monitor starts approval reaction polling state.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.ts:505`: group conversations require explicit approvers before routing approval prompts.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.ts:612`: delivery capability description tells operators to configure `allowFrom`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.ts:17`: persistent namespace is `imessage.approval-reactions`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.ts:272`: `/approve` command-line parser handles approval ids and decisions.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.ts:514`: reaction resolver reads explicit approvers.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reaction-poller.ts:87`: poller scopes discovery through `chats.list`.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reaction-poller.ts:261`: poller converts message reactions into approval reaction payloads.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-seed.ts:51`: seeded iMessage session exists for channel-level MCP surfaces.
- `/Users/kevinlin/code/openclaw/src/agents/tools/message-tool.test.ts:1493`: message tool has an iMessage plugin fixture for action/target surfaces.
- No live native approval or tapback lane was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:133`: session-mode exec delivery works for matching iMessage origins.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:188`: group-origin targets are rejected without approvers.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:202`: group-origin targets are allowed with explicit approvers.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:292`: exec approval prompts render reaction hints.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-native.test.ts:459`: fallback suppression only applies when the exact session-origin native target matches.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.test.ts:80`: allow-always resolves through the shared reaction choice.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.test.ts:509`: direct approval reactions resolve from authorized senders.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reactions.test.ts:582`: reactions from senders not on the approver list are denied.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-reaction-poller.test.ts:63`: bounded recent-chat discovery observes approval prompts.
- `/Users/kevinlin/code/openclaw/extensions/imessage/src/approval-auth.test.ts:128`: chat target entries are rejected as approvers even with service prefixes.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iMessage approval reactions" --json --limit 6`

Results:

- Open issue #85954: iMessage attributed-body formatting for approval prompts,
  referencing prior iMessage approval reaction work.

Query:

`gitcrawl search openclaw/openclaw --query "iMessage approval reaction approve allowFrom" --json --limit 6`

Results:

- No direct hits in the latest pass.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage approval reactions" --limit 6`

Results:

- 2026-05 maintainer report mentioned iMessage approval reactions.
- 2026-05 maintainer discussion asked about approvals in iMessage and WhatsApp
  via reactions for clients with no better approval UI.

Query:

`/Users/kevinlin/.local/bin/discrawl search "iMessage approval reaction approve allowFrom" --limit 6`

Results:

- No snippets returned.
