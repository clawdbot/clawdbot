---
title: "Microsoft Teams - Diagnostics and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Microsoft Teams - Diagnostics and Repair Maturity Note

## Summary

Teams diagnostics are useful once credentials exist: the setup wizard reports
credential status, probe checks bot and Graph tokens, docs cover common setup
errors, and send errors include actionable hints. Coverage remains Alpha
because the audit did not find an OpenClaw-owned live repair scenario for clean
install, admin consent, Graph permissions, Teams app doctor, stale manifest
cache, or webhook endpoint changes.

## Category Scope

This category covers setup wizard status, credential prompts, env credential
detection, setup docs, `teams app doctor` guidance, probe token checks, Graph
role/scope reporting, delegated token status, setup warnings, channel health
hooks, webhook timeout docs, and error hints for auth, throttling, transient,
permanent, network, and revoked-proxy failures.

## Features

- Setup status: Covers Setup status across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Probe and scope reporting: Covers Probe and scope reporting across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Teams app doctor: Covers Teams app doctor across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Webhook and health diagnostics: Covers Webhook and health diagnostics across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.
- Operator repair paths: Covers Operator repair paths across setup wizard status, credential prompts, env credential detection, setup docs, and related diagnostics and repair behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (58%)`
- Positive signals: Docs cover common Teams setup failures; source implements
  setup status, probe, Graph scope/role reporting, and send-error hints.
- Negative signals: No live operator repair scenario was found for Teams app
  doctor, stale manifest cache, RSC permission failure, Graph admin consent
  failure, or webhook endpoint repair.
- Integration gaps: Missing repair proof that starts from broken credentials,
  missing Graph consent, invalid service URL, stale manifest, blocked sideload,
  and unreachable webhook states.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: Focused diagnostics/probe query returned `[]`; broad Teams
  search surfaced active Teams SDK, attachment, Graph tenant, and member-info
  work that diagnostics should help operators reason about.
- Discrawl reports: Focused diagnostics query returned no lines; broad Teams
  search showed operator comments about Teams setup complexity.
- Good qualities: Probe reports bot token and Graph token status, docs include
  concrete troubleshooting steps, setup wizard can detect env credentials, and
  send errors have channel-specific hints.
- Bad qualities: The strongest diagnostic path still points operators at
  Microsoft CLI/admin tools, and OpenClaw does not yet own a durable repair
  scenario for admin-consent or app-manifest drift.
- Excluded from quality: Probe test count, setup test count, and absence of
  live repair tests.

## Completeness Score

- Score: `Alpha (58%)`
- Surface instructions: evaluated against `references/completeness/microsoft-teams.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Setup status, Probe and scope reporting, Teams app doctor, Webhook and health diagnostics, Operator repair paths.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add repair scorecards for missing credentials, bad secret, missing Graph
  consent, blocked RSC permission, stale manifest, wrong webhook path, invalid
  `serviceUrl`, and Teams app cache drift.
- Add a wrapper or checklist that records `teams app doctor` output into a
  durable OpenClaw artifact.
- Add diagnostics that distinguish manifest-declared scopes from tenant-granted
  scopes.

## Evidence

### Docs

- `docs/channels/msteams.md` documents `teams app doctor`, webhook timeout
  symptoms, app manifest upload errors, RSC permission troubleshooting, app
  reinstall/cache behavior, no-response channel troubleshooting, and references
  to Microsoft setup docs.
- `docs/gateway/config-channels.md` documents the `channels.msteams` config
  path and links to the full Teams docs.
- `docs/gateway/health.md` includes Microsoft Teams among built-in channel
  monitor override surfaces.

### Source

- `extensions/msteams/src/setup-core.ts` and `setup-surface.ts` implement setup
  status, credential prompts, and setup finalization.
- `extensions/msteams/src/probe.ts` checks bot token acquisition, Graph token
  roles/scopes, and delegated token status.
- `extensions/msteams/src/errors.ts` classifies auth, throttled, transient,
  permanent, network, content-stream, and revoked-proxy errors and formats
  Teams-specific hints.
- `extensions/msteams/src/doctor.ts` collects mutable allowlist warnings.
- `extensions/msteams/src/channel.ts` exposes status/probe integration and
  security warnings.
- `extensions/msteams/src/webhook-timeouts.ts` applies webhook timeout
  hardening.

### Integration tests

- No live Teams setup/diagnostics/repair scenario was found by `rg`.
- `monitor.test.ts` provides local HTTP timeout proof, but not end-to-end
  Microsoft-side setup repair.

### Unit tests

- `extensions/msteams/src/setup-surface.test.ts` covers setup status and prompts.
- `extensions/msteams/src/probe.test.ts` covers missing credentials and token
  acquisition outcomes.
- `extensions/msteams/src/errors.test.ts` covers error classification and hints.
- `extensions/msteams/src/channel.test.ts` covers cloud/service URL schema
  validation.
- `extensions/msteams/src/cloud.test.ts` covers cloud/service URL boundary
  failures.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "msteams doctor probe setup diagnostics credentials" --json --limit 10`

Results:

- The focused diagnostics query returned `[]`.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "msteams doctor probe diagnostics credentials"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Microsoft Teams"`

Results:

- The focused diagnostics query returned no lines.
- The broad Microsoft Teams query returned operator comments about Microsoft
  setup/admin complexity and wanting a Microsoft Teams report.
