---
title: "TUI - Slash Commands, Pickers, and Settings Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Slash Commands, Pickers, and Settings Maturity Note

## Summary

TUI command UX is substantial: model, agent, session, settings, status,
context, thinking, fast, verbose, trace, reasoning, usage, elevated, activation,
delivery, new/reset/abort, exit, and local `/auth` paths are implemented. It
also supports searchable/filterable pickers and dynamic Gateway command
autocomplete. Quality is beta because local-vs-Gateway command semantics,
plugin slash command dispatch, command descriptions, and competitive TUI gaps
remain active issues.

## Category Scope

This category covers slash command parsing, command forwarding, local-only
commands, model/agent/session selectors, settings overlay, context mode picker,
dynamic Gateway command list, session patch commands, and command docs.

## Features

- Slash Commands: Covers Slash Commands across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Pickers: Covers Pickers across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Settings: Covers Settings across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: command handlers are unit-tested for pickers, forwarding, status, context, session patching, busy-state blocking, `/auth`, `/new`, `/reset`, stop routing, and model refs.
- Negative signals: plugin-owned command dispatch and dynamic autocomplete have thinner end-to-end proof, and local-mode command semantics remain partially divergent.
- Integration gaps: add a PTY scenario that loads `commands.list`, autocompletes a plugin command, dispatches it, and verifies local mode rejects or handles unsupported Gateway commands predictably.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: `gitcrawl search issues "tui commands" -R openclaw/openclaw --state all --json number,title,url,state --limit 10` returned `#71592` for local command fallthrough, `#78347` for plugin slash command dispatch gaps in `openclaw agent` and TUI, `#79458` for command description i18n fields, and `#86534` for competitive TUI gaps.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui commands"` returned discussion that PR `#83640` wires TUI slash autocomplete to Gateway command list so plugin-owned commands show up.
- Good qualities: selector UX is searchable/filterable, command failures render as system messages, and session/model settings patch the authoritative backend rather than only local UI state.
- Bad qualities: command discoverability and dispatch are still catching up to plugin-owned commands and local mode; some command help can advertise behavior that is not actually available in a mode.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Slash Commands, Pickers, Settings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Local-mode command set needs a stricter compatibility table.
- Plugin slash command discovery and dispatch need a full user-flow proof from autocomplete to command result.

## Evidence

### Docs

- `docs/web/tui.md:82` documents model, agent, session, and settings pickers.
- `docs/web/tui.md:101` lists core slash commands.
- `docs/web/tui.md:111` lists session controls such as thinking, fast, verbose, trace, reasoning, usage, elevated, activation, and delivery.
- `docs/web/tui.md:123` lists session lifecycle commands.

### Source

- `src/tui/tui-command-handlers.ts:129` builds the model selector and patches the session model.
- `src/tui/tui-command-handlers.ts:165` builds the agent selector.
- `src/tui/tui-command-handlers.ts:207` builds the recent session selector.
- `src/tui/tui-command-handlers.ts:256` builds settings for tool output and thinking visibility.
- `src/tui/tui-command-handlers.ts:293` dispatches slash commands and forwards unknown commands through the backend.
- `src/tui/gateway-chat.ts:258` exposes `commands.list` for dynamic command discovery.

### Integration tests

- `src/tui/tui-pty-harness.e2e.test.ts:368` exercises typed input through the real terminal loop.
- `src/tui/tui-pty-harness.e2e.test.ts:397` verifies a command/tool-source response is rendered in the terminal.

### Unit tests

- `src/tui/tui-command-handlers.test.ts:175` covers bounded session picker hydration.
- `src/tui/tui-command-handlers.test.ts:257` opens context mode selector for `/context`.
- `src/tui/tui-command-handlers.test.ts:305` forwards `/status` to the shared command path.
- `src/tui/tui-command-handlers.test.ts:436` creates unique TUI sessions for `/new` and resets shared sessions for `/reset`.
- `src/tui/tui-command-handlers.test.ts:715` uses canonical model refs in the model selector.

### Gitcrawl queries

Query:

`gitcrawl search issues "tui commands" -R openclaw/openclaw --state all --json number,title,url,state --limit 10`

Results:

- Returned 10 open reports, including `#71592`, `#78347`, `#79458`, `#10118`, `#81547`, `#56856`, `#86534`, and `#81781`.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "tui commands"`

Results:

- Returned discussion of PR `#83640`, which wires TUI slash autocomplete to the Gateway command list for plugin-owned commands.
