---
title: "Windows via WSL2 - Gateway Access and Exposure Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - Gateway Access and Exposure Maturity Note

## Summary

Auth and secrets are solid at the Gateway layer, but WSL2 exposure makes the operator posture more delicate. The same Gateway token/password, SecretRef, `.env`, remote URL, loopback, SSH tunnel, Tailscale, and security-audit rules apply. The WSL2-specific risk is that the Gateway host is Linux inside a Windows VM, while Control UI, Chrome, node hosts, phone clients, and portproxy/Tailscale entrypoints may live outside that VM.

## Category Scope

Included in this category:

- Gateway token/password auth: Gateway token and password auth for clients running through WSL2.
- Provider credentials: Provider credential storage and lookup from inside the WSL2 environment.
- Gateway auth SecretRefs: Gateway auth SecretRef handling for WSL2-hosted Gateway processes.
- Remote URL credential precedence: Remote URL credential precedence when WSL2 clients connect to local or remote Gateways.
- WSL virtual network: WSL virtual network behavior and host/guest addressing.
- Windows portproxy setup: Windows netsh interface portproxy setup for exposing WSL services.
- Windows Firewall rules: Windows Firewall rules for WSL Gateway access.
- Reachable Gateway URLs: Gateway URLs that must be reachable from Windows, WSL2, and LAN clients.
- Loopback and LAN exposure: Loopback versus LAN listen behavior for WSL2 Gateway exposure.
- WSL2 IPv4 networking: WSL2-specific IPv4 network-family behavior.
- Tailscale remote access: Tailscale and remote access behavior where it intersects WSL2 networking.

## Features

- Gateway token/password auth: Gateway token and password auth for clients running through WSL2.
- Provider credentials: Provider credential storage and lookup from inside the WSL2 environment.
- Gateway auth SecretRefs: Gateway auth SecretRef handling for WSL2-hosted Gateway processes.
- Remote URL credential precedence: Remote URL credential precedence when WSL2 clients connect to local or remote Gateways.
- WSL virtual network: WSL virtual network behavior and host/guest addressing.
- Windows portproxy setup: Windows netsh interface portproxy setup for exposing WSL services.
- Windows Firewall rules: Windows Firewall rules for WSL Gateway access.
- Reachable Gateway URLs: Gateway URLs that must be reachable from Windows, WSL2, and LAN clients.
- Loopback and LAN exposure: Loopback versus LAN listen behavior for WSL2 Gateway exposure.
- WSL2 IPv4 networking: WSL2-specific IPv4 network-family behavior.
- Tailscale remote access: Tailscale and remote access behavior where it intersects WSL2 networking.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Gateway auth, SecretRef runtime behavior, `.env` service guidance, remote credential precedence, exposure runbook, and security audit docs are explicit; source/tests cover gateway-auth SecretRef activation, active-surface reasoning, and redaction.
- Negative signals: WSL2-specific auth proof is mostly inferred from general Gateway/Linux behavior plus WSL2 support reports.
- Integration gaps: no WSL2-specific exposure/auth scorecard was found for token auth, node-host pairing from Windows, Tailscale Serve, portproxy, Control UI device auth, and security audit in one flow.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports: `WSL2 SecretRef token auth Gateway` returned 0 hits, while broader WSL2 queries returned node-host/Control UI and gateway reachability issues where auth and exposure are part of the operator diagnosis.
- Discrawl reports: WSL2 SecretRef/auth search returned unresolved SecretRef runtime logs in WSL2, WSL2 Gateway token auth excerpts, and Windows node-host pairing/relay guidance. Portproxy/Tailscale searches returned reports where the Gateway is loopback/token protected inside WSL2 but external clients cannot route to it cleanly.
- Good qualities: source treats Gateway auth SecretRefs as active startup inputs, remote credentials require explicit handling, and docs discourage direct public exposure.
- Bad qualities: WSL2 makes "gateway host" ambiguous for users, especially when credentials are set in Windows PowerShell while the Gateway service reads Linux `.env`, or when Windows node hosts try to connect through loopback/portproxy.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway token/password auth, Provider credentials, Gateway auth SecretRefs, Remote URL credential precedence, WSL virtual network, Windows portproxy setup, Windows Firewall rules, Reachable Gateway URLs, Loopback and LAN exposure, WSL2 IPv4 networking, Tailscale remote access.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need WSL2-specific examples for Windows node-host auth and re-pairing against a WSL2 Gateway.
- Need diagnostics that explain when auth is configured correctly but Windows/WSL routing prevents the client from reaching the Gateway.
- Need Windows platform docs to tie portproxy/Tailscale exposure back to the Gateway exposure runbook and security audit checklist.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/gateway/authentication.md:31`: provider API keys should be placed on the Gateway host.
- `/Users/kevinlin/code/openclaw/docs/gateway/authentication.md:38`: systemd/launchd Gateway services should read provider keys from `~/.openclaw/.env`.
- `/Users/kevinlin/code/openclaw/docs/gateway/secrets.md:11`: SecretRefs avoid storing supported credentials as plaintext in config.
- `/Users/kevinlin/code/openclaw/docs/gateway/secrets.md:27`: secrets resolve into an in-memory runtime snapshot and startup fails fast for active unresolved refs.
- `/Users/kevinlin/code/openclaw/docs/gateway/secrets.md:81`: gateway remote token/password SecretRefs are active for remote-mode or remote-exposure surfaces.
- `/Users/kevinlin/code/openclaw/docs/gateway/remote.md:84`: explicit `--url` calls require explicit token/password and do not fall back to config/env credentials.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/exposure-runbook.md:11`: exposure runbook warns to understand reachability, auth, agents, and tools before exposing Gateway.
- `/Users/kevinlin/code/openclaw/docs/gateway/security/exposure-runbook.md:24`: exposure patterns define loopback, Tailscale Serve, tailnet/LAN bind, proxy, and public risk.

