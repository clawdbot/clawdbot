---
title: "macOS Gateway host - Remote Gateway Mode Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Remote Gateway Mode Maturity Note

## Summary

Remote Gateway mode is documented and implemented with a clear transport model:
the macOS app can connect to a remote Gateway over SSH tunnel or direct ws/wss,
Tailscale is the recommended low-friction private network path, and the app
starts a local node host instead of a local Gateway in remote mode.

Coverage is Beta because the evidence is strong in docs/source/unit tests but
thinner for packaged app-to-remote-Gateway scenarios. Quality is Stable because
the transport and credential model is explicit, with direct plaintext rejection,
token/password/fingerprint precedence, and tunnel lifecycle management.

## Category Scope

Included in this category:

- macOS app "Remote over SSH": macOS app "Remote over SSH" and direct remote Gateway modes
- SSH tunnel setup: SSH tunnel setup, stable local forward ownership, and tunnel restart/backoff
- Tailscale MagicDNS: Tailscale MagicDNS, Serve, and Funnel guidance for remote access
- Remote endpoint token/password/TLS fingerprint: Remote endpoint token/password/TLS fingerprint resolution
- Local node host startup: Local node host startup and local Gateway suppression while the app is remote

## Features

- macOS app "Remote over SSH": macOS app "Remote over SSH" and direct remote Gateway modes
- SSH tunnel setup: SSH tunnel setup, stable local forward ownership, and tunnel restart/backoff
- Tailscale MagicDNS: Tailscale MagicDNS, Serve, and Funnel guidance for remote access
- Remote endpoint token/password/TLS fingerprint: Remote endpoint token/password/TLS fingerprint resolution
- Local node host startup: Local node host startup and local Gateway suppression while the app is remote

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: remote-mode docs, transport docs, app source, endpoint-store source, SSH tunnel manager source, and command resolver unit tests cover the designed behavior.
- Negative signals: evidence inspected here did not show a packaged end-to-end remote app test that configures SSH/Tailscale, pairs/authenticates, starts the node host, and proves command/control through the remote Gateway.
- Integration gaps: app-managed SSH tunnel ownership, direct ws/wss TLS fingerprint prompts, Tailscale Serve/Funnel paths, and remote node host pairing need stronger live release lanes.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: `macOS remote gateway SSH tunnel Tailscale direct wss tlsFingerprint` returned no open or closed feature-specific hits; `macOS companion app remote gateway tunnel canvas unauthorized node` returned no open hits.
- Discrawl reports: `mac app remote gateway ssh tunnel` returned support threads about SSH tunnel fallback, Tailscale as the recommended remote app path, avoiding manual port-forward conflicts with the app-owned tunnel, and a Canvas unauthorized/node-registration confusion case.
- Good qualities: source separates SSH and direct modes, rejects unsafe public plaintext endpoints unless trusted, centralizes credential precedence, owns a stable local SSH forward, and keeps local Gateway startup disabled in remote mode.
- Bad qualities: operator confusion remains around whether the macOS app is only an operator, a node, or both; Canvas/auth behavior and manual tunnel conflicts show that the remote user model needs clearer product proof.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for macOS app "Remote over SSH", SSH tunnel setup, Tailscale MagicDNS, Remote endpoint token/password/TLS fingerprint, Local node host startup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a packaged remote-mode E2E that drives app settings through SSH tunnel, then verifies Gateway connectivity and node registration.
- Make the app/node/operator distinction clearer in remote troubleshooting docs.
- Add explicit diagnostics for manual tunnel conflicts on the app's stable local forward port.

## Evidence

### Docs

- `docs/platforms/mac/remote.md:8`: documents remote control from the macOS app and the SSH-vs-direct transport split.
- `docs/platforms/mac/remote.md:18`: documents remote topology, `sshTarget`, `url`, local loopback, and local node host behavior.
- `docs/platforms/mac/remote.md:37`: documents remote prerequisites, PATH for noninteractive shells, and Tailscale.
- `docs/platforms/mac/remote.md:45`: documents `openclaw-mac configure-remote`.
- `docs/platforms/mac/remote.md:84`: documents remote permissions/security notes.
- `docs/gateway/remote.md:18`: documents the macOS app remote-mode topology.
- `docs/gateway/remote.md:67`: documents SSH tunnel CLI setup and credential warning.
- `docs/gateway/remote.md:157`: documents security rules, TLS pinning, and Tailscale Serve auth.
- `docs/gateway/tailscale.md:9`: documents Serve and Funnel modes while keeping the Gateway loopback-bound.

### Source

- `apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift:57`: remote mode stops local Gateway, starts the node service, ensures remote control tunnel, and configures the control channel.
- `apps/macos/Sources/OpenClaw/GatewayRemoteConfig.swift:42`: resolves transport as direct, SSH, or legacy.
- `apps/macos/Sources/OpenClaw/GatewayRemoteConfig.swift:88`: resolves remote URL, token, password, and TLS fingerprint.
- `apps/macos/Sources/OpenClaw/GatewayRemoteConfig.swift:174`: normalizes ws/wss URL and rejects public plaintext endpoints unless trusted.
- `apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift:291`: stores local, remote direct, and remote tunnel modes.
- `apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift:343`: ensures the remote control tunnel before using the endpoint.
- `apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift:15`: reuses a running tunnel or restarts it when the listener is absent.
- `apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift:38`: starts the SSH tunnel with configured remote settings and a preferred stable local port.
- `apps/macos/Sources/OpenClaw/TailscaleService.swift:103`: resolves MagicDNS/IP status and hydrates endpoint settings from Tailscale data.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:1006`: macOS guest smoke reaches a first agent turn after Gateway setup, but it is local-mode oriented rather than a dedicated remote-mode app test.
- `test/gateway.multi.e2e.test.ts:27`: multiple Gateway/node pairing coverage exercises Gateway/node contracts relevant to remote node operation.

### Unit tests

- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:148`: covers SSH command construction for remote mode.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:182`: loads remote settings from config.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:204`: rejects unsafe SSH targets.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:210`: ensures local daemon command override ignores remote defaults.
- `apps/macos/Tests/OpenClawIPCTests/TailscaleIntegrationSectionTests.swift:8`: covers not-installed/Serve views.
- `apps/macos/Tests/OpenClawIPCTests/TailscaleIntegrationSectionTests.swift:32`: covers Funnel view behavior.
- `apps/macos/Tests/OpenClawIPCTests/TailscaleIntegrationSectionTests.swift:49`: verifies hydration does not rewrite existing config.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS remote gateway SSH tunnel Tailscale direct wss tlsFingerprint" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

Query:

```bash
gitcrawl search issues "macOS remote gateway SSH tunnel Tailscale direct wss tlsFingerprint" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "mac app remote gateway ssh tunnel"
```

Results:

- Returned an April 2026 MacOS Canvas thread where SSH tunnel fallback was valid but Tailscale was recommended for the app and remote Gateway.
- Returned March 2026 MacOS Node Setup guidance recommending app "Remote over SSH" mode and warning not to run a manual tunnel that conflicts with the app-owned forward.
- Returned a Canvas unauthorized/node-registration confusion case for a macOS desktop app connected to a remote Gateway.
