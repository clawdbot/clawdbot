---
title: "Windows via WSL2 Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (72%)`
- Quality: `Alpha (69%)`
- Completeness: `Beta (72%)`
- LTS Features: `5/6`

## Summary

This report promotes the archived `windows-via-wsl2` maturity evidence from `/Users/kevinlin/tmp/maturity/windows-via-wsl2` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                               | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [WSL Setup](wsl2-install-and-runtime-prerequisites.md)                 | ✅  | `Beta (76%)`  | `Beta (70%)`  | `Beta (76%)`  | WSL2 + Ubuntu installation, Node runtime, Linux install flow inside WSL2, WSL2 runtime boundary, WSL2 network-family requirements, Source install and build inside WSL2                                                                                                                                              |
| [CLI](wsl2-cli.md)                                                     | ✅  | `Beta (76%)`  | `Beta (70%)`  | `Beta (76%)`  | WSL2 CLI entrypoints, openclaw onboard, openclaw doctor status and logs, openclaw update, npm/pnpm/git package-root, Managed systemd Gateway restart, Service metadata refresh, Package-manager caveats                                                                                                              |
| [Gateway Service Lifecycle](systemd-gateway-service-lifecycle.md)      | ✅  | `Alpha (64%)` | `Alpha (66%)` | `Alpha (64%)` | Onboarded systemd install, Gateway service install, systemd user unit rendering, WSL-aware systemd unavailable hints, Doctor service repair, WSL user-service linger, Systemd availability after Windows boot, Windows startup task for WSL, Verification before Windows sign-in, Clear expectations around PC power |
| [Gateway Access and Exposure](auth-secrets-and-exposure-posture.md)    | ✅  | `Beta (70%)`  | `Alpha (65%)` | `Beta (70%)`  | Gateway token/password auth, Provider credentials, Gateway auth SecretRefs, Remote URL credential precedence, WSL virtual network, Windows portproxy setup, Windows Firewall rules, Reachable Gateway URLs, Loopback and LAN exposure, WSL2 IPv4 networking, Tailscale remote access                                 |
| [Diagnostics and Repair](diagnostics-doctor-logs-and-repair.md)        | ✅  | `Beta (74%)`  | `Beta (72%)`  | `Beta (74%)`  | openclaw doctor, openclaw status, openclaw logs, SecretRef, WSL/systemd unavailable hints, Operator repair guidance after WSL2 service                                                                                                                                                                               |
| [Browser and Control UI](split-host-browser-and-control-ui-interop.md) | ❌  | `Beta (72%)`  | `Beta (70%)`  | `Beta (72%)`  | WSL2 Gateway with Windows browser, Windows Control UI URL, Raw remote CDP to Windows Chrome, Host-local Chrome MCP, Browser profile cdpUrl, Layered diagnostics                                                                                                                                                      |

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

### 1. WSL Setup

Search anchors: WSL2 (recommended), Ubuntu, Node 24, source install.

