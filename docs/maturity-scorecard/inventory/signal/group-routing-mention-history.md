---
title: "Signal - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Conversation Routing and Delivery Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Group Routing, Mentions, and Pending History` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Conversation Access and Routing`, `Message Delivery and Actions`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM pairing: Defines DM pairing setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- DM allowlists: Defines DM allowlists setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Sender identity normalization: Defines Sender identity normalization setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Group allowlists: Defines Group allowlists authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Mention gates: Defines Mention gates authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Pending group history: Defines Pending group history authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing.
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool.
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool.
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool.

## Features

- Conversation Routing and Delivery: Evidence scope for Conversation Routing and Delivery.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`

Coverage is Beta because docs, source, contract tests, and unit tests cover group gates, mentions, and pending history, but no live group-routing transcript was found.

## Quality Score

- Score: `Alpha (66%)`

Quality is Alpha because the group model is configurable but operator history shows that defaults and sender matching are hard to reason about in real groups. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Conversation Routing and Delivery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 254-261 document `groupPolicy`, `groupAllowFrom`, per-group overrides, `groupMentionAliases`, and `requireMention`.
- `docs/channels/signal.md` lines 263-268 explain normalized inbound envelopes and route-back behavior.
- `docs/channels/signal.md` lines 270-278 document media, history, and capture limits relevant to group context.

### Source

- `extensions/signal/src/monitor/access-policy.ts` applies group allowlists, group IDs, fallback behavior, and effective group allowlist calculations.
- `extensions/signal/src/monitor/event-handler.ts` resolves group IDs, handles group access blocks, evaluates mention policy, stores pending history for skipped messages, and ingests internal hook context when configured.
- `extensions/signal/src/identity.ts` distinguishes group IDs from direct senders so group IDs do not satisfy direct allowlists.
- `extensions/signal/src/types.ts` carries Signal group and message-envelope types used by the monitor path.

### Integration tests

- `extensions/signal/src/inbound-context.contract.test.ts` validates group session keys and Signal context fields.
- No live group routing, group mention, or group history run was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/monitor/access-policy.test.ts` covers group allowlist forms, mismatch blocking, `allowFrom` fallback, group IDs not satisfying direct allowlists, access groups, and effective group allowlists.
- `extensions/signal/src/monitor/event-handler.mention-gating.test.ts` covers drop/allow decisions around mentions, no-mention-required groups, configured group IDs, pending history, and control-command bypass.
- `extensions/signal/src/monitor/event-handler.inbound-context.test.ts` covers structured pending group history versus current text.

### Gitcrawl queries

- Query: `Signal groupAllowFrom requireMention`
  - Results: archive search returned group policy and mention gating issues, including issue `#53308`.
- Query: `Signal groupAllowFrom sender mismatch requireMention default`
  - Results: issue `#53308` reports group allowlist sender mismatch and `requireMention` default behavior making group integration non-functional.

### Discrawl queries

- Query: `Signal groupAllowFrom requireMention`
  - Results: support messages from 2026-04-20 and 2026-04-21 explain `groupPolicy`, `groupAllowFrom`, `groups.<id>.requireMention`, aliases, and default mention behavior.
- Query: `Signal groupAllowFrom sender mismatch requireMention default`
  - Results: Discord GitHub mirror content for issue `#53308` repeated the sender mismatch and mention-default report.
