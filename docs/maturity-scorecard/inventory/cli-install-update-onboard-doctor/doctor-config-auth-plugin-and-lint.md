---
title: CLI - Doctor Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - Doctor Maturity Note

## Summary

`openclaw doctor` spans config, auth, plugin, lint, and platform/service repair
logic with a large test footprint. Coverage is strong overall. Quality remains
below stable because plugin/schema validation and cross-platform service-repair
flows still produce operator-facing gaps and active bugs.

## Category Scope

This category covers doctor behavior for config migration, auth checks,
SecretRef handling, plugin validation and repair, machine-readable lint
output, extra-service discovery, supervisor drift repair, runtime-path checks,
and restart guidance.

## Features

- Interactive repair: openclaw doctor supports inspect, repair, non-interactive, and forceful repair postures.
- Config migration: Doctor rewrites legacy or damaged config and state into supported current formats.
- Auth and SecretRef checks: Doctor audits auth shape, token generation, and supported SecretRef-backed config paths.
- Plugin validation and repair: Doctor surfaces plugin-config issues and extension schema drift that block normal runtime operation.
- Lint and JSON findings: openclaw doctor --lint --json provides stable machine-readable findings for automation.
- Extra gateway discovery: Doctor can scan for unexpected gateway services and conflicting installs.
- Supervisor drift repair: Doctor checks managed service definitions and can repair launchd, systemd, or Scheduled Task drift.
- Port and startup diagnosis: Doctor points operators at port conflicts, restart failures, and recent gateway errors.
- Runtime path checks: Doctor checks runtime-path best practices and common path misconfigurations.
- Restart guidance: Doctor explains when a health issue needs a restart or a deeper service repair path.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals:
  - `docs/cli/doctor.md`, `docs/gateway/doctor.md`, `docs/gateway/secrets.md`, and `docs/gateway/troubleshooting.md` document the repair model, lint mode, SecretRef expectations, and service-drift troubleshooting paths.
  - The doctor implementation is decomposed across config, auth, state, plugin, lint, gateway-service, and platform-note modules under `src/commands/doctor*.ts`.
  - Config and auth repair logic has wide test coverage, including legacy migrations and non-interactive behavior.
  - Doctor also has service-repair coverage across port drift, token drift, source-checkout warnings, and external policy paths.
  - E2E-style doctor tests exist for missing state directories, legacy state migrations, and sandbox warning scenarios.
- Negative signals:
  - The command has a very broad mandate, which increases the chance of unhandled edge cases.
  - Some plugin-related runtime breakages still require manual log inspection.
  - Cross-user and cross-platform service repair still depend heavily on test coverage rather than broad live proof.
- Integration gaps:
  - No end-to-end proof was found that validates every active plugin/tool schema against the exact runtime projection path before user turns.
  - No live systemd or Windows repair integration suite matching the macOS/launchd depth was found.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "doctor config plugin SecretRef lint" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned `[]`.
  - Query `gitcrawl search issues "doctor gateway service repair port" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned open issues including `#76707 doctor --fix can repair the wrong Unix home when live gateway runs under another user`, `#87156 Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task`, and `#85027 2026.5.6 → 2026.5.19 upgrade left macOS LaunchAgent Gateway unrecoverable`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw doctor config plugin"` surfaced a user report where an unsupported dynamic tool schema poisoned assistant startup while `openclaw doctor` did not flag the root problem.
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "doctor gateway service repair"` returned beta-test guidance emphasizing update/doctor toughness and restart-status validation, which indicates this remains an active operator-risk surface.
- Good qualities:
  - Doctor has explicit read-only, repair, and machine-readable lint modes.
  - Legacy config and auth migrations are covered directly in tests.
  - SecretRef-managed auth and token handling are treated as first-class.
  - Service drift logic has dedicated tests for several real failure classes.
  - The docs point operators at concrete restart and reinstall commands.
- Bad qualities:
  - Plugin runtime/schema breakages can still escape the doctor’s initial pass.
  - Some plugin validation failures still produce operator guidance that is less direct than it should be.
  - Active bugs span the exact cross-user and Windows fallback paths that doctor service repair owns.
  - Upgrade repair can still leave gateways unrecoverable on some platforms.
- Excluded from quality:
  - Doctor test coverage below is counted only toward coverage.

## Known Gaps

- Runtime tool-schema validation is not as comprehensive as the live assistant path needs.
- Plugin manifest and schema validation still miss some runtime breakages before first use.
- Cross-user repair behavior on Unix is still bug-prone.
- Windows Scheduled Task fallback repair remains active bug territory.
- Live platform repair proof is thin outside the existing test harnesses.

## Evidence

### Docs

- `docs/cli/doctor.md`
- `docs/gateway/doctor.md`
- `docs/gateway/secrets.md`
- `docs/gateway/troubleshooting.md`

### Source

- `src/commands/doctor.ts`
- `src/commands/doctor-config-flow.ts`
- `src/commands/doctor-auth.ts`
- `src/commands/doctor-lint.ts`
- `src/commands/doctor-gateway-services.ts`
- `src/commands/doctor-service-repair-policy.ts`
- `src/commands/doctor-platform-notes.ts`
- `src/daemon/service-audit.ts`
- `src/config/validation.ts`

### Integration tests

- `src/commands/doctor.warns-state-directory-is-missing.e2e.test.ts`
- `src/commands/doctor.runs-legacy-state-migrations-yes-mode-without.e2e.test.ts`
- `src/commands/doctor.warns-per-agent-sandbox-docker-browser-prune.e2e.test.ts`

### Unit tests

- `src/commands/doctor-config-flow.test.ts`
- `src/commands/doctor-auth.deprecated-cli-profiles.test.ts`
- `src/commands/doctor-auth-flat-profiles.test.ts`
- `src/commands/doctor-lint.test.ts`
- `src/commands/doctor-plugin-manifests.test.ts`
- `src/commands/doctor-gateway-services.test.ts`
- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts`
- `src/commands/doctor-platform-notes.startup-optimization.test.ts`
- `src/daemon/service-audit.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "doctor config plugin SecretRef lint" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`
- `gitcrawl search issues "doctor gateway service repair port" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[]`
- `[{"number":76707,"state":"open","title":"[UX]: doctor --fix can repair the wrong Unix home when live gateway runs under another user","url":"https://github.com/openclaw/openclaw/issues/76707"},{"number":87156,"state":"open","title":"[Bug]: Windows doctor update leaves Startup-folder gateway fallback stale and does not install Scheduled Task","url":"https://github.com/openclaw/openclaw/issues/87156"},{"number":75502,"state":"open","title":"Downgrading from 2026.4.29 to 2026.4.27 fails due to stale file-transfer entry in ~/.openclaw/plugins/installs.json","url":"https://github.com/openclaw/openclaw/issues/75502"},{"number":85027,"state":"open","title":"[Bug] 2026.5.6 → 2026.5.19 upgrade left macOS LaunchAgent Gateway unrecoverable; Time Machine restore required","url":"https://github.com/openclaw/openclaw/issues/85027"},{"number":52184,"state":"open","title":"[Feature]: Prefer Volta shim path over version-pinned Volta node path for macOS gateway LaunchAgent","url":"https://github.com/openclaw/openclaw/issues/52184"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw doctor config plugin"`
- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "doctor gateway service repair"`

Results:

- Archive discussion included a real report where a broken extension schema caused assistant startup failure without doctor catching the problem first.
- Release-testing guidance from the archive still treats doctor-plus-restart validation as a critical beta check, which matches the open-issue pressure on this category.
