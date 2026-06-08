---
title: "macOS Gateway host Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (75%)`
- Quality: `Beta (79%)`
- Completeness: `Beta (75%)`
- LTS Features: `0/7`

## Summary

This report promotes the archived `macos-gateway-host` maturity evidence from `/Users/kevinlin/tmp/maturity/macos-gateway-host` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                             | LTS | Coverage       | Quality        | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | --- | -------------- | -------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [CLI Setup](cli-install-runtime-prerequisites.md)                                    | ❌  | `Stable (82%)` | `Beta (76%)`   | `Stable (82%)` | Hosted installer, Node 24 recommendation, App-triggered CLI install, Shell PATH and version-manager drift                                                                                                                                                                                    |
| [Local Gateway Integration](local-gateway-mode-host-configuration.md)                | ❌  | `Beta (76%)`   | `Stable (82%)` | `Beta (76%)`   | App local/remote connection mode, App-managed Gateway LaunchAgent install/restart/uninstall, CLI install detection, Attach-to-existing local Gateway compatibility, Gateway endpoint, gateway.mode=local configuration, Loopback bind, Local app endpoint resolution, Bonjour discovery      |
| [Remote Gateway Mode](remote-gateway-mode-transport.md)                              | ❌  | `Beta (72%)`   | `Stable (82%)` | `Beta (72%)`   | macOS app "Remote over SSH", SSH tunnel setup, Tailscale MagicDNS, Remote endpoint token/password/TLS fingerprint, Local node host startup                                                                                                                                                   |
| [Gateway Service Lifecycle](launchagent-service-lifecycle.md)                        | ❌  | `Stable (82%)` | `Beta (76%)`   | `Stable (82%)` | Per-user Gateway LaunchAgent install, launchctl bootstrap, LaunchAgent labels, Gateway token/env handling, App-managed LaunchAgent handoff, openclaw update package/git handoff, Managed service refresh, Stale updater launchd job detection, openclaw uninstall, Stranded service recovery |
| [Diagnostics and Observability](diagnostics-logs-operator-observability.md)          | ❌  | `Stable (80%)` | `Stable (83%)` | `Stable (80%)` | LaunchAgent log paths, openclaw gateway status --deep, Gateway silently stops responding, Stale updater jobs                                                                                                                                                                                 |
| [Permissions and Native Capabilities](macos-permissions-native-node-capabilities.md) | ❌  | `Alpha (62%)`  | `Beta (73%)`   | `Alpha (62%)`  | macOS TCC permission prompts/status, Native node capability exposure, system.run policy, Permission-driven support                                                                                                                                                                           |
| [Profiles and Isolation](profiles-multi-gateway-isolation.md)                        | ❌  | `Beta (74%)`   | `Stable (82%)` | `Beta (74%)`   | Profile-specific LaunchAgent labels, Profile-specific state/config/workspace roots, Derived ports, Rescue bot setup, Extra Gateway process detection                                                                                                                                         |

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

### 1. CLI Setup

Search anchors: macos gateway host macos cli install and runtime prerequisites, macos cli install and runtime prerequisites.

