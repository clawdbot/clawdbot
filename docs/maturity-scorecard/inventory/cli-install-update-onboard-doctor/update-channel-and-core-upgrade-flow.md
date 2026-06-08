---
title: CLI - Updates and Upgrades Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - Updates and Upgrades Maturity Note

## Summary

OpenClaw has a large dedicated updater that covers stable, beta, and dev
channels, install-kind switching, managed gateway restart, and post-update
plugin convergence. Coverage is strong because the updater is extensively
implemented and documented. Quality is lower because the update path still owns
some of the highest-risk service and ownership failure modes.

## Category Scope

This category covers `openclaw update`, update status, channel switching,
managed restart after update, and post-core plugin convergence. It does not
cover initial installation or standalone doctor repair outside the update flow.

## Features

- Update channels: openclaw update supports stable, beta, and dev channel selection.
- Install-kind switching: Update flows can switch between package installs and git/source installs when supported.
- Managed gateway restart: Update flows document when the managed gateway is stopped, restarted, or intentionally left alone.
- Update status and RPC: Operators can inspect update status and related gateway control-plane state.
- Plugin convergence: Core updates document how plugin versions and plugin repair warnings are handled afterward.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - `docs/install/updating.md` and `docs/cli/update.md` describe package and git updates, channel switching, restart behavior, and manual recovery steps.
  - The updater implementation is substantial in `src/cli/update-cli/update-command.ts`, `src/cli/update-cli/status.ts`, `src/cli/update-cli/progress.ts`, and `src/cli/update-cli/shared.ts`.
  - Update status and channel display logic is implemented separately from mutation.
  - The repo contains targeted tests for progress, restart helpers, shared command runners, and update command behavior.
- Negative signals:
  - The updater spans package installs, git checkouts, plugin sync, doctor, and service restart in one flow.
  - Restart and ownership outcomes still vary by install kind and platform.
- Integration gaps:
  - No live multi-platform update smoke was found that proves the full package-swap plus restart plus plugin-convergence sequence end to end.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "openclaw update beta dev restart" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned open issues including `#76150 Gateway did not become healthy after restart` and `#86612 Docker gateway container restart loop when OPENCLAW_SANDBOX=1 and OPENCLAW_HOME=/mnt/...`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw update beta dev restart"` surfaced operator guidance where updates failed to land, manual dev-channel recovery advice, and repeated restart-after-update troubleshooting.
- Good qualities:
  - The updater explicitly understands stable, beta, and dev channel semantics.
  - Dry-run and status modes let operators inspect intent without mutating state.
  - Post-core plugin convergence is treated as a first-class part of the update flow.
- Bad qualities:
  - Update failures often cascade into gateway restart and doctor repair work.
  - Service-manager interactions remain one of the riskiest parts of the flow.
  - Ownership drift and environment-sensitive installs still show up in adjacent issue history.
- Excluded from quality:
  - Update command and progress tests count toward coverage only.

## Known Gaps

- No live end-to-end update matrix across install kinds and platforms was found.
- Restart health and post-update convergence still produce active failures.

## Evidence

### Docs

- `docs/install/updating.md`
- `docs/cli/update.md`
- `docs/gateway/troubleshooting.md`

### Source

- `src/cli/update-cli/update-command.ts`
- `src/cli/update-cli/status.ts`
- `src/cli/update-cli/progress.ts`
- `src/cli/update-cli/shared.ts`

### Integration tests

- None found for a full update-and-restart cross-platform flow.

### Unit tests

- `src/cli/update-cli/update-command.test.ts`
- `src/cli/update-cli/progress.test.ts`
- `src/cli/update-cli/restart-helper.test.ts`
- `src/cli/update-cli/shared.command-runner.test.ts`
- `src/cli/update-cli/post-core-plugin-convergence.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "openclaw update beta dev restart" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[{"number":76150,"state":"open","title":"[Bug]: Gateway did not become healthy after restart.","url":"https://github.com/openclaw/openclaw/issues/76150"},{"number":83981,"state":"open","title":"[Bug]: sessions_yield tool available even when removed from tool policy allowlist","url":"https://github.com/openclaw/openclaw/issues/83981"},{"number":86612,"state":"open","title":"Docker gateway container restart loop when OPENCLAW_SANDBOX=1 and OPENCLAW_HOME=/mnt/...","url":"https://github.com/openclaw/openclaw/issues/86612"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "openclaw update beta dev restart"`

Results:

- Archive results include multiple operator recovery threads where `openclaw update --channel dev|beta`, `openclaw doctor`, and `openclaw gateway restart` were the prescribed next steps after failed or incomplete upgrades.
