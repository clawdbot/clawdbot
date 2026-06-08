---
title: "Microsoft Teams - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Native Controls and Approvals Maturity Note

## Summary

Teams exposes a wide message-action surface: file upload, polls, read/search,
edit/delete, pins, reactions, member info, group management, approval auth, and
feedback. Coverage remains Alpha because these actions are mostly source and
unit backed. Quality remains Alpha because Graph permissions, target routing,
card invokes, and native Teams approval delivery need real tenant proof across
chat, channel, team, and admin-consent states.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Message Actions and Approvals`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Message action discovery: Covers Message action discovery across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Polls and reactions: Covers Polls and reactions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Read, edit, delete, and pin: Covers Read, edit, delete, and pin across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Native approval cards: Covers Native approval cards across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Feedback and group actions: Covers Feedback and group actions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.

## Features

- Message action discovery: Covers Message action discovery across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Polls and reactions: Covers Polls and reactions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Read, edit, delete, and pin: Covers Read, edit, delete, and pin across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Native approval cards: Covers Native approval cards across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.
- Feedback and group actions: Covers Feedback and group actions across message-tool discovery, upload-file, poll, read/search, and related actions and approvals behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: Source and unit tests cover action discovery, target
  fallback, upload-file, polls, reactions, channel list/info, pin/unpin,
  presentation cards, approval auth, and group-management runtime adapters.
- Negative signals: No live Teams action, reaction, poll, approval, or group
  management scenario was found.
- Integration gaps: Missing real tenant proof for Graph-permission denied
  states, card action invokes, native approval delivery, poll votes, reactions,
  and group membership operations.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `msteams approval feedback poll adaptive card OAuth SSO`
  issue search returned `[]`; broader queries returned `#66327` interactive
  approval cards and `#76262` Teams SDK migration with card/feedback fixes.
- Discrawl reports: Focused approval/poll/feedback query returned no lines;
  broad `msteams` search included migration discussion about adaptive card
  buttons, feedback, and edit/delete fixes.
- Good qualities: Message actions are centrally advertised, target resolution
  is explicit, approval auth normalizes stable Teams users, poll votes validate
  conversation IDs, and Graph runtime adapters separate privileged operations.
- Bad qualities: Actions are Graph-permission-sensitive, approval delivery is
  not proven as a native Teams scenario, card invokes are security-sensitive,
  and real Teams UI behavior is not represented by durable scenario proof.
- Excluded from quality: Action unit-test breadth, card test depth, and lack of
  live tenant tests.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Message action discovery, Polls and reactions, Read, edit, delete, and pin, Native approval cards, Feedback and group actions.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live scenarios for polls, reactions, native approval delivery, feedback,
  pin/unpin, edit/delete, search/read, upload-file, and group management.
- Add permission-denied and partial-consent scenario proof for each Graph-backed
  action group.
- Add approval-card and fallback approval flow proof in a real Teams tenant.

## Evidence

### Docs

- `docs/channels/msteams.md` documents polls, presentation cards, message
  actions, target formats, Graph/member-info requirements, and file upload.
- `docs/tools/exec-approvals-advanced.md` mentions Microsoft Teams among
  deliverable chat approval surfaces.

### Source

- `extensions/msteams/src/channel.ts` advertises actions including
  `upload-file`, `poll`, read/search/edit/delete/pin/reactions, channel
  list/info, group management, and `member-info`, and routes action handling.
- `extensions/msteams/src/channel.runtime.ts` exports runtime adapters for
  Graph messages, Graph teams, Graph members, group management, outbound, probe,
  and send/card functions.
- `extensions/msteams/src/polls.ts` builds poll cards and records votes.
- `extensions/msteams/src/monitor.ts` handles poll card actions and generic
  card actions.
- `extensions/msteams/src/approval-auth.ts` implements Teams approval auth;
  this is not the same as durable native approval-delivery proof.
- `extensions/msteams/src/feedback-invoke.ts`,
  `feedback-reflection.ts`, and `feedback-reflection-store.ts` implement
  feedback and reflection.
- `extensions/msteams/src/graph-messages.ts` and
  `graph-group-management.ts` implement Graph-backed actions.

### Integration tests

- No Teams live action/reaction/poll/approval/group-management scenario was
  found by `rg`.

### Unit tests

- `extensions/msteams/src/channel.actions.test.ts` covers action discovery,
  target fallback, upload-file, member-info, channel list/info, pin/unpin,
  reactions, presentation cards, and native channel IDs.
- `extensions/msteams/src/polls.test.ts` covers poll cards and vote selection.
- `extensions/msteams/src/monitor-handler.adaptive-card.test.ts` and
  `monitor.lifecycle.test.ts` cover card invoke handling.
- `extensions/msteams/src/channel.test.ts` covers approval capability exposure.
- `extensions/msteams/src/graph-messages.actions.test.ts`,
  `graph-messages.read.test.ts`, `graph-messages.search.test.ts`,
  `graph-group-management.test.ts`, and `feedback-reflection.test.ts` cover
  mocked Graph/action behavior.

### Gitcrawl queries

Query:

- `gitcrawl search issues "msteams Teams approval feedback poll adaptive card OAuth SSO" -R openclaw/openclaw --state all --json number,title,state,url,updatedAt --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams adaptive card approvals feedback poll action" --json --limit 10`
- `gitcrawl search openclaw/openclaw --query "msteams Microsoft Teams" --json --limit 10`

Results:

- The focused issue and action keyword searches returned `[]`.
- The broad search returned `#66327`, interactive approval cards, and `#76262`,
  Teams SDK migration with adaptive-card/feedback snippets.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams approval poll feedback reaction Adaptive Card"`

Results:

- The focused query returned no lines.
