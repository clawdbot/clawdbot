---
title: "Native Windows - Windows Diagnostics, Status, Doctor, and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Windows Diagnostics, Status, Doctor, and Repair Maturity Note

## Summary

Windows diagnostics reuse the broad `status`, `gateway status`, `doctor`, logs,
and service-audit surfaces. The implementation can inspect Task Scheduler
state, generated scripts, service drift, Gateway health, and config/auth issues.
Coverage is meaningful, but quality remains alpha because archive evidence
shows Windows repair can leave stale Startup-folder fallbacks, mislead around
Task Scheduler state, or surface hard-to-action completion/plugin noise.

## Category Scope

- `openclaw status`, `openclaw gateway status`, `gateway status --deep`,
  `openclaw doctor`, `doctor --fix`, and logs/stability support on Windows.
- Windows service inspection, Task Scheduler runtime parsing, Startup-folder
  fallback inspection, Gateway auth health, and service drift repair.
- Diagnostics expected after install, update, or failed Gateway startup.

## Features

- openclaw status: openclaw status, openclaw gateway status, gateway status --deep, and Windows repair guidance.
- Windows service inspection: Windows service inspection, Task Scheduler runtime parsing, Startup-folder
- Post-install diagnostics: Expected diagnostics, status, and repair behavior after native Windows install.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: docs cover doctor/status commands; source has structured
  health checks, service audit, deep service scans, Gateway health, and Windows
  Task Scheduler parsing; tests cover many status/doctor paths.
- Negative signals: Windows-specific repair proof is mostly unit-level and
  support-driven rather than repeated live repair scenarios.
- Integration gaps: no current live Windows repair scenario was found for stale
  Scheduled Task, stale Startup fallback, completion/plugin loading failure,
  Gateway health failure, and successful post-repair Gateway reachability.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: `Windows doctor gateway status schtasks completion` returned
  open signal for stale Startup-folder fallback after doctor update and Windows
  platform tracking.
- Discrawl reports: Windows doctor output discussions include Task Scheduler
  state confusion, fallback launcher duplication, and completion cache/plugin
  command loading issues.
- Good qualities: doctor has a structured lint/repair contract, service repair
  policy, Windows Task Scheduler parsing, and explicit deep-status service scan
  semantics.
- Bad qualities: Windows has multiple service-state sources, and repair can
  still produce confusing or stale launcher state.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw status, Windows service inspection, Post-install diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a Windows doctor scenario that starts from known-bad Scheduled Task and
  Startup fallback states, runs repair, and verifies the resulting Gateway
  service state.
- Add a support-ready diagnostic bundle for native Windows that captures Task
  Scheduler, Startup-folder launchers, generated scripts, logs, and reachable
  Gateway URLs in one redacted artifact.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:18` defines doctor as the
  main health surface.
- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:25` documents inspect,
  repair, and lint postures.
- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:67` documents `--deep`
  service scans.
- `/Users/kevinlin/code/openclaw/docs/cli/doctor.md:196` says non-interactive
  `doctor --fix` reports stale/missing service definitions but does not install
  or rewrite them outside update repair mode.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md:40` documents status,
  health, and logs commands.

### Source

- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-services.ts:1`
  implements Gateway service diagnostics and repair policy.
- `/Users/kevinlin/code/openclaw/src/commands/gateway-status.ts:38` implements
  Gateway status probing.
- `/Users/kevinlin/code/openclaw/src/commands/status.gateway-connection.ts:20`
  formats Gateway connection details.
- `/Users/kevinlin/code/openclaw/src/daemon/inspect.ts` finds extra Gateway
  services across service managers.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:304` parses
  `schtasks` query output.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/doctor-install-switch-docker.sh`
  exercises doctor/install switching in a service-like environment.
- `/Users/kevinlin/code/openclaw/test/cli-json-stdout.e2e.test.ts` covers
  structured CLI output behavior.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh:1`
  dispatches native Windows smoke infrastructure.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-services.test.ts`
  covers Gateway service doctor behavior.
- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-health.test.ts`
  covers Gateway health diagnostics.
- `/Users/kevinlin/code/openclaw/src/commands/status.daemon.test.ts` covers
  daemon status behavior.
- `/Users/kevinlin/code/openclaw/src/daemon/inspect.test.ts` covers deep
  service inspection including Windows service details.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.test.ts:24` covers
  Windows Task Scheduler runtime parsing.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows doctor gateway status schtasks completion" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "windows gateway schtasks scheduled task fallback startup folder" --mode keyword --limit 5 --json`

Results:

- The doctor/status query returned PR #74163 with Windows doctor/stale fallback
  issue references.
- The scheduled-task query returned open PR #51486, issue #87156, and PR #74163
  around Task Scheduler runtime querying and stale Startup-folder fallback.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "Windows doctor gateway status schtasks completion"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows gateway schtasks"`

Results:

- The narrow doctor/status query returned no direct hits.
- `windows gateway schtasks` returned Windows doctor output discussion showing
  Gateway stopped/task result details, completion cache workaround guidance,
  and Task Scheduler fallback analysis.
