---
title: "Native Windows - Native Gateway Managed Startup and Scheduled Task Fallback Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Native Gateway Managed Startup and Scheduled Task Fallback Maturity Note

## Summary

Native Windows managed startup is implemented and actively maintained through
Task Scheduler, a generated Gateway command script, and a Startup-folder fallback
when task creation is blocked. Coverage is stronger than the foreground-only
path because the code has many targeted Windows tests, but quality stays below
beta because current archive evidence still shows stale fallback launchers,
task runtime detection, hidden-window polish, and startup reliability as active
operator risks.

## Category Scope

- `openclaw gateway install`, `status`, `start`, `stop`, `restart`, and
  uninstall when the service manager is Windows Task Scheduler.
- Generated `gateway.cmd` or hidden launcher files under the OpenClaw state
  directory and Startup folder.
- Scheduled Task runtime status, task-user selection, listener/PID fallback,
  taskkill, and stale launcher behavior.
- Startup-folder fallback when Task Scheduler is unavailable or denied.

## Features

- openclaw gateway install: openclaw gateway install, status, start, stop, restart, and managed startup behavior.
- Gateway launcher files: Generated gateway.cmd and hidden launcher files for managed startup.
- Scheduled Task runtime status: Scheduled Task runtime status, task-user selection, listener/PID fallback, and task repair.
- Startup-folder fallback: Startup-folder fallback when Task Scheduler is unavailable.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: docs cover native managed startup; source has dedicated
  Task Scheduler XML generation, fallback launchers, runtime parsing, PID
  inspection, and termination paths; tests cover many Windows fallback cases.
- Negative signals: the evidence is heavy on unit/runtime fixtures and lighter
  on repeatable live Windows service install/reboot/repair proof.
- Integration gaps: no current live scenario was found that installs a native
  Scheduled Task, verifies post-login autostart, exercises denied-task fallback,
  repairs stale fallback state, and proves Gateway reachability after reboot.

## Quality Score

- Score: `Alpha (64%)`
- Gitcrawl reports: scheduled-task queries returned open PR #51486 for direct
  Windows task runtime querying, issue #87156 for stale Startup-folder fallback
  after doctor update, and issue #70788 / PR #81330 style signal around visible
  command windows.
- Discrawl reports: Windows support discussions describe duplicate Startup
  launcher contention, task-last-run-result confusion, fallback launcher
  behavior, and ongoing task/window polish.
- Good qualities: the implementation encodes Windows-specific Task Scheduler
  XML, localized access-denied handling, hidden launcher support, listener-based
  runtime fallback, and Windows process-tree termination.
- Bad qualities: there are still multiple launcher modes with drift risk, and
  support evidence shows operators can end up with stale or duplicate startup
  paths.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw gateway install, Gateway launcher files, Scheduled Task runtime status, Startup-folder fallback.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add live Windows managed-startup proof for install, status, reboot/login
  autostart, denied Task Scheduler fallback, `gateway install --force`, and
  cleanup of stale Startup-folder launchers.
- Add a user-facing explanation of how to detect and remove duplicate Windows
  launchers when Task Scheduler and Startup-folder fallback both exist.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:37` lists native
  managed-startup caveats.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:52` documents
  `openclaw gateway install` and `openclaw gateway status --json` for native
  managed startup.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:59` states that the
  fallback mode auto-starts through the current user's Startup folder.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md:135` lists the operator
  command set, including install/restart/stop/status.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:45` defines fallback
  triggers for access denied, timeout, and missing output.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:121` builds Task
  Scheduler XML with ONLOGON behavior and battery settings.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:379` renders the
  generated Gateway command script.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:433` renders a hidden
  VBS launcher for Windows startup.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:673` falls back to
  listener-backed runtime detection when `schtasks` does not report running.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:746` uses `taskkill`
  for Windows process-tree termination.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh:1`
  dispatches the Windows Parallels smoke driver.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/windows-smoke.ts`
  contains native Windows smoke phases for package/install/Gateway behavior.
- `/Users/kevinlin/code/openclaw/.github/workflows/windows-blacksmith-testbox.yml`
  defines Windows-native validation infrastructure.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.test.ts:24` tests runtime
  parsing, localized status, task script paths, and generated command parsing.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.startup-fallback.test.ts:224`
  tests fallback to Startup-folder launchers and hidden launcher behavior.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.install.test.ts` covers
  Windows task install behavior.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.stop.test.ts` covers task
  stop behavior.
- `/Users/kevinlin/code/openclaw/src/daemon/inspect.test.ts` covers deep
  Windows service inspection.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "windows gateway schtasks scheduled task fallback startup folder" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "windows gateway schtasks" --mode keyword --limit 5 --json`

Results:

- The scheduled-task query returned open PR #51486, issue #87156, and PR #74163
  with Windows fallback/stale Scheduled Task signal.
- `windows gateway schtasks` returned PRs #51486, #76245, #63651, #68149 and
  issue #44559 covering runtime query, early-exit fallback, duplicate restart
  message, PowerShell Scheduled Task creation, and PowerShell-window disconnects.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "windows gateway schtasks scheduled task fallback startup folder"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows gateway schtasks"`

Results:

- The scheduled-task query returned Windows reports about duplicate Startup
  launcher contention, `doctor --fix` service repair creating a Startup fallback,
  and Task Scheduler gateway retry loops.
- `windows gateway schtasks` returned maintainer summaries of Scheduled Task
  fallback work, localized access-denied handling, restart health checks, and
  visible-window polish.
