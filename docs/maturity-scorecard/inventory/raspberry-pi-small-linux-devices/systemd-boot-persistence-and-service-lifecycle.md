---
title: "Raspberry Pi / small Linux devices - systemd Service and Boot Persistence Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - systemd Service and Boot Persistence Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Systemd Boot Persistence and Service Lifecycle` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Raspberry Pi / small Linux devices capability area represented by these taxonomy features:

- Systemd Boot Persistence and Service Lifecycle: Evidence scope for Systemd Boot Persistence and Service Lifecycle.

## Features

- User service install: Defines User service install setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- linger/boot persistence: Defines linger/boot persistence setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Service drop-ins: Defines Service drop-ins setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Restart tuning: Defines Restart tuning setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Status/log inspection: Defines Status/log inspection setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Backup/restore: Defines Backup/restore setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Linux systemd user service docs, Raspberry Pi service verification, linger handling, service status commands, startup tuning, and source-level systemd safeguards are strong.
- Negative signals: Pi-specific service lifecycle problems still appear in archive reports, especially around duplicated system units, stale state, and long-lived auth/session state.
- Integration gaps: Startup and systemd behavior have broad source/test coverage, but no inspected Pi hardware service-lifecycle gate was found.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: PR #83489 addresses a Gateway service startup race and names Raspberry Pi/Linux systemd in the scenario; other reports mention Linux arm64 systemd state loss.
- Discrawl reports: Pi 5 Debian arm64 systemd repeats, stale tokens, and reconnect issues appear in support history.
- Good qualities: The service lifecycle is one of the most mature parts of the Linux story, with docs and source converging on user services, linger, status, and restart behavior.
- Bad qualities: The failure modes are subtle for headless Pi users and can involve both service state and auth state.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for User service install, linger/boot persistence, Service drop-ins, Restart tuning, Status/log inspection, Backup/restore.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Pi-specific systemd fixture or hardware smoke was found.
- Stale service state and duplicate unit problems are handled reactively rather than represented in a Pi operator checklist.
- Boot persistence is documented, but not tied to an end-to-end release signal for small Linux devices.

## Evidence

### Docs

- `docs/platforms/linux.md:64-70` points Linux users to systemd user units by default.
- `docs/platforms/linux.md:72-99` gives a minimal systemd user unit.
- `docs/install/raspberry-pi.md:92-104` uses onboarding with `--install-daemon`.
- `docs/install/raspberry-pi.md:107-128` verifies daemon and Gateway status and shows the SSH-tunneled Control UI.
- `docs/install/raspberry-pi.md:150-172` documents memory-reducing systemd drop-ins, restart behavior, timeouts, and `loginctl enable-linger`.
- `docs/vps.md:97-127` provides a systemd tuning checklist that also applies to small ARM hosts.

### Source

- `src/commands/systemd-linger.ts:14-25` restricts linger handling to Linux and checks systemd availability.
- `src/commands/systemd-linger.ts:48-83` emits user-facing linger reasons/actions and can enable linger.
- `src/commands/status.daemon.ts:18-39` summarizes daemon status.
- `src/cli/gateway-cli/run.ts:350-358` handles systemd lock exit codes.
- `src/cli/gateway-cli/run.ts:398-460` handles supervised lock recovery and systemd restart-loop avoidance.

### Integration tests

- `package.json:1777` defines the Gateway restart benchmark.
- Installer e2e and smoke scripts verify daemon/install paths generally, but not on Pi systemd hardware.

### Unit tests

- Gateway restart and daemon-status logic is tested in the CLI/Gateway suites.
- No Raspberry Pi systemd unit test fixture was found.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi systemd linger gateway"`

Results:

- Returned PR #83489, "Fix gateway service startup race", with snippets mentioning Raspberry Pi, Linux/systemd, Gateway port `18789`, and old duplicate system units.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi low memory OpenClaw"`

Results:

- Returned a Linux arm64 Raspberry Pi systemd Gateway report where cron history lost backing session state.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi systemd OpenClaw"`

Results:

- Found Pi/Linux systemd service support threads, including Telegram agents with Codex auth failures and a Pi 5 Debian arm64 systemd loop with reconnect/certificate symptoms.