Category note: [WSL Setup](wsl2-install-and-runtime-prerequisites.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- WSL2 + Ubuntu installation: WSL2 and Ubuntu installation requirements.
- Node runtime: Node 24 and Node 22.19+ runtime requirements inside WSL2.
- Linux install flow inside WSL2: Linux install and getting-started flow run inside WSL2.
- WSL2 runtime boundary: WSL2 runtime boundary and its distinction from native Windows installs.
- WSL2 network-family requirements: WSL2-specific network-family requirements that affect Gateway startup.
- Source install and build inside WSL2: Source install and build workflow inside the WSL2 distribution.

Primary docs:

- `docs/platforms/windows.md`
- `docs/start/getting-started.md`

### 2. CLI

Search anchors: windows via wsl2 cli, WSL2 CLI entrypoints, openclaw onboard, openclaw doctor, openclaw status, openclaw logs, openclaw update, package manager.

Category note: [CLI](wsl2-cli.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ✅

Features:

- WSL2 CLI entrypoints: openclaw CLI install, version, onboard, doctor, status, and update commands run inside the WSL2 Linux environment.
- openclaw onboard: openclaw onboard and non-interactive onboarding run inside the WSL2 Linux environment.
- openclaw doctor status and logs: openclaw doctor, status, and logs provide WSL2-specific repair and diagnostic feedback.
- openclaw update: openclaw update, channel switching, dry-run/status diagnostics
- npm/pnpm/git package-root: npm/pnpm/git package-root and install-mode switching
- Managed systemd Gateway restart: Managed systemd Gateway restart and update handoff
- Service metadata refresh: Service metadata refresh after WSL2 Gateway updates.
- Package-manager caveats: Package-manager caveats seen from WSL2 source and package installs.

Primary docs:

- `docs/platforms/windows.md`
- `docs/start/getting-started.md`
- `docs/install/updating.md`
- `docs/cli/onboard.md`
- `docs/cli/doctor.md`
- `docs/cli/status.md`
- `docs/cli/logs.md`

### 3. Gateway Service Lifecycle

Search anchors: Gateway service install (CLI), systemd user service, WSL-aware systemd, Gateway auto-start before Windows login, WSL user-service linger, Windows startup scheduled task.

Category note: [Gateway Service Lifecycle](systemd-gateway-service-lifecycle.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (66%)`
- Completeness: `Alpha (64%)`
- LTS: ✅

Features:

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

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/index.md`
- `docs/gateway/doctor.md`

### 4. Gateway Access and Exposure

Search anchors: Gateway authentication, SecretRef, Remote URL credential precedence, Advanced: expose WSL services over LAN (portproxy), portproxy, WSL2 IPv4.

Category note: [Gateway Access and Exposure](auth-secrets-and-exposure-posture.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (65%)`
- Completeness: `Beta (70%)`
- LTS: ✅

Features:

- Gateway token/password auth: Gateway token and password auth for clients running through WSL2.
- Provider credentials: Provider credential storage and lookup from inside the WSL2 environment.
- Gateway auth SecretRefs: Gateway auth SecretRef handling for WSL2-hosted Gateway processes.
- Remote URL credential precedence: Remote URL credential precedence when WSL2 clients connect to local or remote Gateways.
- WSL virtual network: WSL virtual network behavior and host/guest addressing.
- Windows portproxy setup: Windows netsh interface portproxy setup for exposing WSL services.
- Windows Firewall rules: Windows Firewall rules for WSL Gateway access.
- Reachable Gateway URLs: Gateway URLs that must be reachable from Windows, WSL2, and LAN clients.
- Loopback and LAN exposure: Loopback versus LAN listen behavior for WSL2 Gateway exposure.
- WSL2 IPv4 networking: WSL2-specific IPv4 network-family behavior.
- Tailscale remote access: Tailscale and remote access behavior where it intersects WSL2 networking.

Primary docs:

- `docs/gateway/authentication.md`
- `docs/gateway/secrets.md`
- `docs/gateway/remote.md`
- `docs/gateway/security/exposure-runbook.md`
- `docs/platforms/windows.md`

### 5. Diagnostics and Repair

Search anchors: windows via wsl2 diagnostics, doctor, logs, and repair, diagnostics, doctor, logs, and repair.

Category note: [Diagnostics and Repair](diagnostics-doctor-logs-and-repair.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ✅

Features:

- openclaw doctor: openclaw doctor and repair/migration for WSL2 Gateway
- openclaw status: openclaw status, status --all, and Gateway service/runtime summary
- openclaw logs: openclaw logs and Linux systemd journal fallback
- SecretRef: SecretRef and auth diagnostics visible from status/doctor
- WSL/systemd unavailable hints: WSL/systemd unavailable hints and linger checks
- Operator repair guidance after WSL2 service: Operator repair guidance after WSL2 service, config, or Gateway failures

Primary docs:

- `docs/platforms/windows.md`
- `docs/cli/status.md`
- `docs/cli/logs.md`
- `docs/cli/doctor.md`
- `docs/gateway/doctor.md`

### 6. Browser and Control UI

Search anchors: Raw remote CDP from WSL2 to Windows, Windows Control UI URL, Host-local Chrome MCP.

Category note: [Browser and Control UI](split-host-browser-and-control-ui-interop.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- WSL2 Gateway with Windows browser: WSL2 Gateway with Windows browser and Windows Chrome
- Windows Control UI URL: Windows Control UI URL and origin guidance
- Raw remote CDP to Windows Chrome: Raw remote CDP access from WSL2 to a Windows Chrome instance.
- Host-local Chrome MCP: Host-local Chrome MCP and existing-session boundary
- Browser profile cdpUrl: Browser profile cdpUrl and attachOnly config
- Layered diagnostics: Layered diagnostics for auth/origin/CDP failures

Primary docs:

- `docs/tools/browser-wsl2-windows-remote-cdp-troubleshooting.md`
- `docs/tools/browser.md`
- `docs/web/control-ui.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/windows-via-wsl2/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/windows-via-wsl2`.
