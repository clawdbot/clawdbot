---
title: "Linux Gateway host - Security, Auth, and Secret Handling Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Security, Auth, and Secret Handling Maturity Note

## Summary

Linux Gateway security has stable default controls: loopback bind, auth required for non-loopback access, token/password modes, SecretRef support, fail-closed secret input resolution, provider auth on the Gateway host, exposure audit, and explicit remote CLI credentials. Quality is beta because archive evidence still shows SecretRef diagnostics and status-vs-Gateway auth resolution mismatches.

## Category Scope

This category evaluates the Linux Gateway host capability area represented by these taxonomy features:

- Security, Auth, and Secret Handling: Evidence scope for Security, Auth, and Secret Handling.

## Features

- Gateway exposure safeguards: Defines exposure checks, unsafe-network warnings, and operator controls for Linux Gateway security boundaries.
- Gateway authentication modes: Defines token/password auth, shared-secret resolution, and operator verification for Linux Gateway authentication.
- Secret Handling: Defines Secret Handling setup, credential, configuration, and operator verification behavior for Security, Auth, and Secret Handling.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Rationale: docs and source cover Gateway auth, remote credentials, model-provider env placement, SecretRefs, secret-input filtering, non-loopback guards, and exposure audit.
- Gaps: SecretRef operator behavior is documented but spread across secrets, authentication, doctor, remote, and CLI pages.

## Quality Score

- Score: `Beta (76%)`
- Rationale: the security model is strong, but active archive evidence shows SecretRef diagnostic mismatch and status/deep-probe resolution drift that can mislead Linux operators.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Gateway exposure safeguards, Gateway authentication modes, Secret Handling.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Align `status --deep`, doctor, Gateway runtime, and service install behavior for Gateway auth SecretRefs.
- Make SecretRef failure causes explicit for Linux service environments, especially file-provider paths under `/etc`.

## Evidence

### Docs

- `docs/gateway/authentication.md:23-58` explains provider auth on the Gateway host and environment placement for systemd/launchd.
- `docs/gateway/secrets.md:11-38` documents SecretRefs, plaintext risk, runtime snapshot behavior, fail-fast active references, and atomic reload.
- `docs/gateway/secrets.md:66-100` documents active-surface filtering and Gateway auth/remote SecretRef diagnostics.
- `docs/gateway/secrets.md:112-163` documents env/file/exec SecretRef contracts.
- `docs/gateway/remote.md:125-177` documents credential precedence, SecretRef fail-closed behavior, TLS/public rules, and Tailscale Serve auth boundaries.
- `docs/gateway/security/exposure-runbook.md:74-110` documents minimum safe remote-exposure config.

### Source

- `src/gateway/auth-resolve.ts:31-105` resolves configured auth mode, token/password input, and Tailscale auth behavior.
- `src/gateway/credentials-secret-inputs.ts:55-86` resolves secret-input strings and detects configured Gateway SecretRefs.
- `src/gateway/credentials-secret-inputs.ts:110-181` handles local auth mode paths and path-can-win sentinel behavior.
- `src/cli/daemon-cli/install.ts:220-239` resolves and persists Gateway install tokens.
- `src/cli/gateway-cli/run.ts:223-232` enforces explicit auth before non-loopback binding.

### Integration tests

- `src/commands/doctor-gateway-services.test.ts` covers Gateway service token persistence and auth-related repair behavior.
- `src/cli/daemon-cli/install.integration.test.ts` covers install-time auth/token behavior.
- `src/gateway/server.auth.default-token.test.ts` and `src/gateway/server.auth.modes.suite.ts` cover Gateway auth modes.

### Unit tests

- `src/gateway/resolve-configured-secret-input-string.test.ts` covers SecretRef resolution.
- `src/config/types.secrets.resolution.test.ts` and `src/config/types.secrets.test.ts` cover secret config behavior.
- `src/cli/command-secret-gateway.test.ts` and `src/commands/gateway-install-token.test.ts` cover CLI secret/token flows.
- `src/security/audit-gateway-auth-selection.test.ts` covers auth selection for exposure audit.

### Gitcrawl queries

- Specific query `Gateway token SecretRef service env auth Linux control UI origins exposure` returned no hits.
- Broader query `SecretRef token` returned issue #77687 for doctor reporting Gateway auth SecretRef unavailable when it resolves, PR #84224 for handling Gateway SecretRefs in auth checks, PR #77698 for resolving Gateway token SecretRefs, PR #68280 for fail-fast local probe auth, issue #65201 for false auth-token warnings, and issue #81547 for CLI/TUI SecretRef resolution from `/etc` file providers.

### Discrawl queries

- Query `Gateway auth token SecretRef` found 2026-05-29 maintainer discussion of issue #87815 where `status --deep` resolves status SecretRefs but not Gateway auth token/password.
- The same query found discussion of PR #84224 and false doctor warnings when `gateway.auth.token` is configured as a SecretRef.
