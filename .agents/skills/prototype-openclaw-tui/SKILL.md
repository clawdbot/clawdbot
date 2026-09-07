---
name: prototype-openclaw-tui
description: Build throwaway, fixture-driven OpenClaw Clack or Pi TUI prototypes and compare multiple interactive variants side by side in tmux without running the full application or touching live state.
user-invocable: true
disable-model-invocation: true
---

# Prototype OpenClaw TUI

Use this skill to isolate one OpenClaw terminal surface, render it with the
real OpenClaw TUI stack, and compare two to six design variants in tmux.

## Rules

- Read the root and scoped `AGENTS.md` files before editing.
- Keep the prototype beside the target and name it `*.prototype.ts`.
- When iterating on an existing surface, include its current implementation as
  the first `baseline` variant with the same fixture data. Only omit the
  baseline when the user explicitly asks for a greenfield comparison.
- Use the real OpenClaw renderer, theme, copy, and component where practical.
- Replace scanning, models, network calls, installs, config writes, SQLite, and
  other durable effects with deterministic in-memory fixtures.
- Do not run the full OpenClaw application when the isolated surface is enough.
- Treat prototype code as throwaway. Do not promote it directly to production.
- Preserve unrelated and pre-existing worktree changes.

## Choose the renderer

- Wizard, onboarding, configuration, doctor, selection, or progress surface:
  use `createClackPrompter()` from `src/wizard/clack-prompter.ts`.
- Agent shell, chat, overlay, editor, selector, or `src/tui/**` component:
  use `@earendil-works/pi-tui` and the existing OpenClaw component.

Do not invent a shared Clack/Pi abstraction. They are separate prototype
recipes joined only by the tmux comparison loop.

## Workflow

1. Read the target module, its renderer adapter, callers, and adjacent tests.
2. Create the smallest executable harness that reaches the target surface.
3. If the surface already exists, make the no-argument invocation render its
   current implementation unchanged as `--variant=baseline`.
4. Add structurally different alternatives behind `--variant=<id>`, for two
   to six total variants including the baseline.
5. Give every variant the same fixture data and terminal dimensions.
6. Run each variant directly in its own tmux pane. Do not pipe interactive TUI
   output; tmux must provide the PTY.
7. Iterate on the harness with the launcher's `--refresh` mode. Respawn the
   panes in the existing session; do not kill the session or reopen the user's
   terminal.
8. After the user chooses a direction, carry the decision into production code
   with normal tests and validation. Remove or separately capture the prototype.

## Launch the comparison grid

Run the bundled launcher with a session name, repository path, then title and
command pairs:

```bash
.agents/skills/prototype-openclaw-tui/scripts/launch-tmux-grid.sh \
  --open \
  app-recommendations-prototype "$PWD" \
  "A - Baseline" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=baseline" \
  "B - Grouped" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=grouped" \
  "C - Focused" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=focused"
```

After editing the prototype, run the same command with `--refresh` instead of
`--open`. This preserves the tmux session, attached external terminal, window,
and first pane while restarting all pane commands and reapplying the grid:

```bash
.agents/skills/prototype-openclaw-tui/scripts/launch-tmux-grid.sh \
  --refresh \
  app-recommendations-prototype "$PWD" \
  "A - Baseline" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=baseline" \
  "B - Grouped" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=grouped" \
  "C - Focused" "node --import tsx src/wizard/setup.app-recommendations.prototype.ts --variant=focused"
```

The launcher refuses to replace an existing session unless `--refresh` is
explicitly provided. `--open` uses the user's
`.command`-associated terminal app on macOS, Windows Terminal from WSL, or the
first available Linux launcher from `xdg-terminal-exec`, `$TERMINAL`, and
`x-terminal-emulator`. If no supported launcher is available, the tmux session
remains ready at equal detached dimensions and the script exits successfully
after printing the manual attach command. Attach, then run `--refresh` once to
adopt the terminal's larger dimensions. The same guidance applies if an
external terminal opens but does not attach within ten seconds. When invoked
from a non-interactive `TERM=dumb` environment, the launcher removes its
inherited `NO_COLOR` only from prototype pane processes so the external
terminal can detect and render its normal colors. Prefer the external terminal
over the Codex in-app terminal unless the user asks for the in-app surface.
Leave the session running for user review unless asked to stop it.

## Handoff

Report:

- the prototype path and exact run command;
- the tmux session name and attach command;
- which effects were replaced with fixtures;
- available variant ids;
- whether the prototype changed production code (normally no).
