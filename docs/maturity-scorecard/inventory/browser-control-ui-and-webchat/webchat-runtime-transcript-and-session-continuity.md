---
title: "Gateway Web App - WebChat Runtime and Session Continuity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Gateway Web App - WebChat Runtime and Session Continuity Maturity Note

## Summary

WebChat is deeply integrated into the Gateway runtime through `chat.history`, `chat.send`, `chat.abort`, `chat.inject`, session resolution, live `chat` events, transcript display projection, media supplements, and optimistic client-side reconciliation. Coverage is Stable because server methods, Gateway chat runtime, UI controllers, and browser E2E harnesses cover the main paths. Quality is Alpha because the archive shows a large lived bug surface around session identity, transcript replay, visible delivery, routing drift, stale in-progress state, and message rendering.

## Category Scope

This category covers the Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, injected assistant notes, session continuity across reload/reconnect, optimistic tail preservation, WebChat delivery isolation, and display normalization.

## Features

- chat.history projection: Covers chat.history projection across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- chat.send lifecycle: Covers chat.send lifecycle across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Abort/partial retention: Covers Abort/partial retention across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Injected assistant notes: Covers Injected assistant notes across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.
- Reconnect continuity: Covers Reconnect continuity across Gateway WebChat RPC/runtime contract, durable transcript projection, active run lifecycle, abort and partial retention, and related webchat runtime and session continuity behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Server methods and UI controller tests cover `chat.history`, `chat.send`, abort, transcript projection, media messages, visible tool status, session lists, and browser mocked chat flows.
- Negative signals: Many combinations involve real provider streams, durable session files, external-channel delivery context, and browser reconnects. These have regression coverage but less recurring live browser proof.
- Integration gaps: Add release smoke for restart/reconnect session continuity, channel-to-WebChat transcript viewing, visible tool status replay, media-bearing assistant history, abort partial persistence, and stale in-progress recovery.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: Broad `WebChat` queries returned open issues #80855, #85702, #77136, #70330, #87321, #78885, #87649, #67735, #64917, and related open PRs #75776, #87471, #87476, #77611, #69084, #75254, and #80670.
- Discrawl reports: Discord search found maintainer reports and release traffic naming webchat reconnect send preservation, visible-reply routing fixes, stale WebChat origin bugs, and Control UI/chat regressions as active release hot spots.
- Good qualities: The runtime has explicit display projection, bounded history, transcript-vs-delivery documentation, idempotency, active run state, abort handling, media supplements, and client-side optimistic reconciliation.
- Bad qualities: Session identity and delivery projection are inherently subtle, and the archive shows repeated regressions where WebChat affects or hides channel replies, transcript content, or visible run state.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow proof affect Coverage only.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/browser-control-ui-and-webchat.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for chat.history projection, chat.send lifecycle, Abort/partial retention, Injected assistant notes, Reconnect continuity.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Session continuity across restarts, sleep, and reconnect remains fragile in archive evidence.
- WebChat replay can still diverge from durable transcript or visible delivery state for tool-only and media-bearing replies.
- WebChat session identity still interacts with external channel routing enough to produce regressions.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/webchat.md` documents WebChat RPCs, bounded `chat.history`, display projection, transcript vs delivery model, injected messages, abort partial retention, and remote use.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md` documents chat send/history semantics, idempotency, final history refresh, optimistic local messages, `/new`, `/reset`, `/stop`, and model/thinking session overrides.
- `/Users/kevinlin/code/openclaw/docs/channels/channel-routing.md` documents WebChat behavior as an internal channel/session surface.

### Source

- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat.ts` implements `chat.history`, `chat.send`, `chat.abort`, `chat.inject`, attachment handling, transcript append, media supplements, and reply dispatch.
- `/Users/kevinlin/code/openclaw/src/gateway/chat-display-projection.ts` bounds and normalizes transcript rows for WebChat display.
- `/Users/kevinlin/code/openclaw/src/gateway/server-chat.ts` and `/Users/kevinlin/code/openclaw/src/gateway/live-chat-projector.ts` manage live chat event projection.
- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/chat.ts` loads history, filters hidden rows, preserves optimistic tails, and handles startup retry.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app-chat.ts` coordinates send, abort, session picker refresh, queueing, and model overrides.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/gateway/server.chat.gateway-server-chat.test.ts` and `/Users/kevinlin/code/openclaw/src/gateway/server.chat.gateway-server-chat-b.test.ts` cover Gateway chat server behavior.
- `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat.abort-persistence.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat.inject.parentid.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-methods/chat-webchat-media.test.ts` cover abort persistence, inject parent IDs, and WebChat media.
- `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-flow.e2e.test.ts` and `/Users/kevinlin/code/openclaw/ui/src/ui/e2e/chat-picker-pagination.e2e.test.ts` exercise browser chat flows.
- `/Users/kevinlin/code/openclaw/src/gateway/gateway-codex-harness.live.test.ts` covers live Codex harness Gateway chat paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/ui/src/ui/controllers/chat.test.ts` covers client history/send/abort behavior.
- `/Users/kevinlin/code/openclaw/ui/src/ui/app-chat.test.ts` covers send, abort, pending state, and session/model interactions.
- `/Users/kevinlin/code/openclaw/src/gateway/chat-sanitize.test.ts`, `/Users/kevinlin/code/openclaw/src/gateway/chat-attachments.test.ts`, and `/Users/kevinlin/code/openclaw/src/gateway/server-chat.stream-text-merge.test.ts` cover lower-level chat projection helpers.

### Gitcrawl queries

Query: `gitcrawl --json search issues -R openclaw/openclaw "WebChat"`

Results:

- Returned open #80855, #85702, #77136, #70330, #87321, #78885, #87649, #67735, #64917, #76104, and other WebChat issues.

Query: `gitcrawl --json search prs -R openclaw/openclaw "WebChat"`

Results:

- Returned open PRs #75776, #87471, #87476, #77611, #69084, #75254, #80670, #68701, #80985, and others.

Query: `gitcrawl --json search issues -R openclaw/openclaw "WebChat chat.history chat.send transcript session continuity"`

Results:

- Returned open #70330, `WebChat can silently rotate agent:main:main after gateway restart, hiding prior session/checkpoints`.

### Discrawl queries

Query: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 20 "WebChat"`

Results:

- Found maintainer daily report noting webchat reconnect send preservation.
- Found maintainer discussion of PR #87476 fixing stale WebChat routing for external channel conversations.
- Found release traffic saying transcripts use the same cleaned path as WebChat, CLI/TUI replay, Codex mirrors, and media provenance.