### Source

- `/Users/kevinlin/code/openclaw/src/secrets/runtime-gateway-auth-surfaces.ts:6`: Gateway auth SecretRef surface paths include local and remote token/password fields.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-gateway-auth-surfaces.ts:60`: source evaluates which Gateway auth surfaces are active.
- `/Users/kevinlin/code/openclaw/src/gateway/auth.ts:344`: Gateway auth evaluates allowed browser origins as part of auth context.
- `/Users/kevinlin/code/openclaw/src/gateway/server.config-patch.test.ts:266`: config response redacts credential-bearing browser CDP URLs.
- `/Users/kevinlin/code/openclaw/src/gateway/net.ts:482`: non-loopback `ws://` URLs are treated as insecure because credentials may cross the network.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/secrets/runtime.gateway-auth.integration.test.ts:36`: integration test fails fast when active Gateway auth SecretRef is unresolved.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime.gateway-auth.integration.test.ts:67`: integration test rejects unresolved active Gateway auth refs before persisting them.
- `/Users/kevinlin/code/openclaw/src/security/audit-gateway-exposure.test.ts`: gateway exposure audit has source-level coverage.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/gateway/auth.test.ts:354`: auth tests cover `token_missing`.
- `/Users/kevinlin/code/openclaw/src/gateway/call.test.ts:991`: call tests reject insecure `ws://` remote URLs.
- `/Users/kevinlin/code/openclaw/src/gateway/server.auth.control-ui.suite.ts`: Control UI auth suite covers device identity, pairing, and token/password behavior.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-gateway-local-surfaces.test.ts`: secrets tests cover Gateway local surface behavior.
- `/Users/kevinlin/code/openclaw/src/secrets/runtime-gateway-auth-surfaces.test.ts`: secrets tests cover Gateway auth surface activation.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 SecretRef token auth Gateway" --mode keyword --limit 10 --json`
- `gitcrawl search openclaw/openclaw --query "WSL2 portproxy Gateway Windows host" --mode keyword --limit 10 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 OpenClaw" --mode keyword --limit 12 --json`

Results:

- WSL2 SecretRef/token/auth returned 0 hits.
- WSL2 portproxy/Gateway returned PR #74163 with Windows portproxy/gateway platform context.
- Windows WSL2 OpenClaw returned WSL2 reachability and Control UI/Gateway issues, including #81873, #54669, #61616, #73836, #80336, #86752, and #87387.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 SecretRef token auth Gateway"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 portproxy Gateway Windows host"`

Results:

- SecretRef/token/auth query returned WSL2 Gateway logs with unresolved SecretRef diagnostics, WSL2 token-auth Gateway startup output, and auto-family WSL2 network policy logs.
- Portproxy/Gateway query returned WSL2 + Tailscale and Windows node-host reports where token auth and pairing were present but cross-host reachability or relay setup remained unclear.
