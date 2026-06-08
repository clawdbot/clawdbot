---
title: "Anthropic provider path - Diagnostics and Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Anthropic provider path - Diagnostics and Recovery Maturity Note

## Summary

Anthropic diagnostics cover `models status`, auth profile health, OAuth/token
usage windows, doctor hints, long-context 429 troubleshooting, cooldowns, and
fallback guidance. Coverage is Beta because important diagnostics exist across
docs, source, and tests, but the diagnostic surface is split across model
status, doctor, provider usage, and user-runbook flows. Quality is Beta because
archive evidence shows users still struggle to distinguish Anthropic API-key
billing, Claude account usage, cooldowns, extra-usage errors, and profile-store
state.

## Category Scope

This category covers operator diagnostics and recovery for Anthropic provider
failures: status output, usage windows, auth profile source reporting, cooldown
and disabled profile reporting, doctor hints, long-context 429 remediation,
missing credentials guidance, fallback setup, and provider error/billing
classification.

## Features

- Model status: Covers Model status across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Usage windows: Covers Usage windows across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Cooldown/profile reporting: Covers Cooldown/profile reporting across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Long-context recovery: Covers Long-context recovery across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.
- Fallback guidance: Covers Fallback guidance across operator diagnostics and recovery for Anthropic provider failures: status output, usage windows, auth profile source reporting, cooldown and disabled profile reporting, and related diagnostics and recovery behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docs cover common Anthropic credential errors and long-context 429s; source fetches Claude usage windows, reports doctor hints, and handles provider auth profile ordering/cooldowns; tests cover usage fetch and doctor behavior.
- Negative signals: Recovery is distributed across `models status`, `doctor`, troubleshooting docs, model fallback config, and auth-profile commands rather than one cohesive Anthropic diagnostics workflow.
- Integration gaps: The audit did not find a single live failure-to-repair scenario test for Anthropic auth, usage, cooldown, and fallback recovery.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: #80514 reports Claude Pro Max cap warning being classified as billing failure; #83268 reports API-key profile orphaning; #63145 requests per-model health probing across configured models; PR #85666 skips Anthropic API keys for usage status; PR #87697 clears stale provider cooldowns after reauth.
- Discrawl reports: Discord archive results include users seeing "out of extra usage", invalid bearer token, Anthropic API-key versus Claude account billing confusion, profile cooldown confusion, and daemon/auth-store mismatches.
- Good qualities: Docs name concrete commands, usage fetch handles OAuth/web fallback, doctor reports stale OAuth profiles and refresh guidance, and troubleshooting distinguishes credential eligibility from config shape.
- Bad qualities: Users still need to map upstream Anthropic billing and auth semantics to OpenClaw's auth-store, cooldown, fallback, and model-status vocabulary.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test presence or absence; those are Coverage inputs only.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/anthropic-provider-path.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Model status, Usage windows, Cooldown/profile reporting, Long-context recovery, Fallback guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- `models status` helps, but users still often need maintainer interpretation
  to connect auth-store source, billing status, and model fallback behavior.
- Usage status behavior differs by auth mode and scope.
- The long-context 429 path is documented, but upstream eligibility remains
  outside OpenClaw control.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/providers/anthropic.md` includes troubleshooting accordions for token invalidity, no API key, no profile, and all profiles in cooldown.
- `/Users/kevinlin/code/openclaw/docs/gateway/troubleshooting.md` documents the exact long-context 429 symptom, commands to inspect logs/status/config, causes, and fix options.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md` documents OAuth expiry/refresh behavior, Anthropic API-key or setup-token suggestions, and profile cooldown/disabled reporting.
- `/Users/kevinlin/code/openclaw/docs/reference/prompt-caching.md` documents usage cache counters and Anthropic provider behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/infra/provider-usage.fetch.claude.ts` fetches Anthropic OAuth usage windows, supports claude.ai web-session fallback for missing `user:profile` scope, and returns structured provider usage snapshots.
- `/Users/kevinlin/code/openclaw/extensions/anthropic/register.runtime.ts` wires `fetchUsageSnapshot`, `resolveUsageAuth`, `buildAuthDoctorHint`, and `isCacheTtlEligible`.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.ts` checks Claude CLI command, credentials, workspace/project dirs, and profile store health.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-helpers/provider-error-patterns.ts` and adjacent provider fallback helpers classify provider errors used in recovery/fallback decisions.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.status-command.ts` and related model list/status modules render provider/auth health.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/commands/models.list.e2e.test.ts` covers provider/auth catalog responsiveness in the models command surface.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies Anthropic credential requirements and live profile wiring in package acceptance.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/provider-usage.fetch.claude.test.ts` covers Claude usage fetch behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-claude-cli.test.ts` covers Claude CLI doctor diagnostics.
- `/Users/kevinlin/code/openclaw/src/commands/models/list.status.test.ts` and related model status/list tests cover provider status rendering.
- `/Users/kevinlin/code/openclaw/src/agents/embedded-agent-helpers/provider-error-patterns.test.ts` covers provider error classification.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic usage status API key Claude"`

Results:

- #83268 reports API-key wizard provider orphaning.
- #80514 reports Claude Pro Max cap warning being classified as a billing failure and creating a false cooldown.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic 429 long context extra usage required fallback"`

Results:

- Returned no direct results for that exact issue query.

Query: `gitcrawl --json search issues -R openclaw/openclaw "Anthropic No API key found provider anthropic models status"`

Results:

- Returned related auth/provider-status issues including #63145 for per-model health checks and auth-profile issues from other providers.

### Discrawl queries

Query: `discrawl search --limit 10 "Anthropic usage status Claude API key"`

Results:

- Returned support threads about API-key billing versus Claude account usage, extra-usage errors, invalid bearer token, provider profile source, and what to inspect in `openclaw models status`.

Query: `discrawl search --limit 10 "Claude 4.6 1M context Anthropic 429"`

Results:

- Returned long-context 429 troubleshooting guidance and extra-usage eligibility notes.

Query: `discrawl search --limit 10 "Anthropic API key no credentials profile"`

Results:

- Returned profile/store mismatch, no-key/no-profile, and setup-token confusion threads.
