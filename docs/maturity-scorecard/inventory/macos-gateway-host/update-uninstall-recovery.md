---
title: "macOS Gateway host - Update, Uninstall, and Recovery Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Update, Uninstall, and Recovery Maturity Note

## Summary

Update, uninstall, and recovery are documented and implemented with specific
macOS LaunchAgent handling. The CLI update docs call out package-manager handoff
and LaunchAgent rebootstrap, uninstall docs separate service/data/CLI cleanup,
and troubleshooting docs cover stranded services, stale updater jobs, and
manual launchd repair.

Coverage is Stable because docs/source/unit evidence cover update, uninstall,
doctor repair, stale jobs, and service refresh. Quality is Beta because
agent-invoked self-update and stale launchd updater jobs still appear in live
operator reports.

## Category Scope

- `openclaw update` package/git handoff on macOS.
- Managed service refresh and LaunchAgent rebootstrap after updates.
- Stale updater launchd job detection and cleanup.
- `openclaw uninstall`, service uninstall, state cleanup, and manual launchd removal.
- Recovery after partially updated or stranded macOS Gateway services.

## Features

- openclaw update package/git handoff: openclaw update package/git handoff on macOS
- Managed service refresh: Managed service refresh and LaunchAgent rebootstrap after updates
- Stale updater launchd job detection: Stale updater launchd job detection and cleanup
- openclaw uninstall: openclaw uninstall, service uninstall, state cleanup, and manual launchd removal
- Stranded service recovery: Recovery after partially updated or stranded macOS Gateway services.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: update/uninstall docs, launchd lifecycle source, stale updater source, doctor tests, and Parallels update smoke all cover important recovery paths.
- Negative signals: true agent-invoked self-update while the Gateway supervises the session is difficult to prove and has active archive failures.
- Integration gaps: no inspected live lane repeatedly updates from inside an active macOS agent session and verifies the LaunchAgent remains supervised without outside SSH repair.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `self-update macOS LaunchAgent not loaded gateway` returned open #85133 for LaunchAgent unloaded during self-update and open #75250 for mixed Homebrew Node/runtime/plugin cache drift. The closed update handoff query returned no extra hits.
- Discrawl reports: `gateway update LaunchAgent not loaded` returned a 2026-05-14 report of self-update failure across three macOS LaunchAgent instances, plus GitHub mirror comments closing older update/LaunchAgent issues as implemented.
- Good qualities: docs explicitly warn about service handoff, source detects stale updater jobs, lifecycle code can repair installed-but-unloaded launchd services, and uninstall docs give manual launchd cleanup steps.
- Bad qualities: update is self-referential on a Gateway host: the process can update the runtime that is supervising the session, and stale launchd update wrappers can keep killing the Gateway until manually removed.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for openclaw update package/git handoff, Managed service refresh, Stale updater launchd job detection, openclaw uninstall, Stranded service recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live self-update resilience lane that starts from an active macOS LaunchAgent session and proves service supervision after update.
- Surface stale updater launchd jobs more prominently in macOS recovery docs.
- Make uninstall/reinstall recovery from local-prefix app installs explicit next to global npm/source install recovery.

## Evidence

### Docs

- `docs/cli/update.md:34`: documents update flags and diagnostics.
- `docs/cli/update.md:101`: documents package-manager handoff and macOS LaunchAgent rebootstrap after update.
- `docs/install/updating.md:11`: documents the update command.
- `docs/install/updating.md:48`: documents switching npm/git install roots and service metadata/restart.
- `docs/install/updating.md:213`: documents managed service handoff and macOS LaunchAgent recovery.
- `docs/install/uninstall.md:14`: documents `openclaw uninstall` and noninteractive flags.
- `docs/install/uninstall.md:31`: documents service stop/uninstall and state handling.
- `docs/install/uninstall.md:80`: documents manual macOS launchd removal.
- `docs/gateway/troubleshooting.md:30`: documents after-update repair commands.
- `docs/gateway/troubleshooting.md:420`: documents service installed-but-not-running, port conflicts, deep status, and service port mismatch.

### Source

- `src/daemon/launchd.ts:291`: parses and finds stale updater jobs.
- `src/daemon/launchd.ts:330`: removes/disables stale updater jobs.
- `src/daemon/launchd.ts:596`: repairs installed-but-unloaded LaunchAgents.
- `src/cli/daemon-cli/lifecycle.ts:221`: starts/uninstalls with macOS recovery behavior.
- `src/cli/daemon-cli/lifecycle.ts:275`: restarts with recovery, stale PID cleanup, and health checks.
- `src/cli/daemon-cli/install.ts:155`: detects loaded existing services and refreshes when needed.
- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts:124`: tests stale updater job warning/cleanup behavior.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:873`: runs a dev update through git/package flow on a macOS guest.
- `scripts/e2e/parallels/macos-smoke.ts:923`: verifies deep Gateway status after install/update.
- `src/daemon/launchd.integration.e2e.test.ts:246`: proves repair of an installed but missing bootstrap state.

### Unit tests

- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts:124`: covers stale updater warning and cleanup.
- `src/daemon/launchd.test.ts:1208`: covers restart fallback paths and re-bootstrap after kickstart unload.
- `src/cli/daemon-cli/lifecycle.test.ts:276`: covers re-bootstrap of an installed LaunchAgent when not loaded.
- `src/cli/daemon-cli/lifecycle.test.ts:555`: covers restart re-bootstrap when no unmanaged listener exists.
- `src/daemon/diagnostics.test.ts:23`: covers launchd stderr suppression and stale stderr handling.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS LaunchAgent update handoff not loaded stale updater launchd job" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

Query:

```bash
gitcrawl search issues "self-update macOS LaunchAgent not loaded gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #85133: `Gateway launchd agent gets unloaded during self-update and never re-bootstrapped (macOS)`.
- Open #75250: `Bug: OpenClaw breaks after Homebrew updates due to mixed Homebrew Node/runtime/plugin cache drift`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "gateway update LaunchAgent not loaded"
```

Results:

- Returned a 2026-05-14 maintainer report of self-update failure across three macOS LaunchAgent instances, including unloaded services that required outside SSH repair.
- Returned GitHub mirror comments closing older update/LaunchAgent stale entrypoint and not-loaded restart issues as implemented on current main.
