---
title: "Gateway Web App Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (79%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (79%)`
- LTS Features: `0/6`

## Summary

This report promotes the archived `browser-control-ui-and-webchat` maturity evidence from `/Users/kevinlin/tmp/maturity/browser-control-ui-and-webchat` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                          | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Browser Realtime Talk](browser-realtime-talk-controls-and-voice-transports.md)   | ❌  | `Beta (78%)`   | `Beta (70%)`  | `Beta (78%)`   | Browser Talk start/stop, Provider session selection, Gateway relay audio, Tool-call consults, Steer and cancel                                                                                                                                                                                                                               |
| [Browser Access and Trust](gateway-connection-auth-device-pairing-and-origins.md) | ❌  | `Stable (84%)` | `Alpha (68%)` | `Stable (84%)` | Device pairing, Token/password auth, Tailscale Serve auth, Trusted proxy auth, Allowed origins/gatewayUrl                                                                                                                                                                                                                                    |
| [Configuration](config-schema-editing-and-safe-writes.md)                         | ❌  | `Stable (82%)` | `Beta (78%)`  | `Stable (82%)` | Config snapshots, Schema form editing, Raw JSON editing, Base-hash guarded writes, Apply and restart                                                                                                                                                                                                                                         |
| [Browser UI](control-ui-static-shell-routing-and-pwa.md)                          | ❌  | `Beta (74%)`   | `Beta (72%)`  | `Beta (74%)`   | Gateway-hosted UI, Dashboard open/auth bootstrap, Base-path routing, Static asset recovery, Dev gatewayUrl target, PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications                                                                                                                       |
| [WebChat Conversations](chat-composer-session-model-controls-and-rendering.md)    | ❌  | `Beta (78%)`   | `Alpha (66%)` | `Beta (78%)`   | Send and abort, Session and agent picker, Model/thinking controls, Attachments, Markdown/tool/media rendering, chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity, Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy |
| [Operator Console](diagnostics-logs-update-and-activity.md)                       | ❌  | `Beta (78%)`   | `Beta (74%)`  | `Beta (78%)`   | Health/status/models, Live log tail, Update run/status, Activity summaries, RPC timing telemetry, Channels/login, Session manager and history, Cron, Skills/nodes, Exec approvals/agents                                                                                                                                                     |

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

### 1. Browser Realtime Talk

Search anchors: Browser Talk start/stop, Provider session selection, Gateway relay audio, Tool-call consults, Steer and cancel, What it can do (today), Chat behavior, PWA install and web push.

