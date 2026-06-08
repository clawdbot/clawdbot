---
title: "WhatsApp - Inbound DM Access and Privacy Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Inbound DM Access and Privacy Maturity Note

## Summary

WhatsApp inbound direct-message access and privacy are Beta. The DM policy,
pairing, allowlist, sender identity, read receipt, self-chat, durable receive,
inbound envelope, quoted context, and plugin hook behavior are documented and
implemented with fail-closed defaults. It stays below Stable because current
live proof does not deeply assert read-receipt, history, and privacy boundaries,
and archive evidence shows recent self-chat/read-receipt churn.

## Category Scope

- Direct-message `dmPolicy`, `allowFrom`, pairing challenge, pairing-store
  admission, and account-aware sender access.
- Sender identity extraction, read receipts, self-chat safeguards, contact and
  quoted context, durable receive, and inbound envelope construction.
- Privacy controls for plugin hooks and untrusted context.
- Out of scope: group routing, media payload scoring, outbound sends, and
  native approvals.

## Features

- Direct-message dmPolicy: Direct-message dmPolicy, allowFrom, pairing challenge, pairing-store
- Sender identity extraction: Sender identity extraction, read receipts, self-chat safeguards, and contact matching.
- Privacy controls for plugin hooks: Privacy controls for plugin hooks and untrusted context

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs explain DM access modes, pairing approval, inbound
  envelopes, read receipts, self-chat safeguards, and privacy opt-in; runtime
  flow and monitor tests cover allow/deny decisions, message extraction,
  dispatch, and self-message handling.
- Negative signals: standard live QA covers DM canary, pairing block, and group
  mention gating, but does not deeply assert read-receipt boundaries, plugin
  hook privacy, or history redaction.
- Integration gaps: no located live matrix proves disabled, allowlist deny,
  pairing challenge, pairing approval, read-receipt choice, self-chat ignore,
  durable receive replay, and history redaction in one WhatsApp run.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `whatsapp dm allowFrom pairing inbound privacy` surfaced
  open #68214 for an on-unauthorized hook event and suppress-pairing-reply
  config flag; `whatsapp read receipt` surfaced #79996 around outbound
  WhatsApp activity boundaries for a proposed hook.
- Discrawl reports: `whatsapp read receipt` returned review/support evidence
  for self-chat read-receipt suppression, monitor-group read-receipt opt-out,
  support guidance to disable read receipts, and release-note evidence that
  WhatsApp respects read-receipt boundaries.
- Good qualities: direct-message policies are explicit, pairing state is shared
  and account-scoped, unknown senders are not silently admitted, read receipts
  are delayed until handling completes, self-chat loops are guarded, durable
  receive dedupes/replays stable message IDs, and plugin hook privacy is opt-in.
- Bad qualities: rejected-message customization is not yet first-class, pairing
  replies can still be noisy for some operators, inbound logging includes
  privacy-sensitive body/media-path details, and archive review churn shows
  self-chat and read-receipt boundaries still need attention.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Direct-message dmPolicy, Sender identity extraction, Privacy controls for plugin hooks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live direct-message regressions for all denial and admission modes.
- Add recurring live assertions for blocked-sender no-read, self-chat no-read,
  read-receipts disabled, history redaction, and plugin-hook privacy.
- Decide whether #68214 should become a supported hook/config path.
- Improve operator-facing diagnostics when a sender is blocked by direct-message
  policy rather than by runtime failure.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:178` documents pairing prompts, exec/plugin approval independence, `allowFrom` approvers, and manual `/approve` auth path.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:210` documents plugin hooks and privacy opt-in.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:250` documents DM policy, pairing, allowlists, and direct-message access.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:322` documents self-chat safeguards.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:330` documents inbound envelope, quoted context, media placeholders, and read receipts.
- `/Users/kevinlin/code/openclaw/src/config/types.whatsapp.ts:53` types `dmPolicy`, `allowFrom`, `groupAllowFrom`, history limits, `selfChatMode`, and `sendReadReceipts`.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md:10` documents pairing as explicit access approval for unknown DM senders.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/access-control.ts:24` implements DM/group access control, pairing challenge, group policy, and read receipt decisioning.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/monitor.ts:543` normalizes Baileys inbound messages and drops non-user/status/echo events before routing.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/monitor.ts:660` handles read receipts, including self-chat suppression.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/monitor.ts:716` persists, dedupes, and replays durable inbound messages.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/extract.ts:209` extracts mentioned JIDs and sender context.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/extract.ts:233` extracts text, captions, and contact context.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound-policy.ts:136` maps WhatsApp sender identities into shared stable channel ingress policy with phone identity sensitivity.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/process-message.ts:75` gates plugin hooks behind explicit opt-in.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/process-message.ts:405` builds visible reply context and direct/group prompt context.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:204` defines WhatsApp canary, pairing-block, and mention-gating live scenarios.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:928` runs direct-message and group scenarios against live driver messages.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.allows-messages-from-senders-allowfrom-list.test-support.ts:101` covers allowlisted and same-phone DMs.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.blocks-messages-from-unauthorized-senders-not-allowfrom.test-support.ts:96` covers unauthorized sender blocking, no handler call, and no read receipt.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.streams-inbound-messages.test-support.ts:170` covers streaming inbound messages, delayed read receipts, durable fallback, reconnect, and metadata cache behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound-context.contract.test.ts:1` covers inbound context contract behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/access-control.test.ts:85` covers pairing grace, account-level `dmPolicy`, and persisted pairing behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/access-control.test.ts:356` covers self-chat scoping.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/inbound-context.test.ts:42` covers group history filtering and quote redaction.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/monitor/inbound-dispatch.test.ts:315` covers finalized inbound context construction.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/extract.test.ts:1` covers inbound extraction behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/send-result.test.ts:1` covers send-result handling used by inbound flows.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.blocks-messages-from-unauthorized-senders-not-allowfrom.test-support.ts:1` supports unauthorized sender monitor behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/monitor-inbox.allows-messages-from-senders-allowfrom-list.test-support.ts:1` supports allowFrom monitor behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp dm allowFrom pairing inbound privacy" --json`

Results:

- Surfaced #68214 requesting an on-unauthorized hook event and a suppress-pairing-reply config flag.

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp read receipt" --json`

Results:

- Surfaced #79996, noting no outbound WhatsApp activity such as reply, ack reaction, read receipt, or typing is triggered by a proposed hook.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp dm allowFrom pairing inbound privacy" --limit 5`

Results:

- Returned `null`; no relevant Discrawl archive hits for this exact component in the current snapshot.

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp read receipt" --limit 5`

Results:

- Returned review/support evidence for self-chat read-receipt suppression, monitor-group read-receipt opt-out, support guidance to disable read receipts, and release-note evidence that WhatsApp respects read-receipt boundaries.
