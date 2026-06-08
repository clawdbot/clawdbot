---
title: "Slack - Diagnostics, Status, and Operator Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Slack - Diagnostics, Status, and Operator Repair Maturity Note

## Summary

Slack operator support includes channel status, account inspection, capability diagnostics, doctor/security findings, scope diagnostics, probe behavior, troubleshooting docs, and config migration/repair. Coverage is Beta because source and unit coverage are broad, but live repair proof is uneven. Quality is Beta because the operator record still shows `unknown_method` scope discovery, `missing_scope`, configured-unavailable secrets, silent blocked channel IDs, and transport probes that can look healthy while events are broken.

## Category Scope

This category covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, doctor fixes, security audit findings, troubleshooting docs, migration warnings, channel ID migration, status issues, and operator repair loops.

## Features

- Channel status diagnostics: Covers `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and Slack repair guidance.
- Slack account status: Covers account snapshots, token source/status fields, capability summaries, and Slack status output.
- Operator Repair: Covers Operator Repair across `openclaw channels status --probe`, account snapshots, token source/status fields, capability and scope diagnostics, and related diagnostics, status, and operator repair behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Account inspection, capability diagnostics, status summaries, doctor checks, security audit, config migration, channel ID migration, and troubleshooting copy all have source and unit coverage.
- Negative signals: Live Slack QA does not directly validate doctor repair, status issue reporting, SecretRef-unavailable paths, scope discovery fallbacks, or HTTP-mode status repair.
- Integration gaps: Add live/operator scenarios for `channels status --probe`, `channels capabilities`, `doctor --fix`, missing-scope diagnosis, `configured_unavailable` SecretRefs, channel-name blocking, and stale Socket Mode liveness.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `#44297`, `#75076`, `#44692`, `#44625`, `#43504`, `#63389`, and broad `slack doctor status probe` results show active capability/status/scope/config diagnostic work.
- Discrawl reports: Capability output showed Slack bot scopes returning `auth.scopes`/`apps.permissions.info` `unknown_method`; support threads repeatedly needed logs, status probes, missing-scope fixes, app reinstall, and stable channel ID guidance.
- Good qualities: Docs give a troubleshooting order for no channel replies, ignored DMs, Socket Mode failures, HTTP-mode failures, and native command issues.
- Bad qualities: Some diagnostics still require interpreting Slack-side admin state, probes may not prove inbound event delivery, and name-based channel allowlists can silently block messages.
- Excluded from quality: Unit-test count, live-lane breadth, and integration depth.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/slack.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Channel status diagnostics, Slack account status, Operator Repair.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a single Slack "why no reply?" diagnostic that joins config, token, scope, app install, channel membership, group policy, and event liveness.
- Add status issue copy for probes that pass over Web API while Socket Mode events are stale or missing.
- Add doctor repair for common Slack manifest/scope drift where safe, or a generated exact Slack UI checklist where not safe.

## Evidence

### Docs

- `docs/channels/slack.md` documents status snapshot behavior, troubleshooting for no channel replies, ignored DMs, Socket Mode, HTTP mode, and native commands.
- `docs/channels/troubleshooting.md`, `docs/gateway/troubleshooting.md`, and `docs/gateway/config-channels.md` are linked as shared diagnostic references.

### Source

- `extensions/slack/src/account-inspect.ts` reports mode, credential sources/statuses, group policy, reply modes, actions, and media settings.
- `extensions/slack/src/channel.ts` implements status summaries, capability diagnostics, probes, and scope fetches.
- `extensions/slack/src/doctor.ts`, `security-doctor.ts`, `security-audit.ts`, and `channel-migration.ts` implement repair/audit/migration helpers.
- `src/infra/channels-status-issues.test.ts` includes Slack status issue collection from channel plugins.

### Integration tests

- `extensions/qa-lab/src/live-transports/slack/slack-live.runtime.ts` emits Slack QA reports and observed-message artifacts but does not validate doctor/status repair as standalone scenarios.
- `docs/concepts/qa-e2e-automation.md` documents live Slack output artifacts for report and debugging use.

### Unit tests

- `extensions/slack/src/channel.lazy-seams.test.ts` covers status summary and capability diagnostics lazy SDK forwarding.
- `extensions/slack/src/doctor.test.ts`, `security-audit.test.ts`, `channel-migration.test.ts`, `probe.test.ts`, `scopes.test.ts`, and `errors.test.ts` cover diagnostics and repair behavior.
- `extensions/slack/src/config-schema.test.ts` validates invalid config rejection that feeds operator repair.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "slack doctor status probe" --json`
- `gitcrawl search openclaw/openclaw --query "Slack" --json`

Results:

- Focused status/probe query returned adjacent status/probe reports and `#87168` showing Slack configured in gateway health output.
- Broader Slack results included `#44297` external arg-menu fallback health signal, `#75076` status warnings with Slack/channel health fields, and scope/setup fixes such as `#44692` and onboarding manifest scope work.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Slack channels status probe doctor missing_scope"`

Results:

- Returned Slack capability/status examples where Slack reported configured/running/works while bot scope discovery returned `unknown_method`, plus support advice to inspect `missing_scope`, `not_in_channel`, `Forbidden`, and 401/403 logs.
