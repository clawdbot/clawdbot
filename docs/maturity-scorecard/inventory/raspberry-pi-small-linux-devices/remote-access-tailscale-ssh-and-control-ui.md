---
title: "Raspberry Pi / small Linux devices - Remote Access and Auth Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Remote Access and Auth Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Remote Access, Tailscale, Ssh, and Control UI` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Headless API-key auth: Defines Headless API-key auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Gateway shared-secret auth: Defines Gateway shared-secret auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Device pairing approvals: Defines Device pairing approvals context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SecretRef handling: Defines SecretRef handling context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Token drift recovery: Defines Token drift recovery context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SSH tunnel dashboard access: Defines SSH tunnel dashboard access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Tailscale Serve/Funnel: Defines Tailscale Serve/Funnel setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Loopback/non-loopback exposure controls: Defines Loopback/non-loopback exposure controls setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Authenticated Control UI access: Defines Authenticated Control UI access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.

## Features

- Headless API-key auth: Defines Headless API-key auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Gateway shared-secret auth: Defines Gateway shared-secret auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Device pairing approvals: Defines Device pairing approvals context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SecretRef handling: Defines SecretRef handling context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Token drift recovery: Defines Token drift recovery context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SSH tunnel dashboard access: Defines SSH tunnel dashboard access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Tailscale Serve/Funnel: Defines Tailscale Serve/Funnel setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Loopback/non-loopback exposure controls: Defines Loopback/non-loopback exposure controls setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.
- Authenticated Control UI access: Defines Authenticated Control UI access setup, credential, configuration, and operator verification behavior for Remote Access and Control UI.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Gateway remote docs, Tailscale docs, and Raspberry Pi docs cover SSH tunnels, loopback defaults, Tailscale Serve/Funnel, auth precedence, non-loopback guardrails, and Control UI access.
- Negative signals: Reverse-proxy and Tailscale/Pi edge cases appear in GitHub issues, and hardware-specific remote-access smoke is absent.
- Integration gaps: Gateway network tests exist, but no inspected test targets Raspberry Pi plus Tailscale or SSH tunnel behavior.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: issues include hostname needs for laptop/server/Pi, reverse-proxy secure-context problems on headless Linux/Pi/home server/VPS, and Tailscale-reachable Pi plugin-loader problems.
- Discrawl reports: Pi 5 Docker/Tailscale Serve and device approval workflows are discussed by users.
- Good qualities: Security defaults are conservative: loopback and SSH/Tailscale are the safest path, non-loopback requires auth, and public Funnel is password-gated.
- Bad qualities: The remote-access story is powerful but multi-layered, so support issues often involve browser secure-context rules, auth headers, and tailnet/public exposure mode.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Headless API-key auth, Gateway shared-secret auth, Device pairing approvals, SecretRef handling, Token drift recovery, SSH tunnel dashboard access, Tailscale Serve/Funnel, Loopback/non-loopback exposure controls, Authenticated Control UI access.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No recurring Pi plus Tailscale Serve smoke was found.
- Reverse proxy and secure context behavior is not summarized in the Raspberry Pi guide.
- Control UI remote access depends on multiple docs rather than one small-device flow.

## Evidence

### Docs

- `docs/install/raspberry-pi.md:107-128` verifies Gateway status and shows SSH tunneling to the Control UI, with a Tailscale link.
- `docs/gateway/remote.md:8-16` frames loopback, Tailscale Serve, and SSH as the core remote paths.
- `docs/gateway/remote.md:67-86` documents SSH tunnel access and explicit credentials.
- `docs/gateway/remote.md:157-175` states that loopback plus SSH/Tailscale is safest, non-loopback binds require auth, and SecretRefs fail closed.
- `docs/gateway/tailscale.md:9-17` describes Serve/Funnel modes.
- `docs/gateway/tailscale.md:92-127` documents public Funnel password requirements and prerequisites.

### Source

- `src/shared/gateway-bind-url.ts:21-46` resolves custom, tailnet, and LAN bind URLs and errors.
- `src/gateway/auth-resolve.ts:31-105` resolves Gateway auth token, password, and Tailscale allowances.
- `src/cli/gateway-cli/run.ts:25-48` behavior is documented in source-backed CLI docs, including non-loopback auth guardrails.

### Integration tests

- `package.json:1653` defines `test:docker:gateway-network`.
- `package.json:1677`, `package.json:1678`, and `package.json:1679` define live Gateway Docker test entries.
- No inspected test combines Raspberry Pi hardware with SSH or Tailscale.

### Unit tests

- Gateway bind/auth tests cover policy behavior, but no Pi-specific remote-access unit fixture was found.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi Tailscale gateway"`

Results:

- Returned issue #56276 about surfacing hostnames for laptop/server/Raspberry Pi, issue #53274 about secure context on HTTP reverse-proxy deployments for headless Linux/Raspberry Pi/home server/VPS, and issue #78196 about extension plugins skipped by a Tailscale-reachable Pi Gateway.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi device pairing OpenClaw"`

Results:

- Found a Pi 5 Docker plus Tailscale Serve plan involving device approval, along with device-token and pairing support history.
