---
title: "macOS companion app Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (71%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (71%)`
- LTS Features: `0/8`

## Summary

This report promotes the archived `macos-companion-app` maturity evidence from `/Users/kevinlin/tmp/maturity/macos-companion-app` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                      | LTS | Coverage      | Quality       | Completeness  | Features to evaluate                                                                                                                                                                                                               |
| ------------------------------------------------------------- | --- | ------------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Canvas](canvas-a2ui.md)                                      | ❌  | `Beta (74%)`  | `Alpha (66%)` | `Beta (74%)`  | Canvas panel open/hide/navigate/eval/snapshot, Local custom URL scheme, A2UI host auto-navigation, Canvas enable/disable setting                                                                                                   |
| [Local Setup](onboarding-cli-workspace.md)                    | ❌  | `Beta (72%)`  | `Alpha (65%)` | `Beta (72%)`  | Local mode Gateway attach/start/stop, LaunchAgent install/update/restart/uninstall, Existing-listener detection, Native first-run onboarding flow, CLI discovery, Local workspace selection, Onboarding WebChat session separation |
| [Status and Settings](settings-health-diagnostics.md)         | ❌  | `Beta (70%)`  | `Beta (72%)`  | `Beta (70%)`  | Menu-bar status, Activity state ingestion, Settings navigation, Health polling, Channels settings                                                                                                                                  |
| [Native Capabilities](node-mode-system-run-exec-host.md)      | ❌  | `Alpha (64%)` | `Alpha (60%)` | `Alpha (64%)` | Mac node session connection, system.run, Exec approval policy, Permission requests, TCC persistence                                                                                                                                |
| [Remote Connections](remote-mode-discovery-tunnels.md)        | ❌  | `Beta (72%)`  | `Alpha (68%)` | `Beta (72%)`  | Remote connection mode selection, SSH tunnel, Gateway discovery                                                                                                                                                                    |
| [Voice and Talk](voice-wake-talk.md)                          | ❌  | `Beta (70%)`  | `Alpha (63%)` | `Beta (70%)`  | Voice Wake runtime, Push-to-talk, Talk provider playback plan                                                                                                                                                                      |
| [WebChat](webchat-sessions.md)                                | ❌  | `Beta (72%)`  | `Alpha (62%)` | `Beta (72%)`  | Native SwiftUI WebChat window, Gateway chat transport, Local and remote data-plane reuse                                                                                                                                           |
| [Remote WebChat](native-webchat-and-remote-client-bridges.md) | ❌  | `Beta (74%)`  | `Beta (76%)`  | `Beta (74%)`  | macOS WebChat transport, SSH tunnel data plane, Direct ws/wss remote mode, Session continuity, Remote troubleshooting                                                                                                              |

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

### 1. Canvas

Search anchors: macos companion app canvas and a2ui, canvas and a2ui.

