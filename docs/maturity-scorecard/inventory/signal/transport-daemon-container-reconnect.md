---
title: "Signal - Transport Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Signal - Transport Maturity Note

## Summary

This note migrates archived maturity evidence for `Signal` / `Transport, Daemon, Container, and Reconnect` into the current process-version-3 scorecard inventory.

## Category Scope

Included in this category:

- Native daemon transport: Covers Native daemon transport routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- Container transport: Covers Container transport routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- API mode selection: Covers API mode selection routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- Receive reconnect/readiness: Covers Receive reconnect/readiness routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.

## Features

- Native daemon transport: Covers Native daemon transport routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- Container transport: Covers Container transport routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- API mode selection: Covers API mode selection routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.
- Receive reconnect/readiness: Covers Receive reconnect/readiness routing, session binding, history, and conversation context for Transport, Daemon, Container, and Reconnect.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (60%)`

Coverage is Alpha because native and container transport paths are documented and unit-tested, but no live SSE or container receive proof was found for the current source.

## Quality Score

- Score: `Alpha (58%)`

Quality is Alpha because the adapter is broad but fresh operator history reports an inbound receive wedge, and source still stops the daemon with a fire-and-forget `SIGTERM` path. Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence; those affect Coverage only.

## Completeness Score

- Score: `Alpha (60%)`
- Surface instructions: evaluated against `references/completeness/signal.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native daemon transport, Container transport, API mode selection, Receive reconnect/readiness.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- See the score-specific negative signals and archived evidence below.

## Evidence

### Docs

- `docs/channels/signal.md` lines 170-183 describe native daemon JSON-RPC plus SSE.
- `docs/channels/signal.md` lines 185-240 describe the bbernhard container REST/WebSocket mode, `apiMode`, `MODE=json-rpc`, supported operations, and operational notes.
- `docs/channels/signal.md` lines 263-268 state that native mode uses SSE, container mode uses WebSocket receive, and both normalize envelopes before routing.
- `docs/channels/signal.md` lines 346-363 list transport troubleshooting commands and common failures.

### Source

- `extensions/signal/src/client-adapter.ts` resolves `apiMode`, caches auto-detected mode, prefers native when available, maps RPC calls to native/container implementations, streams events through native SSE or container WebSocket, and fetches attachments through both adapters.
- `extensions/signal/src/sse-reconnect.ts` runs an abort-aware reconnect loop with backoff after stream end or error.
- `extensions/signal/src/daemon.ts` builds native daemon arguments, resolves `~` config paths, classifies logs, spawns `signal-cli daemon --http`, and exposes stop/exited state.
- `extensions/signal/src/monitor/tool-result.ts` starts the daemon, waits for readiness, streams events, and shuts down on abort.

### Integration tests

- `extensions/signal/src/approval-handler.runtime.test.ts` exercises runtime delivery through the approval adapter but does not prove live Signal transport.
- No live SSE receive or container WebSocket receive scenario was found in `qa/`, `test/`, or `tests`.

### Unit tests

- `extensions/signal/src/client-container.test.ts` validates `/v1/about`, WebSocket upgrade rules, receive-message parsing, REST request mapping, typing, receipts, attachment fetches, reactions, and RPC mapping.
- `extensions/signal/src/monitor.tool-result.autostart.test.ts` covers bounded readiness checks, startup timeout override, config-path daemon args, timeout caps, fast failure on daemon exit, and shutdown after abort.
- `extensions/signal/src/monitor.tool-result.pairs-uuid-only-senders-uuid-allowlist-entry.test.ts` covers reconnect after stream errors.
- `extensions/signal/src/daemon.test.ts` covers config-path expansion and log classification.

### Gitcrawl queries

- Query: `Signal inbound SSE listener wedged channels status`
  - Results: open issue `#75426` reports that outbound and probe can work while inbound DMs are not reliable and `channels status` times out.
- Query: `Signal daemon stop race orphaned`
  - Results: open issue `#22676` reports daemon stop race/orphaned process behavior; open PR `#71863` proposes awaiting daemon shutdown on restart.
- Query: `Signal apiMode container WebSocket receive`
  - Results: no compact current hit proved a live container receive path.

### Discrawl queries

- Query: `Signal apiMode container WebSocket receive`
  - Results: a 2026-04-26 Discord review of PR `#16085` said main then had only native JSON-RPC/SSE and lacked `apiMode`; current source now implements `apiMode`, so this was treated as historical drift to check, not a current failure.
- Query: `Signal daemon stop race orphaned`
  - Results: Discord GitHub mirror comments for issue `#22676` said the race was still unfixed across April reviews.
- Query: `Signal inbound SSE listener wedged channels status`
  - Results: Discord GitHub mirror content matched issue `#75426` and the receive/status wedge report.
