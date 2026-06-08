---
title: "Linux Gateway host - Remote Access and Security Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Remote Access and Security Maturity Note

## Summary

Remote Linux Gateway access has strong safety defaults: loopback bind, explicit auth for non-loopback access, SSH tunnel guidance, Tailscale Serve/Tailnet modes, public WebSocket TLS requirements, allowed-origin guidance, and rollback runbooks. Coverage is beta because the surface spans several exposure modes and active support evidence still shows confusion around Tailscale auth, Control UI behavior, and TLS on raw VPS/IP access.

## Category Scope

Included in this category:

- Remote Network Exposure: Defines Remote Network Exposure authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- TLS: Defines TLS authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Tailscale: Defines Tailscale authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Gateway exposure safeguards: Defines exposure checks, unsafe-network warnings, and operator controls for Linux Gateway security boundaries.
- Gateway authentication modes: Defines token/password auth, shared-secret resolution, and operator verification for Linux Gateway authentication.
- Secret Handling: Defines Secret Handling setup, credential, configuration, and operator verification behavior for Security, Auth, and Secret Handling.

## Features

- Remote Network Exposure: Defines Remote Network Exposure authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- TLS: Defines TLS authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Tailscale: Defines Tailscale authorization, trust, safety boundaries, and operator controls for Remote Network Exposure, Tls, and Tailscale.
- Gateway exposure safeguards: Defines exposure checks, unsafe-network warnings, and operator controls for Linux Gateway security boundaries.
- Gateway authentication modes: Defines token/password auth, shared-secret resolution, and operator verification for Linux Gateway authentication.
- Secret Handling: Defines Secret Handling setup, credential, configuration, and operator verification behavior for Security, Auth, and Secret Handling.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Rationale: the safety model is documented and implemented, but the operator surface includes several deployment choices and identity layers that are not yet packaged into one simple Linux remote-access decision flow.
- Gaps: Control UI behavior through Tailscale/VPS access and TLS rules for raw public endpoints remain spread across runbooks and support discussion.

## Quality Score

- Score: `Beta (74%)`
- Rationale: shipped safeguards are strong, but archive evidence shows active user and maintainer work around Tailscale auth, warnings, and remote UI access.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Remote Network Exposure, TLS, Tailscale, Gateway exposure safeguards, Gateway authentication modes, Secret Handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a single Linux remote-access chooser covering SSH tunnel, Tailscale Serve, direct tailnet bind, LAN bind, and public TLS.
- Make Control UI behavior and auth expectations clearer for Tailscale/VPS operators.

## Evidence

### Docs

- `docs/gateway/remote.md:8-17` defines remote Gateway access and loopback-first exposure through Tailscale, LAN, or SSH.
- `docs/gateway/remote.md:67-86` documents SSH tunnel use and explicit token/password flags.
- `docs/gateway/remote.md:125-142` documents credential precedence for local and remote access.
- `docs/gateway/remote.md:157-177` documents loopback default, private `ws://`, public `wss://`, non-loopback auth, SecretRef fail-closed behavior, TLS fingerprints, and Tailscale Serve details.
- `docs/gateway/tailscale.md:9-21` documents Serve and Funnel modes while keeping Gateway bound to loopback.
- `docs/gateway/security/exposure-runbook.md:52-110` documents baseline checks and minimum safe config.

### Source

- `src/gateway/net.ts:262-317` resolves loopback, tailnet, LAN, custom, and container-aware bind hosts.
- `src/gateway/net.ts:319-338` keeps Tailscale Serve on loopback and defaults container mode separately.
- `src/gateway/server-tailscale.ts:19-55` starts Serve/Funnel and logs served URLs or failures.
- `src/shared/gateway-bind-url.ts:13-47` resolves bind URLs for custom, tailnet, and LAN modes.
- `src/gateway/auth-resolve.ts:31-105` resolves Gateway auth mode, token/password inputs, and Tailscale auth behavior.
- `src/security/audit-gateway-exposure.test.ts:39-187` records exposure-audit expectations for dangerous flags, non-loopback bindings, wildcard origins, and host-header fallback.

### Integration tests

- `src/config/config.gateway-tailscale-bind.test.ts` covers Tailscale bind configuration.
- `src/gateway/server-tailscale.test.ts` covers Serve/Funnel process behavior.
- `src/security/audit-gateway-exposure.test.ts` covers exposure risk cases that matter for Linux remote hosts.

### Unit tests

- `src/shared/gateway-bind-url.test.ts` covers remote bind URL resolution.
- `src/shared/tailscale-status.test.ts` covers Tailscale status parsing.
- `src/security/audit-gateway-http-auth.test.ts` and `src/security/audit-gateway-auth-selection.test.ts` cover auth selection and HTTP exposure audit behavior.

### Gitcrawl queries

- Specific query `gateway bind tailnet Tailscale TLS allowed origins remote access Linux` returned no hits.
- Broader query `tailnet Tailscale` returned issue #57110 for optional secondary auth in Tailscale Serve mode, issue #85750 for Control UI avatar 401 through Tailscale, PR #73163 for insecure Control UI access warnings, issue #56118 for remote node on VPS/tailnet browser proxy trouble, and PR #81306 for keeping explicit loopback bind pinned.

### Discrawl queries

- Query `Tailscale tailnet OpenClaw gateway` found Tailscale status issue #71123 and PR #71354, plus operator guidance such as `sudo tailscale set --operator=$USER`, `openclaw gateway restart`, `tailscale serve status`, and `sudo tailscale serve --bg --yes 18789`.
- Query `gateway run port` found support advice that public iOS/VPS access needs `wss://` rather than raw insecure WebSocket access.
