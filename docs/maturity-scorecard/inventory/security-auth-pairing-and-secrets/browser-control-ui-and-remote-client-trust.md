---
title: "Security, auth, pairing, and secrets - Browser Control UI and Remote Client Trust Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Security, auth, pairing, and secrets - Browser Control UI and Remote Client Trust Maturity Note

## Summary

Control UI and browser-control trust have strong architectural guardrails: WebSocket auth, origin checks, device pairing, session-token storage, authenticated runtime config, browser-control route auth, and security-audit checks for risky toggles. Coverage is Stable because the Gateway and browser extension have targeted server-flow tests for browser auth, origins, Control UI pairing, and fail-closed browser-control routes. Quality is Alpha because Discord and GitHub history show repeated high-impact issues and persistent operator confusion around reverse proxies, Tailscale Serve, insecure toggles, stale browser identity, and token storage.

## Category Scope

This category covers Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, runtime config endpoint auth, browser-control HTTP route auth, browser storage risks, and remote/proxy operator repair paths.

## Features

- Browser Control UI: Covers Browser Control UI across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.
- Remote Client Trust: Covers Remote Client Trust across Control UI/WebChat browser trust, device pairing for browser clients, allowed origins, Tailscale/trusted-proxy behavior for browser sessions, and related browser control ui and remote client trust behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Control UI docs and browser-control docs describe auth and pairing behavior; server-flow tests cover browser hardening, Control UI auth, origin allowlists, default token behavior, Tailscale/trusted-proxy modes, and browser-control auth fail-closed paths.
- Negative signals: Real reverse-proxy/Tailscale Serve/mobile-browser topology proof is still thinner than local server-flow tests, and service-worker/stale-identity upgrade behavior remains operationally tricky.
- Integration gaps: Add release smoke for Control UI over localhost, HTTPS reverse proxy, Tailscale Serve, fresh browser profile, stale browser identity, and browser-control routes under token, password, trusted-proxy, and none/private-ingress modes.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: The exact issue query returned open #46919, `Token URL Disabled Via Config`. The related PR query returned open #73163 for insecure Control UI access warnings, plus other active browser/UI PRs adjacent to service-worker and tools surfaces.
- Discrawl reports: Discord search found PR #64165 about reusable device-auth secrets in browser storage, PR #43613 review about Tailscale-authenticated Control UI operator sessions, and repeated support cases for `pairing required`, `allowInsecureAuth`, allowed origins, stale localStorage gateway URLs, reverse proxy headers, and token storage.
- Good qualities: Browser-origin policy, device identity, paired device state, runtime config auth, and browser-control shared-secret auth are explicitly implemented and documented.
- Bad qualities: Browser trust is a high-risk UX boundary; support evidence shows users frequently rely on dangerous toggles or stale browser state while debugging, and the browser storage issue was high severity.
- Excluded from quality: Coverage breadth, unit-test breadth, and integration-test depth are scored only under Coverage.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/security-auth-pairing-and-secrets.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Browser Control UI, Remote Client Trust.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Control UI reverse-proxy and Tailscale setup remains hard to diagnose without gateway logs and browser DevTools details.
- Browser-local identity and token storage have had serious hardening churn.
- The browser-control API intentionally does not inherit trusted-proxy/Tailscale identity modes, which is safer but easy to misunderstand.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents browser WebSocket auth, device pairing, Tailscale Serve skip conditions, token storage, runtime config auth, allowed origins, and PWA/service-worker behavior.
- `/Users/kevinlin/code/openclaw/docs/tools/browser-control.md` documents browser-control HTTP routes, auth requirements, and loopback-only caveats for `auth.mode=none` and trusted-proxy.
- `/Users/kevinlin/code/openclaw/docs/gateway/trusted-proxy-auth.md` and `/Users/kevinlin/code/openclaw/docs/gateway/tailscale.md` document identity-bearing proxy paths.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/audit-checks.md` documents Control UI origin, insecure-auth, device-auth disabled, and browser-control auth audit checks.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/auth.ts` authorizes token/password/trusted-proxy/Tailscale auth and browser-origin policy.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/message-handler.ts` enforces WebSocket handshake auth, device identity, scopes, and Control UI connection behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/origin-check.ts` handles origin policy.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server.ts` and `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/control-auth.ts` implement browser-control HTTP auth behavior.
- `/Users/kevinlin/code/openclaw/ui/src` contains the Control UI browser client.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.browser-hardening.test.ts` covers browser origin and hardening behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.suite.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.test.ts` cover Control UI auth behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.modes.suite.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.auth.default-token.suite.ts` cover auth modes and default-token server behavior.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server.auth-fail-closed.test.ts` and `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/server.auth-token-gates-http.test.ts` cover browser-control route auth.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/auth.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/auth-surface-resolution.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/connection-auth.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/http-utils.authorize-request.test.ts` cover lower-level auth helpers.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/auth-context.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/handshake-auth-helpers.test.ts` cover WS auth state helpers.
- `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/control-auth.test.ts`, `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/control-auth.auto-token.test.ts`, and `/Users/kevinlin/code/openclaw/extensions/browser/src/browser/routes/permissions.test.ts` cover browser-control auth and permission routes.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "browser control auth control ui device pairing origin"`

Results:

- Returned open issue #46919, `[Feature]: Token URL Disabled Via Config`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "gateway auth trusted proxy browser control auth"`

Results:

- Returned open PRs including #73163 `fix(gateway): warn for insecure Control UI access`, #87077 `fix(ui): bypass service worker for top-level navigations`, #63919 `feat(gateway): wire coding tools into /tools/invoke HTTP surface`, and #84247 `Feat/browser screenshot vision`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "browser control auth control ui device pairing origin"`

Results:

- Found PR #43613 review clarifying that Tailscale-authenticated Control UI operator sessions may skip a pairing round trip only when device identity remains intact.
- Found PR #64165 describing high-severity reusable device-auth secrets in browser storage.
- Found multiple support cases for `pairing required`, `allowInsecureAuth`, trusted proxy/origin setup, stale localStorage gateway URLs, and token storage behavior.
