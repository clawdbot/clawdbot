---
title: "macOS Gateway host - Local Gateway Integration Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Local Gateway Integration Maturity Note

## Summary

Local Gateway mode is the best-supported macOS host mode. Docs and source cover
`gateway.mode=local`, loopback default binding, non-loopback auth guardrails,
port/config precedence, health/status, local app endpoint resolution, and
Bonjour discovery. The main weakness is not the local runtime model itself, but
operator drift from mixed ownership, stale config, and split-brain installs.

## Category Scope

Included in this category:

- App local/remote connection mode: App local/remote connection mode coordination
- App-managed Gateway LaunchAgent install/restart/uninstall: App-managed Gateway LaunchAgent install/restart/uninstall through the CLI
- CLI install detection: CLI install detection and app install prompt
- Attach-to-existing local Gateway compatibility: Attach-to-existing local Gateway compatibility checks
- Gateway endpoint: Gateway endpoint, credential, and control-channel resolution
- gateway.mode=local configuration: gateway.mode=local configuration and defaulting during service install
- Loopback bind: Loopback bind, explicit host/bind overrides, auth requirements, and port precedence
- Local app endpoint resolution: Local app endpoint resolution, local control channel, and attach-to-existing Gateway behavior
- Bonjour discovery: Bonjour discovery and local status/probe/health surfaces

## Features

- App local/remote connection mode: App local/remote connection mode coordination
- App-managed Gateway LaunchAgent install/restart/uninstall: App-managed Gateway LaunchAgent install/restart/uninstall through the CLI
- CLI install detection: CLI install detection and app install prompt
- Attach-to-existing local Gateway compatibility: Attach-to-existing local Gateway compatibility checks
- Gateway endpoint: Gateway endpoint, credential, and control-channel resolution
- gateway.mode=local configuration: gateway.mode=local configuration and defaulting during service install
- Loopback bind: Loopback bind, explicit host/bind overrides, auth requirements, and port precedence
- Local app endpoint resolution: Local app endpoint resolution, local control channel, and attach-to-existing Gateway behavior
- Bonjour discovery: Bonjour discovery and local status/probe/health surfaces

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: docs, service install source, Gateway run source, app endpoint source, status/probe docs, and multi-Gateway runtime tests cover local mode from configuration through runtime.
- Negative signals: local mode proof is split across CLI, Gateway, app, and Bonjour surfaces rather than one complete packaged macOS scenario.
- Integration gaps: no single visible lane proves app local mode, LaunchAgent install, Bonjour advertisement, control UI, and `gateway status --deep` together after a clean install.

## Quality Score

- Score: `Stable (83%)`
- Gitcrawl reports: `gateway.mode local macOS gateway start blocked token port` returned open #78493 for mixed sudo ownership and config repair after EACCES/read failure; no direct local-mode transport breakage dominated the result set.
- Discrawl reports: `gateway mode local macOS` returned support threads where config/routing drift affected Gateway behavior, including group/session routing issues and closed reports around local gateway restart/token mismatch.
- Good qualities: the CLI defaults missing `gateway.mode` to local during install, Gateway run rejects unsafe bind/auth combinations, local endpoint resolution has explicit token/password precedence, and docs emphasize loopback and local health checks.
- Bad qualities: local mode is sensitive to ownership, config path, token, and mixed install-root drift; users can still end up with a locally installed Gateway whose runtime config is not the one the app or CLI expects.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App local/remote connection mode, App-managed Gateway LaunchAgent install/restart/uninstall, CLI install detection, Attach-to-existing local Gateway compatibility, Gateway endpoint, gateway.mode=local configuration, Loopback bind, Local app endpoint resolution, Bonjour discovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Mixed ownership and config repair can make local mode look broken even when the core local host model is sound.
- Local endpoint, token, and config path precedence should be easier to inspect from one macOS-specific command.
- Bonjour auto-start and local status are documented separately from the app local-mode setup path.

## Evidence

### Docs

- `docs/gateway/index.md:25`: documents local startup and health commands.
- `docs/gateway/index.md:71`: documents runtime model, default loopback behavior, and required auth.
- `docs/gateway/index.md:111`: documents port/bind precedence and supervisor metadata refresh.
- `docs/cli/gateway.md:25`: documents `gateway run`, `gateway.mode=local` guard, and non-loopback auth requirements.
- `docs/cli/gateway.md:267`: documents `gateway status`, deep status, config path drift, and RPC requirements.
- `docs/cli/gateway.md:323`: documents `gateway probe` warnings and multiple Gateway detection.
- `docs/gateway/bonjour.md:9`: documents Bonjour LAN discovery as a macOS convenience feature.
- `docs/platforms/macos.md:24`: documents local mode attach-or-enable behavior.

### Source

- `src/cli/daemon-cli/install.ts:80`: writes `gateway.mode=local` when missing during install.
- `src/cli/gateway-cli/run.ts:472`: reads config, resolves port, applies future config guard, and starts the Gateway.
- `src/cli/gateway-cli/run.ts:575`: applies bind-mode handling.
- `src/cli/gateway-cli/run.ts:645`: parses token/auth/Tailscale options before serving.
- `src/config/paths.ts:56`: resolves state dir with `OPENCLAW_STATE_DIR` override and default `~/.openclaw`.
- `src/config/paths.ts:151`: resolves config path with env override.
- `src/config/paths.ts:331`: resolves Gateway port from env/config/default.
- `apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift:11`: centralizes local/remote effective endpoint resolution.
- `apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift:81`: resolves local token/password precedence from app, env, config, and launchd.
- `apps/macos/Sources/OpenClaw/GatewayProcessManager.swift:192`: attaches to an existing local Gateway when compatible.

### Integration tests

- `test/gateway.multi.e2e.test.ts:27`: spins multiple Gateway instances, HTTP hooks, and WebSocket node pairing.
- `scripts/e2e/parallels/macos-smoke.ts:827`: performs local onboarding with `--install-daemon` on a macOS guest.
- `scripts/e2e/parallels/macos-smoke.ts:923`: verifies `gateway status --deep --require-rpc` on the macOS guest.
- `scripts/e2e/parallels/macos-smoke.ts:980`: loads the dashboard through the local Gateway.

### Unit tests

- `src/daemon/service-env.test.ts:640`: asserts durable TMPDIR and canonical PATH for macOS LaunchAgents.
- `src/daemon/service-env.test.ts:725`: verifies proxy/env persistence rules for managed services.
- `src/commands/doctor-platform-notes.launchctl-env-overrides.test.ts:19`: warns about launchctl token overrides that can affect local Gateway auth.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:210`: ensures local override ignores remote defaults for daemon commands.
- `apps/macos/Tests/OpenClawIPCTests/GatewayLaunchAgentManagerTests.swift:29`: parses local Gateway LaunchAgent port/bind/token/password from the plist snapshot.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "gateway.mode local macOS gateway start blocked token port" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #78493: `sudo openclaw update can create mixed ownership, then doctor overwrites config after EACCES/read failure`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "gateway mode local macOS"
```

Results:

- Returned support threads where Gateway config drift affected runtime behavior, including Discord group/DM routing divergence.
- Returned GitHub mirror comments closing older macOS local gateway restart/token mismatch reports as superseded or implemented.
