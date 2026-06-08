---
title: "macOS companion app - Remote Connections Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Remote Connections Maturity Note

## Summary

Remote mode is substantially implemented: the app can configure SSH or direct ws/wss Gateway access, keep a loopback control tunnel, start the local node host service, handle TLS pinning, and reuse the same WebChat/health path. Coverage is Beta because tunnel, discovery, pinning, and health flows have concrete implementation with helper proof, but no end-to-end remote Gateway app scenario was found. Quality is Alpha due to archive evidence around stale token recovery, SSH tunnel/discovery confusion, and remote macOS node capability drift.

## Category Scope

Included in this category:

- Remote connection mode selection: Remote connection mode selection and configuration
- SSH tunnel: SSH tunnel and direct ws/wss Gateway transport
- Gateway discovery: Gateway discovery, TLS pin repair, and remote node-service startup

## Features

- Remote connection mode selection: Remote connection mode selection and configuration
- SSH tunnel: SSH tunnel and direct ws/wss Gateway transport
- Gateway discovery: Gateway discovery, TLS pin repair, and remote node-service startup

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs cover SSH tunnel, direct ws/wss, setup CLI, WebChat reuse, permissions, and troubleshooting. Source has explicit mode coordinator branches, tunnel reuse/restart/backoff, remote command configuration, endpoint store, TLS pin policy, and node-service startup.
- Negative signals: Unit tests focus on tunnel helper logic and TLS decisions. They do not prove a real remote host with SSH, Tailscale, Gateway auth rotation, WebChat, voice wake, and Mac node capabilities.
- Integration gaps: Missing an end-to-end remote app scenario with SSH tunnel setup, direct `wss://*.ts.net`, stale pin repair, token rotation, node host service startup, WebChat turn, and macOS capability invocation.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Results include issue #26250 on SSH transport security check before tunnel establishment, issue #47342 on node-host SSH transport and reverse proxy challenge auth, issue #69135 on duplicate reachable Gateway detection with SSH tunnel plus remote URL, and PR #82739 showing control-channel tunnel recovery in duplicate-icon context.
- Discrawl reports: Maintainer discussion on 2026-05-01 calls stale shared-token recovery for remote Swift clients release-relevant; Discord GitHub mirror also shows remote macOS skill eligibility issue #71877 and remote SSH browser path issue #67336.
- Good qualities: Remote docs are explicit about transport choice, loopback tunnel safety, strict host-key checks, TLS fingerprint repair for trusted loopback/Tailscale Serve, and troubleshooting when dashboard works but Mac capabilities are offline.
- Bad qualities: Remote control depends on SSH, PATH, auth, tunnel reuse, TLS pinning, node-service state, and macOS permissions. Archive evidence shows these boundaries can strand paired clients or remote skills.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Remote connection mode selection, SSH tunnel, Gateway discovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need release-smoke proof for remote host auth rotation and trusted TLS/fingerprint recovery.
- Need clearer operator distinction between control connection healthy, WebChat healthy, and Mac node/capability connection healthy.
- Need a remote macOS node skill/bin probe scenario that proves `system.which` and browser/canvas ownership.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/remote.md` documents local/remote/direct modes, SSH tunnel behavior, remote host prerequisites, setup CLI, WebChat, permissions, security, and troubleshooting.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents remote mode, tunnel plumbing, debug CLI, and preference for Tailscale MagicDNS.
- `/Users/kevinlin/code/openclaw/docs/gateway/remote.md` provides adjacent Gateway remote-host guidance.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift` stops local Gateway, starts node service, ensures remote control tunnel, and configures the control channel in remote mode.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift` creates/reuses/restarts SSH tunnels with listener checks and restart backoff.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/RemotePortTunnel.swift` builds the SSH forwarding process.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift` handles remote TLS pins and stale Tailscale Serve pin repair.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClawMacCLI/ConfigureRemoteCommand.swift` writes remote configuration.

### Integration tests

- No complete remote-host app integration scenario was found.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayConnectionControlTests.swift` uses fake WebSocket sessions for Gateway connection behavior, not a remote host.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/RemotePortTunnelTests.swift` covers port-free detection and remote-port override parsing.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ConfigureRemoteCommandTests.swift` covers remote CLI configuration.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MacNodeModeCoordinatorTests.swift` covers remote TLS params and stale pin auto-repair decisions.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryModelTests.swift`, `WideAreaGatewayDiscoveryTests.swift`, and `TailscaleServeGatewayDiscoveryTests.swift` cover discovery helpers.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS remote gateway ssh tunnel" --json`

Results:

- Issue #26250 `SSH transport security check rejects connection before tunnel is established`.
- Issue #47342 `Node host: no SSH transport support + challenge auth fails behind reverse proxy`.
- Issue #69135 ``gateway probe`: false positive "multiple reachable gateways" when SSH tunnel + remote.url hit the same gateway`.
- PR #82739 included control-channel SSH tunnel recovery log evidence.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS remote gateway"`

Results:

- 2026-05-01 maintainer thread: remote Swift stale shared-token recovery and retry/cancel loop were called release-relevant.
- 2026-04-26 GitHub mirror: issue #67336 notes Remote over SSH rewriting browser path to discovered host URL.
- 2026-04-26 GitHub mirror: issue #71877 notes remote macOS skill eligibility ignoring `system.which` object-map responses.
