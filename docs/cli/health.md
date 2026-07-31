---
summary: "CLI reference for `openclaw health` (gateway health snapshot via RPC)"
read_when:
  - You want to quickly check the running Gateway's health
title: "Health"
---

# `openclaw health`

Fetch a health snapshot from the running Gateway over WebSocket RPC (no direct channel sockets from the CLI).

## Options

| Flag             | Default | Description                                                                       |
| ---------------- | ------- | --------------------------------------------------------------------------------- |
| `--json`         | `false` | Print machine-readable JSON instead of text.                                      |
| `--timeout <ms>` | `10000` | Connection timeout in milliseconds.                                               |
| `--verbose`      | `false` | Forces a live probe and expands output across all configured accounts and agents. |
| `--debug`        | `false` | Alias for `--verbose`.                                                            |

Examples:

```bash
openclaw health
openclaw health --json
openclaw health --timeout 2500
openclaw health --verbose
openclaw health --debug
```

## Behavior

- Without `--verbose`, the Gateway can return a cached snapshot (fresh for up to 60 seconds and unchanged from live channel runtime state) and refresh it in the background for the next caller.
- `--verbose` forces a live probe (per-channel account probes), prints Gateway connection details, and expands human-readable output across all configured accounts and agents instead of just the default agent.
- `--json` always returns the full snapshot: channels, per-account probes, plugin load state, context-engine quarantine state, model-pricing cache state, event-loop health, delivery-queue dead letters, and per-agent session stores.
- When outbound deliveries or inbound channel events are dead-lettered, text output reports their counts and oldest failure age. Inbound counts are grouped by channel account; inspect or recover individual events with [`openclaw channels dead-letters`](/cli/channels#inbound-dead-letters).

## Related

- [CLI reference](/cli)
- [`openclaw status`](/cli/status) — local diagnosis and channel probes without a full health snapshot
- [Gateway health](/gateway/health)
