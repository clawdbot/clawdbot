---
title: "Gateway Web App - Browser Access and Trust Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - Browser Access and Trust Maturity Note

## Summary

Control UI and WebChat browser access have substantial auth and trust machinery: WebSocket shared-secret auth, password auth, Tailscale Serve identity, trusted-proxy auth, browser origin policy, device identity, pairing, scope upgrades, runtime config endpoint auth, and documented insecure-mode caveats. Coverage is Stable because server-flow tests target these paths directly. Quality is Alpha because archive evidence shows repeated operator confusion around pairing, stale browser state, Tailscale/allowed origins, insecure toggles, and browser-side device-token storage.

## Category Scope

Included in this category:

- Device pairing: Covers Device pairing across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Token/password auth: Covers Token/password auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Tailscale Serve auth: Covers Tailscale Serve auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Trusted proxy auth: Covers Trusted proxy auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Allowed origins/gatewayUrl: Covers Allowed origins/gatewayUrl across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.

## Features

- Device pairing: Covers Device pairing across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Token/password auth: Covers Token/password auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Tailscale Serve auth: Covers Tailscale Serve auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Trusted proxy auth: Covers Trusted proxy auth across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.
- Allowed origins/gatewayUrl: Covers Allowed origins/gatewayUrl across Control UI/WebChat Gateway connection setup, browser-origin checks, token/password auth, trusted-proxy and Tailscale Serve auth, and related gateway connection, auth, device pairing, and remote origins behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Gateway auth suites cover Control UI auth modes, browser hardening, origin allowlists, default-token behavior, device pairing, and shared-token rotation; docs cover local, tailnet, Tailscale Serve, trusted-proxy, insecure HTTP, and remote dev-server flows.
- Negative signals: Real browser proof for proxy/Tailscale Serve/mobile browser combinations is thinner than server-flow proof, and stale browser identity behavior is more often covered through regression tests than release-smoke scenarios.
- Integration gaps: Add recurring browser release smokes for fresh profile, stale profile, scope upgrade, Tailscale Serve, trusted proxy, reverse proxy with allowed origins, and remote dev-server `gatewayUrl` bootstrap.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: The auth query returned #46919 for token URL disabling, PR #73163 for insecure Control UI access warnings, and adjacent Control UI/service-worker/security hardening PRs.
- Discrawl reports: Discord search found PR #43613 discussion about Tailscale-authenticated Control UI sessions, PR #64165 about reusable browser device-auth secrets in storage, and support cases for `pairing required`, `allowInsecureAuth`, stale localStorage gateway URLs, allowed origins, token prompts, and Tailscale/trusted-proxy setup.
- Good qualities: The trust model is explicit, scope-gated, and documented. Local loopback, Tailscale Serve, trusted proxy, and shared-secret modes have distinct code paths and security warnings.
- Bad qualities: Browser auth is a high-risk UX boundary. Operators often reach for dangerous toggles or stale browser state repairs before understanding which gate failed.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Device pairing, Token/password auth, Tailscale Serve auth, Trusted proxy auth, Allowed origins/gatewayUrl.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Proxy/Tailscale setup remains difficult to debug without logs and browser DevTools.
- Browser-local identity and device-token storage have had serious hardening churn.
- The difference between Control UI auth, HTTP API auth, browser-control HTTP auth, and node pairing is easy to misunderstand.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents WebSocket auth, device pairing, local auto-approval, Tailscale Serve behavior, runtime config auth, insecure HTTP, allowed origins, `gatewayUrl`, and token-fragment bootstrap.
- `/Users/kevinlin/code/openclaw/docs/web/dashboard.md` documents dashboard auth, token/password storage expectations, unauthorized/1008 repair steps, and `openclaw dashboard`.
- `/Users/kevinlin/code/openclaw/docs/gateway/tailscale.md` documents Serve/Funnel auth, identity-header verification, and browser device-identity requirements.
- `/Users/kevinlin/code/openclaw/docs/gateway/remote.md` documents remote Gateway security rules, SSH tunnels, Tailscale, and WebChat remote access.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/auth.ts` resolves and validates gateway auth modes.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/message-handler.ts` enforces WebSocket handshake auth, device identity, scopes, and Control UI client behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/origin-check.ts` implements browser origin policy.
- `/Users/kevinlin/code/openclaw/src/gateway/device-auth.ts` implements device-auth helpers.
- `/Users/kevinlin/code/openclaw/ui/src/ui/device-auth.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/device-identity.ts` manage browser-side device identity.
- `/Users/kevinlin/code/openclaw/ui/src/ui/control-ui-auth.ts` resolves auth headers for Control UI HTTP fetches.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.browser-hardening.test.ts` covers browser auth and hardening behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.suite.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.test.ts` cover Control UI auth flows.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.modes.suite.ts` covers auth modes, including Tailscale and trusted-proxy behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server.device-pair-approve-supersede.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.device-token-rotate-authz.test.ts` cover pairing and device-token operations.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/auth.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/auth-surface-resolution.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/origin-check.test.ts` cover lower-level auth/origin helpers.
- `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/auth-context.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server/ws-connection/handshake-auth-helpers.test.ts` cover handshake helpers.
- `/Users/kevinlin/code/openclaw/ui/src/ui/connect-error.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/connect-error.node.test.ts` cover client-facing connect error formatting.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "browser control auth control ui device pairing origin"`

Results:

- Returned open #46919, `[Feature]: Token URL Disabled Via Config`.

Query: `gitcrawl --json search prs -R openclaw/openclaw "gateway auth trusted proxy browser control auth"`

Results:

- Returned open PR #73163, `fix(gateway): warn for insecure Control UI access`.
- Returned open PR #87077, `fix(ui): bypass service worker for top-level navigations`.
- Returned adjacent browser/Gateway PRs #63919 and #84247.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "browser control auth control ui device pairing origin"`

Results:

- Found PR #43613 review clarifying that Tailscale-authenticated Control UI operator sessions may skip a pairing round trip only when browser device identity remains intact.
- Found PR #64165 describing high-severity reusable device-auth secrets in browser storage.
- Found support cases for `pairing required`, `allowInsecureAuth`, trusted proxy/origin setup, stale localStorage gateway URLs, and token prompts.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "pairing required allowInsecureAuth Control UI Tailscale Serve localStorage"`

Results:

- Found user support guidance to clear site data, inspect browser WebSocket errors, verify `allowedOrigins`, and avoid `dangerouslyDisableDeviceAuth` outside temporary experiments.
