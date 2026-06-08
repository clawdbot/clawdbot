---
title: "Linux companion app - Status and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Status and Diagnostics Maturity Note

## Summary

Linux Gateway diagnostics are documented through CLI, Control UI, logs, doctor, and systemd guidance. A native Linux companion app would need to consolidate those into app-level readiness, diagnostics, and repair surfaces; open PR #59859 claims such work, but no supported Linux app diagnostics are checked in.

## Category Scope

Included in this category:

- Native Linux app readiness: Native Linux app readiness states
- Gateway health/status display: Gateway health/status display behavior, status, and operator-visible verification.
- Log/transcript opening: Log/transcript opening and locality-aware resource handling
- Doctor/repair affordances: Doctor/repair affordances and systemd lifecycle diagnostics
- Linux tray/status item: Linux tray/status item behavior, status, and operator-visible verification.
- Runtime status row: Runtime status row and native notifications
- Desktop-environment integration: Desktop-environment integration for GNOME/KDE/Wayland/X11 tray behavior

## Features

- Native Linux app readiness: Native Linux app readiness states
- Gateway health/status display: Gateway health/status display behavior, status, and operator-visible verification.
- Log/transcript opening: Log/transcript opening and locality-aware resource handling
- Doctor/repair affordances: Doctor/repair affordances and systemd lifecycle diagnostics
- Linux tray/status item: Linux tray/status item behavior, status, and operator-visible verification.
- Runtime status row: Runtime status row and native notifications
- Desktop-environment integration: Desktop-environment integration for GNOME/KDE/Wayland/X11 tray behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (8%)`
- Positive signals: Linux Gateway CLI diagnostics and systemd docs exist, and open PR #59859 reports app-level readiness/diagnostics verification.
- Negative signals: no checked-in native Linux app diagnostics source or app-level repair tests exist.
- Integration gaps: no native Linux app doctor/status/log/transcript or repair scenario proof exists in the current source tree.

## Quality Score

- Score: `Experimental (38%)`
- Gitcrawl reports: Linux diagnostics query returned a broad tracking PR, while PR #59859 claims readiness/diagnostics and locality-aware resource fallback.
- Discrawl reports: the diagnostics-specific query returned no direct supported-release proof; issue #75 comments mention in-progress Linux diagnostics milestones.
- Good qualities: the underlying CLI/Gateway diagnostics are documented, and the open Linux app PRs name important readiness states and local-vs-remote resource risks.
- Bad qualities: current docs do not provide an app-level Linux diagnostic workflow, readiness taxonomy, repair UX, or official escalation path.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (8%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Linux app readiness, Gateway health/status display, Log/transcript opening, Doctor/repair affordances, Linux tray/status item, Runtime status row, Desktop-environment integration.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Define app-level readiness states from no setup through configured, service installed, connected, degraded, and remote.
- Add native Linux log/transcript locality handling.
- Document repair actions the app may trigger versus actions that stay CLI-only.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:58`: Linux docs direct users to `openclaw doctor` for repair/migration.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:64`: Linux systemd user service behavior is documented.
- `/Users/kevinlin/code/openclaw/docs/start/openclaw.md:224`: operational checklist includes `openclaw status`, `openclaw status --all`, `openclaw status --deep`, and `openclaw health --json`.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:117`: browser Control UI includes cron, skills, nodes, and exec approval panels, which are adjacent operator surfaces.

### Source

- Current source has CLI/Gateway diagnostics and status code, but no `apps/linux` app-level diagnostics source.
- `/Users/kevinlin/code/openclaw/src/commands/status.scan.ts` and related `src/commands/doctor-*` files are CLI/Gateway diagnostics paths, not Linux companion app UI.

### Integration tests

- No native Linux app diagnostics/health/repair integration test was found.
- Linux CLI installer smoke exists, but it does not launch or verify a companion app diagnostics UI.

### Unit tests

- No Linux companion diagnostics unit tests were found.
- Existing status/doctor unit tests cover CLI/Gateway behavior outside this native app surface.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion diagnostics health status doctor" --mode keyword --limit 8 --json`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The diagnostics query returned broad tracking PR #74163, not a landed Linux companion diagnostic result.
- PR #59859 claims Linux runtime/readiness modeling, onboarding, diagnostics, notifications, systemd integration, and manual verification of readiness states; it remains open.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion diagnostics health status doctor"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux Windows Clawdbot Apps issue 75"`

Results:

- The diagnostics-specific query returned no direct results.
- The issue #75 query returned Linux app milestone comments that mention diagnostics and readiness progress, but not a supported checked-in release.
