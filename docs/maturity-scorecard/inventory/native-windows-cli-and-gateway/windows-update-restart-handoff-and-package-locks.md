---
title: "Native Windows - Updates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - Updates Maturity Note

## Summary

Windows update behavior has real product investment: update docs warn about
managed Gateway handoff, source has Windows-specific recovery text and detached
handoff code, and release validation includes Windows package/install smoke.
The path still scores below stable because archive evidence shows EBUSY,
staged-update handoff, hidden child-window, stale fallback, and restart-after-
update issues are still active.

## Category Scope

Included in this category:

- openclaw update on native Windows package: openclaw update on native Windows package installs
- Managed Gateway stop/restart: Managed Gateway stop/restart and service metadata refresh during update
- Detached update handoff: Detached update handoff from a running Gateway.
- Windows package locks: Windows package locks, EBUSY/EPERM behavior, staged swaps, child-window

## Features

- openclaw update on native Windows package: openclaw update on native Windows package installs
- Managed Gateway stop/restart: Managed Gateway stop/restart and service metadata refresh during update
- Detached update handoff: Detached update handoff from a running Gateway.
- Windows package locks: Windows package locks, EBUSY/EPERM behavior, staged swaps, child-window

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: update docs cover package-manager updates and managed
  service handoff; source has recovery text for Windows Scheduled Task/login
  item state; CI docs mention Windows packaged and installer lanes; tests cover
  update recovery and packaged Windows behavior.
- Negative signals: live Windows update proof exists as release infrastructure,
  but not as a simple local scenario artifact attached to this audit.
- Integration gaps: no current single-run proof was found for package update
  while a native Scheduled Task Gateway is running, service restart after update,
  stale fallback cleanup, and post-update Gateway version/reachability.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: `Windows update` returned PR #79694 for hidden post-core
  update/completion child windows, PR #75649 for preserving staged Windows
  update handoff, issue #40540 for EBUSY update failures, and issue #87156 for
  stale Startup-folder fallback after doctor update.
- Discrawl reports: maintainer summaries describe Windows update fixes for
  post-core hangs, stale update swaps, stopping the Gateway before update,
  restarting after update, packaged timeout recovery, and npm stability.
- Good qualities: the update path recognizes managed service roots, blocks
  unsafe in-Gateway updates, uses detached handoff for control-plane updates,
  and prints Windows-specific recovery guidance.
- Bad qualities: Windows file locking and service handoff remain active
  product risks, and stale fallback launcher state can survive update/repair.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test
  evidence is recorded only under Coverage and Evidence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw update on native Windows package, Managed Gateway stop/restart, Detached update handoff, Windows package locks.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a native Windows update scenario covering installed package baseline,
  running managed Gateway, `openclaw update`, restart handoff, version check,
  service status, and stale launcher cleanup.
- Add operator docs for recognizing Windows EBUSY/file-lock failures and safely
  recovering with `gateway stop`, package reinstall, and `gateway install --force`.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/updating.md:11` recommends
  `openclaw update` and says it restarts the Gateway.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:71` says managed
  Gateway updates refresh service metadata and restart unless `--no-restart` is
  passed.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:111` warns to stop a
  supervised Gateway before manual package-manager replacement.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:213` describes the
  managed service control-plane handoff.
- `/Users/kevinlin/code/openclaw/docs/ci.md:303` says Windows packaged and
  installer fresh lanes verify installed-package behavior.

### Source

- `/Users/kevinlin/code/openclaw/src/cli/update-cli/update-command.ts:717`
  formats platform-specific post-update recovery guidance.
- `/Users/kevinlin/code/openclaw/src/cli/update-cli/update-command.ts:733`
  tells Windows users to recover missing/stale Scheduled Task or login item
  state with `gateway install --force` and `gateway status --deep`.
- `/Users/kevinlin/code/openclaw/src/cli/update-cli/update-command.ts:823`
  inspects and stops managed services before package update.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update-managed-service-handoff.ts:25`
  contains the detached managed update handoff script.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update-managed-service-handoff.ts:205`
  spawns the managed update command after parent Gateway exit.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh:1`
  dispatches the Windows smoke lane.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-npm-update-smoke.sh`
  dispatches package update smoke infrastructure.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs`
  probes Gateway health after update scenarios.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/upgrade-survivor/config-recipe/gateway.json`
  includes Gateway config recipe coverage for upgrade-survivor lanes.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/update-cli/update-command.test.ts:684`
  covers invalid-config post-core update gating before restart.
- `/Users/kevinlin/code/openclaw/src/cli/update-cli/restart-helper.test.ts`
  covers update restart helper behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update-managed-service-handoff.test.ts`
  covers managed service update handoff behavior.
- `/Users/kevinlin/code/openclaw/src/infra/update-startup.test.ts` covers update
  startup behavior.
- `/Users/kevinlin/code/openclaw/test/scripts/parallels-npm-update-smoke.test.ts`
  covers Parallels npm update smoke helpers.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows update gateway restart npm package locks scheduled task" --mode keyword --limit 5 --json`
- `gitcrawl search openclaw/openclaw --query "Windows update" --mode keyword --limit 8 --json`

Results:

- The narrow update query returned 0 hits.
- `Windows update` returned PR #79694, PR #59705, PR #75649, issue #40540,
  issue #87156, and issue #70788, covering hidden child windows, Parallels
  update logging, staged handoff preservation, EBUSY failures, stale fallback
  state, and startup-window polish.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "Windows update gateway restart npm package locks scheduled task"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 4 "install.ps1 Windows PowerShell installer"`

Results:

- The narrow update query returned Windows summary output noting release
  validation with real Windows install/update smoke, packaged upgrade, Gateway
  startup, and recovery checks.
- The installer query returned native Windows summaries that update got fixes
  for post-core hangs, stale update swaps, Gateway stop before update, restart
  after update, packaged timeout recovery, and npm install/update stability.
