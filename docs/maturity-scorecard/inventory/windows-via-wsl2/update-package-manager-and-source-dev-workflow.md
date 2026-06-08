---
title: "Windows via WSL2 - Update, Package-manager, and Source-dev Workflow Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Update, Package-manager, and Source-dev Workflow Maturity Note

## Summary

The update and development workflow is adequate for WSL2 because it reuses the Linux/systemd path, and docs explicitly show source setup inside WSL. `openclaw update` has substantial service-aware behavior, including package-root detection, install-mode switching, service metadata refresh, and systemd update handoff. The weakness is WSL2-specific acceptance: current evidence shows support friction around pnpm/npm installs, source assets, stale service entrypoints, and Gateways that are running but unreachable after updates.

## Category Scope

- Source install/build flow inside WSL2.
- `openclaw update`, channel switching, dry-run/status diagnostics.
- npm/pnpm/git package-root and install-mode switching.
- Managed systemd Gateway restart and update handoff.
- Service metadata refresh after updates.
- Package manager caveats as seen from WSL2 users.

## Features

- Source install and build inside WSL2: Source install and build workflow inside the WSL2 distribution.
- openclaw update: openclaw update, channel switching, dry-run/status diagnostics
- npm/pnpm/git package-root: npm/pnpm/git package-root and install-mode switching
- Managed systemd Gateway restart: Managed systemd Gateway restart and update handoff
- Service metadata refresh: Service metadata refresh after WSL2 Gateway updates.
- Package-manager caveats: Package-manager caveats seen from WSL2 source and package installs.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Windows docs include WSL2 source build/onboard commands; update docs cover `openclaw update`, channels, package-root handling, service metadata refresh, and service verification; tests cover systemd update handoff and service-aware update behavior.
- Negative signals: most proof is Linux/systemd general rather than WSL2-specific, and source-flow docs still rely on users running the right shell and package manager inside WSL.
- Integration gaps: no current WSL2 update scorecard was found that starts from an installed service, applies update, refreshes systemd metadata, restarts, verifies dashboard/control UI, and runs doctor.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `WSL2 update npm pnpm openclaw gateway` returned 0 hits. `WSL2 install Node openclaw onboard` returned issue #63740 for WSL2 source/runtime syntax failure and issue #86612 for Docker/WSL2 path interactions. Broader WSL2/systemd queries returned stale unit and restart-loop issues.
- Discrawl reports: WSL2 update query returned status excerpts from WSL2 installs with pnpm/npm update state, gateway unreachable after update, service restart logs, and guidance to use `openclaw update` rather than raw npm/pnpm.
- Good qualities: update docs and source handle managed service roots carefully, and systemd handoff logic is explicit rather than assuming foreground CLI updates.
- Bad qualities: WSL2 users still encounter package-manager and service-entrypoint drift, especially across source/package installs and WSL filesystem boundaries.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Source install and build inside WSL2, openclaw update, npm/pnpm/git package-root, Managed systemd Gateway restart, Service metadata refresh, Package-manager caveats.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need WSL2-specific update smoke coverage with npm, pnpm, and source installs.
- Need docs that call out WSL filesystem location and package-manager expectations in the Windows page.
- Need clearer status/doctor guidance when WSL2 update state is healthy but Gateway loopback is unreachable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:221`: WSL2 install section follows Linux getting-started inside WSL.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:226`: source flow clones repo, runs `pnpm install`, `pnpm build`, `pnpm ui:build`, and `pnpm openclaw onboard --install-daemon`.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:234`: source dev loop points to `pnpm openclaw setup` and `pnpm gateway:watch`.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:11`: `openclaw update` detects install type, fetches latest, runs doctor, and restarts the Gateway.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:48`: update docs describe switching between npm and git installs.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:69`: dev channel ensures a git checkout, builds it, and installs the global CLI.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:71`: updates refresh service metadata and restart the Gateway unless `--no-restart` is passed.
- `/Users/kevinlin/code/openclaw/docs/install/updating.md:111`: manual package-manager updates on supervised installs should stop the Gateway before replacing package files.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update-managed-service-handoff.ts`: managed service update handoff handles systemd supervisor mode.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update.ts`: Gateway update method coordinates managed service update behavior.
- `/Users/kevinlin/code/openclaw/src/infra/update-package-manager.ts`: package-manager detection and update behavior are centralized.
- `/Users/kevinlin/code/openclaw/src/infra/update-startup.ts`: update startup handling tracks restart/update state.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:160`: e2e verifies npm-to-git service entrypoint switching through doctor.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:167`: e2e verifies git-to-npm service entrypoint switching through doctor.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-npm-update-smoke.sh`: npm update smoke exists, though not WSL2-specific.
- `/Users/kevinlin/code/openclaw/scripts/e2e/update-channel-switch-docker.sh`: update-channel switch e2e exists, though Docker/Linux rather than WSL2.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/update-cli.test.ts:2740`: update tests stop a systemd service during package update without leaking raw stop output into JSON.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/update-managed-service-handoff.test.ts:190`: update handoff tests launch systemd handoffs through transient user scope.
- `/Users/kevinlin/code/openclaw/src/infra/update-package-manager.test.ts`: package-manager update behavior has unit coverage.
- `/Users/kevinlin/code/openclaw/src/infra/update-runner.test.ts`: update runner behavior has unit coverage.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 update npm pnpm openclaw gateway" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "WSL2 install Node openclaw onboard" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 gateway systemd" --mode keyword --limit 10 --json`

Results:

- WSL2 update/npm/pnpm query returned 0 hits.
- WSL2 install/onboard returned issue #63740, PR #74163, and issue #86612.
- Windows WSL2 gateway systemd returned stale unit, restart loop, and systemd service issues that overlap update/service metadata drift.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 update npm pnpm openclaw gateway"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 install Node openclaw onboard"`

Results:

- WSL2 update/npm/pnpm query returned 8 hits, including WSL2 status outputs with pnpm/npm update state, gateway service running but Gateway unreachable, update restart logs, and advice to prefer `openclaw update`.
- WSL2 install/onboard query returned 8 hits, including WSL2 install guidance, native Windows caveats, source install reports, and setup prerequisites.
