---
title: "Gateway Web App - Browser UI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Browser UI Maturity Note

## Summary

The browser Control UI shell is a first-class Gateway-served Vite/Lit app with base-path routing, static asset handling, security headers, manifest and service-worker assets, and documented build/open flows. Coverage is Stable because the HTTP serving path and service-worker behavior have targeted server and UI tests. Quality is Beta because the implementation has strong routing and header boundaries, but archive evidence still shows stale service-worker, asset packaging, and browser reload issues as live operator risks.

## Category Scope

Included in this category:

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

## Features

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

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Gateway HTTP tests cover Control UI serving, auto-root behavior, routing, CSP, manifest and service-worker MIME handling, and assistant-media e2e paths; UI tests cover service-worker cache versioning and mocked browser chat flows.
- Negative signals: Coverage is strongest for local server behavior and mocked browser flows. Cross-browser install, mobile PWA install, reverse-proxy reload, and package-installed asset freshness proof are thinner.
- Integration gaps: Add a recurring package-installed browser smoke for localhost, base-path, Tailscale Serve, reverse-proxy auth, service-worker update, and PWA install prompts across at least Chromium plus one non-Chromium browser.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Service-worker and PWA queries found open #87268 for service-worker top-level 401 handling, #85939 for full-page reload data behavior, #55600 for icon asset display, and PR #87077 for top-level navigation bypass.
- Discrawl reports: The exact shell/PWA query returned no rows, but broader Control UI archive traffic includes hosted-control-panel onboarding confusion and release notes around Control UI/chat regressions.
- Good qualities: Routing keeps API and plugin routes outside the SPA catch-all, service-worker cache retention is bounded by build id, the Gateway applies conservative static headers, and docs describe blank-page recovery and protocol mismatch repair.
- Bad qualities: Stale browser state, stale service-worker assets, and packaged asset availability remain recurring operator failure modes, especially after upgrades and hosted/proxy deployments.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway-hosted UI, Dashboard open/auth bootstrap, Base-path routing, Static asset recovery, Dev gatewayUrl target, PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Mobile PWA install and browser-update behavior need explicit release-smoke proof.
- Hosted and reverse-proxy deployments need a stronger stale-service-worker runbook.
- Asset packaging issues still show up in archive history even though the local HTTP server path is well defined.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents the Gateway-served Vite/Lit app, default URL, `gateway.controlUi.basePath`, PWA manifest, service worker, protocol mismatch repair, blank-page recovery, and build commands.
- `/Users/kevinlin/code/openclaw/docs/web/index.md` documents the web surface, bind modes, default-on Control UI config, and static build command.
- `/Users/kevinlin/code/openclaw/docs/web/dashboard.md` documents the dashboard open path and authentication handoff from `openclaw dashboard`.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.ts` serves static assets, public PWA assets, assistant media routes, avatar routes, and Control UI security headers.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-routing.ts` classifies root-mounted and base-path Control UI requests while excluding `/api`, `/plugins`, and probe routes.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-csp.ts` builds the CSP used by served pages.
- `/Users/kevinlin/code/openclaw/ui/public/sw.js` implements install, activate, cache pruning, fetch, push, and notification-click handlers.
- `/Users/kevinlin/code/openclaw/ui/src/main.ts` registers the service worker in production with a build-id query and unregisters stale dev workers.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.http.test.ts` covers HTTP serving, static asset behavior, manifest, and service worker routes.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.auto-root.http.test.ts` covers auto-root serving.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-routing.test.ts` covers routing classification.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui-csp.test.ts` covers CSP header behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-flow.e2e.test.ts` exercises the served UI harness through mocked Gateway chat flows.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/service-worker-cache.test.ts` covers service-worker cache versioning and retained prior-build caches.
- `/Users/kevinlin/code/openclaw/ui/src/ui/mount-fallback.test.ts` covers mount fallback behavior.
- `/Users/kevinlin/code/openclaw/src/infra/control-ui-assets.test.ts` covers asset root resolution.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "service worker Control UI"`

Results:

- Returned open #87268, `Control UI service worker swallows top-level 401 from reverse-proxy auth, suppressing browser native credentials dialog`.
- Returned open #85939, `Control UI: browser (F5) full-page reload re-fetches all API data - slow and state-less`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "service worker Control UI"`

Results:

- Returned open PR #87077, `fix(ui): bypass service worker for top-level navigations`.
- Returned open PR #74715, `fix(ui): show Communication Notifications tab`.

Query: `gitcrawl --json search issues -R openclaw/openclaw "PWA Control UI"`

Results:

- Returned open #55600, `Control UI header logo/icon not displaying after 2026.3.24 update`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI service worker PWA protocol mismatch blank page"`

Results:

- Returned no rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 20 "Control UI"`

Results:

- Found hosted-control-panel support discussion where direct `fly.dev` dashboard access was expected to fail behind hosted auth.
- Found release and maintainer traffic naming Control UI/chat regressions and stale state as beta/release hot spots.
