---
title: "Matrix - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Matrix - Native Controls and Approvals Maturity Note

## Summary

Matrix action support is broad and reasonably structured. The plugin exposes
channel actions for messages, polls, reactions, pins, profile updates, member
info, room info, permissions, and verification actions, with account-scoped
gating and tool schemas. Coverage is Beta because source and tests cover the
action families but live scenario proof is not equally deep for every action.
Quality is Beta because the source is robust but the action surface is broad
and some room/member info fields remain intentionally partial.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Messaging and Room Tools`, `Approvals`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Channel action discovery: Channel action discovery, account-scoped action gates, and tool schemas
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools.
- Profile media loading: Profile media loading from URL or local path.
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior.
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior.
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies.
- Matrix native exec: Matrix native exec and plugin approval capability
- Origin target resolution from Matrix turn: Origin target resolution from Matrix turn source, session fallback, and approval routing.
- Approver DM target resolution: Approver DM target resolution, forwarding fallback suppression, and native approval delivery.
- Matrix approval metadata: Matrix approval metadata, reaction hints, reaction anchor persistence, and decision state.
- Origin target resolution from Matrix turn: Origin target resolution from Matrix turn source, session fallback, and approval routing
- Approver DM target resolution: Approver DM target resolution, forwarding fallback suppression, and native approval delivery
- Matrix approval metadata: Matrix approval metadata, reaction hints, reaction anchor persistence, and decision state

## Features

- Channel action discovery: Channel action discovery, account-scoped action gates, and tool schemas
- Message send/read/edit/delete: Message send/read/edit/delete, poll voting, reaction add/remove/list, pins, and related room tools.
- Profile media loading: Profile media loading from URL or local path.
- Outbound Matrix text: Outbound Matrix text, media, encrypted media, poll, typing, read receipt, and delivery behavior.
- Message presentation metadata: Message presentation metadata, Matrix mention metadata, and chunked delivery behavior.
- Inbound media failure handling: Inbound media download failure handling when it affects outbound replies.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals:
  - Docs cover profile management, reactions, target resolution, history
    context, config reference, and tooling/action settings.
  - Source has one channel action adapter and one direct tool dispatcher with
    account-scoped gates and action-specific parsing.
  - Unit tests cover action discovery, profile schema, action gating, account
    propagation, poll votes, reactions, message actions, pins, devices, summary,
    profile updates, and room/member info.
  - Matrix QA includes media, reactions, edit, room, DM, and E2EE scenarios
    that exercise action-adjacent behavior.
- Negative signals:
  - Live proof is not equally strong for every action exposed through the
    adapter.
  - Some actions depend on Matrix server state APIs that can be sparse or
    permission-sensitive.
- Integration gaps:
  - Add an action-focused Matrix QA profile for profile updates, pins, member
    info, room info, poll votes, and reaction listing.
  - Add live evidence for account-scoped action overrides.
  - Add docs linking each exposed action to its command/tool name and failure
    modes.

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

- Score: `Beta (72%)`
- Gitcrawl reports:
  - Query `gitcrawl --json search openclaw/openclaw --query "Matrix actions polls reactions profile pins"` returned no hits.
  - Broad query `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned broader Matrix issues, but no direct high-signal action-specific incident among the top results.
- Discrawl reports:
  - Query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix actions polls reactions profile pins"` returned no hits.
  - Broad query `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"` returned release chatter mentioning Matrix channel validation and mention behavior.
- Good qualities:
  - Action exposure is gated by account config and sender owner context for
    profile updates.
  - Direct action handling normalizes snake_case aliases and account-scoped
    options.
  - Poll vote code validates poll event type, option ids, indexes, and
    selection limits before sending a response.
  - Profile updates use runtime media loaders and persist through shared helper
    paths.
- Bad qualities:
  - The action surface is wide and exposes many failure modes through one
    dispatcher.
  - Member and room info intentionally return partial data for membership,
    power levels, and alternate aliases.
  - Archive evidence is broad rather than action-specific, so supporting signal is
    bounded by source review and tests.
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

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/matrix.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channel action discovery, Message send/read/edit/delete, Profile media loading, Outbound Matrix text, Message presentation metadata, Inbound media failure handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an action contract table that lists each action, config gate, parameters,
  and Matrix event/API dependency.
- Add live QA for pins and member/room info, not only lower-level unit coverage.
- Decide whether partial member/room info should be documented as an explicit
  limitation.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:491` documents Matrix
  profile management.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:568` documents
  reactions.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:589` documents
  history context.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:812` documents
  target resolution.
- `/Users/kevinlin/code/openclaw/docs/channels/matrix.md:831` documents
  action and tooling config.

### Source

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.ts:20` lists
  Matrix plugin-handled channel action names.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.ts:64` builds
  exposed actions from action gates, encryption state, and owner context.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.ts:119`
  implements the Matrix channel message action adapter.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.ts:47`
  groups direct Matrix tool actions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.ts:150`
  dispatches Matrix direct actions with account-scoped config.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/polls.ts:24`
  resolves selected poll answer ids and labels.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/polls.ts:73`
  sends Matrix poll vote responses.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/profile.ts:6`
  updates Matrix profile name/avatar using runtime media loading.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/room.ts:5`
  reads member info and room info.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/devices.ts:5`
  lists Matrix devices and prunes stale gateway devices.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:581`
  waits for Matrix approval reaction echo before awaiting a decision.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4181`
  sends a real Matrix image attachment for image-understanding prompts.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4366`
  covers every Matrix media msgtype with caption-triggered replies.
- `/Users/kevinlin/code/openclaw/extensions/qa-matrix/src/runners/contract/scenarios.test.ts:4816`
  auto-joins a freshly invited Matrix group room before replying.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.test.ts:55`
  covers poll action exposure.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.test.ts:75`
  covers self-profile action discovery.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.test.ts:122`
  covers gated actions disabled by account config.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/actions.test.ts:193`
  covers selected Matrix account during action discovery.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.test.ts:74`
  covers snake_case poll vote params.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.test.ts:141`
  covers account-scoped reaction adds.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.test.ts:277`
  covers media roots for profile updates.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.test.ts:316`
  covers member and room info actions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/tool-actions.test.ts:404`
  covers account-scoped action overrides.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/reactions.test.ts:43`
  covers Matrix reaction actions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/pins.test.ts:39`
  covers pins actions.
- `/Users/kevinlin/code/openclaw/extensions/matrix/src/matrix/actions/profile.test.ts:41`
  covers profile actions.

### Gitcrawl queries

- `gitcrawl --json search openclaw/openclaw --query "Matrix actions polls reactions profile pins"`
  returned no hits.
- `gitcrawl --json search openclaw/openclaw --query "Matrix"` returned broad
  Matrix operational hits but no top action-specific incident in the returned
  set.

### Discrawl queries

- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix actions polls reactions profile pins"`
  returned no hits.
- `/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 10 "Matrix openclaw"`
  returned general Matrix release and validation chatter.
