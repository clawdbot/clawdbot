---
title: "WhatsApp - Outbound Delivery and Targeting Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Outbound Delivery and Targeting Maturity Note

## Summary

WhatsApp outbound delivery and targeting are Beta. The documented core path is
broad and source-backed, with active-listener checks, target normalization,
chunking, quoted replies, delivery receipts, polls, reactions, and action-path
gating. It stays below Stable because delivery still depends on a live WhatsApp
Web/Baileys listener and archive search did not add current field signal for
this exact component.

## Category Scope

- Outbound text sends, message-tool delivery, explicit DM/group/newsletter
  targets, chunking, native reply quoting, polls, reactions, upload-file action
  path, and active-listener failure behavior.
- Provider-accepted receipts and durable delivery identifiers.
- Out of scope: inbound access policy, media payload quality beyond outbound
  routing, and native approval decision semantics.

## Features

- Outbound text sends: Outbound text sends, message-tool delivery, explicit DM/group/newsletter
- Provider-accepted receipts: Provider-accepted receipts and durable delivery identifiers

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: contract tests cover outbound chunking and durable-final
  text/replyTo proofs; runtime-style tests exercise monitor delivery, pending
  delivery drains, chunked replies, quote propagation, and target/action
  authorization.
- Negative signals: Gitcrawl and Discrawl did not surface current live-field
  evidence for outbound chunking, quoting, explicit targets, or actions.
- Integration gaps: no current live Baileys delivery proof covers DM, group JID,
  newsletter JID, quoted reply, reaction, poll, and upload-file action paths as
  one matrix.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: `whatsapp outbound send target chunk quote newsletter`
  returned no hits.
- Discrawl reports: `whatsapp outbound send target chunk quote newsletter`
  returned `null`.
- Good qualities: source fails fast without an active listener, normalizes
  E.164/group/newsletter targets, preserves provider acceptance in receipts,
  supports LID-aware sends/reactions, sanitizes visible text, and retries
  retryable outbound failures.
- Bad qualities: `@openclaw/whatsapp` depends on Baileys `7.0.0-rc13`,
  WhatsApp Web session volatility remains an operator concern, docs understate
  the full `upload-file` action path, and structured-only payloads without
  text/media are explicitly rejected.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Outbound text sends, Provider-accepted receipts.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live proof for DM, group JID, newsletter JID, quoted reply, poll, reaction,
  and upload-file action sends.
- Improve docs for the full outbound action surface, especially upload-file.
- Keep provider-accepted versus provider-delivered semantics visible in operator
  troubleshooting.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:155` documents WhatsApp Web/Baileys scope, Gateway-owned socket, active-listener requirement, group sends, and newsletter targets.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:421` documents text chunk limits and `chunkMode`.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:455` documents native reply quoting modes.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:584` documents actions and gates.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:669` documents active-listener and provider-accepted troubleshooting.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/send.ts:47` requires an active listener for outbound sends.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/send.ts:77` normalizes text, resolves media, uses the Baileys listener, and registers approval reaction targets.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/normalize-target.ts:70` normalizes DM, group, and newsletter targets.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/resolve-outbound-target.ts:17` resolves allowFrom-aware outbound targets.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-base.ts:144` declares gateway delivery, 4000-character chunking, durable text/replyTo, polls, and quote lookup.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/send-api.ts:68` builds Baileys payloads for quoted options, mentions, send receipts, polls, and reactions.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/package.json:10` pins Baileys as the outbound transport dependency.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-payload.contract.test.ts:33` covers outbound payload contracts and 4000-character chunking.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/outbound-payload.contract.test.ts:71` covers durable-final text and replyTo proofs.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:269` covers pending delivery drain while connected.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply.web-auto-reply.connection-and-logging.e2e.test.ts:939` covers monitor processing of direct inbound messages into reply resolution.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/resolve-outbound-target.test.ts:103` covers group/newsletter targets and allowFrom behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/deliver-reply.test.ts:245` covers chunked text replies and receipts.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/auto-reply/deliver-reply.test.ts:363` covers quote threading on every text chunk.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/channel-react-action.test.ts:106` covers upload-file action authorization and send path.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/action-runtime.test.ts:55` covers reaction add/remove, gating, and account routing.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/inbound/send-api.test.ts:408` covers polls, reactions, provider-unaccepted sends, newsletter sends, and quoted remote JIDs.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp outbound send target chunk quote newsletter" --json`

Results:

- Returned no hits.

Query:

`gitcrawl search openclaw/openclaw --query "WhatsApp outbound send target chunk quote reaction active listener Baileys" --json`

Results:

- Returned no hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp outbound send target chunk quote newsletter" --limit 5`

Results:

- Returned `null`.

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "WhatsApp outbound send target chunk quote reaction active listener" --limit 5`

Results:

- Returned `null`.
