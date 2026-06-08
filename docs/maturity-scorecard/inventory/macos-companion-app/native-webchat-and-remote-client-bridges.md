---
title: "macOS companion app - Remote WebChat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Remote WebChat Maturity Note

## Summary

The macOS native WebChat bridge shares the Gateway WebSocket contract with browser WebChat while adding SwiftUI windows/panels, session selection, model/thinking controls, health, events, and remote SSH tunnel management. Coverage is Beta because Swift tests cover many bridge pieces, but release-smoke proof across sleep, remote mode, reconnect, and SSH tunnel recovery is thinner. Quality is Beta because the bridge reuses the Gateway protocol well, while archive evidence shows session reset, reconnect, and client-type distinctions remain active issues.

## Category Scope

Included in this category:

- macOS WebChat transport: Covers macOS WebChat transport across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- SSH tunnel data plane: Covers SSH tunnel data plane across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Direct ws/wss remote mode: Covers Direct ws/wss remote mode across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Session continuity: Covers Session continuity across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Remote troubleshooting: Covers Remote troubleshooting across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.

## Features

- macOS WebChat transport: Covers macOS WebChat transport across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- SSH tunnel data plane: Covers SSH tunnel data plane across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Direct ws/wss remote mode: Covers Direct ws/wss remote mode across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Session continuity: Covers Session continuity across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.
- Remote troubleshooting: Covers Remote troubleshooting across native macOS WebChat, Gateway connection reuse, native chat transport mapping, window/panel presentation, and related remote webchat client bridges behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: macOS IPC tests cover WebChat SwiftUI smoke, manager behavior, main session key, Gateway channel connect/request/configure, Gateway connection control, endpoint store, discovery, remote port tunnel, and remote auth prompts.
- Negative signals: There is less repeated proof for real app sleep/wake, network disconnect, remote SSH tunnel loss, remote direct/tailnet fallback, and long-lived session continuity than for browser local tests.
- Integration gaps: Add native release smoke for local WebChat, remote WebChat over SSH, remote direct tailnet, sleep/wake reconnect, tunnel restart, and session continuity after gateway restart.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `mac WebChat` and `remote WebChat` queries returned #39597 for distinguishing Mac app vs browser client types, #87700 for session reset after network disconnect/sleep, #38091 for UI WebSocket reconnect causing session termination, #78674 for null client identity through Cloudflare tunnel, and PRs #74733 and #87474 for message ordering and false busy state.
- Discrawl reports: Exact macOS remote query returned no rows, but WebChat and Control UI archive traffic repeatedly mentions reconnect, stale session, remote/hosted access, and visible routing fixes.
- Good qualities: The native app reuses a single Gateway WebSocket actor, maps Gateway events into shared chat UI transport events, records active sessions, and manages SSH tunnel reuse/restart with listener checks.
- Bad qualities: Native remote mode adds OS, network, tunnel, and sleep state that are not visible in browser-only tests; session continuity issues still appear in archive history.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for macOS WebChat transport, SSH tunnel data plane, Direct ws/wss remote mode, Session continuity, Remote troubleshooting.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Mac app and browser WebChat client types are not fully distinct in product semantics.
- Sleep/network-disconnect recovery remains a known risk for session continuity.
- Remote tunnel and tailnet fallback behavior needs more regular proof as part of release qualification.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/webchat.md` documents macOS WebChat, direct Gateway WebSocket use, local/remote mode, launch/debugging, RPCs, events, session behavior, and security boundary.
- `/Users/kevinlin/code/openclaw/docs/gateway/remote.md` documents WebChat remote access, SSH tunnels, LAN/Tailnet direct mode, macOS remote mode, and security rules.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/remote.md` documents the macOS remote setup and notes there is no separate WebChat HTTP server.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/WebChatSwiftUI.swift` maps Gateway chat/history/models/sessions/abort events to the shared native chat UI transport.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/WebChatManager.swift` manages window/panel lifecycle and active session keys.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/GatewayConnection.swift` owns the shared Gateway WebSocket connection and request/retry behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/RemoteTunnelManager.swift` manages SSH tunnel creation, reuse, listener checks, and restart backoff.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift` and `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/RemoteGatewayProbe.swift` support endpoint selection and remote probing.

### Integration tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatSwiftUISmokeTests.swift`, `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatManagerTests.swift`, and `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatMainSessionKeyTests.swift` cover native WebChat UI and session behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayChannelConnectTests.swift`, `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayChannelRequestTests.swift`, and `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayConnectionControlTests.swift` cover Gateway communication.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/RemotePortTunnelTests.swift`, `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/ConfigureRemoteCommandTests.swift`, and `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/OnboardingRemoteAuthPromptTests.swift` cover remote mode support.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/MacGatewayChatTransportMappingTests.swift` covers native chat transport mapping.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayEndpointStoreTests.swift`, `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayEnvironmentTests.swift`, and `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayDiscoveryModelTests.swift` cover supporting endpoint and discovery logic.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "mac WebChat"`

Results:

- Returned open #39597, `Feature: Distinguish webchat client types (Mac app vs browser)`.
- Returned open #87700, `Control UI webchat session silently resets after network disconnect / sleep`.
- Returned open #54874, slow typing in WebChat input, plus routing/session issues #67735, #77012, and #86262.

Query: `gitcrawl --json search issues -R openclaw/openclaw "remote WebChat"`

Results:

- Returned open #38091 for UI WebSocket reconnect causing session termination.
- Returned open #78674 for null client identity through Cloudflare tunnel.
- Returned open #87387 and #87700 for false in-progress state and reconnect/session reset behavior.

Query: `gitcrawl --json search prs -R openclaw/openclaw "mac WebChat"`

Results:

- Returned open PR #74733, `fix(ui): stabilize WebChat message ordering`.
- Returned open PR #86335, `feat(webchat): allow safe app-protocol links`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 10 "macOS WebChat remote mode Gateway WebSocket SSH tunnel"`

Results:

- Returned no rows.

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 20 "WebChat"`

Results:

- Found maintainer and release traffic about reconnect send preservation, stale WebChat routing, and chat/session fixes.
