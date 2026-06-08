---
title: "macOS companion app - WebChat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - WebChat Maturity Note

## Summary

The macOS app embeds the shared WebChat UI as a native SwiftUI window/panel backed by Gateway RPCs and event streams. It supports session switching, model/thinking controls, health, abort, compaction, reset, attachments, and main-session defaults through `OpenClawChatUI`. Coverage is Beta because native chat transport paths are implemented with supporting smoke proof, but a live app WebChat scenario through local and remote Gateway was not found. Quality is Alpha because archive evidence shows active WebChat freezes, transcript/session continuity regressions, and native credential flicker.

## Category Scope

Included in this category:

- Native SwiftUI WebChat window: Native SwiftUI WebChat window and menu panel
- Gateway chat transport: Gateway chat transport, session/model/thinking controls, event mapping, and health
- Local and remote data-plane reuse: Local and remote data-plane reuse across native WebChat sessions.

## Features

- Native SwiftUI WebChat window: Native SwiftUI WebChat window and menu panel
- Gateway chat transport: Gateway chat transport, session/model/thinking controls, event mapping, and health
- Local and remote data-plane reuse: Local and remote data-plane reuse across native WebChat sessions.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (72%)`
- Positive signals: Docs and source cover WebChat launch, local/remote data planes, Gateway methods/events, session defaults, and debug logging. Smoke tests instantiate window and panel controllers with a fake transport. Shared WebChat UI has broader browser/control-ui coverage in adjacent surfaces.
- Negative signals: No macOS app live WebChat test was found that sends a real Gateway turn, handles reconnect, switches sessions, and keeps the same panel/window state.
- Integration gaps: Need a local and remote native WebChat scenario covering `chat.history`, `chat.send`, streaming events, abort, session switch, sleep/reconnect, and recovery from Gateway restart.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: Results include WebChat issues for slow input (#54874), leaked memory injection blocks (#64613), render failures (#77136), transcript overwrite (#77012), lost messages during reconnect (#45952), duplicate final messages (#85771), session reset after network disconnect/sleep (#87700), and native credentials-gate flicker (#85352).
- Discrawl reports: 2026-05-21 user support report says macOS WebChat locks after one prompt and forces a new session per message. Release-testing discussion repeatedly calls out WebChat/mobile/control UI as regression focus.
- Good qualities: Native WebChat uses a shared transport abstraction, maps Gateway health/chat/agent/session events, persists thinking level, supports session switcher, and shares remote/local connection plumbing.
- Bad qualities: WebChat session continuity and rendering have a large lived regression record. The native app adds another layer where credential gates, panel/window lifecycle, and remote tunnel state can diverge.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (72%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native SwiftUI WebChat window, Gateway chat transport, Local and remote data-plane reuse.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a native WebChat live reconnect/sleep/Gateway-restart scenario.
- Need a session-lock regression test for the one-prompt freeze support report.
- Need native app proof that credential state, control connection, and chat history are loaded without flicker or reset.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/webchat.md` documents native SwiftUI WebChat, local/remote modes, launch/debugging, Gateway methods/events, session behavior, and known limitations.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` references WebChat through remote tunnel and app controls.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` documents the shared WebChat behavior used by the native bridge.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/WebChatManager.swift` manages window/panel controllers, active session key, preferred session key, and tunnel reset.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/WebChatSwiftUI.swift` implements `MacGatewayChatTransport`, maps Gateway pushes to chat events, creates SwiftUI windows/panels, and routes session/model/thinking controls.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/GatewayConnection.swift` provides shared Gateway request/event transport.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit` and `OpenClawChatUI` provide shared chat models/views.

### Integration tests

- No native app WebChat live Gateway scenario was found.
- `/Users/kevinlin/code/openclaw/qa/scenarios/channels/webchat-direct-reply-routing.md` covers channel-level WebChat direct reply routing, not the macOS native app panel.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatSwiftUISmokeTests.swift` instantiates WebChat window and panel controllers with a fake transport.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatManagerTests.swift` verifies preferred session key behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/WebChatMainSessionKeyTests.swift` covers main session key mapping.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app-gateway-chat-load.node.test.ts` and related UI tests cover browser-side WebChat behavior, not native app-specific behavior.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS WebChat" --json`

Results:

- Issue #54874 `Slow typing in webchat input with keystroke delay`.
- Issue #64613 `chat.history leaks system-level memory injection blocks to WebChat UI`.
- Issue #77136 `WebChat fails to render some assistant messages`.
- Issue #77012 `WebChat session transcript overwritten on every turn`.
- Issue #45952 `Webchat: messages lost during WebSocket reconnect`.
- Issue #85771 `WebChat UI renders duplicate assistant messages`.
- Issue #87700 `Control UI webchat session silently resets after network disconnect / sleep`.
- Issue #85352 `macOS menu bar app flashes credentials gate on open`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS WebChat"`

Results:

- 2026-05-21 user support report: macOS WebChat locks after one prompt and requires a new session every message.
- 2026-05-26 release-testing proposal includes WebChat/tool-call freezes as regression focus.
- 2026-05-27 report lists WebChat titles among top closed topics.
