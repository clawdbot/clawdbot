---
title: "Linux Gateway host Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Stable (80%)`
- Quality: `Beta (76%)`
- Completeness: `Stable (80%)`
- LTS Features: `4/5`

## Summary

This report promotes the archived `linux-gateway-host` maturity evidence from `/Users/kevinlin/tmp/maturity/linux-gateway-host` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                                 | LTS | Coverage       | Quality      | Completeness   | Features to evaluate                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | --- | -------------- | ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Host Setup and Updates](linux-cli-install-and-update-path.md)                           | ✅  | `Stable (82%)` | `Beta (78%)` | `Stable (82%)` | Linux CLI install, Node runtime prerequisites, Package-manager policy, Update path                                                                                                                          |
| [Gateway Runtime and Service Control](foreground-gateway-runtime-and-process-control.md) | ✅  | `Stable (83%)` | `Beta (78%)` | `Stable (83%)` | Foreground Gateway Runtime, Process Control, Systemd User Service Lifecycle setup, Systemd User Service Lifecycle operation, Systemd User Service Lifecycle status, Systemd User Service Lifecycle recovery |
| [Remote Access and Security](remote-network-exposure-tls-and-tailscale.md)               | ✅  | `Beta (78%)`   | `Beta (74%)` | `Beta (78%)`   | Remote Network Exposure, TLS, Tailscale, Gateway exposure safeguards, Gateway authentication modes, Secret Handling                                                                                         |
| [Diagnostics and Repair](diagnostics-logs-doctor-and-repair.md)                          | ✅  | `Stable (82%)` | `Beta (78%)` | `Stable (82%)` | Gateway diagnostic reports, Gateway log tailing, Doctor checks, Operator repair guidance                                                                                                                    |
| [Deployment Targets](vps-container-and-cloud-deployment-guidance.md)                     | ❌  | `Beta (76%)`   | `Beta (72%)` | `Beta (76%)`   | VPS, Container, Cloud Deployment Guidance                                                                                                                                                                   |

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

### 1. Host Setup and Updates

Search anchors: Linux install, Node runtime prerequisites, package-manager policy, updating OpenClaw.

Category note: [Host Setup and Updates](linux-cli-install-and-update-path.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Linux CLI install: Linux CLI installation paths and operator verification after install.
- Node runtime prerequisites: Node runtime version requirements and host prerequisite checks for Linux Gateway operation.
- Package-manager policy: Supported package-manager and platform policy for Linux install and update paths.
- Update path: Linux update workflow, package or git handoff, and post-update verification.

Primary docs:

- `docs/install/index.md`
- `docs/install/updating.md`
- `docs/platforms/linux.md`
- `docs/platforms/index.md`

### 2. Gateway Runtime and Service Control

Search anchors: Foreground Gateway Runtime, Process Control, linux gateway host foreground gateway runtime and process control, foreground gateway runtime and process control, Systemd User Service Lifecycle setup, Systemd User Service Lifecycle operation, Systemd User Service Lifecycle status, Systemd User Service Lifecycle recovery, linux gateway host systemd user service lifecycle, systemd user service lifecycle.

Category note: [Gateway Runtime and Service Control](foreground-gateway-runtime-and-process-control.md)

Score decisions:

- Coverage: `Stable (83%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (83%)`
- LTS: ✅

Features:

- Foreground Gateway Runtime: Covers Foreground Gateway Runtime user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Process Control: Covers Process Control user-facing controls, state display, navigation, and rendering behavior for Foreground Gateway Runtime and Process Control.
- Systemd User Service Lifecycle setup: Defines Systemd User Service Lifecycle setup setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle operation: Defines Systemd User Service Lifecycle operation setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle status: Defines Systemd User Service Lifecycle status setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.
- Systemd User Service Lifecycle recovery: Defines Systemd User Service Lifecycle recovery setup, credential, configuration, and operator verification behavior for Systemd User Service Lifecycle.

Primary docs:

- `docs/gateway/index.md`
- `docs/cli/gateway.md`
- `docs/platforms/linux.md`
- `docs/vps.md`

### 3. Remote Access and Security

Search anchors: Remote Network Exposure, TLS, Tailscale, linux gateway host remote network exposure, tls, and tailscale, remote network exposure, tls, and tailscale, exposure-runbook, Gateway authentication, Secret Handling, linux gateway host security, auth, and secret handling, security, auth, and secret handling.

Category note: [Remote Access and Security](remote-network-exposure-tls-and-tailscale.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (78%)`
- LTS: ✅

Features:

- Remote Network Exposure: Defines Remote Network Exposure authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- TLS: Defines TLS authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Tailscale: Defines Tailscale authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Gateway exposure safeguards: Defines exposure checks, unsafe-network warnings, and operator controls for Linux Gateway security boundaries.
- Gateway authentication modes: Defines token/password auth, shared-secret resolution, and operator verification for Linux Gateway authentication.
- Secret Handling: Defines Secret Handling setup, credential, configuration, and operator verification behavior for Security, Auth, and Secret Handling.

Primary docs:

- `docs/gateway/remote.md`
- `docs/gateway/tailscale.md`
- `docs/gateway/security/exposure-runbook.md`
- `docs/gateway/authentication.md`
- `docs/gateway/secrets.md`

### 4. Diagnostics and Repair

Search anchors: openclaw status, gateway diagnostics, openclaw logs, openclaw doctor, repair guidance, linux gateway host diagnostics, logs, doctor, and repair, diagnostics, logs, doctor, and repair.

Category note: [Diagnostics and Repair](diagnostics-logs-doctor-and-repair.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (82%)`
- LTS: ✅

Features:

- Gateway diagnostic reports: Covers Gateway status, diagnostic output, failure handling, and operator repair for diagnostics, logs, doctor, and repair workflows.
- Gateway log tailing: Covers log viewing, log tailing, local fallback behavior, and operator-visible Gateway log status.
- Doctor checks: Covers `openclaw doctor` checks, Gateway health probes, and operator diagnostics for Linux Gateway deployments.
- Operator repair guidance: Covers failure handling, repair guidance, and recovery steps for Linux Gateway diagnostics and doctor findings.

Primary docs:

- `docs/cli/status.md`
- `docs/cli/logs.md`
- `docs/cli/doctor.md`
- `docs/gateway/diagnostics.md`
- `docs/gateway/index.md`

### 5. Deployment Targets

Search anchors: Vps, Container, Cloud Deployment Guidance, linux gateway host vps, container, and cloud deployment guidance, vps, container, and cloud deployment guidance.

Category note: [Deployment Targets](vps-container-and-cloud-deployment-guidance.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- VPS: Defines VPS setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Container: Defines Container setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Cloud Deployment Guidance: Defines Cloud Deployment Guidance setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.

Primary docs:

- `docs/vps.md`
- `docs/install/docker.md`
- `docs/install/hetzner.md`
- `docs/install/digitalocean.md`
- `docs/install/kubernetes.md`
- `docs/install/podman.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/linux-gateway-host/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/linux-gateway-host`.
