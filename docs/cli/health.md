---
summary: "CLI reference for `openclaw health` (gateway health snapshot via RPC)"
read_when:
  - You want to quickly check the running Gateway's health
title: "Health"
---

# `openclaw health`

Fetch health from the running Gateway.

## Options

| Flag             | Default | Description                                                        |
| ---------------- | ------- | ------------------------------------------------------------------ |
| `--json`         | `false` | Print machine-readable JSON instead of text.                       |
| `--timeout <ms>` | `10000` | Connection timeout in milliseconds.                                |
| `--verbose`      | `false` | Verbose logging. Forces a live probe and expands per-agent output. |
| `--debug`        | `false` | Alias for `--verbose`.                                             |

Examples:

```bash
openclaw health
openclaw health --json
openclaw health --timeout 2500
openclaw health --verbose
openclaw health --debug
```

Notes:

- Default `openclaw health` asks the running gateway for its health snapshot. When the
  gateway already has a fresh cached snapshot, it can return that cached payload and
  refresh in the background.
- `--verbose` forces a live probe, prints gateway connection details, and expands the
  human-readable output across all configured accounts and agents.
- Output includes per-agent session stores when multiple agents are configured.

## Related

- [CLI reference](/cli)
- [Gateway health](/gateway/health)
