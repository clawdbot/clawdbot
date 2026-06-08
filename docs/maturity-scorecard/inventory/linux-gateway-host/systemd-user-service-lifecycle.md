---
title: "Linux Gateway host - Systemd User Service Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Systemd User Service Lifecycle Maturity Note

## Summary

The systemd user-service path is the best-documented Linux Gateway host path. Docs cover `openclaw gateway install`, `systemctl --user enable --now`, `loginctl enable-linger`, manual units, system-level service alternatives, and repair through doctor. Source code backs unit generation, env-file parsing, install refresh, and service repair. Quality is beta because recent archive evidence shows system-level detection, EnvironmentFile, WSL/user-bus, and provenance edges.

## Category Scope

This category evaluates the Linux Gateway host capability area represented by these taxonomy features:

- Systemd User Service Lifecycle: Evidence scope for Systemd User Service Lifecycle.

## Features

- Systemd User Service Lifecycle setup: Defines Systemd User Service Lifecycle setup setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle operation: Defines Systemd User Service Lifecycle operation setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle status: Defines Systemd User Service Lifecycle status setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle recovery: Defines Systemd User Service Lifecycle recovery setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Rationale: docs and source cover the user-service happy path, linger, manual units, system service alternative, service repair, env-file handling, and restart semantics.
- Gaps: service docs are split between Gateway, Linux platform, VPS, and doctor pages, and WSL/user-bus caveats are more visible in issue evidence than in the main operator path.

## Quality Score

- Score: `Beta (78%)`
- Rationale: the recommended service path is mature, but active archive evidence shows important edge cases around system-level services, EnvironmentFile usage, user-bus availability, and systemd provenance.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Systemd User Service Lifecycle setup, Systemd User Service Lifecycle operation, Systemd User Service Lifecycle status, Systemd User Service Lifecycle recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Make system-level-service detection and user-service status behavior visible in docs and status output.
- Add operator guidance for WSL/user-bus failures and when to choose user service, system service, tmux, or container process supervision.

## Evidence

### Docs

- `docs/gateway/index.md:231-266` documents the Linux systemd user-service tab, `openclaw gateway install`, `systemctl --user enable --now`, `loginctl enable-linger`, and manual unit creation.
- `docs/gateway/index.md:284-298` documents the system-level service path and notes doctor refusal when a system-level service already owns the host.
- `docs/platforms/linux.md:36-70` documents service install commands and systemd user-service default behavior.
- `docs/platforms/linux.md:72-99` provides a manual systemd unit.
- `docs/vps.md:97-132` documents VPS systemd tuning, restart limits, compile cache, `OPENCLAW_NO_RESPAWN`, and memory controls.

### Source

- `src/daemon/systemd-unit.ts:49-94` builds the unit with network-online ordering, restart policy, `RestartPreventExitStatus=78`, `KillMode=control-group`, and EnvironmentFile ordering.
- `src/daemon/systemd.ts:60-79` resolves the user unit path and service name.
- `src/daemon/systemd.ts:85-146` reads ExecStart, WorkingDirectory, Environment, and EnvironmentFile state from systemd units.
- `src/daemon/service.ts:134-165` collects repair issues for version, temporary, and missing-program service drift.
- `src/cli/daemon-cli/install.ts:241-275` builds and installs the service plan.

### Integration tests

- `src/cli/daemon-cli/install.integration.test.ts` covers service install integration paths.
- `src/commands/doctor-gateway-services.test.ts` covers service rewrites, active service skips, token persistence, and legacy systemd handling.
- `src/commands/gateway-readiness.test.ts` covers Gateway readiness expectations for managed service flows.

### Unit tests

- `src/daemon/systemd-unit.test.ts:42-53` covers EnvironmentFile ordering before inline Environment.
- `src/daemon/systemd.test.ts` covers EnvironmentFile parsing, install retry, user-bus failures, and service control.
- `src/cli/daemon-cli/lifecycle.test.ts`, `src/cli/daemon-cli/lifecycle-core.test.ts`, and `src/cli/daemon-cli/install.test.ts` cover daemon lifecycle branches.

### Gitcrawl queries

- Specific query `systemd user service loginctl enable-linger daemon install Linux gateway` returned PR #68400 about distinguishing WSL user D-Bus socket absence from missing `systemctl`.
- Broader query `systemd` returned issue #87577 for status/restart not detecting system-level services, issue #80595 for state-dir `.env` as Linux systemd EnvironmentFile, PR #80140 for watchdog heartbeat, PR #85151 for system-level unit detection, PR #66735 for self-restart handoff, PR #57276 for system-scoped units, PR #68909 for cgroup-aware dedup, and PR #81019 for unit provenance.

### Discrawl queries

- Query `systemd user service loginctl enable-linger daemon install Linux gateway` found support threads using `openclaw onboard --install-daemon`, `openclaw gateway install`, `systemctl --user enable --now openclaw-gateway.service`, and `sudo loginctl enable-linger <user>`.
- The same query found fallback guidance for tmux or system services where `systemctl --user` is unavailable.