Category note: [Browser Realtime Talk](browser-realtime-talk-controls-and-voice-transports.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Browser Talk start/stop: Covers Browser Talk start/stop across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Provider session selection: Covers Provider session selection across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Gateway relay audio: Covers Gateway relay audio across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Tool-call consults: Covers Tool-call consults across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.
- Steer and cancel: Covers Steer and cancel across browser Talk controls, Talk options, OpenAI browser WebRTC, Google Live/provider WebSocket, and related browser realtime talk behavior.

Primary docs:

- `docs/web/control-ui.md`
- `docs/gateway/protocol.md`
- `docs/nodes/talk.md`

### 2. Browser Access and Trust

Search anchors: Device pairing, Token/password auth, Tailscale Serve auth, Trusted proxy auth, Allowed origins/gatewayUrl, What it can do (today), Chat behavior, PWA install and web push.

Category note: [Browser Access and Trust](gateway-connection-auth-device-pairing-and-origins.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Alpha (68%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- Device pairing: Covers Device pairing across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Token/password auth: Covers Token/password auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Tailscale Serve auth: Covers Tailscale Serve auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Trusted proxy auth: Covers Trusted proxy auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Allowed origins/gatewayUrl: Covers Allowed origins/gatewayUrl across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.

Primary docs:

- `docs/web/control-ui.md`
- `docs/web/dashboard.md`
- `docs/gateway/tailscale.md`
- `docs/gateway/remote.md`

### 3. Configuration

Search anchors: Config snapshots, Schema form editing, Raw JSON editing, Base-hash guarded writes, Apply and restart, What it can do (today), Chat behavior, PWA install and web push.

Category note: [Configuration](config-schema-editing-and-safe-writes.md)

Score decisions:

- Coverage: `Stable (82%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (82%)`
- LTS: ❌

Features:

- Config snapshots: Covers Config snapshots across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Schema form editing: Covers Schema form editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Raw JSON editing: Covers Raw JSON editing across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Base-hash guarded writes: Covers Base-hash guarded writes across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.
- Apply and restart: Covers Apply and restart across `config.get`, `config.set`, `config.apply`, `config.patch`, and related config schema editing and safe writes behavior.

Primary docs:

- `docs/web/control-ui.md`
- `docs/gateway/configuration.md`

### 4. Browser UI

Search anchors: Gateway-hosted UI, Dashboard open/auth bootstrap, Base-path routing, Static asset recovery, Dev gatewayUrl target, What it can do (today), Chat behavior, PWA install and web push, PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications.

Category note: [Browser UI](control-ui-static-shell-routing-and-pwa.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Gateway-hosted UI: Covers Gateway-hosted UI across serving the Control UI bundle from the Gateway, root and base-path routing, static asset MIME/cache behavior, public PWA assets, and related control ui shell and routing behavior.
- Dashboard open/auth bootstrap: Covers Dashboard open/auth bootstrap across serving the Control UI bundle from the Gateway, root and base-path routing, static asset MIME/cache behavior, public PWA assets, and related control ui shell and routing behavior.
- Base-path routing: Covers Base-path routing across serving the Control UI bundle from the Gateway, root and base-path routing, static asset MIME/cache behavior, public PWA assets, and related control ui shell and routing behavior.
- Static asset recovery: Covers Static asset recovery across serving the Control UI bundle from the Gateway, root and base-path routing, static asset MIME/cache behavior, public PWA assets, and related control ui shell and routing behavior.
- Dev gatewayUrl target: Covers Dev gatewayUrl target across serving the Control UI bundle from the Gateway, root and base-path routing, static asset MIME/cache behavior, public PWA assets, and related control ui shell and routing behavior.
- PWA install metadata: Covers PWA install metadata across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Service worker updates: Covers Service worker updates across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- VAPID keys: Covers VAPID keys across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Subscribe/unsubscribe: Covers Subscribe/unsubscribe across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Test notifications: Covers Test notifications across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.

Primary docs:

- `docs/web/control-ui.md`
- `docs/web/index.md`
- `docs/web/dashboard.md`
- `docs/gateway/protocol.md`

### 5. WebChat Conversations

Search anchors: Send and abort, Session and agent picker, Model/thinking controls, Attachments, Markdown/tool/media rendering, What it can do (today), Chat behavior, PWA install and web push, chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity, Hosted embeds, External embed gating, Assistant media tickets, Authenticated avatars, CSP image policy.

Category note: [WebChat Conversations](chat-composer-session-model-controls-and-rendering.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Alpha (66%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Send and abort: Covers Send and abort across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Session and agent picker: Covers Session and agent picker across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Model/thinking controls: Covers Model/thinking controls across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Attachments: Covers Attachments across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- Markdown/tool/media rendering: Covers Markdown/tool/media rendering across browser chat composition and display UX after an authenticated Gateway connection exists: composer controls, slash commands, session and agent filtering, model/thinking overrides, and related chat composer and message rendering behavior.
- chat.history projection: Covers chat.history projection across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- chat.send lifecycle: Covers chat.send lifecycle across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Abort/partial retention: Covers Abort/partial retention across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Injected assistant notes: Covers Injected assistant notes across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Reconnect continuity: Covers Reconnect continuity across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Hosted embeds: Covers Hosted embeds across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- External embed gating: Covers External embed gating across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Assistant media tickets: Covers Assistant media tickets across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- Authenticated avatars: Covers Authenticated avatars across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.
- CSP image policy: Covers CSP image policy across `[embed ...]` rendering policy, `gateway.controlUi.embedSandbox`, external embed URL gating, CSP and frame denial, and related hosted media and embed safety behavior.

Primary docs:

- `docs/web/control-ui.md`
- `docs/web/webchat.md`
- `docs/start/getting-started.md`
- `docs/channels/channel-routing.md`
- `docs/gateway/security/secure-file-operations.md`

### 6. Operator Console

Search anchors: Health/status/models, Live log tail, Update run/status, Activity summaries, RPC timing telemetry, What it can do (today), Chat behavior, PWA install and web push, Channels/login, session manager, session history, Cron, Skills/nodes, Exec approvals/agents.

Category note: [Operator Console](diagnostics-logs-update-and-activity.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (74%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Health/status/models: Covers Health/status/models across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Live log tail: Covers Live log tail across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Update run/status: Covers Update run/status across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Activity summaries: Covers Activity summaries across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- RPC timing telemetry: Covers RPC timing telemetry across Debug, Logs, Update, Activity, and related diagnostics, logs, update, and activity behavior.
- Channels/login: Covers Channels/login across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Session manager and history: Covers browser Control UI session manager, session history, instance presence, approvals, diagnostics, and log tabs.
- Cron: Covers Cron across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Skills/nodes: Covers Skills/nodes across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.
- Exec approvals/agents: Covers Exec approvals/agents across non-config operator panels in the browser Control UI: channels and login, instances/presence, sessions, cron jobs, skills, nodes, exec approvals, agents, usage, dreams, and the dashboard navigation that surfaces them.

Primary docs:

- `docs/web/control-ui.md`
- `docs/gateway/health.md`
- `docs/gateway/protocol.md`
- `docs/web/dashboard.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/browser-control-ui-and-webchat/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/browser-control-ui-and-webchat`.
