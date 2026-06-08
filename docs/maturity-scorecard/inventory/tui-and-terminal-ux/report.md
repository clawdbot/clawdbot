---
title: "TUI Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# TUI Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (76%)`
- Quality: `Beta (71%)`
- Completeness: `Beta (76%)`
- LTS Features: `0/5`

## Summary

This report promotes the archived `tui-and-terminal-ux` maturity evidence from `/Users/kevinlin/tmp/maturity/tui-and-terminal-ux` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                     | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Runtime Modes](launch-modes-and-cli-entrypoints.md)                         | ❌  | `Beta (78%)`   | `Beta (72%)`  | `Beta (78%)`   | Gateway TUI launch, Local chat launch, Terminal alias launch, Initial message launch, Launch option validation, Gateway connection, Gateway authentication, History load on attach, Reconnect visibility, Gateway command RPCs, Embedded local chat, Local auth flow, Config repair loop, Gateway-free recovery |
| [Input and Commands](composer-keybindings-and-input-editing.md)              | ❌  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Message composition, Input history, Keyboard shortcuts, Paste and busy-submit handling, IME and AltGr handling, Slash Commands, Pickers, Settings                                                                                                                                                               |
| [Session Management](session-lifecycle-history-and-resume.md)                | ❌  | `Stable (80%)` | `Alpha (68%)` | `Stable (80%)` | Session Lifecycle, History, Resume                                                                                                                                                                                                                                                                              |
| [Local Shell Execution](local-shell-execution-and-approval-boundary.md)      | ❌  | `Beta (70%)`   | `Beta (76%)`  | `Beta (70%)`   | Bang-command routing, Approval prompt, Command output display, Execution environment marker                                                                                                                                                                                                                     |
| [Rendering and Output Safety](streaming-message-rendering-and-tool-cards.md) | ❌  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Streaming Message Rendering, Tool Cards, Terminal Rendering Primitives, Output Safety                                                                                                                                                                                                                           |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Runtime Modes

Search anchors: Gateway TUI launch, Local chat launch, Terminal alias launch, Initial message launch, Launch option validation, keyboard shortcuts, gateway mode, local mode, Gateway connection, Gateway authentication, History load on attach, Reconnect visibility, Gateway command RPCs, Embedded local chat, Local auth flow, Config repair loop, Gateway-free recovery, pickers + overlays.

Category note: [Runtime Modes](launch-modes-and-cli-entrypoints.md)

Score decisions:

- Coverage: `Beta (78%)`
- Quality: `Beta (72%)`
- Completeness: `Beta (78%)`
- LTS: ❌

Features:

- Gateway TUI launch: Covers Gateway TUI launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Local chat launch: Covers Local chat launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Terminal alias launch: Covers Terminal alias launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Initial message launch: Covers Initial message launch across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Launch option validation: Covers Launch option validation across `openclaw tui`, `openclaw chat`, `openclaw terminal`, local-vs-Gateway option validation, launch relaunching from setup/hatch paths, initial message and timeout flags, and launch docs.
- Gateway connection: Covers Gateway connection across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway authentication: Covers Gateway authentication across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- History load on attach: Covers History load on attach across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Reconnect visibility: Covers Reconnect visibility across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Gateway command RPCs: Covers Gateway command RPCs across Gateway connection resolution, token/password/SecretRef auth for TUI, `--url` auth requirements, client mode/capability registration, and related gateway transport, auth, and history behavior.
- Embedded local chat: Covers Embedded local chat across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Local auth flow: Covers Local auth flow across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Config repair loop: Covers Config repair loop across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.
- Gateway-free recovery: Covers Gateway-free recovery across embedded backend lifecycle, local model catalog loading, local `chat.send` event projection, queued local runs, local session history, local `/auth`, local config repair docs, and Gateway-free recovery scenarios.

Primary docs:

- `docs/cli/tui.md`
- `docs/web/tui.md`
- `docs/cli/index.md`

