---
title: "Native Windows Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Alpha (68%)`
- Quality: `Alpha (63%)`
- Completeness: `Alpha (68%)`
- LTS Features: `1/4`

## Summary

This report promotes the archived `native-windows-cli-and-gateway` maturity evidence from `/Users/kevinlin/tmp/maturity/native-windows-cli-and-gateway` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                       | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --- | ------------- | ------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CLI](native-powershell-install-and-cli-entrypoints.md)                        | ✅  | `Beta (72%)`  | `Alpha (66%)` | `Beta (72%)`  | PowerShell installer, Node and package-manager bootstrap, npm global install, Packaged CLI launcher, Windows command shims, openclaw onboard, Local Gateway config, Daemon install flags, Native-vs-WSL setup boundary                                                                             |
| [Gateway Management](native-gateway-foreground-runtime-and-process-control.md) | ❌  | `Alpha (68%)` | `Alpha (62%)` | `Alpha (68%)` | openclaw gateway, Foreground runtime health/readiness, Windows-specific restart/signal, Unmanaged foreground mode, openclaw gateway install, Gateway launcher files, Scheduled Task runtime status, Startup-folder fallback, openclaw status, Windows service inspection, Post-install diagnostics |
| [Networking](windows-host-networking-portproxy-and-remote-access.md)           | ❌  | `Alpha (58%)` | `Alpha (56%)` | `Alpha (58%)` | Native Windows host networking, netsh interface portproxy, Gateway status and probe output, Loopback, LAN, and WSL boundary                                                                                                                                                                        |
| [Updates](windows-update-restart-handoff-and-package-locks.md)                 | ❌  | `Beta (74%)`  | `Alpha (68%)` | `Beta (74%)`  | openclaw update on native Windows package, Managed Gateway stop/restart, Detached update handoff, Windows package locks                                                                                                                                                                            |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. CLI

Search anchors: native windows cli setup, install.ps1, PowerShell, openclaw.cmd, PATHEXT, openclaw onboard, Local Gateway config, daemon install.

Category note: [CLI](native-powershell-install-and-cli-entrypoints.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (72%)`
- LTS: ✅

Features:

- PowerShell installer: Native Windows install.ps1 hosted installer path and flags.
- Node and package-manager bootstrap: Node, Git, pnpm, npm, and PATH bootstrap for native Windows.
- npm global install: npm global install, git checkout install, and generated openclaw.cmd.
- Packaged CLI launcher: Packaged openclaw CLI launcher, version, and doctor entrypoints.
- Windows command shims: Windows .cmd launcher, PATHEXT, and package-manager shim compatibility.
- openclaw onboard: openclaw onboard and openclaw onboard --non-interactive on native Windows
- Local Gateway config: Local Gateway config, auth choice, gateway token/password SecretRef handling, and local endpoint defaults.
- Daemon install flags: Daemon install flags for native Windows onboarding.
- Native-vs-WSL setup boundary: Setup boundary between native Windows Gateway and the recommended WSL2 path.

Primary docs:

- `docs/install/index.md`
- `docs/install/installer.md`
- `docs/platforms/windows.md`
- `docs/start/getting-started.md`
- `docs/cli/onboard.md`

### 2. Gateway Management

Search anchors: openclaw gateway, Foreground runtime, Windows signal handling, openclaw gateway install, Scheduled Tasks, Startup-folder, openclaw status, openclaw doctor, Gateway diagnostics.

Category note: [Gateway Management](native-gateway-foreground-runtime-and-process-control.md)

Score decisions:

- Coverage: `Alpha (68%)`
- Quality: `Alpha (62%)`
- Completeness: `Alpha (68%)`
- LTS: ❌

Features:

- openclaw gateway: openclaw gateway, openclaw gateway run, openclaw gateway status, and foreground process behavior.
- Foreground runtime health/readiness: Foreground runtime health/readiness and local loopback Gateway targets
- Windows-specific restart/signal: Windows-specific restart/signal and process-control behavior
- Unmanaged foreground mode: Operator expectations when running without a managed Scheduled Task.
- openclaw gateway install: openclaw gateway install, status, start, stop, restart, and managed startup behavior.
- Gateway launcher files: Generated gateway.cmd and hidden launcher files for managed startup.
- Scheduled Task runtime status: Scheduled Task runtime status, task-user selection, listener/PID fallback, and task repair.
- Startup-folder fallback: Startup-folder fallback when Task Scheduler is unavailable.
- openclaw status: openclaw status, openclaw gateway status, gateway status --deep, and Windows repair guidance.
- Windows service inspection: Windows service inspection, Task Scheduler runtime parsing, Startup-folder
- Post-install diagnostics: Expected diagnostics, status, and repair behavior after native Windows install.

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/index.md`
- `docs/cli/gateway.md`
- `docs/cli/doctor.md`

### 3. Networking

Search anchors: portproxy, Gateway status, loopback, LAN.

Category note: [Networking](windows-host-networking-portproxy-and-remote-access.md)

Score decisions:

- Coverage: `Alpha (58%)`
- Quality: `Alpha (56%)`
- Completeness: `Alpha (58%)`
- LTS: ❌

Features:

- Native Windows host networking: Native Windows host binding and Gateway exposure behavior.
- netsh interface portproxy: netsh interface portproxy, Windows Firewall rules, and WSL IP refresh
- Gateway status and probe output: Gateway status and probe output that helps operators verify Windows networking.
- Loopback, LAN, and WSL boundary: Boundaries between loopback, LAN, and WSL exposure modes.

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/index.md`
- `docs/cli/gateway.md`

### 4. Updates

Search anchors: openclaw update, package locks, restart handoff.

Category note: [Updates](windows-update-restart-handoff-and-package-locks.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- openclaw update on native Windows package: openclaw update on native Windows package installs
- Managed Gateway stop/restart: Managed Gateway stop/restart and service metadata refresh during update
- Detached update handoff: Detached update handoff from a running Gateway.
- Windows package locks: Windows package locks, EBUSY/EPERM behavior, staged swaps, child-window

Primary docs:

- `docs/install/updating.md`
- `docs/ci.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/native-windows-cli-and-gateway/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/native-windows-cli-and-gateway`.
