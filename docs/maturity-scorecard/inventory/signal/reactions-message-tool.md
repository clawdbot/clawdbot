---
title: "Signal - Reactions Message Tool Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Reactions Message Tool Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Reactions Message Tool` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Signal capability area represented by these taxonomy features:

- Reactions Message Tool: Evidence scope for Reactions Message Tool.

## Features

- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`

Coverage is Beta because docs, source, and unit tests cover reaction action discovery, add/remove calls, and group metadata validation, but no live Signal reaction proof was found.

## Quality Score

- Score: `Beta (72%)`

Quality is Beta because reaction gating and validation are explicit, with the main source risk being metadata-sensitive group targets rather than broad design ambiguity. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Reaction action discovery, Add/remove reactions, Group reaction targeting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 286-307 document Signal reactions, the message tool, enablement config, account selection, `reactionLevel`, and group `targetAuthor` requirements.
- `docs/channels/signal.md` lines 324-329 document target forms used by reaction calls.

### Source

- `extensions/signal/src/message-actions.ts` describes available message tools based on configured accounts and action gates, validates target/message IDs, handles current-message fallback, and exposes add/remove reaction actions.
- `extensions/signal/src/send-reactions.ts` normalizes recipients, requires timestamp/emoji/target author where needed, and maps add/remove calls to Signal reaction RPCs.
- `extensions/signal/src/channel.ts` wires Signal message actions into the channel surface.
- `src/config/types.signal.ts` defines `actions.reactions` and `reactionLevel`.

### Integration tests

- No live reaction add/remove run was found in `qa/`, `test/`, or `tests`.
- Signal channel contract tests cover context wiring but not real reaction delivery.

### Unit tests

- `extensions/signal/src/message-actions.test.ts` covers action discovery by configured accounts and reaction gates, disabled action behavior, direct target mapping, UUID targets, group `targetAuthor`, current-message fallback, and invalid inputs.
- `extensions/signal/src/client-container.test.ts` covers container reaction RPC mapping.
- `extensions/signal/src/approval-reactions.test.ts` covers a separate approval-reaction path and target binding behavior.

### Gitcrawl queries

- Query: `Signal reactions targetAuthor`
  - Results: no focused current failure was found for the general message reaction tool.
- Query: `Signal message actions reactions`
  - Results: broader archive results centered on approval reactions and reaction routing rather than the user-facing message action.

### Discrawl queries

- Query: `Signal reactions targetAuthor`
  - Results: no displayed operator transcript proved live reaction success or failure.
- Query: `Signal message actions reactions`
  - Results: no displayed Signal-specific user/operator report changed the source-based assessment.
