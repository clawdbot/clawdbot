---
title: "Windows via WSL2 - Windows Boot Chain and Login Persistence Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Windows Boot Chain and Login Persistence Maturity Note

## Summary

The Windows boot-chain story is documented but thinly implemented by OpenClaw itself. The runbook correctly explains that a WSL2 systemd user service persists after WSL starts, while Windows boot-before-login requires `loginctl enable-linger` plus a Windows scheduled task that starts the distro. That makes this component Alpha for Coverage and Quality: the path is viable, but it is more of an operator recipe than a product-managed lifecycle.

## Category Scope

- WSL user-service linger.
- WSL systemd availability after distro startup.
- Windows startup scheduled task that launches WSL.
- Verification before Windows sign-in.
- Clear expectations around PC power, sleep, Windows boot, WSL boot, and Gateway uptime.
- Excludes native Windows Gateway Scheduled Task behavior.

## Features

- WSL user-service linger: WSL user-service linger behavior, status, and operator-visible verification.
- Systemd availability after Windows boot: Systemd availability after Windows boot and WSL distribution startup.
- Windows startup task for WSL: Windows startup task behavior for launching WSL before login.
- Verification before Windows sign-in: Verification before Windows sign-in behavior, status, and operator-visible verification.
- Clear expectations around PC power: Clear expectations around PC power, sleep, Windows boot, WSL boot, and Gateway uptime

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: Windows platform docs describe each step in the boot chain and include concrete commands for linger, Gateway install, Windows `schtasks`, distro-name lookup, and post-reboot verification.
- Negative signals: the Windows boot scheduled task is a manual PowerShell recipe; OpenClaw does not install or verify that Windows-side task for the WSL2 path.
- Integration gaps: no WSL2 boot-before-login e2e or live proof was found; current tests cover Linux systemd behavior and Windows WSL availability probes, not full Windows boot persistence.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `WSL2 Windows boot loginctl linger schtasks` returned 0 hits. Broader `Windows WSL2 gateway systemd` returned active service-lifecycle issues but not a clean boot-chain implementation issue.
- Discrawl reports: WSL2 boot/support searches include support guidance that WSL2 systemd Gateway starts when Ubuntu/WSL starts, but Windows boot alone may not start WSL without additional setup.
- Good qualities: docs explicitly call out the headless boot chain instead of implying that a Linux user service automatically solves Windows boot.
- Bad qualities: the chain crosses product, WSL, Windows Task Scheduler, and Windows power settings, so operational success depends heavily on users following and maintaining a manual Windows-side task.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WSL user-service linger, Systemd availability after Windows boot, Windows startup task for WSL, Verification before Windows sign-in, Clear expectations around PC power.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need an OpenClaw-managed or doctor-verified WSL boot task for Windows.
- Need live proof that the Gateway is reachable after Windows reboot before sign-in.
- Need a clearer `status` or `doctor` message when WSL2 service is healthy but Windows boot did not start WSL.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:94`: docs introduce Gateway auto-start before Windows login.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:99`: first boot-chain step is `sudo loginctl enable-linger "$(whoami)"`.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:107`: second step installs the OpenClaw Gateway user service inside WSL.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:115`: third step starts WSL automatically at Windows boot using PowerShell.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:120`: scheduled task command invokes `wsl.exe -d Ubuntu --exec /bin/true` on start as SYSTEM.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:129`: verification checks `systemctl --user is-enabled` and `systemctl --user status`.

### Source

- `/Users/kevinlin/code/openclaw/src/daemon/systemd-hints.ts:17`: headless server hints include `loginctl enable-linger`.
- `/Users/kevinlin/code/openclaw/src/flows/doctor-health-contributions.ts:623`: doctor systemd-linger health imports the linger helper for Linux user services.
- `/Users/kevinlin/code/openclaw/src/flows/doctor-health-contributions.ts:642`: linger health explains that systemd stops the user session on logout/idle without lingering.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd-linger.ts`: systemd linger helper owns user linger status and enablement.

### Integration tests

- `/Users/kevinlin/code/openclaw/.github/workflows/windows-testbox-probe.yml:76`: workflow probes WSL2 availability on Windows runners.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/doctor-install-switch/scenario.sh:12`: Docker e2e stubs `loginctl` and systemd for service flows.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/response.test.ts:26`: daemon response tests classify headless systemd linger hints.
- `/Users/kevinlin/code/openclaw/src/cli/daemon-cli/response.test.ts:34`: daemon response tests classify WSL systemd hints.
- `/Users/kevinlin/code/openclaw/src/daemon/systemd.test.ts`: systemd tests cover user-service availability and user-bus behavior.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 Windows boot loginctl linger schtasks" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 gateway systemd" --mode keyword --limit 10 --json`

Results:

- The exact boot/loginctl/schtasks query returned 0 hits.
- The broader WSL2 systemd query returned 10 active service-lifecycle hits, including WSL diagnostics PR #58853, WSL user-bus PR #68400, WSL2 Gateway lifecycle issues, and systemd restart/lock issues.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 Windows boot loginctl linger schtasks"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "Windows WSL2 gateway systemd"`

Results:

- The exact boot/loginctl/schtasks query returned no displayed hits.
- The WSL2 systemd query returned support guidance that the Gateway service should auto-start when Ubuntu/WSL starts, but that Windows boot alone does not always mean WSL has started.
