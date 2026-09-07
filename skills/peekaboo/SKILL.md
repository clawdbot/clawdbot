---
name: peekaboo
description: "Capture and automate macOS UI with the Peekaboo CLI."
homepage: https://peekaboo.boo
metadata:
  {
    "openclaw":
      {
        "emoji": "👀",
        "os": ["darwin"],
        "requires": { "bins": ["peekaboo"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/peekaboo",
              "bins": ["peekaboo"],
              "label": "Install Peekaboo (brew)",
            },
          ],
      },
  }
---

# Peekaboo

Use Peekaboo to inspect macOS UI, act on the intended target, and verify the result.
The examples below use v4 syntax. Check `peekaboo --version` and the installed
command's `--help`; for older versions, follow that version's help.

## OpenClaw Bridge

The OpenClaw macOS app hosts Peekaboo Bridge when Computer Control is enabled,
its provider is Peekaboo, and Peekaboo Bridge is enabled. Keep the existing
OpenClaw socket selection when running through that host:

```bash
export PEEKABOO_BRIDGE_SOCKET="${PEEKABOO_BRIDGE_SOCKET:-$HOME/Library/Application Support/OpenClaw/bridge.sock}"
peekaboo bridge status --json
```

Confirm that the selected host and socket are the intended ones. Preserve an
explicit `PEEKABOO_BRIDGE_SOCKET` or `--bridge-socket` selection. If the required
host is unavailable, report that outcome; do not clear the selection or switch
Computer Control providers to make a command succeed.

Permissions belong to the process or Bridge host performing the operation.
Do not pass `--no-remote` unless the caller has the required permissions.

## Find the installed command

Use leaf help for flags and targeting requirements instead of copying a flag
between commands. Use root help to discover the available commands:

```bash
peekaboo --help
peekaboo app list --help
peekaboo see --help
peekaboo press --help
peekaboo drag --help
```

V4 removed these old command roots:

| Old command | V4 command                                               |
| ----------- | -------------------------------------------------------- |
| `list apps` | `app list`                                               |
| `image`     | `see --no-elements` for pixels without element detection |
| `hotkey`    | `press` with chords such as `cmd+shift+t`                |
| `swipe`     | `drag --from … --to …`                                   |

For other operations, including clicking, typing, scrolling, and managing windows
or menus, use `peekaboo <command> --help`. Put command options after the leaf
command; `--json` requests structured output.

## Inspect, act, verify

Start with application inventory and a fresh view of the target:

```bash
peekaboo app list --json
peekaboo see --app Safari --window-title "Example" --annotate \
  --path /tmp/peekaboo-example.png --json
```

Read the returned elements before acting. Keep actions tied to the intended app,
window, and fresh snapshot; do not reuse example element IDs. After an action,
inspect the UI again and check the requested result. Refresh the observation when
the window changes or a target becomes stale.

For a screenshot without element detection:

```bash
peekaboo see --mode screen --screen-index 0 --no-elements --retina \
  --path /tmp/peekaboo-screen.png --json
```

Raw keyboard chords require explicit foreground interaction or a fresh
exact-window receipt accepted by `press`. Dragging always moves the shared cursor
and requires `--foreground`. When foreground interaction is authorized:

```bash
peekaboo press cmd+shift+t --app Safari --foreground --json
peekaboo drag --from 100,500 --to 100,200 --duration 800ms --foreground --json
```

Use the actual target and coordinates from the current observation. Prefer
explicit duration units such as `800ms`; consult each command's help for its
options and prerequisites.

## Troubleshooting

- For a removed-command error, use the replacement named by the installed CLI.
- For host or permission failures, inspect `peekaboo bridge status --json` and
  `peekaboo permissions status --json` for the selected host.
- For targeting failures, read the leaf help and obtain fresh UI state with `see`.
- On macOS 15+, the private window picker prompt is separate from the base
  Screen Recording grant and can appear even when Bridge permissions are correct.
