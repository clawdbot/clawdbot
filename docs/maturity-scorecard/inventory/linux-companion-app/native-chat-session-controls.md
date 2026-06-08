---
title: "Linux companion app - Chat and Sessions Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Chat and Sessions Maturity Note

## Summary

OpenClaw has mature browser and macOS/iOS WebChat contracts, and open Linux app PRs claim native chat windows and session/model controls. The supported Linux companion app surface is still not landed, so users on Linux must use the browser Control UI or channels for supported chat.

## Category Scope

Included in this category:

- Native Linux chat window: Native Linux chat window behavior, status, and operator-visible verification.
- Transcript: Transcript, composer, session picker, model picker, send/abort/follow-up controls
- Gateway chat transport: Gateway WebSocket chat transport from a Linux desktop client.

## Features

- Native Linux chat window: Native Linux chat window behavior, status, and operator-visible verification.
- Transcript: Transcript, composer, session picker, model picker, send/abort/follow-up controls
- Gateway chat transport: Gateway WebSocket chat transport from a Linux desktop client.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (10%)`
- Positive signals: Gateway chat contracts and browser/macOS/iOS WebChat docs are strong adjacent proof; open Linux PRs claim chat-client implementations.
- Negative signals: no checked-in native Linux chat client or supported Linux app tests exist.
- Integration gaps: no supported native Linux chat e2e, WebSocket reconnect, transcript, session, model, or composer proof was found.

## Quality Score

- Score: `Experimental (36%)`
- Gitcrawl reports: Linux chat-specific query surfaced a broad tracking PR and open Linux app PRs with claimed chat functionality.
- Discrawl reports: issue #75 comments report a Linux app chat milestone with native chat window, transcript, composer, session selection, model selection, and diagnostics.
- Good qualities: the underlying Gateway `chat.history`, `chat.send`, and Control UI patterns give a coherent contract for a future Linux client.
- Bad qualities: no supported Linux UX exists for chat state, local persistence, reconnect, accessibility, markdown/tool rendering, or session selection; archive proof is contributor-branch evidence rather than shipped evidence.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (10%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native Linux chat window, Transcript, Gateway chat transport.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Land or explicitly defer native Linux chat.
- Define parity with browser Control UI and macOS/iOS WebChat.
- Document Linux chat auth, session persistence, reconnect, transcript replay, and local settings.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/web/webchat.md:8`: macOS/iOS SwiftUI chat UI talks directly to the Gateway WebSocket.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md:12`: WebChat is a native chat UI for the Gateway on supported native clients.
- `/Users/kevinlin/code/openclaw/docs/web/webchat.md:25`: WebChat uses `chat.history`, `chat.send`, and `chat.inject`.
- `/Users/kevinlin/code/openclaw/docs/web/control-ui.md:98`: browser Control UI provides chat and Talk today.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:13`: Linux companion apps are planned, so Linux native chat is not currently promised as supported.

### Source

- No checked-in `apps/linux` or `apps/linux-gtk` native chat client source exists.
- `/Users/kevinlin/code/openclaw/apps/shared/OpenClawKit/Sources/OpenClawChatUI`: shared native chat UI exists for current Apple/mobile clients, but is not a Linux app implementation.
- Browser Control UI chat source exists under the Gateway web surface, not as a native Linux app.

### Integration tests

- No native Linux app chat integration test was found.
- Existing browser/Gateway and app-specific chat tests are adjacent, not Linux native app proof.

### Unit tests

- No Linux native chat unit tests were found.
- Existing shared OpenClawKit chat tests cover shared Swift UI behavior for current app clients, not Linux.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion chat window session model diagnostics" --mode keyword --limit 8 --json`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`
- `gitcrawl gh pr view 61576 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The Linux chat query returned broad tracking PR #74163, including a reference to official companion downloads.
- PR #59859 claims native management surfaces and dashboard/general/diagnostics, but it remains open.
- PR #61576 claims a GTK4 Chat view with live send/receive, Markdown rendering, session model picker, typing indicator, thinking/tool-call toggles, and `chat.history`, but it remains open and early.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion chat window session model diagnostics"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion app native Linux app"`

Results:

- The chat/session query returned an April 19 issue #75 comment saying the Linux app supports Chat as a real product surface in a contributor track, with native chat window, transcript, composer, session selection, model selection, singleton behavior, and diagnostics.
- The native Linux app query also returned support guidance saying Linux users should use OpenClaw/web UI or other bridges because no supported native Linux companion app exists yet.
