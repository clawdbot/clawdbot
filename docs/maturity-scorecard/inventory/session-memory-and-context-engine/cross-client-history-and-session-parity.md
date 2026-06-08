---
title: "Session, memory, and context engine - Cross-client History and Session Parity Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Session, memory, and context engine - Cross-client History and Session Parity Maturity Note

## Summary

Cross-client session parity is a central product promise: WebChat, TUI, Android,
OpenAI-compatible HTTP, and channel clients should see compatible history and
session state through Gateway-owned sessions. The source has strong projection,
history, and client code, but archive reports show persistent gaps after reset,
restart, native CLI imports, Telegram persistence, TUI refresh, and WebChat
checkpoint display.

## Category Scope

This category covers `chat.history`, `chat.send`, WebChat display projection,
TUI session actions, Android chat/session selection, OpenAI-compatible history
mapping, channel history windows, and history visibility across reset/restart.

## Features

- Cross-client History: Covers Cross-client History across `chat.history`, `chat.send`, WebChat display projection, TUI session actions, Android chat/session selection, OpenAI-compatible history mapping, channel history windows, and history visibility across reset/restart.
- Session Parity: Covers Session Parity across `chat.history`, `chat.send`, WebChat display projection, TUI session actions, Android chat/session selection, OpenAI-compatible history mapping, channel history windows, and history visibility across reset/restart.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Gateway `chat.history` tests, HTTP history tests, TUI history tests, Android chat controller tests, OpenAI-compatible history mapping, and channel history window tests cover major client surfaces.
- Negative signals: live parity across all clients and channel upstreams is not represented by one comprehensive scenario.
- Integration gaps: add a parity smoke that sends messages from WebChat, TUI, Android, and one channel into the same session and verifies consistent history, session id, model selection, and reset behavior.

## Quality Score

- Score: `Alpha (62%)`
- Gitcrawl reports: session/history query returned many open reports for WebChat hidden archives, TUI refresh misses, Telegram DM non-persistence, Slack reply drops, WebChat restart rotation, and native CLI context loss.
- Discrawl reports: Android support mentions `chat.history` parity; session/history archive discussions identify mismatched native CLI versus OpenClaw transcript stores.
- Good qualities: Gateway is the single history authority and client code requests history through typed RPCs.
- Bad qualities: parity breaks are user-visible and often present as missing history rather than explicit recoverable errors.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/session-memory-and-context-engine.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Cross-client History, Session Parity.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Native CLI import parity is uneven across providers.
- Reset/restart/checkpoint display can still diverge across WebChat, TUI, and channel clients.

## Evidence

### Docs

- `docs/web/webchat.md:25` says WebChat uses `chat.history`, `chat.send`, and `chat.inject`; `docs/web/webchat.md:52` says JSONL is the durable transcript.
- `docs/platforms/android.md:166` documents Android chat plus history; `docs/platforms/android.md:170` says history uses `chat.history`.
- `docs/channels/channel-routing.md:143` says WebChat attaches to the selected agent and defaults to its main session.

### Source

- `src/gateway/chat-display-projection.ts:1201` projects chat display messages and `src/gateway/chat-display-projection.ts:850` sanitizes history messages.
- `src/tui/gateway-chat.ts:210` loads history through `chat.history`; `src/tui/gateway-chat.ts:230` lists sessions.
- `apps/android/app/src/main/java/ai/openclaw/app/chat/ChatController.kt:333` requests `chat.history`; `apps/android/app/src/main/java/ai/openclaw/app/chat/ChatController.kt:367` requests `sessions.list`.
- `src/channels/turn/history-window.ts:40` creates channel history windows.

### Integration tests

- `src/gateway/server.chat.gateway-server-chat-b.test.ts:163` verifies `chat.history` does not wait for model catalog discovery.
- `src/gateway/server.chat.gateway-server-chat-b.test.ts:741` backfills Claude CLI sessions from project files.
- `src/gateway/sessions-history-http.test.ts:575` streams session history updates over SSE.
- `src/gateway/openai-http.test.ts:130` validates OpenAI-compatible history/current message routing.

### Unit tests

- `src/tui/gateway-chat.test.ts:572` retries startup-unavailable `chat.history`.
- `apps/android/app/src/test/java/ai/openclaw/app/chat/ChatControllerSessionPolicyTest.kt:36` prevents stale history load after session switch.
- `src/channels/turn/history-window.test.ts:6` records, formats, exposes, and clears channel history.

### Gitcrawl queries

Query:

`gitcrawl search issues "chat.history WebChat Android session history" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned `[]`.

Query:

`gitcrawl search issues "openclaw sessions transcripts chat.history" -R openclaw/openclaw --state all --json number,title,url,state`

Results:

- Returned 13 open reports, including WebChat hidden archives, TUI non-refresh after channel reset, Telegram session non-persistence, Slack transcript/delivery mismatch, WebChat restart rotation, and native CLI context-loss races.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "chat.history WebChat Android session history"`

Results:

- Returned Android support guidance that chat requires an operator connection and uses `chat.history`; also returned older support where a context-limit-stuck session required clearing session state.

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "openclaw sessions transcripts chat.history"`

Results:

- Returned discussions of orphaned transcript cleanup, hidden transcript-only artifacts, and OpenClaw-vs-native-CLI history store confusion.
