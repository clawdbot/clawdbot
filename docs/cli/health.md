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
- `--json` always returns the full snapshot: channels, per-account probes, plugin load state, context-engine quarantine state, model-pricing cache state, event-loop health, delivery-queue warnings, and per-agent session stores.
- Top-level `ok: true` means the health RPC succeeded and the Gateway produced a snapshot. Queue warnings do not change it to `false`.
- When outbound or session deliveries, or inbound channel events, are dead-lettered, text output reports their counts and oldest failure age. Inbound counts are grouped by channel account; inspect or recover individual events with [`openclaw channels dead-letters`](/cli/channels#inbound-dead-letters).
- Optional `deliveryQueues.ingressPressure` summarizes durable inbound lanes that may be blocking later events. It is grouped by channel account and never exposes event, lane, payload, error, owner, token, session, or target identifiers. See [Gateway health](/gateway/health#queue-warnings) for the exact qualification and counting semantics.

## Runtime configuration

The `runtimeConfig` object in JSON output compares the configuration loaded by the running Gateway with the reloader's latest completed source observation for model, provider, authentication, and secret-provider paths. It does not read the file directly, so the diagnostic can intentionally lag while watcher debounce or an in-flight reload owns a newer write.

| State     | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ok`      | The loaded values match the latest completed reload observation for the monitored paths.                               |
| `drift`   | The loaded and latest observed values differ. Restart the Gateway, then run `openclaw health --json` again to confirm. |
| `unknown` | The Gateway cannot compare the loaded and latest observed sources. Validate the config and inspect Gateway logs first. |

Gateway health snapshots are shared by health RPC, connection hello, and health broadcasts. The `runtimeConfig` diagnostic therefore never includes config fingerprints or detailed source-observation errors that could reveal paths or parse excerpts, including for admin-scoped clients.

For recovery commands and log guidance, see [Gateway troubleshooting](/gateway/troubleshooting).

## Related

- [CLI reference](/cli)
- [`openclaw status`](/cli/status) — local diagnosis and channel probes without a full health snapshot
- [Gateway health](/gateway/health)
