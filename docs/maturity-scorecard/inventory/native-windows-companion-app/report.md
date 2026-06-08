---
title: "Native Windows companion app Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Experimental (5%)`
- Quality: `Experimental (30%)`
- Completeness: `Experimental (5%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `native-windows-companion-app` maturity evidence from `/Users/kevinlin/tmp/maturity/native-windows-companion-app` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                    | LTS | Coverage            | Quality              | Completeness        | Features to evaluate                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --- | ------------------- | -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Installation and Updates](packaging-install-update-desktop-integration.md) | ❌  | `Experimental (5%)` | `Experimental (25%)` | `Experimental (5%)` | Official app download, MSI/MSIX/App Installer/winget-style packaging, Windows architecture handling for x64, App release channel                                                                                    |
| [Gateway Connection](gateway-connection-pairing-local-remote.md)            | ❌  | `Experimental (8%)` | `Experimental (35%)` | `Experimental (8%)` | App-managed local Gateway attach/start, Remote Gateway connection modes, Device/node pairing                                                                                                                        |
| [Chat Sessions](native-chat-session-controls.md)                            | ❌  | `Experimental (0%)` | `Experimental (25%)` | `Experimental (0%)` | Native Windows chat window, Gateway chat transport                                                                                                                                                                  |
| [Status and Repair](diagnostics-health-operator-repair.md)                  | ❌  | `Experimental (5%)` | `Experimental (35%)` | `Experimental (5%)` | App health states, App-specific repair, Windows system tray app, Status indicators, App-specific notification permission                                                                                            |
| [Desktop Tools and Permissions](node-host-capabilities-exec-approvals.md)   | ❌  | `Experimental (5%)` | `Experimental (28%)` | `Experimental (5%)` | Windows node identity, Host command execution, Desktop command policy, App approval prompts, Screen and media capture, Canvas host behavior, Windows shell integrations, App secrets, Windows ACL, Command approval |

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

### 1. Installation and Updates

Search anchors: Native Windows companion apps are planned, Windows companion app, App Installer, winget.

Category note: [Installation and Updates](packaging-install-update-desktop-integration.md)

Score decisions:

- Coverage: `Experimental (5%)`
- Quality: `Experimental (25%)`
- Completeness: `Experimental (5%)`
- LTS: ❌

Features:

- Official app download: Official app download or installer path for the native Windows companion app.
- MSI/MSIX/App Installer/winget-style packaging: MSI/MSIX/App Installer/winget-style packaging, signing, update, rollback, uninstall, and desktop entries
- Windows architecture handling for x64: Windows architecture handling for x64 and ARM64
- App release channel: App release channel, architecture handling, and update availability.

Primary docs:

- `docs/platforms/windows.md`
- `docs/install/index.md`

### 2. Gateway Connection

Search anchors: Windows companion app, local Gateway, remote Gateway, pairing.

Category note: [Gateway Connection](gateway-connection-pairing-local-remote.md)

Score decisions:

- Coverage: `Experimental (8%)`
- Quality: `Experimental (35%)`
- Completeness: `Experimental (8%)`
- LTS: ❌

Features:

- App-managed local Gateway attach/start: App-managed local Gateway attach/start and status
- Remote Gateway connection modes: Remote Gateway connection modes, token/TLS handling, and reconnect
- Device/node pairing: Device/node pairing, pending approval UX, and pairing recovery

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/index.md`
- `docs/gateway/pairing.md`
- `docs/gateway/remote.md`

### 3. Chat Sessions

Search anchors: WebChat, Gateway WebSocket, Windows companion app.

Category note: [Chat Sessions](native-chat-session-controls.md)

Score decisions:

- Coverage: `Experimental (0%)`
- Quality: `Experimental (25%)`
- Completeness: `Experimental (0%)`
- LTS: ❌

Features:

- Native Windows chat window: Native Windows chat window, transcript, composer, session picker, model/thinking controls, abort/follow-up actions, reconnect handling, and tool rendering
- Gateway chat transport: Gateway chat transport and session control from the native Windows app.

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/protocol.md`

### 4. Status and Repair

Search anchors: Windows companion app, Gateway status, doctor repair, system tray, native notifications.

Category note: [Status and Repair](diagnostics-health-operator-repair.md)

Score decisions:

- Coverage: `Experimental (5%)`
- Quality: `Experimental (35%)`
- Completeness: `Experimental (5%)`
- LTS: ❌

Features:

- App health states: App health states, Gateway/node readiness, diagnostic panels, log opening, update status, repair actions, and support bundle behavior
- App-specific repair: App-specific repair for pairing, permissions, service lifecycle, stale versions, and protocol mismatch
- Windows system tray app: Windows system tray app, status icon, status menu, native notifications, and app launch/quit controls
- Status indicators: Status indicators for Gateway, node pairing, work activity, and updates
- App-specific notification permission: App-specific notification permission and failure handling

Primary docs:

- `docs/platforms/windows.md`
- `docs/gateway/doctor.md`
- `docs/gateway/index.md`

### 5. Desktop Tools and Permissions

Search anchors: node host, system.run, Exec approvals, screen capture, Windows ACL, app secrets.

Category note: [Desktop Tools and Permissions](node-host-capabilities-exec-approvals.md)

Score decisions:

- Coverage: `Experimental (5%)`
- Quality: `Experimental (28%)`
- Completeness: `Experimental (5%)`
- LTS: ❌

Features:

- Windows node identity: Windows node identity and capability advertisement.
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop command policy: Desktop command allow/deny policy for native Windows tools.
- App approval prompts: App UI prompts for approval-sensitive desktop commands.
- Screen and media capture: Screen snapshot, recording, and native media capture affordances.
- Canvas host behavior: Canvas and A2UI host behavior in a native Windows companion app.
- Windows shell integrations: Windows shell and PowerToys-style desktop integrations.
- App secrets: App secrets, token persistence, secure local IPC, app signing identity, AppContainer or desktop permission posture
- Windows ACL: Windows ACL and filesystem hygiene for app-owned state
- Command approval: Command approval and dangerous capability gating as surfaced to users

Primary docs:

- `docs/platforms/windows.md`
- `docs/nodes/index.md`
- `docs/tools/exec.md`
- `docs/tools/exec-approvals.md`
- `docs/gateway/security/index.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/native-windows-companion-app/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/native-windows-companion-app`.
