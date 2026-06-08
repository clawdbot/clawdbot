---
title: "TUI - Rendering and Output Safety Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Rendering and Output Safety Maturity Note

## Summary

The TUI has a rich rendering pipeline for assistant deltas/finals, thinking
visibility, tool-call cards, tool-output expansion, streaming watchdogs,
fallback model updates, local `/btw` results, source replies, and sanitized
error text. Coverage is one of the strongest parts of the TUI. Quality is still
beta because active reports cluster around stream watchdog state, live-streaming
through `--session`, buffered Gateway/provider streams, and missing inline media.

## Category Scope

Included in this category:

- Streaming Message Rendering: Covers Streaming Message Rendering across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Tool Cards: Covers Tool Cards across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Terminal Rendering Primitives: Covers Terminal Rendering Primitives across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.
- Output Safety: Covers Output Safety across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.

## Features

- Streaming Message Rendering: Covers Streaming Message Rendering across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Tool Cards: Covers Tool Cards across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Terminal Rendering Primitives: Covers Terminal Rendering Primitives across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.
- Output Safety: Covers Output Safety across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: event handlers and formatters have extensive unit tests, PTY tests cover source replies and preserved provider errors, and the stream assembler handles delta/final reconciliation.
- Negative signals: full provider/Gateway streaming behavior is represented through mocks and issue-specific unit tests more than through recurring live-provider terminal proof.
- Integration gaps: add live or synthetic Gateway-v4 streaming PTY proof covering delta-only events, tool updates, inline media placeholders, provider fallback, and reconnect.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `gitcrawl search issues "tui stream" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned `#45388` for `--session` not live-streaming, `#78360` for stream watchdog marking quiet active runs idle, `#82988` for delta-only assistant events ignored by Gateway/embedded TUI, `#57592` for inline terminal image display, `#86050` for buffered claude-cli streams, and `#67052` for stale streaming indicators.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui stream"` returned release and user discussion about source replies, TUI transcript/source handling, and a local embedded TUI watchdog no-stream failure.
- Good qualities: tool cards use bounded previews, tool verbosity controls output exposure, final text reconciliation handles malformed fragments, and watchdog notices avoid silently idle states.
- Bad qualities: the active issue trail shows streaming correctness and status semantics are still the most visible TUI reliability risk.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Streaming Message Rendering, Tool Cards, Terminal Rendering Primitives, Output Safety.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Inline image support for modern terminals is still a feature gap.
- Streaming status semantics still need refinement for quiet active runs and provider/client buffering.

## Evidence

### Docs

- `docs/web/tui.md:186` documents tool cards, Ctrl+O expansion, and partial tool updates.
- `docs/web/tui.md:198` documents history loading, in-place streaming, and richer tool cards.
- `docs/web/tui.md:52` describes chat log, status line, and footer fields.

### Source

- `src/tui/components/chat-log.ts:18` tracks system, user, assistant, tool, pending, and `/btw` messages.
- `src/tui/components/chat-log.ts:253` starts and updates streaming assistant components.
- `src/tui/components/tool-execution.ts:55` renders tool cards with args, previews, errors, and expanded output.
- `src/tui/tui-stream-assembler.ts:103` assembles thinking/content deltas and final messages per run.
- `src/tui/tui-event-handlers.ts:471` handles chat delta events, arms the watchdog, and updates assistant text.
- `src/tui/tui-event-handlers.ts:584` handles agent tool events according to verbose/full output settings.

### Integration tests

- `src/tui/tui-pty-harness.e2e.test.ts:397` renders message-tool-only internal UI source replies in the terminal.
- `src/tui/tui-pty-harness.e2e.test.ts:415` preserves xAI account limit errors in terminal output.

### Unit tests

- `src/tui/tui-event-handlers.test.ts:588` accepts tool events after chat final for the same run.
- `src/tui/tui-event-handlers.test.ts:1211` covers the streaming watchdog.
- `src/tui/tui-stream-assembler.test.ts` covers streamed/final assistant message assembly.
- `src/tui/tui-formatters.test.ts:11` covers final-answer preference, malformed stream errors, ANSI/control sanitization, thinking extraction, and long-token handling.
- `src/tui/components/chat-log.test.ts` covers chat-log rendering behavior.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui stream" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned 10 open reports, including `#45388`, `#78360`, `#82988`, `#57592`, `#86050`, and `#67052`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui stream"`

Results:

- Returned release notes and user discussion covering source replies in WebChat/TUI, TUI transcript/source handling, and a local embedded TUI no-stream watchdog failure.
