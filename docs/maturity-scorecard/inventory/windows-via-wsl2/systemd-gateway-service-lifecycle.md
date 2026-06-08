---
title: "Windows via WSL2 - Gateway Service Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Gateway Service Lifecycle Maturity Note

## Summary

WSL2 Gateway lifecycle inherits the Linux systemd user-service implementation. The documented commands are simple, and the source/test base for systemd units, service metadata, restart behavior, and repair is substantial. Quality stays Beta because WSL2 adds user-bus and environment edge cases that still appear in archive reports.

## Category Scope

Included in this category:

- Onboarded systemd install: openclaw onboard daemon installation inside WSL2.
- Gateway service install: openclaw gateway install behavior under WSL2 systemd.
- systemd user unit rendering: systemd user unit rendering and lifecycle metadata.
- WSL-aware systemd unavailable hints: Operator hints when systemd is unavailable in the WSL distribution.
- Doctor service repair: Doctor repair behavior for WSL2 Gateway services.
- WSL user-service linger: WSL user-service linger behavior, status, and operator-visible verification.
- Systemd availability after Windows boot: Systemd availability after Windows boot and WSL distribution startup.
- Windows startup task for WSL: Windows startup task behavior for launching WSL before login.
- Verification before Windows sign-in: Verification before Windows sign-in behavior, status, and operator-visible verification.
- Clear expectations around PC power: Clear expectations around PC power, sleep, Windows boot, WSL boot, and Gateway uptime

## Features

- Onboarded systemd install: openclaw onboard daemon installation inside WSL2.
- Gateway service install: openclaw gateway install behavior under WSL2 systemd.
- systemd user unit rendering: systemd user unit rendering and lifecycle metadata.
- WSL-aware systemd unavailable hints: Operator hints when systemd is unavailable in the WSL distribution.
- Doctor service repair: Doctor repair behavior for WSL2 Gateway services.
- WSL user-service linger: WSL user-service linger behavior, status, and operator-visible verification.
- Systemd availability after Windows boot: Systemd availability after Windows boot and WSL distribution startup.
- Windows startup task for WSL: Windows startup task behavior for launching WSL before login.
- Verification before Windows sign-in: Verification before Windows sign-in behavior, status, and operator-visible verification.
- Clear expectations around PC power: Clear expectations around PC power, sleep, Windows boot, WSL boot, and Gateway uptime

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: docs give the WSL2 service commands; Gateway runbook documents Linux systemd user units; source renders hardened systemd unit defaults; tests cover systemd unit rendering, availability, user-bus repair, and Docker e2e doctor/install switch behavior.
- Negative signals: WSL2-specific service coverage is mostly inherited from Linux/systemd tests rather than a dedicated Windows/WSL2 lifecycle e2e.
- Integration gaps: no current live WSL2 proof was found for install, status, restart, doctor repair, and update handoff across Windows reboot and WSL restart boundaries.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `Windows WSL2 gateway systemd` returned open PR #58853 for WSL environment diagnostics, issue #55563 for gateway cycling after doctor, PR #68400 for WSL user D-Bus socket detection, issue #80696 for systemd RestartSec/lock timing, issue #84610 for WSL2 SIGTERM loops, and other WSL2/systemd reports.
- Discrawl reports: WSL2 systemd search returned support threads where WSL2 service probes fail with `No medium found`, users are reminded that systemd starts when WSL starts, and users need help distinguishing native Windows installs from WSL2 services.
- Good qualities: the core unit defaults are robust and source-backed, with restart limits, control-group kill mode, environment-file ordering, and WSL-specific hints.
- Bad qualities: WSL2 user-bus behavior and Windows/WSL startup semantics still produce misleading service status and repeated operator confusion.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Onboarded systemd install, Gateway service install, systemd user unit rendering, WSL-aware systemd unavailable hints, Doctor service repair, WSL user-service linger, Systemd availability after Windows boot, Windows startup task for WSL, Verification before Windows sign-in, Clear expectations around PC power.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a dedicated WSL2 service lifecycle smoke that proves install/status/restart/stop/doctor under an actual WSL2 distro.
- Need clearer WSL2 service-status diagnostics for user-bus failures such as `No medium found`.
- Need support guidance that cleanly distinguishes WSL2 systemd user service from native Windows Scheduled Task behavior.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:66`: WSL2 Gateway service install commands are documented.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:68`: WSL2 users run `openclaw onboard --install-daemon`.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:76`: WSL2 users can run `openclaw gateway install`.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:88`: WSL2 repair/migration points to `openclaw doctor`.
- `/Users/kevinlin/code/openclaw/docs/gateway/index.md:231`: Gateway runbook documents Linux systemd user-service commands.
- `/Users/kevinlin/code/openclaw/docs/gateway/doctor.md:529`: doctor audits and repairs supervisor config drift for launchd/systemd/schtasks.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.ts:49`: systemd unit rendering builds the OpenClaw Gateway unit.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.ts:68`: unit includes `After=network-online.target` and `Wants=network-online.target`.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.ts:75`: unit uses `Restart=always`, `RestartSec=5`, and `RestartPreventExitStatus=78`.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.ts:81`: unit keeps service children in the control group for cleanup.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-hints.ts:27`: WSL-specific systemd unavailable hints tell users to enable systemd in `/etc/wsl.conf`.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/lifecycle-core.ts:68`: lifecycle code augments service hints with WSL-aware systemd guidance.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:12`: Docker e2e stubs systemd/loginctl so doctor and daemon flows run.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:122`: e2e verifies service install with one install variant and doctor repair with another.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:145`: e2e asserts the systemd user unit exists.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.test.ts:15`: unit tests assert control-group kill mode, timeouts, restart limit, and exit-78 protection.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-unit.test.ts:42`: unit tests assert EnvironmentFile entries render before inline Environment values.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd.test.ts:158`: systemd availability test returns true when `systemctl --user` succeeds.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd.test.ts:165`: systemd availability test repairs missing user bus environment when runtime bus exists.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/response.test.ts:13`: daemon response tests classify WSL systemd hints.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Windows WSL2 gateway systemd" --mode keyword --limit 10 --json`
- `gitcrawl search openclaw/openclaw --query "WSL2 systemd gateway install loginctl portproxy" --mode keyword --limit 10 --json`

Results:

- `Windows WSL2 gateway systemd` returned 10 hits, including PR #58853, issue #55563, PR #68400, issue #56733, issue #80696, issue #84610, and WSL2 channel/runtime reports.
- The narrower install/loginctl/portproxy query returned 0 hits, which is neutral after the freshness check because broader WSL2/systemd queries did return relevant service issues.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "Windows WSL2 gateway systemd"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 systemd gateway install loginctl portproxy"`

Results:

- Windows WSL2 gateway systemd returned 8 hits, including `No medium found` systemd service probe failures, gateway restart guidance, and support comments distinguishing WSL2 systemd service behavior from native Windows autorun.
- WSL2 systemd/install/loginctl/portproxy returned a support answer that lists WSL2 networking, file I/O, auto-start/services, and Windows-native integration tradeoffs.