Category note: [CLI Setup](cli-install-runtime-prerequisites.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Hosted installer: Hosted installer and local-prefix install paths on macOS
- Node 24 recommendation: Node 24 recommendation and Node 22.19+ compatibility floor
- App-triggered CLI install: App-triggered CLI install and runtime discovery
- Shell PATH and version-manager drift: Shell PATH, package-manager, and version-manager drift that affect the host Gateway.

Primary docs:

- `docs/platforms/macos.md`
- `docs/platforms/mac/bundled-gateway.md`
- `docs/install/installer.md`
- `docs/install/node.md`

### 2. Local Gateway Integration

Search anchors: macos gateway host companion app gateway integration, companion app gateway integration, macos gateway host local gateway mode and host configuration, local gateway mode and host configuration.

Category note: [Local Gateway Integration](local-gateway-mode-host-configuration.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Stable (82%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- App local/remote connection mode: App local/remote connection mode coordination
- App-managed Gateway LaunchAgent install/restart/uninstall: App-managed Gateway LaunchAgent install/restart/uninstall through the CLI
- CLI install detection: CLI install detection and app install prompt
- Attach-to-existing local Gateway compatibility: Attach-to-existing local Gateway compatibility checks
- Gateway endpoint: Gateway endpoint, credential, and control-channel resolution
- gateway.mode=local configuration: gateway.mode=local configuration and defaulting during service install
- Loopback bind: Loopback bind, explicit host/bind overrides, auth requirements, and port precedence
- Local app endpoint resolution: Local app endpoint resolution, local control channel, and attach-to-existing Gateway behavior
- Bonjour discovery: Bonjour discovery and local status/probe/health surfaces

Primary docs:

- `docs/platforms/macos.md`
- `docs/platforms/mac/bundled-gateway.md`
- `docs/platforms/mac/remote.md`
- `docs/gateway/index.md`
- `docs/cli/gateway.md`
- `docs/gateway/bonjour.md`

### 3. Remote Gateway Mode

Search anchors: macos gateway host remote gateway mode and transport, remote gateway mode and transport.

Category note: [Remote Gateway Mode](remote-gateway-mode-transport.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Stable (82%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- macOS app "Remote over SSH": macOS app "Remote over SSH" and direct remote Gateway modes
- SSH tunnel setup: SSH tunnel setup, stable local forward ownership, and tunnel restart/backoff
- Tailscale MagicDNS: Tailscale MagicDNS, Serve, and Funnel guidance for remote access
- Remote endpoint token/password/TLS fingerprint: Remote endpoint token/password/TLS fingerprint resolution
- Local node host startup: Local node host startup and local Gateway suppression while the app is remote

Primary docs:

- `docs/platforms/mac/remote.md`
- `docs/gateway/remote.md`
- `docs/gateway/tailscale.md`

### 4. Gateway Service Lifecycle

Search anchors: macos gateway host launchagent service lifecycle, launchagent service lifecycle, macos gateway host update, uninstall, and recovery, update, uninstall, and recovery.

Category note: [Gateway Service Lifecycle](launchagent-service-lifecycle.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Per-user Gateway LaunchAgent install: Per-user Gateway LaunchAgent install, stage, uninstall, start, stop, restart, and status
- launchctl bootstrap: launchctl bootstrap, bootout, enable, disable, kickstart, runtime parsing, installed-but-unloaded repair, and --disable semantics
- LaunchAgent labels: LaunchAgent labels, profile labels, legacy cleanup, service metadata, plist generation, KeepAlive, RunAtLoad, logs, working directory, and temp directory handling
- Gateway token/env handling: Gateway token/env handling, owner-only env files/wrappers, managed service env keys, and config audit/status output
- App-managed LaunchAgent handoff: macOS app integration that manages the Gateway LaunchAgent in local mode and avoids it in remote or attach-only modes.
- openclaw update package/git handoff: openclaw update package/git handoff on macOS
- Managed service refresh: Managed service refresh and LaunchAgent rebootstrap after updates
- Stale updater launchd job detection: Stale updater launchd job detection and cleanup
- openclaw uninstall: openclaw uninstall, service uninstall, state cleanup, and manual launchd removal
- Stranded service recovery: Recovery after partially updated or stranded macOS Gateway services.

Primary docs:

- `docs/platforms/macos.md`
- `docs/platforms/mac/bundled-gateway.md`
- `docs/cli/gateway.md`
- `docs/gateway/index.md`
- `docs/cli/update.md`
- `docs/install/updating.md`
- `docs/install/uninstall.md`
- `docs/gateway/troubleshooting.md`

### 5. Diagnostics and Observability

Search anchors: macos gateway host diagnostics, logs, and operator observability, diagnostics, logs, and operator observability.

Category note: [Diagnostics and Observability](diagnostics-logs-operator-observability.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Stable (83%)`
- Completeness: `Stable (80%)`
- LTS: ❌

Features:

- LaunchAgent log paths: LaunchAgent log paths and app diagnostic log paths
- openclaw gateway status --deep: openclaw gateway status --deep, gateway probe, doctor, health, and logs commands
- Gateway silently stops responding: Gateway silently stops responding, ENETDOWN sleep/wake failure, port conflicts, invalid config, and memory pressure runbooks
- Stale updater jobs: Stale updater jobs, service config drift, and LaunchAgent environment diagnostics

Primary docs:

- `docs/platforms/mac/bundled-gateway.md`
- `docs/platforms/macos.md`
- `docs/cli/gateway.md`
- `docs/gateway/doctor.md`
- `docs/gateway/troubleshooting.md`

### 6. Permissions and Native Capabilities

Search anchors: macos gateway host macos permissions and native node capabilities, macos permissions and native node capabilities.

Category note: [Permissions and Native Capabilities](macos-permissions-native-node-capabilities.md)

Score decisions:

- Coverage: `Alpha (62%)`
- Quality: `Beta (73%)`
- Completeness: `Alpha (62%)`
- LTS: ❌

Features:

- macOS TCC permission prompts/status: macOS TCC permission prompts/status for Accessibility, AppleScript, Screen Recording, Microphone, Speech Recognition, Camera, Location, Notifications, and Voice Wake
- Native node capability exposure: Native node capability exposure for screen/canvas/browser/system operations
- system.run policy: system.run policy and local/remote node execution expectations
- Permission-driven support: Permission-driven support and operator diagnostics

Primary docs:

- `docs/platforms/macos.md`
- `docs/platforms/mac/remote.md`

### 7. Profiles and Isolation

Search anchors: macos gateway host profiles and multi-gateway isolation, profiles and multi-gateway isolation.

Category note: [Profiles and Isolation](profiles-multi-gateway-isolation.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Stable (82%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Profile-specific LaunchAgent labels: Profile-specific LaunchAgent labels and plist paths
- Profile-specific state/config/workspace roots: Profile-specific state, config, and workspace roots for isolated local Gateways.
- Derived ports: Derived ports and multi-Gateway conflict avoidance
- Rescue bot setup: Rescue bot setup and operator checks
- Extra Gateway process detection: Deep status detection for extra Gateway-like services and duplicate local processes.

Primary docs:

- `docs/gateway/multiple-gateways.md`
- `docs/gateway/index.md`
- `docs/cli/gateway.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/macos-gateway-host/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/macos-gateway-host`.
