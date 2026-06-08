---
title: "Linux Gateway host - Diagnostics and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Diagnostics and Repair Maturity Note

## Summary

Linux Gateway operators have a strong diagnostics toolkit: `openclaw status --deep`, `openclaw logs --follow`, doctor inspect/repair/lint, Gateway diagnostics bundles, stability snapshots, journal fallback, service repair, and health/readiness checks. Quality is beta because current issue evidence shows doctor false positives, missed invalid tool-schema states, clean-state `--fix` output problems, stale lock-file gaps, and surprising token rotation.

## Category Scope

Included in this category:

- Gateway diagnostic reports: Covers Gateway status, diagnostic output, failure handling, and operator repair for diagnostics, logs, doctor, and repair workflows.
- Gateway log tailing: Covers log viewing, log tailing, local fallback behavior, and operator-visible Gateway log status.
- Doctor checks: Covers `openclaw doctor` checks, Gateway health probes, and operator diagnostics for Linux Gateway deployments.
- Operator repair guidance: Covers failure handling, repair guidance, and recovery steps for Linux Gateway diagnostics and doctor findings.

## Features

- Gateway diagnostic reports: Covers Gateway status, diagnostic output, failure handling, and operator repair for diagnostics, logs, doctor, and repair workflows.
- Gateway log tailing: Covers log viewing, log tailing, local fallback behavior, and operator-visible Gateway log status.
- Doctor checks: Covers `openclaw doctor` checks, Gateway health probes, and operator diagnostics for Linux Gateway deployments.
- Operator repair guidance: Covers failure handling, repair guidance, and recovery steps for Linux Gateway diagnostics and doctor findings.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Rationale: the diagnostics surface covers status, logs, doctor, diagnostics export, repair, service state, and readiness checks with Linux-specific systemd behavior.
- Gaps: some Linux repair cases are scattered across doctor notes, update docs, service docs, and archive discussions.

## Quality Score

- Score: `Beta (78%)`
- Rationale: diagnostic tools are extensive, but active archive evidence shows false positives, missed errors, and operator-surprising repair behavior.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway diagnostic reports, Gateway log tailing, Doctor checks, Operator repair guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Make doctor/repair output safer around clean-state fixes, token rotation, stale locks, and SecretRef warnings.
- Consolidate Linux Gateway diagnosis into a single decision tree from status to logs to doctor to diagnostics export.

## Evidence

### Docs

- `docs/cli/status.md:20-40` documents deep probes and status output for Gateway, node, host service runtime, update, and SecretRefs.
- `docs/cli/logs.md:11-12` documents tailing Gateway logs remotely over RPC; `docs/cli/logs.md:60-63` documents Linux active user-systemd journal fallback and reconnect behavior.
- `docs/cli/doctor.md:18-34` describes doctor health, inspect, repair, and lint behavior.
- `docs/cli/doctor.md:188-218` documents Linux systemd-unavailable handling, backup behavior, update repair, service rewrites, env fallback, service repair, and SecretRef warnings.
- `docs/gateway/diagnostics.md:10-16` describes sanitized diagnostics exports; `docs/gateway/diagnostics.md:75-90` lists included files.
- `docs/gateway/index.md:331-359` documents operational checks, readiness, and common failure signatures.

### Source

- `src/cli/daemon-cli/status.gather.ts:101-139` loads Gateway probe, auth, system inspect, audit, TLS, and restart-health information.
- `src/cli/daemon-cli/status.gather.ts:168-252` builds fast/full status configs and output.
- `src/cli/logs-cli.ts` implements Gateway log streaming and fallback behavior.
- `src/commands/doctor.ts` coordinates doctor health and repair checks.
- `src/daemon/service.ts:134-232` collects service repair issues and starts/repairs the Gateway service.

### Integration tests

- `src/cli/logs-cli.test.ts:415-471` covers active systemd journal fallback.
- `src/commands/doctor-gateway-services.test.ts` covers active service skips, systemd update repairs, token persistence, and legacy user systemd services.
- `src/commands/gateway-readiness.test.ts` covers readiness behavior.

### Unit tests

- `src/commands/doctor-format.test.ts:5-29` covers suspicious systemd cgroup hygiene output.
- `src/cli/daemon-cli/status.gather.test.ts` covers status gathering branches.
- `src/gateway/diagnostics.test.ts` covers diagnostics export behavior.

### Gitcrawl queries

- Specific query `doctor logs diagnostics systemd Linux port runtime repair gateway` returned no hits.
- Broader query `doctor logs` returned issue #50561 for auto-applying safe doctor fixes on Gateway start, issue #80435 for `doctor --fix` trailer output on a clean state, PR #59196 for disk-space health checks, issue #65201 for a false Gateway auth token warning with secrets, issue #49036 for stale Gateway lock-file detection, issue #87270 for unsupported active custom tool schema not caught by doctor, issue #87517 for `doctor --fix` silently rotating `gateway.auth.token`, and issue #87312 for Chrome version false reporting.

### Discrawl queries

- Query `openclaw doctor logs` found a 2026-05-27 unsupported tool-schema crash that doctor did not catch.
- The same query found common support guidance to run `openclaw models status`, `openclaw doctor`, and `openclaw logs --follow`.
