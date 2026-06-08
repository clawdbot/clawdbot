---
title: "iOS app - Chat and Sessions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Chat and Sessions Maturity Note

## Summary

The iOS app has a real operator-facing chat surface: a dedicated operator Gateway session, Chat tab, shared native chat UI, command-center session links, agent routing, share/deep-link forwarding, and exec-approval prompts. Coverage is Experimental because most proof is source and unit/smoke level; the only current live iOS script exercises node capabilities, not the chat/operator workflow. Quality is Experimental because the implementation has good security and product structure, but current archive evidence shows recent iOS chat delivery, slash-command, share transcript, and operator-scope regressions.

## Category Scope

Included in this category:

- Chat sessions and operator controls: Operator session transport, Chat tab, chat composer/history/streaming/tool display, command-center, permissions, and session controls.

## Features

- Chat sessions and operator controls: Operator session transport, Chat tab, chat composer/history/streaming/tool display, command-center, permissions, and session controls.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (40%)`
- Positive signals: Source implements a secondary operator WebSocket, `chat.history`, `chat.send`, `chat.abort`, `sessions.list`, `sessions.create`, reset/compact, `agent.wait`, chat/agent event handling, active-session command-center rows, share/deep-link forwarding, and exec-approval review UI.
- Negative signals: No current iOS live/e2e proof was found for install/pair/open Chat/send/stream/tool-display/switch-session/share/deep-link/approval as one flow. The current iOS runtime script covers a connected iOS node and `node.invoke`, not the operator chat tab or composer.
- Integration gaps: Add a paired-device or simulator e2e that drives the Chat tab against a real Gateway, sends text and image attachments, validates streaming/tool cards/history, switches sessions from Command Center, exercises share/deep-link intake, and resolves an exec approval.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

## Quality Score

- Score: `Experimental (44%)`
- Gitcrawl reports: Open issue #80231 reports iOS group-chat messages not updating in real time; open PR #86737 identifies `IOSGatewayChatTransport.setActiveSessionKey` as a no-op and adds per-session transcript subscription work. PR #86936 reports iOS Share Extension images reaching the agent but losing media metadata in transcripts. PR #79985 documents that iOS/Android/TUI agent visibility depends on Gateway `agents.list`, which intentionally differs from CLI scope.
- Discrawl reports: Discord/GitHub mirror records prior iOS chat being blocked by node-role restrictions, `/compact` and slash-command regressions, missing `chat.side_result` consumption, ShareExtension build/metadata issues, and operator-approval scope/reconnect compatibility review findings.
- Good qualities: The app separates node and operator sessions, uses explicit operator scopes, keeps node commands off the operator socket, rate-limits and confirms untrusted agent deep links, strips untrusted delivery fields, persists per-gateway selected agents, and exposes approval decisions through both command-center rows and a modal card.
- Bad qualities: The current transport still has no active-session subscription body and no visible `session.message` event mapping in `IOSGatewayChatTransport`, so multi-agent/group-chat updates depend on weaker chat/agent events and refresh fallbacks. The iOS transport does not implement model or thinking patch RPCs, and several operator-chat paths are still being repaired in open archive records.
- Excluded from quality: Unit, integration, e2e, live, and real runtime test coverage were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

## Completeness Score

- Score: `Experimental (40%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Chat sessions and operator controls.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Current source needs a subscribed per-session transcript path for iOS group chats, plus visible handling for assistant `session.message` events.
- The iOS chat/operator workflow needs one repeatable runtime proof that covers Chat tab, Command Center session handoff, share/deep-link forwarding, and exec approvals.
- Model/thinking controls are present in shared chat UI but are not fully backed by iOS transport RPCs.
- Share-extension media persistence and transcript parity are still represented by open archive repair work.

## Evidence

### Docs

- `/Users/kevinlin/code/claw/maintainers/docs/kevinslin/maturity-scorecard/maturity-scorecard.md` lists `iOS app | M1 Experimental | High | Internal preview / super-alpha. TestFlight and relay-backed push flows exist, but no public distribution yet.`
- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` documents the iOS node, authenticated node plus operator sessions, `gateway.identity.get`, foreground limits, and the iOS node-command relationship.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` says the app is super-alpha/internal-use only, and lists Chat + Talk through the operator gateway session plus share-extension deep-link forwarding as concrete working surfaces.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Model/NodeAppModel.swift` owns separate `nodeGateway` and `operatorGateway` sessions, starts the operator loop with `role: "operator"` and `operator.read`/`operator.write`/`operator.talk.secrets` scopes, refreshes config/agents/share route, derives agent-scoped `chatSessionKey`, forwards agent deep links, and resolves exec approvals.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Chat/IOSGatewayChatTransport.swift` maps the iOS operator session to `sessions.create`, `chat.abort`, `sessions.list`, `sessions.reset`, `sessions.compact`, `chat.history`, `chat.send`, `agent.wait`, `health`, and server `chat`/`agent` events.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Design/ChatProTab.swift` embeds `OpenClawChatView` with the iOS transport, connection pill, agent display, and Talk toggle.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Design/CommandCenterTab.swift` renders gateway state, pending approvals, active/recent chat sessions from `sessions.list`, and routes rows into Chat.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift`, `ChatView.swift`, and `ChatComposer.swift` implement history bootstrap, optimistic sends, streaming assistant text, pending tool display, attachments, abort/refresh/reset/compact, session choices, model/thinking UI, and foreground refresh.
- `/Users/kevinlin/code/openclaw/apps/ios/ShareExtension/ShareViewController.swift` sends shared text/images to the gateway as `agent.request` via `node.event`.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Gateway/DeepLinkAgentPromptAlert.swift` and `ExecApprovalPromptDialog.swift` provide local confirmation and approval UI.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/dev/ios-node-e2e.ts` connects to a real Gateway as an operator, finds a connected iOS node, and invokes node commands; it does not cover Chat tab/composer/history/session UI.
- `/Users/kevinlin/code/openclaw/package.json` has `ios:build` and `ios:run` scripts for simulator build/launch, but no scripted chat/operator workflow assertion was found.
- No current checked-in iOS e2e was found for `chat.send` through a paired iOS app, real streaming/tool display, Command Center session handoff, share/deep-link delivery, or exec approval resolution.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/IOSGatewayChatTransportTests.swift` covers iOS transport request encoding, `agent.wait` status handling, session list params, chat send params, and fail-fast behavior when the Gateway is disconnected.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/NodeAppModelInvokeTests.swift` covers `chatSessionKey`, agent-scoped sessions, deep-link confirmation/rate limits/key bypass, and exec-approval prompt/watch recovery behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/GatewayConnectionControllerTests.swift` covers operator scope construction and backward-compatible `operator.approvals` behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/SwiftUIRenderSmokeTests.swift` verifies `RootTabs` and settings surfaces build a view hierarchy.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift` and adjacent shared chat tests cover the shared chat model, session choices, streaming/final events, attachments, slash commands, compact/reset behavior, markdown, and composer helpers.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "openclaw-ios chat" --json`

Results:

- Returned open issue #80231 `Group chat messages don't update in real-time on iOS — requires exit and re-entry`.
- Returned open PR #86737 `fix(ios): subscribe to per-session transcripts so group chats update in real time (#80231)`.
- Returned open PR #50483 `fix(ios): stabilize chat streaming layout and session flow`.
- Returned open PR #86936 `fix(gateway): persist media metadata in agent.request transcripts`.
- Returned open PR #73711 `feat(chat/ios): photos-picker-style attachment thumbnails with persistent add-more tile`.
- Returned open PR #79985 `docs+tests: clarify agents.list visibility scope across CLI and Gateway`.

Query:

`gitcrawl search openclaw/openclaw --query "IOSGatewayChatTransport" --json`

Results:

- Returned open PR #86737; snippet identifies `IOSGatewayChatTransport.setActiveSessionKey` as a comment-only stub.

Query:

`gitcrawl search openclaw/openclaw --query "iOS group chat real time session.message" --json`

Results:

- Returned open issue #80231 and open PR #86737 for group-chat real-time updates and per-session transcript work.

Query:

`gitcrawl threads openclaw/openclaw --numbers 80231 --include-closed --json`

Results:

- Issue #80231 body reports Aight/iOS group-chat replies do not appear automatically and require exiting/re-entering the chat; labels include `impact:session-state` and `impact:message-loss`.

Query:

`gitcrawl search openclaw/openclaw --query "iOS agent request share extension attachments" --json`

Results:

- Returned open PR #86936; body states images shared via iOS Share Extension reach the gateway through `agent.request` but media metadata was not persisted in transcript history.

Query:

`gitcrawl search openclaw/openclaw --query "iOS exec approval operator approvals" --json`

Results:

- Returned no hits.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "IOSGatewayChatTransport"`

Results:

- Returned GitHub mirror review comments for #53843 and #45444 about missing iOS `/compact` transport support and iOS not consuming `chat.side_result` events.
- Returned 2026-02-03/04 dev and architecture messages asking whether iOS chat was intentionally blocked because the app used a node-role connection while `chat.send`/`chat.history` required operator access.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS Share Extension"`

Results:

- Returned #44914 mirror text about ShareExtension build breakage after `GatewayNodeSession.connect` gained `bootstrapToken`.
- Returned #60339 mirror text about iOS share/node-path offloaded media refs not being persisted to transcripts.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "operator.approvals iOS"`

Results:

- Returned #63697 and #60238 mirror review/comments about respecting `includeApprovalScope`, backward-compatible operator reconnect scopes, and avoiding forced `operator.approvals` scope upgrades on legacy iOS pairings.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "chat.side_result iOS"`

Results:

- Returned #45444 review comment that iOS did not consume `chat.side_result` events, risking loss of side-question output until live event support exists.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS chat /compact"`

Results:

- Returned #63697 review/comment history about routing slash commands through Gateway and retry behavior after `/compact`.
- Returned #53843 review comment that missing iOS `compactSession` support would make `/compact` fail in the iOS chat sheet.

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Aight group chat"`

Results:

- Returned no rows.
