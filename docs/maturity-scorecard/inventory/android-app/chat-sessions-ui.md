---
title: "Android app - Mobile Chat Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Android app - Mobile Chat Maturity Note

## Summary

The Android app has a substantial mobile chat surface: session selection, history, optimistic sends, streaming assistant text, pending tool-call display, image attachments, thinking controls, markdown rendering, and online chat benchmark support. Coverage reaches Beta because the implementation spans Gateway chat RPCs and online UI proof, though no full Play-installed chat scenario was found. Quality stays Alpha because active archive evidence includes chat copy/reply review issues and the current source still depends on fast-moving mobile UI paths.

## Category Scope

Included in this category:

- Chat tab: Chat tab, session list/filtering, composer, image attachments, message parsing/rendering, model/provider status adjacent to chat, and Gateway chat RPC integration

## Features

- Chat tab: Chat tab, session list/filtering, composer, image attachments, message parsing/rendering, model/provider status adjacent to chat, and Gateway chat RPC integration

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (70%)`
- Positive signals: Docs describe `chat.history`, `chat.send`, `chat.subscribe`, session selection, display normalization, and best-effort push updates. Source implements history bootstrap, session switching, optimistic messages, streaming assistant text, pending tool calls, abort/refresh, attachments, and markdown rendering. The online benchmark explicitly checks connected state and live chat composer.
- Negative signals: Evidence is stronger for source/unit/UI benchmark slices than for an end-to-end Play-installed chat path through install, pair, send, stream, background, reconnect, and resume.
- Integration gaps: Need recurring mobile chat QA that sends text and images, changes sessions, streams a tool-using answer, backgrounds/reopens the app, and verifies history parity with another client.

## Quality Score

- Score: `Alpha (66%)`
- Gitcrawl reports: `Android message copy text selection chat screen` found issue #57754 and PR #59603 for chat copy/text selection. The PR review record flagged reply quoting, attachment-only reply context, empty text actions, and reply send semantics.
- Discrawl reports: Search found GitHub mirror review comments on PR #59603 that identify user-visible reply/copy problems around multiline quoting, image-only messages, blank copy/share payloads, and local-only reply UI state.
- Good qualities: Chat logic tracks pending run IDs, normalizes sessions, strips noisy model-control/tool-call text from history, supports image attachments with size handling, and separates visible health/errors from composer send enablement.
- Bad qualities: Reply/copy behavior has had several subtle user-facing regressions, mobile chat UI is still being actively rebuilt, and session continuity across network changes/backgrounding lacks a published Android-specific runbook result.
- Excluded from quality: Test coverage and runtime-flow proof were not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (70%)`
- Surface instructions: evaluated against `references/completeness/android-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Chat tab.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a mobile chat parity smoke against WebChat/TUI for history, streaming, sessions, attachments, and abort.
- Confirm reply/copy/text-selection behavior after the PR #59603 review findings.
- Make reconnect and session-resume state explicit in Android chat diagnostics.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/android.md` documents Chat tab history via `chat.history`, send via `chat.send`, best-effort `chat.subscribe`, session selection, and display normalization behavior.
- `/Users/kevinlin/code/openclaw/apps/android/README.md` says the rebuild includes restyled Chat UI, streaming support, and push notifications for gateway/chat status updates.

### Source

- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/chat/ChatController.kt` implements session loading/switching, health, optimistic sends, pending runs, streaming assistant text, tool-call state, history, and Gateway `chat.send`.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatScreen.kt` composes chat header, notices, message list, attachments, voice shortcut, thinking level, refresh/abort, and send path.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatComposer.kt` implements composer controls, thinking selector, attachment strip, refresh, abort, and send enablement.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/chat/ChatMarkdown.kt` renders markdown blocks, code, tables, task lists, links, images, and selection containers.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/main/java/ai/openclaw/app/ui/SessionsScreen.kt` renders recent/live session filters, sorting, and active-session rows.

### Integration tests

- `/Users/kevinlin/code/openclaw/apps/android/scripts/perf-online-benchmark.sh` verifies the app reaches a visible connected state and that the live chat composer is present, then runs chat session-switch or scroll benchmarks.
- No full Android chat e2e through a real Gateway answer and another client history parity check was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/chat/ChatControllerMessageIdentityTest.kt`, `ChatControllerSessionPolicyTest.kt`, and `ChatMessageContentParsingTest.kt` cover chat model/controller behavior.
- `/Users/kevinlin/code/openclaw/apps/android/app/src/test/java/ai/openclaw/app/ui/chat/ChatComposerDraftTest.kt`, `ChatImageCodecTest.kt`, `ChatMarkdownTest.kt`, `ChatSheetContentTest.kt`, and `SessionFiltersTest.kt` cover chat UI helpers.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "Android message copy text selection chat screen" --json`

Results:

- Issue #57754 `Android: Add message copy and text selection to chat screen`.
- PR #59603 `feat(android): Add message copy and text selection to chat screen`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Android chat screen message copy"`

Results:

- 2026-04-03 GitHub mirror review comments on PR #59603 flagged multiline quote formatting, attachment-only reply context, empty copy/share actions for image-only messages, and missing reply target in outgoing send path.
