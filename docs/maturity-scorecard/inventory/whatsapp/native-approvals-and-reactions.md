---
title: "WhatsApp - Native Controls and Approvals Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# WhatsApp - Native Controls and Approvals Maturity Note

## Summary

WhatsApp native approvals and reactions are Beta for Coverage and Stable for
Quality. The source separates approval approvers from channel allowlists,
supports explicit approver targets, binds reaction decisions to persistent
prompt targets, and handles prompt update/cancel behavior. Coverage remains
Beta because live approval proof exists but should remain a recurring scenario
for both exec and plugin approval routes.

## Normalization

Active category after channel taxonomy normalization.

- Normalized category: `Native Controls and Approvals`
- Merged from: `Native Approvals`
- Score carry-forward: conservative minimum of merged source category scores.

## Category Scope

Included in this category:

- Native exec: Native exec and plugin approval delivery through WhatsApp
- Approver target resolution: Approver target resolution, DM/group target eligibility, route suppression, and approval delivery.

## Features

- Native exec: Native exec and plugin approval delivery through WhatsApp
- Approver target resolution: Approver target resolution, DM/group target eligibility, route suppression, and approval delivery.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs cover exec/plugin approvals, manual `/approve`, native
  reaction behavior, and authorization separation; live QA has selectable
  WhatsApp native approval scenarios for exec and plugin approvals.
- Negative signals: native approval scenarios are not part of the standard
  default WhatsApp live set, and archive evidence is mostly adjacent discussion
  rather than current WhatsApp-specific defects.
- Integration gaps: add routine live proof for exec and plugin prompt delivery,
  update, reaction decision, cancellation, stale-target cleanup, and group-origin
  suppression.

## Quality Score

- Score: `Stable (84%)`
- Gitcrawl reports: `whatsapp native approval reaction exec plugin` surfaced
  only adjacent iMessage approval formatting noise, not a direct WhatsApp issue.
- Discrawl reports: `whatsapp native approval reaction exec plugin` surfaced
  maintainer discussion and PR #86735 around centralizing approval reaction logic
  into plugin-sdk for iMessage, WhatsApp, and Signal.
- Good qualities: authorization is not inferred from channel allowlists,
  approver targets are explicit, group-origin routing requires eligible
  approvers, reaction targets are persisted and cleaned up, stale decisions are
  resolved defensively, and prompt update/cancel behavior is channel-specific.
- Bad qualities: persistent reaction-target state is best-effort around deleted
  or stale messages, and delivery still depends on the same active listener and
  Baileys session health as outbound messages.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow
  test coverage did not raise or lower this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/whatsapp.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native exec, Approver target resolution.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Include WhatsApp exec and plugin native approval scenarios in recurring live
  coverage or an equivalent release gate.
- Add explicit stale-target and deleted-message operational diagnostics.
- Keep approval approver docs close to channel allowlist docs to avoid unsafe
  inference by operators.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:178` documents approval prompts, exec/plugin independence, approver `allowFrom`, and manual `/approve` behavior.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:455` documents reaction levels and ack/status reactions.
- `/Users/kevinlin/code/openclaw/docs/channels/whatsapp.md:584` documents action and config write gates.

### Source

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.ts:203` enables approval routing based on channel and account settings.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.ts:250` determines session and explicit target eligibility.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.ts:316` resolves origin targets and group approver requirements.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.ts:383` resolves approver DM routing and suppression.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.ts:425` exposes the WhatsApp native approval capability.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-handler.runtime.ts:94` delivers, updates, binds, unbinds, and cancels native approval prompts.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-auth.ts:22` authorizes approval decisions from configured approvers.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-reactions.ts:37` defines persistent reaction target storage.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-reactions.ts:263` resolves incoming reaction decisions and stale target cleanup.

### Integration tests

- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:47` lists `whatsapp-approval-exec-native` and `whatsapp-approval-plugin-native`.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.ts:676` handles approval request, decision, and live message matching.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.test.ts:167` verifies native approval scenarios are selectable outside the default set.
- `/Users/kevinlin/code/openclaw/extensions/qa-lab/src/live-transports/whatsapp/whatsapp-live.runtime.test.ts:194` verifies config enables native approvals for approval scenarios.

### Unit tests

- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-native.test.ts:1` covers native approval routing behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-handler.runtime.test.ts:1` covers runtime delivery, update, bind, unbind, and cancel behavior.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-auth.test.ts:1` covers approval authorization.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/approval-reactions.test.ts:1` covers reaction decision resolution and persistent targets.
- `/Users/kevinlin/code/openclaw/extensions/whatsapp/src/reaction-level.test.ts:1` covers reaction-level behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "whatsapp native approval reaction exec plugin" --json`

Results:

- Surfaced only adjacent iMessage approval prompt formatting noise, not a direct WhatsApp approval defect.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl --json search "whatsapp native approval reaction exec plugin" --limit 5`

Results:

- Returned maintainer discussion and PR #86735 around centralizing approval reaction logic into plugin-sdk for channels with reaction approvals, including WhatsApp.
