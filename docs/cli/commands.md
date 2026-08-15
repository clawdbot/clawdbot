---
summary: "List and inspect the command surfaces known to OpenClaw"
read_when:
  - Building command inventory, compliance, diagnostics, or documentation tooling
  - Inspecting command provenance and effect data
title: "Commands"
---

# `openclaw tools commands`

`openclaw tools commands` provides a read-only inventory of command information OpenClaw already
owns. It does not execute commands, grant permission, or enforce policy.

## List commands

```bash
openclaw tools commands list
openclaw tools commands list --json
openclaw tools commands list --markdown
openclaw tools commands list --json --plugin-descriptors
openclaw tools commands list --json --node <node-id>
```

The inventory joins these command-owned sources:

- static core and sub-CLI descriptors
- routed command paths and their operation metadata
- commands registered in the current CLI invocation
- plugin CLI descriptors when `--plugin-descriptors` is supplied
- commands advertised by one connected, paired Gateway node when `--node` is supplied

Human output is Markdown by default. Use `--json` for the versioned machine-readable shape.
`--json` and `--markdown` cannot be combined.

Plugin descriptor discovery is opt-in because it activates plugin registration. When requested,
loader failures and error-level plugin diagnostics fail the command instead of returning an
apparently complete partial inventory. Plugin warnings remain visible on stderr.

## Inspect one path

```bash
openclaw tools commands inspect gateway
openclaw tools commands inspect nodes run --json
openclaw tools commands inspect memory --json --plugin-descriptors
```

`inspect` hydrates the requested lazy core or sub-CLI group, resolves runtime aliases, and returns
the records that match that exact command path. The result includes `found`, the requested and
resolved paths, and matching descriptors, routes, routed operations, runtime registrations, plugin
registrations, and caller-supplied node records.

An unknown path returns `found: false` in JSON or `No matching command was found` in Markdown.

## Inventory semantics

The JSON result includes `schemaVersion: 1`, source identity, discovery mode, visibility, and effect
metadata where the owning registry provides it. Missing effect metadata is not a safety claim.
Callers should not infer that an unannotated command is read-only or low risk.

The current runtime command scope is the command tree registered for this invocation. Plugin
commands appear only with `--plugin-descriptors`. A live node query is opt-in with `--node`; the
selected node must be connected and paired, and an empty result is still reported with
`nodeCommandScope: "live-gateway-query"` so callers can distinguish an executed Gateway query from
caller-supplied records.

The existing Gateway `commands.list` RPC remains the agent-facing chat, native, skill, and plugin
inventory. This CLI is an operator and developer view and does not replace that RPC.

## Options

| Flag                   | Meaning                                                           |
| ---------------------- | ----------------------------------------------------------------- |
| `--json`               | Emit the versioned JSON inventory.                                |
| `--markdown`           | Emit Markdown explicitly; this is the default human format.       |
| `--plugin-descriptors` | Load plugin CLI descriptors and include their command shape.      |
| `--node <node-id>`     | Query one connected, paired Gateway node for advertised commands. |
| `--url <url>`          | Gateway WebSocket URL for the live node query.                    |
| `--token <token>`      | Gateway token for the live node query.                            |
| `--timeout <ms>`       | Gateway timeout in milliseconds for the live node query.          |

## Related

- [CLI reference](/cli)
- [Plugin SDK](/plugins/sdk-overview)
- [`openclaw nodes`](/cli/nodes)
