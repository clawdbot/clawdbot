---
title: CLI - Gateway Service Management Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# CLI - Gateway Service Management Maturity Note

## Summary

The CLI exposes a broad managed-gateway surface for run, install, status,
start, stop, restart, safe restart, and service repair hints across launchd,
systemd, and Windows Scheduled Tasks. Coverage is strong because the command and
platform adapters are broad and there is real launchd integration proof; quality
is materially lower because service lifecycle remains a recurring operator pain
point, especially on Linux systemd and cross-version restarts.

## Category Scope

This category covers foreground gateway runs and supervised gateway install and
lifecycle control. It does not cover high-level onboarding choices or the doctor
workflow that repairs service drift after the fact.

## Features

- Foreground gateway runs: Operators can run the gateway directly from the CLI for local development or ad hoc recovery.
- Service install and control: The CLI documents install, status, start, stop, restart, and run flows for managed gateway services.
- Service auth wiring: Gateway service installation documents how auth tokens and other sensitive values are handled.
- Drift and reinstall recovery: Operators are given explicit guidance for repairing or reinstalling a broken managed gateway service.
- Service health checks: Gateway service flows point operators at runtime health and troubleshooting checks after install or restart.

## Archive Freshness

- gitcrawl: `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `repository_count=2`, `api_supported=false`, `github_token_present=false`.
- discrawl: `generated_at=2026-05-30T01:10:41Z`, `state=current`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `share.needs_update=true`.

## Coverage Score

- Score: `Stable (88%)`
- Positive signals:
  - `docs/cli/gateway.md`, `docs/gateway/troubleshooting.md`, and `docs/install/updating.md` document run, install, restart, stop, status, and supervised recovery flows.
  - Lifecycle command implementation spans `src/cli/gateway-cli/run.ts`, `src/cli/gateway-cli/run-loop.ts`, `src/cli/daemon-cli/shared.ts`, and platform adapters under `src/daemon/`.
  - Platform-specific service implementations exist for launchd, systemd, and schtasks in `src/daemon/launchd.ts`, `src/daemon/systemd.ts`, and `src/daemon/schtasks.ts`.
  - Real integration evidence exists in `src/daemon/launchd.integration.e2e.test.ts`.
- Negative signals:
  - Cross-platform proof is uneven, with macOS launchd better covered than live systemd or Windows flows.
  - Service lifecycle remains sensitive to restart handoff, stale units, and wrapper/process behavior.
- Integration gaps:
  - No equivalent live systemd or Windows scheduled-task integration suite matching the launchd depth was found.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports:
  - Query `gitcrawl search issues "gateway install restart status start stop" -R openclaw/openclaw --state open --json number,title,url,state --limit 5` returned open issues including `#81410 Gateway lifecycle commands target stale SUDO_USER scope from root shell instead of root systemd user service`, `#83360 auto-update can never succeed under systemd`, `#83354 helper commands can silently resurrect stopped user-level units`, `#79375 stale user-level systemd unit dueling services`, and `#79534 Gateway wrapper child survives SIGTERM and blocks systemd restarts`.
- Discrawl reports:
  - Query `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "gateway install restart status stop"` returned the 2026.5.16 beta test focus calling out managed restart and stale wrapper warnings, plus operator discussion around restart/update behavior.
- Good qualities:
  - Lifecycle responsibilities are centralized in dedicated CLI and daemon modules.
  - The docs are explicit about safe restart versus forceful restart behavior.
  - There is real launchd integration coverage instead of only mocks.
- Bad qualities:
  - Open issues show that systemd lifecycle and restart semantics still regress.
  - Restart/update interactions remain especially fragile under managed services.
  - Cross-platform behavior is difficult to make uniform.
- Excluded from quality:
  - `src/daemon/launchd.integration.e2e.test.ts` and unit suites below count toward coverage, not quality.

## Known Gaps

- Live systemd and Windows lifecycle proof trails macOS launchd.
- Restart handoff and stale-unit recovery are still active operator risk areas.

## Evidence

### Docs

- `docs/cli/gateway.md`
- `docs/gateway/troubleshooting.md`
- `docs/install/updating.md`

### Source

- `src/cli/gateway-cli/run.ts`
- `src/cli/gateway-cli/run-loop.ts`
- `src/cli/daemon-cli/shared.ts`
- `src/daemon/launchd.ts`
- `src/daemon/systemd.ts`
- `src/daemon/schtasks.ts`

### Integration tests

- `src/daemon/launchd.integration.e2e.test.ts`

### Unit tests

- `src/cli/daemon-cli/status.gather.test.ts`
- `src/cli/daemon-cli/status.print.test.ts`
- `src/daemon/service-audit.test.ts`
- `src/daemon/schtasks.install.test.ts`
- `src/daemon/schtasks.stop.test.ts`

### Surface validation commands

- `none declared in taxonomy`: `pass` - CLI surface does not declare extra validation commands for scoring.

### Gitcrawl queries

Query:

- `gitcrawl search issues "gateway install restart status start stop" -R openclaw/openclaw --state open --json number,title,url,state --limit 5`

Results:

- `[{"number":81410,"state":"open","title":"Gateway lifecycle commands target stale SUDO_USER scope from root shell instead of root systemd user service","url":"https://github.com/openclaw/openclaw/issues/81410"},{"number":83360,"state":"open","title":"[Bug]: auto-update can never succeed under systemd — updater is spawned as a child of the gateway it needs to restart","url":"https://github.com/openclaw/openclaw/issues/83360"},{"number":83354,"state":"open","title":"Helper commands can silently resurrect stopped user-level openclaw-gateway units","url":"https://github.com/openclaw/openclaw/issues/83354"},{"number":79375,"state":"open","title":"Upgrade leaves stale user-level systemd unit, dueling services kill each other on Linux","url":"https://github.com/openclaw/openclaw/issues/79375"},{"number":79534,"state":"open","title":"Gateway wrapper's spawned child process can survive parent SIGTERM, blocking systemd restarts on EADDRINUSE","url":"https://github.com/openclaw/openclaw/issues/79534"}]`

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 5 "gateway install restart status stop"`

Results:

- Release-testing guidance explicitly calls out managed restart, `openclaw update status`, dashboard reopening, and stale wrapper warnings as areas to verify, which matches the open-issue pressure on this surface.
