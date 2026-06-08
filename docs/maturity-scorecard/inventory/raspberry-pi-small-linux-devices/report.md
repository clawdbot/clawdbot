---
title: "Raspberry Pi / small Linux devices Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (70%)`
- Quality: `Alpha (67%)`
- Completeness: `Beta (70%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `raspberry-pi-small-linux-devices` maturity evidence from `/Users/kevinlin/tmp/maturity/raspberry-pi-small-linux-devices` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                              | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Setup and Compatibility](arm-linux-install-and-runtime-prerequisites.md)             | ❌  | `Alpha (55%)` | `Alpha (58%)` | `Alpha (55%)` | Hardware and 64-bit OS requirements, Node runtime setup, OpenClaw install and onboarding, First-run verification, Supported Pi model selection, 64-bit ARM boundary, Unsupported device guidance, Slow-device caveats, npm/pnpm/Bun install modes, Installer architecture detection, Optional ARM binary checks, Fallback/build guidance |
| [Remote Access and Auth](remote-access-tailscale-ssh-and-control-ui.md)               | ❌  | `Beta (74%)`  | `Alpha (68%)` | `Beta (74%)`  | Headless API-key auth, Gateway shared-secret auth, Device pairing approvals, SecretRef handling, Token drift recovery, SSH tunnel dashboard access, Tailscale Serve/Funnel, Loopback/non-loopback exposure controls, Authenticated Control UI access                                                                                     |
| [Gateway Runtime](headless-gateway-runtime-and-model-routing.md)                      | ❌  | `Beta (78%)`  | `Beta (72%)`  | `Beta (78%)`  | Always-on Gateway process, Cloud model configuration, Channel startup, Gateway health/status, User service install, linger/boot persistence, Service drop-ins, Restart tuning, Status/log inspection, Backup/restore                                                                                                                     |
| [Performance and Diagnostics](resource-tuning-diagnostics-and-low-memory-behavior.md) | ❌  | `Beta (75%)`  | `Alpha (69%)` | `Beta (75%)`  | Swap and low-RAM tuning, USB SSD guidance, Compile cache/no-respawn settings, OOM/performance troubleshooting, Diagnostics bundles                                                                                                                                                                                                       |

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

### 1. Setup and Compatibility

Search anchors: Hardware and 64-bit OS requirements, Node runtime setup, OpenClaw install and onboarding, First-run verification, Hardware compatibility, Install Node.js 24, API keys are recommended over OAuth, Access the Control UI, Supported Pi model selection, 64-bit ARM boundary, Unsupported device guidance, Slow-device caveats, npm/pnpm/Bun install modes, Installer architecture detection, Optional ARM binary checks, Fallback/build guidance.

Category note: [Setup and Compatibility](arm-linux-install-and-runtime-prerequisites.md)

Score decisions:

- Coverage: `Alpha (55%)`
- Quality: `Alpha (58%)`
- Completeness: `Alpha (55%)`
- LTS: ❌

Features:

- Hardware and 64-bit OS requirements: Defines Hardware and 64-bit OS requirements setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Node runtime setup: Defines Node runtime setup setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- OpenClaw install and onboarding: Defines OpenClaw install and onboarding setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- First-run verification: Defines First-run verification setup, credential, configuration, and operator verification behavior for ARM Linux Setup and Prerequisites.
- Supported Pi model selection: Defines Supported Pi model selection setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- 64-bit ARM boundary: Defines 64-bit ARM boundary setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Unsupported device guidance: Defines Unsupported device guidance setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- Slow-device caveats: Defines Slow-device caveats setup, credential, configuration, and operator verification behavior for Hardware Support Boundary.
- npm/pnpm/Bun install modes: Defines npm/pnpm/Bun install modes setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Installer architecture detection: Defines Installer architecture detection setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Optional ARM binary checks: Defines Optional ARM binary checks setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.
- Fallback/build guidance: Defines Fallback/build guidance setup, credential, configuration, and operator verification behavior for Package Manager and ARM Binary Compatibility.

Primary docs:

- `docs/install/raspberry-pi.md`
- `docs/install/index.md`
- `docs/help/faq-first-run.md`
- `docs/help/faq.md`
- `docs/platforms/linux.md`
- `docs/install/installer.md`

### 2. Remote Access and Auth

Search anchors: Headless API-key auth, Gateway shared-secret auth, Device pairing approvals, SecretRef handling, Token drift recovery, Hardware compatibility, Install Node.js 24, API keys are recommended over OAuth, SSH tunnel dashboard access, Tailscale Serve/Funnel, Loopback/non-loopback exposure controls, Authenticated Control UI access, Access the Control UI.

Category note: [Remote Access and Auth](remote-access-tailscale-ssh-and-control-ui.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Headless API-key auth: Defines Headless API-key auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Gateway shared-secret auth: Defines Gateway shared-secret auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Device pairing approvals: Defines Device pairing approvals context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SecretRef handling: Defines SecretRef handling context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Token drift recovery: Defines Token drift recovery context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SSH tunnel dashboard access: Defines SSH tunnel dashboard access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Tailscale Serve/Funnel: Defines Tailscale Serve/Funnel setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Loopback/non-loopback exposure controls: Defines Loopback/non-loopback exposure controls setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Authenticated Control UI access: Defines Authenticated Control UI access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.

Primary docs:

- `docs/install/raspberry-pi.md`
- `docs/gateway/authentication.md`
- `docs/gateway/secrets.md`
- `docs/gateway/pairing.md`
- `docs/cli/devices.md`
- `docs/gateway/remote.md`
- `docs/gateway/tailscale.md`

### 3. Gateway Runtime

Search anchors: Always-on Gateway process, Cloud model configuration, Channel startup, Gateway health/status, Hardware compatibility, Install Node.js 24, API keys are recommended over OAuth, Access the Control UI, User service install, linger/boot persistence, Service drop-ins, Restart tuning, Status/log inspection, Backup/restore.

Category note: [Gateway Runtime](headless-gateway-runtime-and-model-routing.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Always-on Gateway process: Defines Always-on Gateway process setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Cloud model configuration: Defines Cloud model configuration setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Channel startup: Defines Channel startup setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- Gateway health/status: Defines Gateway health/status setup, credential, configuration, and operator verification behavior for Headless Gateway and Model Setup.
- User service install: Defines User service install setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- linger/boot persistence: Defines linger/boot persistence setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Service drop-ins: Defines Service drop-ins setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Restart tuning: Defines Restart tuning setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Status/log inspection: Defines Status/log inspection setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.
- Backup/restore: Defines Backup/restore setup, credential, configuration, and operator verification behavior for systemd Service and Boot Persistence.

Primary docs:

- `docs/gateway/index.md`
- `docs/cli/gateway.md`
- `docs/install/raspberry-pi.md`
- `docs/platforms/linux.md`
- `docs/vps.md`

### 4. Performance and Diagnostics

Search anchors: Swap and low-RAM tuning, USB SSD guidance, Compile cache/no-respawn settings, OOM/performance troubleshooting, Diagnostics bundles, Hardware compatibility, Install Node.js 24, API keys are recommended over OAuth.

Category note: [Performance and Diagnostics](resource-tuning-diagnostics-and-low-memory-behavior.md)

Score decisions:

- Coverage: `Beta (75%)`
- Quality: `Alpha (69%)`
- Completeness: `Beta (75%)`
- LTS: ❌

Features:

- Swap and low-RAM tuning: Defines Swap and low-RAM tuning setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- USB SSD guidance: Defines USB SSD guidance setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Compile cache/no-respawn settings: Defines Compile cache/no-respawn settings setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- OOM/performance troubleshooting: Defines OOM/performance troubleshooting setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.
- Diagnostics bundles: Defines Diagnostics bundles setup, credential, configuration, and operator verification behavior for Resource Tuning and Diagnostics.

Primary docs:

- `docs/install/raspberry-pi.md`
- `docs/platforms/linux.md`
- `docs/gateway/health.md`
- `docs/gateway/diagnostics.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/raspberry-pi-small-linux-devices/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/raspberry-pi-small-linux-devices`.
