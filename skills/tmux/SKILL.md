---
name: tmux
description: "Control tmux sessions/panes for interactive CLIs: list, capture output, send keys, paste text, monitor prompts."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧵",
        "os": ["darwin", "linux"],
        "requires": { "bins": ["tmux"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "tmux",
              "bins": ["tmux"],
              "label": "Install tmux (brew)",
            },
          ],
      },
  }
---

# tmux

Use for existing interactive tmux sessions. For one-shot commands, use normal shell. For new non-interactive background jobs, use background execution.

## Basics

```bash
tmux ls
tmux list-windows -t shared
tmux list-panes -t shared:0
tmux capture-pane -t shared:0.0 -p
tmux capture-pane -t shared:0.0 -p -S -
```

Target format: `session:window.pane`, e.g. `shared:0.0`.

## Send input

Literal text, then Enter:

```bash
tmux send-keys -t shared:0.0 -l -- "Please continue"
tmux send-keys -t shared:0.0 Enter
```

Special keys:

```bash
tmux send-keys -t shared:0.0 C-c
tmux send-keys -t shared:0.0 C-d
tmux send-keys -t shared:0.0 Escape
```

Use `-l --` for arbitrary text. Split text and Enter to avoid paste/newline surprises.

## Sessions

```bash
tmux new-session -d -s worker
tmux rename-session -t old new
tmux kill-session -t worker
```

## Prompt checks

```bash
tmux capture-pane -t worker-3 -p | tail -20
tmux capture-pane -t worker-3 -p | rg "proceed|permission|Yes|No|❯"
```

Approve/select only when the prompt is understood:

```bash
tmux send-keys -t worker-3 -l -- "y"
tmux send-keys -t worker-3 Enter
```

## Helpers

- `scripts/find-sessions.sh`: discover sessions.
- `scripts/wait-for-text.sh`: wait until pane output contains text.

## Notes

- `capture-pane -p` prints to stdout for scripts.
- `-S -` captures full scrollback.
- tmux sessions persist across SSH disconnects.
