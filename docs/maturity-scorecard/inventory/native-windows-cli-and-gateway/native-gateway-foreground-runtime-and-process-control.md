---
title: "Native Windows - Gateway Management Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Gateway Management Maturity Note

## Summary

Native Windows can run the Gateway in the foreground and query it through the
same `openclaw gateway` command family as other platforms. The docs are clear
that this is enough for CLI-only use, but archive evidence still shows fragile
behavior when users close PowerShell, rely on unmanaged restart behavior, or
hit Windows-specific process/signal differences.

## Category Scope

Included in this category:

- openclaw gateway: openclaw gateway, openclaw gateway run, openclaw gateway status, and foreground process behavior.
- Foreground runtime health/readiness: Foreground runtime health/readiness and local loopback Gateway targets
- Windows-specific restart/signal: Windows-specific restart/signal and process-control behavior
- Unmanaged foreground mode: Operator expectations when running without a managed Scheduled Task.
- openclaw gateway install: openclaw gateway install, status, start, stop, restart, and managed startup behavior.
- Gateway launcher files: Generated gateway.cmd and hidden launcher files for managed startup.
- Scheduled Task runtime status: Scheduled Task runtime status, task-user selection, listener/PID fallback, and task repair.
- Startup-folder fallback: Startup-folder fallback when Task Scheduler is unavailable.
- openclaw status: openclaw status, openclaw gateway status, gateway status --deep, and Windows repair guidance.
- Windows service inspection: Windows service inspection, Task Scheduler runtime parsing, Startup-folder
- Post-install diagnostics: Expected diagnostics, status, and repair behavior after native Windows install.

## Features

- openclaw gateway: openclaw gateway, openclaw gateway run, openclaw gateway status, and foreground process behavior.
- Foreground runtime health/readiness: Foreground runtime health/readiness and local loopback Gateway targets
- Windows-specific restart/signal: Windows-specific restart/signal and process-control behavior
- Unmanaged foreground mode: Operator expectations when running without a managed Scheduled Task.
- openclaw gateway install: openclaw gateway install, status, start, stop, restart, and managed startup behavior.
- Gateway launcher files: Generated gateway.cmd and hidden launcher files for managed startup.
- Scheduled Task runtime status: Scheduled Task runtime status, task-user selection, listener/PID fallback, and task repair.
- Startup-folder fallback: Startup-folder fallback when Task Scheduler is unavailable.
- openclaw status: openclaw status, openclaw gateway status, gateway status --deep, and Windows repair guidance.
- Windows service inspection: Windows service inspection, Task Scheduler runtime parsing, Startup-folder
- Post-install diagnostics: Expected diagnostics, status, and repair behavior after native Windows install.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (68%)`
- Positive signals: docs document native foreground CLI-only use; shared
  Gateway docs cover run/status/health/restart options; source has Gateway
  health/readiness, restart, process, and Windows port/PID helpers.
- Negative signals: the main real-environment proof found for native Windows is
  Parallels smoke infrastructure and archive reports, not a broad current
  foreground Gateway scenario suite.
- Integration gaps: no current live native Windows proof was found for
  foreground start, PowerShell closure behavior, unmanaged restart, status,
  health, and an agent turn in one repeatable scenario.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: `windows gateway` returned open issue/PR signal for
  Windows Server sluggishness, unsupported `SIGUSR1` restart handling, Parallels
  smoke logging, and path/runtime issues.
- Discrawl reports: native Windows reports include PowerShell window closure
  disconnects, retry-loop investigation, and comments that native Gateway
  stability remains fragile under some loads.
- Good qualities: foreground operation uses the same Gateway command contract
  as other platforms, status commands are explicit, and source has
  Windows-aware process helpers rather than assuming POSIX signals.
- Bad qualities: native foreground process ownership is easy for users to
  misinterpret, and Windows-specific signal/process behavior still produces
  active support and PR traffic.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Alpha (68%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw gateway, Foreground runtime health/readiness, Windows-specific restart/signal, Unmanaged foreground mode, openclaw gateway install, Gateway launcher files, Scheduled Task runtime status, Startup-folder fallback, openclaw status, Windows service inspection, Post-install diagnostics.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add one repeatable native Windows foreground Gateway scenario covering start,
  health, status, restart behavior, PowerShell window closure expectations, and
  a simple agent or Control UI request.
- Clarify in docs when foreground `gateway run` is expected to stop with the
  terminal and when a managed startup path is required.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:23` documents native
  Windows status and caveats.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:45` gives the native
  CLI-only path: `openclaw onboard --non-interactive --skip-health` and
  `openclaw gateway run`.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md:25` documents local
  foreground startup and health verification commands.
- `/Users/kevinlin/code/openclaw/docs/cli/gateway.md:25` documents
  `openclaw gateway` and the `gateway run` alias.
- `/Users/kevinlin/code/openclaw/docs/cli/gateway.md:113` documents restart
  modes and `--safe` restart behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/commands/gateway-status.ts:38` implements
  the Gateway status command and target probing.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/restart.ts`
  implements Gateway restart request handling.
- `/Users/kevinlin/code/openclaw/src/infra/gateway-processes.ts` contains
  Gateway process discovery and restart helpers used by service/runtime paths.
- `/Users/kevinlin/code/openclaw/src/infra/windows-port-pids.ts` handles
  Windows port-to-process discovery.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/gateway.multi.e2e.test.ts` exercises
  multi-Gateway runtime behavior.
- `/Users/kevinlin/code/openclaw/test/helpers/gateway-e2e-harness.ts` provides
  the shared Gateway e2e harness.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh:1`
  dispatches the Parallels Windows smoke lane.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/windows-smoke.ts`
  contains the native Windows smoke driver.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/gateway-processes.test.ts` covers
  Gateway process discovery behavior.
- `/Users/kevinlin/code/openclaw/src/infra/gateway-process-argv.test.ts` covers
  Gateway process argv recognition.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/restart.test.ts`
  covers Gateway restart method behavior.
- `/Users/kevinlin/code/openclaw/src/commands/gateway-readiness.test.ts` covers
  Gateway readiness command behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows gateway run PowerShell closes disconnected SIGUSR1" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "windows gateway" --mode keyword --limit 8 --json`

Results:

- The narrow foreground query returned 0 hits.
- `windows gateway` returned open PR #84280 for unsupported `SIGUSR1` restart on
  Windows, issue #72922 for sluggish and unstable Windows Server Gateway/CLI,
  PR #59705 for Parallels Windows smoke logging, and related Windows runtime
  issues.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "Windows gateway run PowerShell closes disconnected SIGUSR1"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows gateway schtasks"`

Results:

- The narrow foreground query returned no direct hits.
- `windows gateway schtasks` returned Windows support discussions about
  PowerShell closure disconnects, duplicate startup paths, `gateway/ws` probe
  failures, Scheduled Task fallback behavior, and native Windows stability work.
