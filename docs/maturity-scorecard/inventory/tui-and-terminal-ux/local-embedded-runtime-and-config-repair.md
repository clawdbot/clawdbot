---
title: "TUI - Local Embedded Runtime and Config Repair Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Local Embedded Runtime and Config Repair Maturity Note

## Summary

Local embedded mode is the strongest user-facing TUI addition: it allows
`openclaw chat` and `openclaw tui --local` to run without a Gateway, load local
session history, send turns through the embedded agent runtime, run `/auth`, and
support a documented config-repair loop. Coverage includes a PTY local-mode
smoke with a mocked model endpoint. Quality remains beta because local mode
still has documented command surface gaps and local-provider/operator confusion
in the archive.

## Category Scope

This category covers embedded backend lifecycle, local model catalog loading,
local `chat.send` event projection, queued local runs, local session history,
local `/auth`, local config repair docs, and Gateway-free recovery scenarios.

## Features

- Embedded local chat: Covers Embedded local chat across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Local auth flow: Covers Local auth flow across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Config repair loop: Covers Config repair loop across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Gateway-free recovery: Covers Gateway-free recovery across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: local embedded mode has docs, command registration, embedded backend tests, and a PTY e2e that sends a real local-mode turn to a mocked model endpoint.
- Negative signals: the PTY e2e does not cover `/auth`, local shell config repair, multiple real local providers, or Gateway-unhealthy hatch recovery.
- Integration gaps: add a local config-repair scenario that runs `/auth`, `!openclaw config validate`, and a model response through the same PTY harness.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: `gitcrawl search issues "tui commands" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned `#71592` for local mode advertising `/status` and `/compact` while falling through to model text. `gitcrawl search issues "TUI local shell" ...` returned `#86632` for a local embedded Ollama/Qwen session failing a live-data request handled by another coding-agent shell path.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "local embedded tui auth config repair"` returned discussion of PR `#66767` and PR `#69995`, plus remaining follow-up polish for setup/hatch recovery.
- Good qualities: embedded mode suppresses runtime console pollution, projects agent events into TUI chat events, queues same-session local sends, resolves local history from session stores, and has a local `/auth` path.
- Bad qualities: local command capability is not yet fully aligned with documented slash commands, and archive discussion shows local model/provider experiences can still fail in confusing ways.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Embedded local chat, Local auth flow, Config repair loop, Gateway-free recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Local-only command semantics need stricter alignment with docs and help text.
- Config repair is documented, but the full repair loop has thinner executable proof than simple local chat.

## Evidence

### Docs

- `docs/web/tui.md:35` documents local mode with `openclaw chat` and `openclaw tui --local`.
- `docs/web/tui.md:144` documents a local TUI config repair workflow.
- `docs/cli/tui.md:60` documents the same config repair loop in the CLI reference.
- `docs/cli/tui.md:44` documents local-only `/auth`.

### Source

- `src/tui/embedded-backend.ts:253` implements `EmbeddedTuiBackend`.
- `src/tui/embedded-backend.ts:270` starts embedded mode, warms context, suppresses runtime logs, and subscribes to agent events.
- `src/tui/embedded-backend.ts:325` sends local chat turns, supports stop commands, and queues same-session runs.
- `src/tui/embedded-backend.ts:382` loads local session history and bounds display history bytes.
- `src/tui/tui-command-handlers.ts:308` implements local `/auth` and rejects it outside local mode.

### Integration tests

- `src/tui/tui-pty-local.e2e.test.ts:249` drives `tui --local` through a mocked model endpoint and waits for terminal output.
- `src/tui/tui-pty-harness.e2e.test.ts:397` verifies message-tool-only internal UI source replies are visible in the terminal loop.

### Unit tests

- `src/tui/embedded-backend.test.ts:748` covers stopping local runs while post-turn maintenance is pending.
- `src/tui/embedded-backend.test.ts:861` covers queued same-session sends behind terminal local runs.
- `src/tui/tui-command-handlers.test.ts:643` runs `/auth` through local auth flow and refreshes session info.
- `src/tui/tui-event-handlers.test.ts:1026` shows concise `/auth` hints for local auth failures.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui commands" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned `#71592`, `#78347`, and other command-surface gaps; `#71592` directly affects local mode command behavior.

Query:

`gitcrawl search issues "TUI local shell" -R openclaw/openclaw --state all --json number,title,url,state --limit 8`

Results:

- Returned `#86632` about local embedded Ollama/Qwen live-data failure and additional TUI terminal-mode issues.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "local embedded tui auth config repair"`

Results:

- Returned maintainer discussion that gateway-free local TUI and config-repair docs landed, with setup/hatch follow-up work still visible.
