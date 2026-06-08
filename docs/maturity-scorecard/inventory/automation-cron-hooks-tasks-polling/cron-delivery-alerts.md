---
title: "Automation: cron, hooks, tasks, polling - Cron Delivery and Failure Alerts Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Automation: cron, hooks, tasks, polling - Cron Delivery and Failure Alerts Maturity Note

## Summary

Cron delivery is feature-rich: jobs can announce to channels, post webhook payloads, suppress runner fallback delivery, preserve last/current chat routing, mirror direct delivery into transcripts, suppress stale interim text, prefer descendant subagent output, and notify failure destinations. The implementation is powerful but complex enough that archive evidence still shows privacy and routing hazards around failure alerts and webhook mode.

## Category Scope

This category covers cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, failure destinations, skipped-run alerts, message-tool delivery awareness, descendant subagent delivery preference, and cleanup after isolated runs.

## Features

- Chat announce delivery: Covers Chat announce delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Webhook delivery: Covers Webhook delivery across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Failure destinations: Covers Failure destinations across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Skipped-run alerts: Covers Skipped-run alerts across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.
- Delivery previews: Covers Delivery previews across cron output delivery modes, channel target resolution, direct delivery retries, transcript mirroring, and related cron delivery and failure alerts behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Delivery has focused coverage for direct delivery, delivery target resolution, failure alerts, delivery plans/previews, double-announce prevention, named-agent delivery, outbound runtime dispatch, stale interim suppression, and delivery status persistence.
- Negative signals: Coverage is mostly simulated and component-level. Cross-channel live delivery, webhook delivery failure privacy, and descendant subagent delivery behavior are not proven by one broad e2e scenario.
- Integration gaps: A live matrix should cover announce, webhook, no-deliver, explicit failure destinations, stale target rejection, skipped provider-preflight alerts, and descendant subagent final-output delivery across at least one chat channel and one webhook receiver.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: PR #85394 references failure-alert schema and cron-tool decomposition. The query found ongoing work near skipped-run alert behavior.
- Discrawl reports: A review comment on PR #31059 warns that webhook-mode failure alerts without `to` could fall through to announce delivery and leak error details to chat targets.
- Good qualities: Delivery planning is explicit, provider selector prefixes are validated, direct delivery uses idempotency keys and transient retry loops, stale deliveries can be skipped, and isolated cleanup closes tracked browser/MCP resources best-effort without masking the run result.
- Bad qualities: Delivery has a large state space across channel routes, direct sends, fallback announcement, transcript mirroring, webhook mode, failure alerts, and subagent follow-up. The archive privacy warning shows mode boundaries can be easy to get wrong.
- Excluded from quality: Test inventory and runtime proof depth; they are coverage inputs only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/automation-cron-hooks-tasks-polling.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Chat announce delivery, Webhook delivery, Failure destinations, Skipped-run alerts, Delivery previews.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Failure-alert mode should fail closed when destination fields are incomplete, with no fallback to a broader recipient than the operator selected.
- Delivery documentation should include a compact routing table for `last`, explicit channel targets, provider-prefixed targets, webhook mode, and failure destinations.
- A small local webhook fixture would make delivery regressions easier to prove without real channel credentials.

## Evidence

### Docs

- `docs/automation/cron-jobs.md` documents delivery modes `announce`, `webhook`, and `none`; explicit channel targets; channel prefix validation; message-tool interaction; output language; failure destinations; skipped alerts; and troubleshooting for no delivery.
- `docs/automation/tasks.md` documents cleanup and completion behavior for cron tasks and descendant subagent output preference.
- `docs/channels/discord.md` includes channel-specific cron delivery behavior for Discord text announcements.

### Source

- `src/cron/delivery.ts`, `src/cron/delivery-plan.ts`, `src/cron/delivery-preview.ts`, `src/cron/delivery-context.ts`, `src/cron/delivery-field-schemas.ts`, and `src/cron/webhook-url.ts` implement delivery validation, planning, preview, and URL handling.
- `src/cron/isolated-agent/delivery-dispatch.ts`, `src/cron/isolated-agent/delivery-target.ts`, `src/cron/isolated-agent/delivery-outbound.runtime.ts`, and `src/cron/isolated-agent/subagent-followup.ts` implement isolated direct delivery, idempotency, retries, transcript mirroring, and descendant-output preference.
- `src/cron/service/initial-delivery.ts`, `src/cron/service/task-ledger.ts`, and `src/cron/service/timer.ts` feed initial delivery context, task state, and failure alerts from the scheduler.

### Integration tests

- `src/cron/isolated-agent.direct-delivery-core-channels.test.ts` covers direct delivery across core channel abstractions.
- `src/cron/isolated-agent/delivery-dispatch.named-agent.test.ts` and `src/cron/isolated-agent/delivery-dispatch.double-announce.test.ts` exercise integrated isolated delivery dispatch cases.
- `src/cron/isolated-agent.delivery-awareness.test.ts` covers awareness of agent-sent messages versus fallback delivery.

### Unit tests

- `src/cron/delivery.test.ts`, `src/cron/delivery-plan.test.ts`, `src/cron/delivery-preview.test.ts`, `src/cron/delivery.failure-notify.test.ts`, and `src/cron/delivery-context.test.ts` cover planning and alert logic.
- `src/cron/isolated-agent/delivery-target.test.ts`, `src/cron/isolated-agent/channel-output-policy.test.ts`, and `src/cron/isolated-agent/subagent-followup.test.ts` cover target resolution, channel output rules, and descendant follow-up.
- `src/cron/service.delivery-plan.test.ts`, `src/cron/service.failure-alert.test.ts`, and `src/cron/service.persists-delivered-status.test.ts` cover service-level delivery behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "cron delivery failure alerts announce webhook skipped" --json --limit 5`

Results:

- PR #85394, `refactor(cron-tool): decompose into per-action tools (WOR-317)`, includes failure-alert schema and skipped-run alert fields, showing this surface is actively evolving.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 5 "cron delivery failure alerts announce webhook skipped"`

Results:

- Review comment on PR #31059 warns that `sendCronFailureAlert` in webhook mode without `to` could fall through to announce delivery and leak failure text to chat targets.
