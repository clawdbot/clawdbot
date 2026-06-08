---
title: "Native Windows companion app - Status and Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Status and Repair Maturity Note

## Summary

Native Windows CLI/Gateway diagnostics are real: docs, doctor/service code,
Scheduled Task inspection, Startup-folder fallback, and Parallels smoke
validation exist. The Windows companion app does not have its own diagnostic or
repair surface in supported source, and archive evidence shows ongoing Windows
operator pain around Scheduled Tasks, update, slow status, and gateway reachability.

## Category Scope

Included in this category:

- App health states: App health states, Gateway/node readiness, diagnostic panels, log opening, update status, repair actions, and support bundle behavior
- App-specific repair: App-specific repair for pairing, permissions, service lifecycle, stale versions, and protocol mismatch
- Windows system tray app: Windows system tray app, status icon, status menu, native notifications, and app launch/quit controls
- Status indicators: Status indicators for Gateway, node pairing, work activity, and updates
- App-specific notification permission: App-specific notification permission and failure handling

## Features

- App health states: App health states, Gateway/node readiness, diagnostic panels, log opening, update status, repair actions, and support bundle behavior
- App-specific repair: App-specific repair for pairing, permissions, service lifecycle, stale versions, and protocol mismatch
- Windows system tray app: Windows system tray app, status icon, status menu, native notifications, and app launch/quit controls
- Status indicators: Status indicators for Gateway, node pairing, work activity, and updates
- App-specific notification permission: App-specific notification permission and failure handling

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (12%)`
- Positive signals: native Windows CLI/Gateway diagnostic and service repair paths exist and are exercised outside the app surface.
- Negative signals: no Windows app diagnostic UI, log viewer, health panel, repair action, or app-level protocol mismatch workflow exists.
- Integration gaps: no app-specific readiness, health, log, update, or repair scenario can be exercised.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (38%)`
- Gitcrawl reports: `#87156` tracks Windows doctor update leaving Startup-folder Gateway fallback stale and not installing a Scheduled Task; `#74163` tracks multiple Windows platform issues; `#87205` notes untested Scheduled Task migration and automatic restart paths.
- Discrawl reports: `2026-05-13` archive summary says native Windows install/start/update/restart has improved but Scheduled Task lifecycle, Gateway stability, and UX polish remain unfinished; `2026-03-30` review comment flags tight `schtasks` no-output budgets causing incorrect runtime detection.
- Good qualities: adjacent CLI/Gateway diagnostics have clear service concepts and repair hooks.
- Bad qualities: app diagnostics are missing, and the archive record shows Windows operator confusion around exactly the service/update states an app would need to explain.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (12%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App health states, App-specific repair, Windows system tray app, Status indicators, App-specific notification permission.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Windows app diagnostic surface exists.
- No app-specific health or repair guidance exists for Gateway offline, node disconnected, pairing stale, app outdated, or protocol mismatch.
- No app log location, support bundle, or operator runbook exists.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:37-59` documents native Windows CLI/Gateway caveats and managed startup.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md` covers doctor/service diagnostics broadly.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md` documents `gateway status`, `gateway restart`, and Windows native service commands.

### Source

- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-services.ts` and `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-health.ts` implement adjacent Gateway checks.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts` implements Windows Scheduled Task status/install/fallback logic.
- `/Users/kevinlin/code/openclaw/src/infra/windows-task-restart.ts` implements Scheduled Task restart handoff.
- No Windows companion diagnostics source was found.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh` and `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/windows-smoke.ts` cover native Windows CLI/Gateway smoke.
- No Windows companion diagnostics integration tests were found.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-services.test.ts`
- `/Users/kevinlin/code/openclaw/src/commands/doctor-gateway-health.test.ts`
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/windows-task-restart.test.ts`

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows scheduled task startup gateway update" --json`
- `gitcrawl search openclaw/openclaw --query "Windows companion diagnostics health status" --json`

Results:

- `#87156` open issue: Windows doctor update leaves Startup-folder Gateway fallback stale and does not install Scheduled Task.
- `#51486` PR: query Windows task runtime directly.
- `#87205` PR: avoids Gateway daemon repair on protocol mismatch and notes Scheduled Task migration/automatic restart not tested.
- `#74163` tracking PR includes Windows health/status timeout issues.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows scheduled task startup gateway update"`
- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows companion diagnostics health status"`

Results:

- `2026-05-13` archive summary says native Windows install/start/update/restart is supported but still has sharp Scheduled Task, Gateway stability, and UX edges.
- `2026-04-19` user report shows Windows status output with Gateway unreachable timeout while Scheduled Task and Startup-folder fallback are present.
- `2026-04-15` user report shows slow Gateway status on Windows.
- `2026-03-30` review comment on `#57332` flags overly tight `schtasks` no-output budget causing incorrect runtime detection/fallback logic.
