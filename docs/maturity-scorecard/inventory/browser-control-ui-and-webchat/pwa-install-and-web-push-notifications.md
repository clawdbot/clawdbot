---
title: "Gateway Web App - PWA Install and Web Push Notifications Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - PWA Install and Web Push Notifications Maturity Note

## Summary

The Control UI ships a PWA manifest, production service-worker registration, web push subscription UI calls, VAPID key management, persisted web push subscriptions, and Gateway methods to subscribe, unsubscribe, fetch VAPID public keys, and send test notifications. Coverage is Beta because persistence and server methods have tests, but real browser notification and installed-PWA behavior is less proven. Quality is Beta because the design is explicit and bounded, while archive evidence and current source show this is newer and easy to confuse with native APNS push.

## Category Scope

This category covers browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, VAPID key generation/env overrides, web push subscription storage, `push.web.*` Gateway RPCs, and the Control UI notification controls that call them.

## Features

- PWA install metadata: Covers PWA install metadata across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Service worker updates: Covers Service worker updates across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- VAPID keys: Covers VAPID keys across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Subscribe/unsubscribe: Covers Subscribe/unsubscribe across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.
- Test notifications: Covers Test notifications across browser PWA install metadata, production service-worker registration, push event handling, notification-click behavior, and related pwa install and web push notifications behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Source tests cover VAPID key handling, subscription storage, Gateway push methods, service-worker cache behavior, and public manifest/service-worker serving.
- Negative signals: Real browser push subscriptions require secure contexts and browser/OS permission behavior. Installed-PWA wake behavior and notification click/focus behavior lack broad live scenario proof.
- Integration gaps: Add live browser smoke for subscribe/unsubscribe/test notification on localhost HTTPS or Tailscale Serve, installed PWA focus/open, expired subscription cleanup, and browser permission denial.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Web push queries found PR #73894, `Add Control UI notification controls and web push test fixes`, plus service-worker PR #87077 and PWA/icon issue #55600.
- Discrawl reports: The exact web-push query returned no rows; broader Control UI traffic shows notifications and service-worker behavior are still release-adjacent.
- Good qualities: Web Push is separated from APNS push, VAPID credentials can be env-pinned, subscriptions are endpoint-keyed, push RPCs are operator-write scoped, and the service worker keeps notification payload handling small.
- Bad qualities: Browser push depends on secure context, browser permission UX, installed-PWA behavior, and browser-specific service-worker details that are not yet represented by recurring live proof.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for PWA install metadata, Service worker updates, VAPID keys, Subscribe/unsubscribe, Test notifications.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- The docs do not yet provide a step-by-step operator runbook for browser notification permission failures.
- Installed-PWA behavior needs cross-browser and mobile proof.
- Web Push can be confused with native APNS relay-backed push unless docs and UI keep the boundary obvious.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents the PWA manifest, service worker, VAPID files, VAPID env overrides, `push.web.*` RPCs, and the boundary from iOS APNS relay push.
- `/Users/kevinlin/code/openclaw/docs/gateway/protocol.md` lists `push.web.vapidPublicKey`, `push.web.subscribe`, `push.web.unsubscribe`, and `push.web.test`.

### Source

- `/Users/kevinlin/code/openclaw/ui/public/manifest.webmanifest` is the PWA manifest.
- `/Users/kevinlin/code/openclaw/ui/public/sw.js` implements push and notification-click handlers.
- `/Users/kevinlin/code/openclaw/ui/src/main.ts` registers the production service worker.
- `/Users/kevinlin/code/openclaw/ui/src/ui/push-subscription.ts` requests permission, reads VAPID keys, subscribes, unsubscribes, and sends test pushes.
- `/Users/kevinlin/code/openclaw/src/infra/push-web.ts` manages VAPID keys and subscription persistence.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/push.ts` exposes web push Gateway RPCs.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/push.test.ts` covers Gateway push RPC handling.
- `/Users/kevinlin/code/openclaw/src/gateway/control-ui.http.test.ts` covers manifest and service-worker serving.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/push-web.test.ts` covers VAPID key generation, env overrides, subscription registration/list/remove, and sends.
- `/Users/kevinlin/code/openclaw/ui/src/ui/service-worker-cache.test.ts` covers service-worker cache versioning.
- `/Users/kevinlin/code/openclaw/src/gateway/protocol/push.test.ts` covers protocol schemas for push payloads.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "Control UI web push PWA VAPID notification service worker"`

Results:

- Returned `[]`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "web push"`

Results:

- Returned open PR #73894, `Add Control UI notification controls and web push test fixes`.
- Returned adjacent PRs #73923, #73987, #87077, and #87192.

Query: `gitcrawl --json search issues -R openclaw/openclaw "PWA Control UI"`

Results:

- Returned open #55600, `Control UI header logo/icon not displaying after 2026.3.24 update`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "Control UI web push PWA VAPID notification service worker"`

Results:

- Returned no rows.
