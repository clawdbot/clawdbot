---
title: "Linux companion app Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (5%)`
- Quality: `Experimental (27%)`
- Completeness: `Experimental (5%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `linux-companion-app` maturity evidence from `/Users/kevinlin/tmp/maturity/linux-companion-app` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                            | LTS | Coverage             | Quality              | Completeness         | Features to evaluate                                                                                                                                                                                   |
| ------------------------------------------------------------------- | --- | -------------------- | -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [App Distribution](packaging-install-update-desktop-integration.md) | ❌  | `Experimental (0%)`  | `Experimental (18%)` | `Experimental (0%)`  | Native app package, Distro package targets, Official release metadata                                                                                                                                  |
| [Gateway Connectivity](gateway-connection-pairing-local-remote.md)  | ❌  | `Experimental (8%)`  | `Experimental (35%)` | `Experimental (8%)`  | Local Gateway attach and status, Gateway pairing and auth, Remote mode, Local and remote resource boundaries                                                                                           |
| [Chat and Sessions](native-chat-session-controls.md)                | ❌  | `Experimental (10%)` | `Experimental (36%)` | `Experimental (10%)` | Native Linux chat window, Transcript, Gateway chat transport                                                                                                                                           |
| [Desktop Capabilities](desktop-permissions-secrets-sandbox.md)      | ❌  | `Experimental (0%)`  | `Experimental (20%)` | `Experimental (0%)`  | Linux desktop permissions, Secret storage, Sandbox/package posture, Linux native node identity, Host command execution, Desktop tools, Linux native Talk, Microphone capture, Native media permissions |
| [Status and Diagnostics](diagnostics-health-operator-repair.md)     | ❌  | `Experimental (5%)`  | `Experimental (25%)` | `Experimental (5%)`  | Native Linux app readiness, Gateway health/status display, Log/transcript opening, Doctor/repair affordances, Linux tray/status item, Runtime status row, Desktop-environment integration              |

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

### 1. App Distribution

Search anchors: Native Linux companion apps are planned, Linux app, Gateway service install.

Category note: [App Distribution](packaging-install-update-desktop-integration.md)

Score decisions:

- Coverage: `Experimental (0%)`
- Quality: `Experimental (18%)`
- Completeness: `Experimental (0%)`
- LTS: ❌

Features:

- Native app package: Native Linux companion-app package availability and installation path.
- Distro package targets: Distro package targets, desktop files, icons, autostart, and update metadata
- Official release metadata: Official release metadata for downstream consoles

Primary docs:

- `docs/platforms/linux.md`
- `docs/platforms/index.md`
- `docs/install/index.md`

### 2. Gateway Connectivity

Search anchors: Linux app, Gateway service install, remote Gateway, pairing.

Category note: [Gateway Connectivity](gateway-connection-pairing-local-remote.md)

Score decisions:

- Coverage: `Experimental (8%)`
- Quality: `Experimental (35%)`
- Completeness: `Experimental (8%)`
- LTS: ❌

Features:

- Local Gateway attach and status: Local Gateway attach, start, and status behavior from a Linux app.
- Gateway pairing and auth: Gateway auth and device pairing from a native Linux client.
- Remote mode: Remote mode through direct URL, SSH tunnel, or Tailscale
- Local and remote resource boundaries: Local and remote resource boundaries for a Linux companion client.

Primary docs:

- `docs/platforms/linux.md`
- `docs/gateway/index.md`
- `docs/gateway/pairing.md`
- `docs/gateway/remote.md`

### 3. Chat and Sessions

Search anchors: WebChat, Gateway WebSocket, chat history.

Category note: [Chat and Sessions](native-chat-session-controls.md)

Score decisions:

- Coverage: `Experimental (10%)`
- Quality: `Experimental (36%)`
- Completeness: `Experimental (10%)`
- LTS: ❌

Features:

- Native Linux chat window: Native Linux chat window behavior, status, and operator-visible verification.
- Transcript: Transcript, composer, session picker, model picker, send/abort/follow-up controls
- Gateway chat transport: Gateway WebSocket chat transport from a Linux desktop client.

Primary docs:

- `docs/platforms/linux.md`
- `docs/gateway/protocol.md`
- `docs/web/webchat.md`

### 4. Desktop Capabilities

Search anchors: Native Linux companion apps are planned, Linux app, Exec approvals, headless node host, system.run, Talk mode, microphone capture, camera.

Category note: [Desktop Capabilities](desktop-permissions-secrets-sandbox.md)

Score decisions:

- Coverage: `Experimental (0%)`
- Quality: `Experimental (20%)`
- Completeness: `Experimental (0%)`
- LTS: ❌

Features:

- Linux desktop permissions: Linux desktop permissions for notifications, microphone, screen, camera, accessibility, portals, and desktop-environment APIs
- Secret storage: Secret storage for Gateway token, device identity, approval socket token, and app settings
- Sandbox/package posture: Sandbox/package posture for Flatpak/Snap/AppImage or system packages
- Linux native node identity: Linux native node identity and capability advertisement
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop tools: Desktop tools such as screen, camera, notifications, Canvas, and local command execution
- Linux native Talk: Linux native Talk, push-to-talk, voice wake, and transcription
- Microphone capture: Microphone capture, screen/camera capture, desktop context sensing, and local media attachment flows
- Native media permissions: Native media permissions and foreground/background behavior

Primary docs:

- `docs/platforms/linux.md`
- `docs/tools/exec-approvals.md`
- `docs/gateway/secrets.md`
- `docs/nodes/index.md`
- `docs/tools/exec.md`
- `docs/nodes/talk.md`
- `docs/nodes/camera.md`

### 5. Status and Diagnostics

Search anchors: Gateway service install, openclaw status, Control UI, Linux app, status, desktop notifications.

Category note: [Status and Diagnostics](diagnostics-health-operator-repair.md)

Score decisions:

- Coverage: `Experimental (5%)`
- Quality: `Experimental (25%)`
- Completeness: `Experimental (5%)`
- LTS: ❌

Features:

- Native Linux app readiness: Native Linux app readiness states
- Gateway health/status display: Gateway health/status display behavior, status, and operator-visible verification.
- Log/transcript opening: Log/transcript opening and locality-aware resource handling
- Doctor/repair affordances: Doctor/repair affordances and systemd lifecycle diagnostics
- Linux tray/status item: Linux tray/status item behavior, status, and operator-visible verification.
- Runtime status row: Runtime status row and native notifications
- Desktop-environment integration: Desktop-environment integration for GNOME/KDE/Wayland/X11 tray behavior

Primary docs:

- `docs/platforms/linux.md`
- `docs/start/openclaw.md`
- `docs/gateway/doctor.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/linux-companion-app/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/linux-companion-app`.
