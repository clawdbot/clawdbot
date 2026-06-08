---
title: "TUI - Input and Commands Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI - Input and Commands Maturity Note

## Summary

The TUI input path covers normal messages, slash commands, local shell lines,
history, busy-submit draft preservation, paste burst coalescing, AltGr/Kitty
CSI-u input, and documented keyboard shortcuts. Coverage is broad at the unit
level and has PTY typed-input proof. Quality is beta because multiline
submission, configurable send keybindings, IME friendliness, and cross-terminal
input behavior still have active user-facing reports.

## Category Scope

Included in this category:

- Message composition: Covers Message composition across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Input history: Covers Input history across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Keyboard shortcuts: Covers Keyboard shortcuts across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Paste and busy-submit handling: Covers Paste and busy-submit handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- IME and AltGr handling: Covers IME and AltGr handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Slash Commands: Covers Slash Commands across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Pickers: Covers Pickers across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Settings: Covers Settings across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.

## Features

- Message composition: Covers Message composition across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Input history: Covers Input history across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Keyboard shortcuts: Covers Keyboard shortcuts across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Paste and busy-submit handling: Covers Paste and busy-submit handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- IME and AltGr handling: Covers IME and AltGr handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Slash Commands: Covers Slash Commands across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Pickers: Covers Pickers across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Settings: Covers Settings across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: submit routing, history, busy-state draft preservation, paste coalescing, custom key handlers, AltGr decoding, and PTY typed input are covered.
- Negative signals: cross-terminal IME behavior, configurable send/newline keys, and real CJK/AltGr terminal variants are not comprehensively proven.
- Integration gaps: add PTY scenarios for multiline entry, Shift+Enter or configured send key behavior, and at least one terminal encoding path that previously broke IME/AltGr input.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: `gitcrawl search issues "Shift Enter newline TUI" -R openclaw/openclaw --state all --json number,title,url,state --limit 8` returned open `#10118`, which tracks Shift+Enter newline, configurable Ctrl+Enter, and IME-friendly behavior.
- Discrawl reports: `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Shift Enter newline TUI"` returned discussion that core Shift+Enter behavior may exist through pi-tui, but help-visible/configurable keybindings and IME-friendly behavior are still missing.
- Good qualities: the editor preserves drafts when busy, recognizes important shortcuts, routes `!` only when it is the first raw character, and handles several platform-specific paste/AltGr edge cases.
- Bad qualities: the documented shortcut set is not yet configurable, newline/send ergonomics remain open, and archive signal shows users consider accidental Enter sends high friction.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test depth.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/tui-and-terminal-ux.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Message composition, Input history, Keyboard shortcuts, Paste and busy-submit handling, IME and AltGr handling, Slash Commands, Pickers, Settings.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Configurable send/newline keybindings are not a settled user contract.
- Cross-terminal input behavior is still mostly inferred from unit fixtures rather than real terminal matrix proof.

## Evidence

### Docs

- `docs/web/tui.md:89` lists keyboard shortcuts from Enter through Ctrl+T.
- `docs/web/tui.md:52` describes the input as a text editor with autocomplete.
- `docs/web/tui.md:136` documents `!` local shell routing and the rule that leading spaces do not trigger local exec.

### Source

- `src/tui/components/custom-editor.ts:42` implements `CustomEditor` with shortcut callbacks.
- `src/tui/components/custom-editor.ts:55` handles Alt+Enter, Alt+Up, Ctrl+L/O/P/G/T, Shift+Tab, Esc, Ctrl+C, Ctrl+D, and AltGr printable input.
- `src/tui/tui-submit.ts:3` routes submissions to local shell, slash command, or chat send paths.
- `src/tui/tui-submit.ts:55` enables platform-specific paste burst coalescing.
- `src/tui/tui.ts:216` deduplicates rapid backspace input.

### Integration tests

- `src/tui/tui-pty-harness.e2e.test.ts:368` drives the real terminal loop through typed input.
- `src/tui/tui-pty-harness.e2e.test.ts:429` verifies overlapping normal messages are blocked while a run is busy.

### Unit tests

- `src/tui/tui-input-history.test.ts:4` verifies submitted messages, slash commands, and bang-prefixed lines enter the correct routes and history.
- `src/tui/tui.submit-handler.test.ts:79` preserves the real editor value after a busy submit.
- `src/tui/tui.submit-handler.test.ts:127` covers rapid single-line paste coalescing.
- `src/tui/components/custom-editor.test.ts:33` inserts German AltGr printable Kitty CSI-u input.

### Gitcrawl queries

Query:

`gitcrawl search issues "Shift Enter newline TUI" -R openclaw/openclaw --state all --json number,title,url,state --limit 8`

Results:

- Returned open `#10118` for Shift+Enter newline and configurable send-key behavior.

### Discrawl queries

Query:

`DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "Shift Enter newline TUI"`

Results:

- Returned issue discussion noting remaining configurability and IME-friendly behavior gaps.
