---
title: "Signal - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Native Controls and Approvals Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Approval Routing and Reaction Resolution` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Native Approvals`, `Message Delivery and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Native approval routing: Defines Native approval routing authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Reaction approval responses: Defines Reaction approval responses authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Approver targeting: Defines Approver targeting authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.
- Reactions Message Tool: Evidence scope for Reactions Message Tool

## Features

- Native approval routing: Defines Native approval routing authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Reaction approval responses: Defines Reaction approval responses authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.
- Approver targeting: Defines Approver targeting authorization, trust, safety boundaries, and operator controls for Approval Routing and Reaction Resolution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (65%)`

Coverage is Alpha because docs, source, and tests cover native approval routing and reaction binding, but no live Signal approval run was found.

## Quality Score

- Score: `Beta (70%)`

Quality is Beta because session and target routing have explicit source checks and persistence, but group approvals depend on explicit approver routing and exact target metadata. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (65%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native approval routing, Reaction approval responses, Approver targeting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 309-322 document approval reactions, route configuration, and fallback behavior.
- `docs/channels/signal.md` lines 324-329 document delivery targets used by approval routing.
- `docs/channels/signal.md` lines 286-307 document the reaction primitives that approval prompts rely on.

### Source

- `extensions/signal/src/approval-native.ts` checks approval eligibility, origin account, route mode, explicit approvers, and delivery capabilities; it also suppresses local exec prompts only when configured Signal routes can handle them.
- `extensions/signal/src/approval-handler.runtime.ts` creates the native runtime adapter and prepares Signal-specific approval targets.
- `extensions/signal/src/approval-reactions.ts` stores bounded prompt bindings, builds reaction hints, appends eligibility metadata, registers outbound approval targets, and resolves reaction responses.
- `extensions/signal/src/channel.ts` wires approval capability into the Signal channel.

### Integration tests

- `extensions/signal/src/approval-handler.runtime.test.ts` exercises runtime target preparation and pending delivery through the Signal approval adapter.
- No live Signal approval prompt, reaction approve, or fallback transcript was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/approval-native.test.ts` covers readiness alone not enabling approvals, session-mode exec delivery for matching origins, explicit approvers for group-origin approvals, independent exec/plugin gates, non-Signal origin rejection, target-mode config availability, and manual fallback without reaction bindings/approvers.
- `extensions/signal/src/approval-reactions.test.ts` covers reaction hints, duplicate-hint avoidance, target-mode outbound approval prompt registration, disabled target route fallback, allow-always target behavior, and registered-target resolution.

### Gitcrawl queries

- Query: `Signal approval reactions`
  - Results: archive results showed approval-reaction development history but no live Signal approval success transcript.
- Query: `Signal approvals explicit approvers group`
  - Results: no focused current failure was returned beyond the source-visible explicit-approver requirement.

### Discrawl queries

- Query: `Signal approval reactions`
  - Results: no displayed operator transcript proved live Signal approval handling.
- Query: `Signal approvals explicit approvers group`
  - Results: no displayed operator report changed the source-based assessment.
