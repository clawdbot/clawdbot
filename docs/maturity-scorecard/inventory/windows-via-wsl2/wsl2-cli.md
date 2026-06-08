---
title: "Windows via WSL2 - CLI Maturity Note"
version: 3
last_refreshed: 2026-06-04
last_refreshed_by: codex
---

# Windows via WSL2 - CLI Maturity Note

## Summary

The WSL2 CLI path is the recommended Windows operator path: users install and
run the OpenClaw CLI inside the WSL2 Linux environment, then use normal Linux
commands for onboarding, status, doctor, logs, updates, and package/source
workflow repair. Coverage is `Beta` because the docs and existing WSL2 platform
evidence describe the full CLI lifecycle, while quality remains bounded by WSL
boot, systemd, package-manager, and Windows/WSL boundary behavior.

## Category Scope

- This category covers OpenClaw CLI entrypoints and lifecycle commands when the
  CLI runs inside WSL2.
- This category covers onboarding, doctor/status/logs, updates, package-root
  behavior, install-mode switching, and update handoff as CLI-facing operator
  workflows.
- Out of scope: generic WSL2/Ubuntu installation prerequisites, Gateway
  service lifecycle, Gateway auth/exposure, and split-host browser behavior.

## Features

- WSL2 CLI entrypoints: openclaw CLI install, version, onboard, doctor, status, and update commands run inside the WSL2 Linux environment.
- openclaw onboard: openclaw onboard and non-interactive onboarding run inside the WSL2 Linux environment.
- openclaw doctor status and logs: openclaw doctor, status, and logs provide WSL2-specific repair and diagnostic feedback.
- openclaw update: openclaw update, channel switching, dry-run/status diagnostics
- npm/pnpm/git package-root: npm/pnpm/git package-root and install-mode switching
- Managed systemd Gateway restart: Managed systemd Gateway restart and update handoff
- Service metadata refresh: Service metadata refresh after WSL2 Gateway updates.
- Package-manager caveats: Package-manager caveats seen from WSL2 source and package installs.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals:
  - `docs/platforms/windows.md` describes WSL2 as the recommended Windows path
    and routes operators through Linux-style CLI setup.
  - `docs/start/getting-started.md`, `docs/cli/onboard.md`,
    `docs/cli/doctor.md`, `docs/cli/status.md`, and `docs/cli/logs.md` cover
    normal CLI entrypoints and repair commands.
  - `docs/install/updating.md` covers update, install-mode, package-manager,
    and service restart behavior that applies to WSL2 CLI usage.
- Negative signals:
  - The strongest evidence is docs and adjacent WSL2 platform scoring, not a
    fresh dedicated WSL2 CLI end-to-end scorecard.
- Integration gaps:
  - Add a repeatable WSL2 CLI release smoke that provisions a distro, installs
    the CLI, runs onboarding, status, doctor, logs, update dry-run, and verifies
    service metadata after update.

## Quality Score

- Score: `Beta (70%)`
- Good qualities:
  - WSL2 keeps the CLI on the Linux path instead of relying on native Windows
    command shims.
  - Operator docs make the native-vs-WSL boundary explicit and keep WSL2 as the
    recommended full-experience path.
- Bad qualities:
  - CLI success still depends on WSL boot state, systemd availability, package
    manager behavior, and Windows/WSL network and filesystem boundaries.
- Excluded from quality:
  - Documentation breadth and test presence raise Coverage only.

## Completeness Score

- Score: `Beta (76%)`
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WSL2 CLI entrypoints, openclaw onboard, openclaw doctor status and logs, openclaw update, npm/pnpm/git package-root, Managed systemd Gateway restart, Service metadata refresh, Package-manager caveats.
  diagnostics, logs, update, package-root, and service metadata handoff.
- Negative signals: The category still lacks a dedicated live WSL2 CLI
  acceptance artifact.