### 2. Input and Commands

Search anchors: Message composition, Input history, Keyboard shortcuts, Paste and busy-submit handling, IME and AltGr handling, gateway mode, local mode, Slash Commands, Pickers, Settings, tui and terminal ux slash commands, pickers, and settings, slash commands, pickers, and settings.

Category note: [Input and Commands](composer-keybindings-and-input-editing.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Message composition: Covers Message composition across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Input history: Covers Input history across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Keyboard shortcuts: Covers Keyboard shortcuts across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Paste and busy-submit handling: Covers Paste and busy-submit handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- IME and AltGr handling: Covers IME and AltGr handling across editor, submit handler, input history, slash/local shell routing, busy-submit behavior, paste fallback, backspace dedupe, Ctrl/Esc shortcuts, AltGr handling, and documented keyboard shortcuts.
- Slash Commands: Covers Slash Commands across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Pickers: Covers Pickers across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.
- Settings: Covers Settings across slash command parsing, command forwarding, local-only commands, model/agent/session selectors, settings overlay, context mode picker, dynamic Gateway command list, session patch commands, and command docs.

Primary docs:

- `docs/web/tui.md`

### 3. Session Management

Search anchors: Session Lifecycle, History, Resume, tui and terminal ux session lifecycle, history, and resume, session lifecycle, history, and resume.

Category note: [Session Management](session-lifecycle-history-and-resume.md)

Score decisions:

- Coverage: `Stable (80%)`
- Quality: `Alpha (68%)`
- Completeness: `Stable (80%)`
- LTS: ❌

Features:

- Session Lifecycle: Covers Session Lifecycle across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- History: Covers History across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.
- Resume: Covers Resume across session-key resolution, last selected session persistence, session picker policy, history loading, and related session lifecycle, history, and resume behavior.

Primary docs:

- `docs/web/tui.md`
- `docs/cli/sessions.md`

### 4. Local Shell Execution

Search anchors: Bang-command routing, Approval prompt, Command output display, Execution environment marker, keyboard shortcuts, gateway mode, local mode, pickers + overlays.

Category note: [Local Shell Execution](local-shell-execution-and-approval-boundary.md)

Score decisions:

- Coverage: `Beta (70%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (70%)`
- LTS: ❌

Features:

- Bang-command routing: Covers Bang-command routing across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Approval prompt: Covers Approval prompt across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Command output display: Covers Command output display across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.
- Execution environment marker: Covers Execution environment marker across `!` routing, local exec approval prompt, Yes/No overlay, command execution, output capture and cap, exit/error rendering, environment marker, cwd handling, and docs that distinguish local host execution from Gateway execution.

Primary docs:

- `docs/web/tui.md`
- `docs/cli/tui.md`

### 5. Rendering and Output Safety

Search anchors: Streaming Message Rendering, Tool Cards, tui and terminal ux streaming message rendering and tool cards, streaming message rendering and tool cards, Terminal Rendering Primitives, Output Safety, tui and terminal ux terminal rendering primitives and output safety, terminal rendering primitives and output safety.

Category note: [Rendering and Output Safety](streaming-message-rendering-and-tool-cards.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

- Streaming Message Rendering: Covers Streaming Message Rendering across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Tool Cards: Covers Tool Cards across chat log rendering, assistant stream assembly, final/error resolution, thinking visibility, and related streaming message rendering and tool cards behavior.
- Terminal Rendering Primitives: Covers Terminal Rendering Primitives across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.
- Output Safety: Covers Output Safety across shared terminal output helpers used by CLI/TUI surfaces: safe stream writing, text sanitization, ANSI/OSC handling, table wrapping, and related terminal rendering primitives and output safety behavior.

Primary docs:

- `docs/web/tui.md`
- `docs/cli/qr.md`
- `docs/cli/logs.md`
- `docs/cli/completion.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/tui-and-terminal-ux/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/tui-and-terminal-ux`.