Category note: [Canvas](canvas-a2ui.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Canvas panel open/hide/navigate/eval/snapshot: Canvas panel open/hide/navigate/eval/snapshot behavior, status, and operator-visible verification.
- Local custom URL scheme: Local custom URL scheme and session-root file serving
- A2UI host auto-navigation: A2UI host auto-navigation, push/reset, and action bridge
- Canvas enable/disable setting: Canvas enable/disable setting and node command behavior

Primary docs:

- `docs/platforms/mac/canvas.md`
- `docs/platforms/macos.md`
- `docs/web/webchat.md`

### 2. Local Setup

Search anchors: macos companion app local gateway and launchagent, local gateway and launchagent, macos companion app onboarding, cli install, and workspace setup, onboarding, cli install, and workspace setup.

Category note: [Local Setup](onboarding-cli-workspace.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (65%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Local mode Gateway attach/start/stop: Local mode Gateway attach/start/stop behavior, status, and operator-visible verification.
- LaunchAgent install/update/restart/uninstall: LaunchAgent install/update/restart/uninstall through app-managed CLI calls
- Existing-listener detection: Existing-listener detection, port guarding, and launchd log path
- Native first-run onboarding flow: Native first-run onboarding flow and completion marker
- CLI discovery: CLI discovery and "Install CLI" prompt/install path
- Local workspace selection: Local workspace selection and Gateway wizard startup
- Onboarding WebChat session separation: Onboarding WebChat session separation behavior, status, and operator-visible verification.

Primary docs:

- `docs/platforms/mac/bundled-gateway.md`
- `docs/platforms/macos.md`
- `docs/platforms/mac/child-process.md`
- `docs/platforms/mac/dev-setup.md`

### 3. Status and Settings

Search anchors: macos companion app menu status and dashboard, menu status and dashboard, macos companion app settings, health, channels, and diagnostics, settings, health, channels, and diagnostics.

Category note: [Status and Settings](settings-health-diagnostics.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Menu-bar status: Menu-bar status, action menu, status icon state, dock menu, dashboard/chat/canvas/talk shortcuts
- Activity state ingestion: Activity state ingestion and status row behavior
- Settings navigation: Settings navigation and tabs
- Health polling: Health polling, channel status, logs, debug actions, config/session/instance visibility
- Channels settings: Channels settings and QR/login/probe status surfaced through the app

Primary docs:

- `docs/platforms/mac/menu-bar.md`
- `docs/platforms/mac/icon.md`
- `docs/platforms/macos.md`
- `docs/platforms/mac/health.md`
- `docs/platforms/mac/logging.md`
- `docs/platforms/mac/remote.md`

### 4. Native Capabilities

Search anchors: macos companion app node mode, system.run, and exec host, node mode, system.run, and exec host, macos companion app permissions, privacy, and tcc, permissions, privacy, and tcc.

Category note: [Native Capabilities](node-mode-system-run-exec-host.md)

Score decisions:

- Coverage: `Alpha (64%)`
- Quality: `Alpha (60%)`
- Completeness: `Alpha (64%)`
- LTS: ❌

Features:

- Mac node session connection: Mac node session connection, capability and command advertisement
- system.run: system.run, system.which, system.notify, exec approvals get/set
- Exec approval policy: Exec approval policy, app exec host, local socket, and event emission
- Permission requests: Permission requests, status polling, settings UI, and node permission advertisement
- TCC persistence: TCC persistence, signing requirements, and safe app-owned permission guidance

Primary docs:

- `docs/platforms/macos.md`
- `docs/platforms/mac/xpc.md`
- `docs/platforms/mac/permissions.md`
- `docs/platforms/mac/signing.md`
- `docs/platforms/mac/peekaboo.md`

### 5. Remote Connections

Search anchors: macos companion app remote mode, discovery, and tunnels, remote mode, discovery, and tunnels.

Category note: [Remote Connections](remote-mode-discovery-tunnels.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Remote connection mode selection: Remote connection mode selection and configuration
- SSH tunnel: SSH tunnel and direct ws/wss Gateway transport
- Gateway discovery: Gateway discovery, TLS pin repair, and remote node-service startup

Primary docs:

- `docs/platforms/mac/remote.md`
- `docs/platforms/macos.md`
- `docs/gateway/remote.md`

### 6. Voice and Talk

Search anchors: macos companion app voice wake, push-to-talk, and talk mode, voice wake, push-to-talk, and talk mode.

Category note: [Voice and Talk](voice-wake-talk.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Alpha (63%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Voice Wake runtime: Voice Wake runtime, trigger detection, permissions, overlay, chimes, and forwarding
- Push-to-talk: Push-to-talk and Talk Mode capture/listen/think/speak lifecycle
- Talk provider playback plan: Talk provider playback plan and Gateway talk status

Primary docs:

- `docs/platforms/mac/voicewake.md`
- `docs/platforms/mac/voice-overlay.md`
- `docs/nodes/talk.md`
- `docs/platforms/macos.md`

### 7. WebChat

Search anchors: macos companion app webchat and session ui, webchat and session ui.

Category note: [WebChat](webchat-sessions.md)

Score decisions:

- Coverage: `Beta (72%)`
- Quality: `Alpha (62%)`
- Completeness: `Beta (72%)`
- LTS: ❌

Features:

- Native SwiftUI WebChat window: Native SwiftUI WebChat window and menu panel
- Gateway chat transport: Gateway chat transport, session/model/thinking controls, event mapping, and health
- Local and remote data-plane reuse: Local and remote data-plane reuse across native WebChat sessions.

Primary docs:

- `docs/platforms/mac/webchat.md`
- `docs/platforms/macos.md`
- `docs/web/webchat.md`

### 8. Remote WebChat

Search anchors: macOS WebChat transport, SSH tunnel data plane, Direct ws/wss remote mode, Session continuity, Remote troubleshooting, What it can do (today), Chat behavior.

Category note: [Remote WebChat](native-webchat-and-remote-client-bridges.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- macOS WebChat transport: Covers macOS WebChat transport across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- SSH tunnel data plane: Covers SSH tunnel data plane across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Direct ws/wss remote mode: Covers Direct ws/wss remote mode across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Session continuity: Covers Session continuity across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Remote troubleshooting: Covers Remote troubleshooting across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.

Primary docs:

- `docs/platforms/mac/webchat.md`
- `docs/gateway/remote.md`
- `docs/platforms/mac/remote.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/macos-companion-app/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/macos-companion-app`.
