---
title: "Signal - Access and Identity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Access and Identity Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `DM Pairing and Access Control` into the current process-version-3 scorecard inventory.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Access and Identity`
- Merged from: `Conversation Access and Routing`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- DM pairing: Defines DM pairing setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- DM allowlists: Defines DM allowlists setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Sender identity normalization: Defines Sender identity normalization setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Group allowlists: Defines Group allowlists authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Mention gates: Defines Mention gates authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Pending group history: Defines Pending group history authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- DM pairing: Defines DM pairing setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control
- DM allowlists: Defines DM allowlists setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control
- Sender identity normalization: Defines Sender identity normalization setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control
- Group allowlists: Defines Group allowlists authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History
- Mention gates: Defines Mention gates authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History
- Pending group history: Defines Pending group history authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History
- Text delivery targets: Covers Text delivery targets routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing
- Media delivery and limits: Covers Media delivery and limits routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing
- Typing and read receipts: Covers Typing and read receipts routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing
- Styled/chunked output: Covers Styled/chunked output routing, session binding, history, and conversation context for Outbound Delivery, Media, Receipts, and Typing
- Reaction action discovery: Covers Reaction action discovery routing, session binding, history, and conversation context for Reactions Message Tool
- Add/remove reactions: Covers Add/remove reactions routing, session binding, history, and conversation context for Reactions Message Tool
- Group reaction targeting: Covers Group reaction targeting routing, session binding, history, and conversation context for Reactions Message Tool

## Features

- DM pairing: Defines DM pairing setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- DM allowlists: Defines DM allowlists setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Sender identity normalization: Defines Sender identity normalization setup, credential, configuration, and operator verification behavior for DM Pairing and Access Control.
- Group allowlists: Defines Group allowlists authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Mention gates: Defines Mention gates authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.
- Pending group history: Defines Pending group history authorization, trust, safety boundaries, and operator controls for Group Routing, Mentions, and Pending History.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`

Coverage is Beta because docs, source, and unit tests cover pairing, allowlists, and identity forms across phone and UUID senders, but live pairing evidence is absent.

## Quality Score

- Score: `Beta (70%)`

Quality is Beta because the access model is explicit and source-backed, but operator history shows allowlist confusion and an open alias-matching follow-up. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for DM pairing, DM allowlists, Sender identity normalization, Group allowlists, Mention gates, Pending group history.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 30-54 document `dmPolicy`, `allowFrom`, and default pairing configuration.
- `docs/channels/signal.md` lines 74-79 document number normalization and self-loop protection.
- `docs/channels/signal.md` lines 246-253 document DM pairing and access behavior.
- `docs/channels/signal.md` lines 367-372 document security notes for allowlists and account isolation.

### Source

- `extensions/signal/src/setup-core.ts` prompts for `allowFrom`, defaults `dmPolicy` to pairing, and stores per-account direct-message policy.
- `extensions/signal/src/identity.ts` resolves phone and UUID senders, formats peer IDs, parses allowlist entries, supports wildcard values, and normalizes UUID/phone aliases.
- `extensions/signal/src/monitor/access-policy.ts` computes access state, applies pairing store checks, handles direct-message pairing challenge replies, and builds stable identity aliases.
- `extensions/signal/src/monitor/event-handler.ts` filters self-loop/sync messages, resolves direct-message access, handles pairing replies, and drops unauthorized direct-message commands.

### Integration tests

- `extensions/signal/src/inbound-context.contract.test.ts` verifies Signal inbound context keys and provider/surface fields.
- No live direct-message pairing proof was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/monitor/access-policy.test.ts` covers access groups, pairing-store direct senders, pairing-store group mismatch blocking, direct-message pairing code flow, and control-command gates.
- `extensions/signal/src/monitor.tool-result.pairs-uuid-only-senders-uuid-allowlist-entry.test.ts` covers UUID-only sender pairing and UUID allowlist entry handling.
- `extensions/signal/src/core.test.ts` covers setup parsing for UUID and wildcard allowlist entries.
- `extensions/signal/src/monitor/event-handler.inbound-context.test.ts` covers allowed direct messages, read receipts, and dropping direct-message commands in open mode without allowlists.

### Gitcrawl queries

- Query: `Signal allowlist uuid e164 alias`
  - Results: open PR `#78022` proposes matching allowlists on either UUID or E.164 aliases.
- Query: `Signal dmPolicy pairing allowFrom uuid`
  - Results: broader results show pairing and allowlist discussions but no live end-to-end pass record.

### Discrawl queries

- Query: `Signal dmPolicy pairing allowFrom uuid`
  - Results: support discussion from 2026-02-25 and 2026-02-26 advised staying on `dmPolicy: "pairing"` and showed operator confusion around `allowFrom` and UUID-only senders.
- Query: `Signal allowlist uuid e164 alias`
  - Results: no displayed result proved the alias-matching follow-up had landed and been exercised live.
