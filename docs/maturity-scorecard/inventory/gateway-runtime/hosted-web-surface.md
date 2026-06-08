---
title: Gateway Runtime - Hosted Web Surface Maturity Note
version: 3
last_refreshed: 2026-05-29
last_refreshed_by: codex
feature_family: Hosted Web Surface
feature_slug: hosted-web-surface
---

# Hosted Web Surface

## Summary

OpenClaw hosts browser-facing surfaces through the Gateway HTTP server,
including Control UI assets/config/media routes, WebChat behavior, plugin web
routes, and Canvas/A2UI browser routes. Coverage remains strong because the
archived evidence includes Control UI media e2e coverage, plugin route
precedence coverage, WebChat-mode Gateway tests, and Canvas route registration
tests. Quality remains Beta because historical and open reports still cover
Control UI packaging, plugin route precedence/auth, Canvas/A2UI Gateway-flow
coverage, and stale WebChat documentation.

Scores:

- Coverage: `88` - `Stable`
- Quality: `74` - `Beta`
- Completeness: `72` - `Beta`

## Features

- Control UI: Control UI hosting on the Gateway server.
- WebChat hosting: WebChat hosting.
- Plugin web routes: Canvas and other plugin HTTP surfaces served by the Gateway.
- Canvas and A2UI routes: Canvas documents, A2UI transport, and browser-hosted plugin routes under the Gateway HTTP server.

## Coverage

Score: `88`

Positive signals:

- Gateway docs describe a multiplexed port that serves plugin HTTP routes and Control UI alongside the Gateway protocol.
- Control UI docs describe Gateway-hosted runtime config and same-port WebSocket behavior.
- Source orders plugin routes before the Control UI catch-all so plugin web surfaces stay reachable.
- Tests cover Control UI media routes, WebChat Gateway mode, plugin-route precedence, and Canvas route registration.

Negative signals:

- Canvas/A2UI host coverage is stronger at plugin registration and local host layers than at a full Gateway plugin-route/auth/node-capability scenario.
- WebChat documentation is split between older static-hosting language and current native/Control UI chat descriptions.

## Quality

Score: `74`

Good qualities:

- Route ownership is explicit: built-in HTTP routes precede plugin routes, and plugin routes precede Control UI catch-all routing.
- Plugin HTTP routes have Gateway-auth fail-closed behavior and scoped method dispatch.
- Control UI has dedicated runtime config, assistant media, avatar, and static file serving paths.

Bad qualities:

- Archive history includes Control UI packaging and 404 issues.
- Plugin web route auth, precedence, and scope boundaries have had repeated reports.
- Canvas/A2UI browser-route maturity needs a Gateway-level scenario proof.

## Completeness

Score: `72`

Positive signals:

- The category captures browser-hosted surfaces separately from callable HTTP APIs, which makes Control UI, WebChat, plugin web routes, and Canvas/A2UI easier to score independently.

Missing capability branches:

- Gateway-level Canvas/A2UI plugin-route test covering auth and node-capability URL behavior.
- Updated WebChat documentation that clearly states whether WebChat is hosted static UI, Control UI chat, native chat, or a combination.
- One co-hosted web-surface scenario proving Control UI and plugin web routes coexist on a root-mounted Gateway.

## Evidence

- Docs: `docs/gateway/index.md`, `docs/concepts/architecture.md`, `docs/web/control-ui.md`, `docs/web/webchat.md`, `docs/refactor/canvas.md`.
- Source: `src/gateway/server-http.ts`, `src/gateway/control-ui.ts`, `src/gateway/server/plugins-http.ts`, `src/gateway/server-runtime-state.ts`, `src/plugins/registry.ts`, `src/plugin-sdk/gateway-method-runtime.ts`, `extensions/canvas/index.ts`.
- Tests: `src/gateway/control-ui-assistant-media.e2e.test.ts`, `src/gateway/server.chat.gateway-server-chat.test.ts`, `src/gateway/server.plugin-http-auth.test.ts`, `src/gateway/server/plugins-http.test.ts`, `extensions/canvas/index.test.ts`, `extensions/canvas/src/host/server.test.ts`.
- Archive queries: Control UI Gateway issues, plugin HTTP route Gateway issues, WebChat Gateway issues, and Canvas/A2UI route evidence from the archived score run.
