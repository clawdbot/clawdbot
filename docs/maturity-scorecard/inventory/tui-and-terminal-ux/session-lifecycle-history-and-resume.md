---
title: "TUI - Session Management Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Session Management Maturity Note

## Summary

The TUI session UX supports agent-scoped keys, last-session resume, bounded
session pickers, history loading, session patching, `/new`, `/reset`, `/abort`,
token/status footer updates, pending user reconciliation, and history refresh
after final events. Coverage is stable for internal state transitions. Quality
is alpha because active reports show session refresh, hook-visible new-session
events, cross-surface activity, and auto-scroll behavior still surprise users.

## Category Scope

Included in this category:

- Session Lifecycle: Covers Session Lifecycle across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- History: Covers History across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- Resume: Covers Resume across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.

## Features

- Session Lifecycle: Covers Session Lifecycle across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- History: Covers History across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- Resume: Covers Resume across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (80%)`
- Positive signals: session actions, command handlers, event handlers, last-session persistence, Gateway history retry, and session store RPCs are well tested.
- Negative signals: cross-client reset/refresh, scroll behavior, and real Gateway restart/session recovery are not proven end to end from a terminal.
- Integration gaps: add a Gateway PTY scenario that resumes last session, handles `/new`, receives external reset/session change, and verifies visible history refresh.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: `gitcrawl search issues "tui session" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned `#49918` for `/new` hook-visible behavior, `#38966` for TUI not refreshing when reset from another client, `#68970` for missed post-restart heartbeat reply, `#45388` for `--session` not live-streaming, `#51825` for no activity indicator on system-injected events, `#44130` for disruptive scroll-jump behavior, and `#81781` for derived-title quality.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui session"` returned release/user discussion about transcript-backed paths, TUI/source replies, and local embedded TUI user sessions.
- Good qualities: session keys are normalized, bounded, agent-aware, and persisted under scoped state; `/new` isolates sessions with TUI-specific keys; `/reset` uses backend session reset.
- Bad qualities: cross-client session refresh and activity visibility are not yet robust enough to prevent stale or misleading terminal state in active user reports.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Stable (80%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Session Lifecycle, History, Resume.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Cross-surface reset/session-change events need clearer terminal behavior.
- Session picker and scroll behavior need more user-centered polish for long-running sessions.

## Evidence

### Docs

- `docs/web/tui.md:60` explains agents and sessions, agent-scoped session keys, global scope, and last-session resume.
- `docs/web/tui.md:82` documents the session picker.
- `docs/web/tui.md:123` documents `/new`, `/reset`, `/abort`, settings, and exit.
- `docs/cli/sessions.md:19` documents bounded session lists and `Gateway sessions.list` behavior.

### Source

- `src/tui/tui.ts:149` resolves raw TUI session keys into global or agent-scoped keys.
- `src/tui/tui-session-actions.ts:73` applies backend agent/session scope results to TUI state.
- `src/tui/tui-session-actions.ts:227` refreshes session info from bounded `sessions.list`.
- `src/tui/tui-session-actions.ts:297` loads history, renders user/assistant/tool messages, and remembers session keys.
- `src/tui/tui-session-actions.ts:378` switches sessions and reloads history.
- `src/tui/tui-command-handlers.ts:582` creates unique `tui-*` sessions for `/new`; `src/tui/tui-command-handlers.ts:600` resets the current session.

### Integration tests

- `src/gateway/server.sessions.store-rpc.test.ts:35` validates Gateway-backed session list, patch, cleanup, reset, compact, delete, and related RPC paths.
- `src/tui/tui-pty-harness.e2e.test.ts:381` sends multiple prompts in order through the terminal loop.

### Unit tests

- `src/tui/tui-session-actions.test.ts:60` verifies queued session refreshes.
- `src/tui/tui-session-actions.test.ts:549` remembers selected sessions after history loads.
- `src/tui/tui-last-session.test.ts:26` persists last session under a scoped hashed key.
- `src/tui/tui-event-handlers.test.ts:692` refreshes history after a non-local chat final.
- `src/tui/tui-command-handlers.test.ts:436` covers `/new` and `/reset`.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui session" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned 10 open reports, including `#49918`, `#38966`, `#68970`, `#45388`, `#51825`, `#44130`, and `#81781`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui session"`

Results:

- Returned release/user discussion referencing transcript-backed paths, CLI/TUI replay, and local embedded TUI session output.
