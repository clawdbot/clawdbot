---
title: "Raspberry Pi / small Linux devices - Gateway Auth, Device Pairing, and Secrets Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Raspberry Pi / small Linux devices - Gateway Auth, Device Pairing, and Secrets Maturity Note

## Summary

This note migrates archived maturity evidence for `Raspberry Pi / small Linux devices` / `Device Pairing, Secrets, and Operator Auth` into the current process-version-3 scorecard inventory.

## Category Scope

This category evaluates the Raspberry Pi / small Linux devices capability area represented by these taxonomy features:

- Device Pairing, Secrets, and Operator Auth: Evidence scope for Device Pairing, Secrets, and Operator Auth.

## Features

- Headless API-key auth: Defines Headless API-key auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Gateway shared-secret auth: Defines Gateway shared-secret auth context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Device pairing approvals: Defines Device pairing approvals context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- SecretRef handling: Defines SecretRef handling context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.
- Token drift recovery: Defines Token drift recovery context assembly, persistence, token-pressure handling, and recovery behavior for Gateway Auth, Device Pairing, and Secrets.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Gateway pairing, device CLI, SecretRefs, API key setup, and remote auth precedence are documented and backed by source. Raspberry Pi docs recommend API keys over OAuth for headless setups.
- Negative signals: Raspberry Pi specific auth workflows are assembled from several docs, and archive reports show stale token and Codex OAuth pain on Pi/systemd deployments.
- Integration gaps: Pairing/auth flows have coverage in the Gateway/device suites, but no inspected Pi hardware auth smoke was found.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: SecretRef and Pi/systemd reports exist, including a Raspberry Pi 5 aarch64 managed-systemd SecretRef path mention.
- Discrawl reports: Pi users hit pairing-required loops, stale device tokens, `/tmp`/plugin/device pairing breakage, and Codex auth failures under systemd.
- Good qualities: The docs recommend predictable API keys for long-lived hosts and SecretRefs fail closed.
- Bad qualities: Headless auth remains a frequent user-support area because it combines device pairing, Gateway auth, systemd persistence, CLI tokens, and channel/tool auth.
- Excluded from quality: unit, integration, e2e, live, runtime-flow, and manual smoke test evidence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/raspberry-pi-small-linux-devices.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Headless API-key auth, Gateway shared-secret auth, Device pairing approvals, SecretRef handling, Token drift recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No Raspberry Pi quickstart consolidates Gateway auth, device pairing, SecretRefs, and channel credentials into a single verified flow.
- Stale device-token recovery is documented in CLI docs, but Pi archive reports show users still get stuck.
- No Pi systemd auth fixture or hardware smoke was found.

## Evidence

### Docs

- `docs/install/raspberry-pi.md:92-104` recommends API keys over OAuth for headless setups and calls Telegram easiest for a headless Pi.
- `docs/gateway/authentication.md:13-19` says API keys are most predictable for always-on Gateway hosts.
- `docs/gateway/authentication.md:23-43` tells users to put keys in `~/.openclaw/.env` for systemd/launchd.
- `docs/gateway/secrets.md:11-20` describes SecretRefs as a way to reduce plaintext credential exposure.
- `docs/gateway/secrets.md:93-108` covers Gateway auth diagnostics and onboarding validation for SecretRefs.
- `docs/gateway/pairing.md:25-44` describes pending request, approval, token issuance, reconnect, and headless-friendly CLI workflow.
- `docs/cli/devices.md:51-83` documents device approval flow and latest-request preview.

### Source

- `src/gateway/auth-resolve.ts:31-105` resolves Gateway auth token/password/default and Tailscale allowance.
- `src/gateway/credentials-secret-inputs.ts:55-86` resolves SecretInput and configured SecretRefs.
- `src/gateway/credentials-secret-inputs.ts:110-181` determines if Gateway SecretRef paths can win.
- `src/commands/status.gateway-probe.ts:8-21` resolves Gateway probe auth.

### Integration tests

- Gateway auth and device pairing flows are covered by Gateway/device suites, but no inspected integration test is labeled for Raspberry Pi.
- No hardware auth smoke was found for Pi plus systemd plus device pairing.

### Unit tests

- Auth, SecretRef, and pairing behavior has targeted source-level tests in Gateway/device areas.
- No unit fixture modeled Pi/headless systemd credential storage.

### Gitcrawl queries

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi device pairing gateway token"`

Results:

- No matching threads returned.

Query: `gitcrawl search openclaw/openclaw --json --query "Raspberry Pi systemd Gateway auth SecretRef"`

Results:

- Returned PR #78555, with snippets mentioning `sibling_ref` SecretRef assignments and an `rpi-2712` Pi 5 aarch64 managed-systemd Gateway.

### Discrawl queries

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi device pairing OpenClaw"`

Results:

- Found Pi `devices list` output, pairing-required/native approval loops, `/tmp` read-only breaking plugin/device pairing/memory behavior, Pi 5 Docker/Tailscale Serve approval plans, stale device-token mismatch, and Pi 5 local Ollama/Gateway/Telegram setup struggles.

Query: `/Users/kevinlin/.local/bin/discrawl search --limit 5 "Raspberry Pi Codex auth systemd"`

Results:

- Found Pi/Linux systemd support history with repeated Codex OAuth failures.
