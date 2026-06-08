---
title: "WhatsApp - Conversation Routing and Delivery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Conversation Routing and Delivery Maturity Note

## Summary

WhatsApp group routing and activation are Beta. Docs and source cover group
allowlists, mention gating, owner activation, deterministic group session keys,
broadcast fanout, participant context, and group prompt behavior. It stays below
Stable because group configuration is brittle in practice and archive evidence
still shows operator confusion around exact group JIDs, account IDs, and mention
requirements.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Conversation Routing and Delivery`
- Merged from: `Message Routing and Delivery`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Group allowlists: Group allowlists, groupPolicy, exact group JIDs, requireMention, owner
- Group session keys: Group session keys, broadcast fanout, outbound mentions, and group prompt
- Outbound text sends: Outbound text sends, message-tool delivery, explicit DM/group/newsletter
- Provider-accepted receipts: Provider-accepted receipts and durable delivery identifiers
- Outbound text sends: Covers Outbound text sends, message-tool delivery, explicit DM/group/newsletter behavior.
- Provider-accepted receipts and durable delivery identifiers: Evidence scope for Provider-accepted receipts and durable delivery identifiers.

## Features

- Group allowlists: Group allowlists, groupPolicy, exact group JIDs, requireMention, owner
- Group session keys: Group session keys, broadcast fanout, outbound mentions, and group prompt
- Outbound text sends: Outbound text sends, message-tool delivery, explicit DM/group/newsletter
- Provider-accepted receipts: Provider-accepted receipts and durable delivery identifiers

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs cover group routing, group messages, activation, group
  session keys, mentions, and troubleshooting; source covers on-message gating,
  group activation, broadcast, session keys, inbound policy, and outbound
  mentions.
- Negative signals: live proof exists for mention-gating, but not the full
  group matrix of exact JID config, activation, wildcard prompts, broadcast, and
  participant context.
- Integration gaps: no located live scenario proves multi-account group JID
  routing, owner activation, mention-gated admission, and broadcast reply fanout
  together.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `whatsapp group mention gating groupPolicy` surfaced #63589
  for participant identity/quoted reply context in gateway inbound logs and
  #76135 for private messaging group sessions to surface verbose/tool progress.
- Discrawl reports: group searches returned support guidance that exact group
  JID and account ID must match and that most "group messages not received"
  reports are mention-gating or access-control issues.
- Good qualities: group admission is explicit, group session keys are
  deterministic, group prompts distinguish wildcard admission, and source
  centralizes gating before dispatch.
- Bad qualities: operator configuration has several exact-match fields, group
  JID discovery is not always obvious, and private group/session progress still
  has open UX asks.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Group allowlists, Group session keys, Outbound text sends, Provider-accepted receipts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live group-routing scenario that proves exact group JID, account ID,
  mention gating, owner activation, and group reply delivery.
- Improve diagnostics for dropped group messages so mention policy, allowlist
  policy, and wrong-account policy failures are distinct.
- Decide whether private group sessions should surface verbose/tool progress.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:165` documents group sends, mention metadata, status/broadcast ignore behavior, group session keys, and group JID behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:279` documents group policy, mentions, and activation.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:685` documents troubleshooting for group messages ignored by the bot.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:703` documents system prompt hierarchy and wildcard group prompt admission caveats.
- `/Users/kevinlin/code/openclaw/docs/channels/group-messages.md:11` documents WhatsApp-specific group behavior and context.
- `/Users/kevinlin/code/openclaw/docs/channels/group-messages.md:61` documents owner-only activation, usage, smoke checks, and known considerations.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/on-message.ts:97` routes messages and resolves sessions before processing.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/on-message.ts:214` applies group gating, broadcast handling, and process dispatch.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/group-gating.ts:131` enforces group allowlists, mentions, activation, and pending history.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/group-activation.ts:1` implements group activation state.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/broadcast.ts:1` handles broadcast fanout.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/group-session-key.ts:1` implements group session key behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/outbound-mentions.ts:1` maps outbound mention behavior for inbound group context.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:235` defines the live `whatsapp-mention-gating` scenario.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.test.ts:235` verifies group mention scenario config.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.broadcast-groups.combined.test.ts:1` covers combined auto-reply broadcast group behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:939` covers monitor processing of inbound messages into reply resolution.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/web-auto-reply-monitor.test.ts:170` covers group gating behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/group-gating.allowlist-warn.test.ts:1` covers group allowlist warnings.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/group-activation.test.ts:1` covers group activation.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/group-gating.audio-preflight.test.ts:1` covers group gating during audio preflight.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/group-policy.test.ts:1` and `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/group-session-key.test.ts:1` cover policy and session-key behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp group mention gating groupPolicy" --json`

Results:

- Surfaced #63589 for participant identity/quoted reply context in gateway inbound logs.
- Surfaced #76135 for private messaging group sessions to surface verbose/tool progress.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp group mention gating groupPolicy" --limit 5`

Results:

- Returned guidance that exact group JID and account ID must match for multiple accounts, that group routing does not bypass access controls, a review note about inherited account defaults in group gating, and a support thread where "group messages not received" was likely mention gating.
