---
summary: "Generated reference for OpenClaw command inventory and effect metadata"
read_when:
  - Looking up available top-level OpenClaw commands
  - Reviewing command effect or provenance metadata
title: "Command inventory"
---

# Command inventory

This page is generated from OpenClaw's static command descriptors. Do not edit it by hand.
Regenerate it with `pnpm docs:commands:gen`; CI verifies freshness with
`pnpm docs:commands:check`.

Use [`openclaw tools commands list`](/cli/index#command-inventory) for the current
invocation's runtime tree and opt-in plugin descriptors. Runtime plugin, paired-node,
and external-provider state is deployment-specific and is not checked into this page.

```bash
openclaw tools commands list
openclaw tools commands list --json
openclaw tools commands list --markdown
openclaw tools commands list --json --plugin-descriptors
openclaw tools commands list --json --node <node-id>
```

The inventory joins static core and sub-CLI descriptors, routed command paths,
commands registered in the current CLI invocation, opt-in plugin CLI descriptors,
and commands advertised by one connected, paired Gateway node when `--node` is supplied.

Human output is Markdown by default. Use `--json` for the versioned machine-readable
shape. `--json` and `--markdown` cannot be combined.

Plugin descriptor discovery is opt-in because it activates plugin registration. When
requested, loader failures and error-level plugin diagnostics fail the command instead
of returning an apparently complete partial inventory. Plugin warnings remain visible
on stderr.

Use `openclaw tools commands inspect <path>` to hydrate one lazy core or sub-CLI group,
resolve runtime aliases, and return the records that match that exact command path.
Unknown paths return `found: false` in JSON or `No matching command was found` in Markdown.

JSON output includes `schemaVersion: 1`, source identity, discovery mode, visibility,
and effect metadata where the owning registry provides it. A live node query is opt-in
with `--node`; the selected node must be connected and paired, and an empty result is
still reported with `nodeCommandScope: "live-gateway-query"` so callers can distinguish
an executed Gateway query from caller-supplied records.

The existing Gateway `commands.list` RPC remains the agent-facing chat, native, skill,
and plugin inventory. This CLI is an operator and developer view and does not replace
that RPC.

An **Unknown** effect means the owning command descriptor has not classified the
command. It does not mean read-only, low risk, or confirmation-free.

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

Generated entries: 64.

| Command          | Description                                                                                                         | Effect                                    | Source   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------- |
| `setup`          | Chat with OpenClaw; onboard when setup is incomplete                                                                | Unknown                                   | `core`   |
| `onboard`        | Guided setup for auth, models, Gateway, workspace, channels, and skills                                             | Unknown                                   | `core`   |
| `configure`      | Interactive configuration for credentials, channels, gateway, and agent defaults                                    | Unknown                                   | `core`   |
| `config`         | Non-interactive config helpers (get/set/patch/unset/file/schema/validate). Run without subcommand for guided setup. | Unknown                                   | `core`   |
| `backup`         | Create and verify backup archives and SQLite snapshots                                                              | Unknown                                   | `core`   |
| `migrate`        | Import state from another agent system                                                                              | Unknown                                   | `core`   |
| `doctor`         | Health checks + quick fixes for the gateway and channels                                                            | Unknown                                   | `core`   |
| `dashboard`      | Open the Control UI with your current token                                                                         | Unknown                                   | `core`   |
| `reset`          | Reset local config/state (keeps the CLI installed)                                                                  | Unknown                                   | `core`   |
| `uninstall`      | Uninstall the gateway service + local data (CLI remains)                                                            | Unknown                                   | `core`   |
| `message`        | Send, read, and manage messages and channel actions                                                                 | Unknown                                   | `core`   |
| `mcp`            | Manage OpenClaw mcp.servers config and channel bridge                                                               | Unknown                                   | `core`   |
| `transcripts`    | Inspect stored transcripts                                                                                          | Unknown                                   | `core`   |
| `agent`          | Run an agent turn via the Gateway (use --local for embedded)                                                        | Unknown                                   | `core`   |
| `agents`         | Manage isolated agents (workspaces + auth + routing)                                                                | Unknown                                   | `core`   |
| `status`         | Show channel health and recent session recipients                                                                   | Unknown                                   | `core`   |
| `health`         | Fetch health from the running gateway                                                                               | Unknown                                   | `core`   |
| `audit`          | Inspect activity records and exact-run identity context                                                             | Unknown                                   | `core`   |
| `sessions`       | List stored conversation sessions                                                                                   | Unknown                                   | `core`   |
| `commitments`    | List and manage inferred follow-up commitments                                                                      | Unknown                                   | `core`   |
| `tasks`          | Inspect durable background tasks and TaskFlow state                                                                 | Unknown                                   | `core`   |
| `acp`            | Run an ACP bridge backed by the Gateway                                                                             | Unknown                                   | `subcli` |
| `gateway`        | Run, inspect, and query the WebSocket Gateway                                                                       | mixed; medium risk; confirmation required | `subcli` |
| `daemon`         | Manage the Gateway service (launchd/systemd/schtasks)                                                               | Unknown                                   | `subcli` |
| `logs`           | Tail gateway file logs via RPC                                                                                      | Unknown                                   | `subcli` |
| `system`         | System tools (events, heartbeat, presence)                                                                          | Unknown                                   | `subcli` |
| `models`         | Model discovery, scanning, and configuration                                                                        | Unknown                                   | `subcli` |
| `promos`         | Discover and claim promotional model offers from ClawHub                                                            | Unknown                                   | `subcli` |
| `infer`          | Run provider-backed inference commands through a stable CLI surface                                                 | Unknown                                   | `subcli` |
| `capability`     | Run provider capability commands (fallback alias: infer)                                                            | Unknown                                   | `subcli` |
| `approvals`      | Manage approval policy and pending requests                                                                         | Unknown                                   | `subcli` |
| `exec-approvals` | Manage exec approvals (alias for approvals)                                                                         | Unknown                                   | `subcli` |
| `exec-policy`    | Show or synchronize requested exec policy with host approvals                                                       | Unknown                                   | `subcli` |
| `nodes`          | Manage gateway-owned nodes (pairing, status, invoke, and media)                                                     | Unknown                                   | `subcli` |
| `devices`        | Device pairing and auth tokens                                                                                      | Unknown                                   | `subcli` |
| `users`          | Manage durable user profiles and email aliases                                                                      | Unknown                                   | `subcli` |
| `node`           | Run and manage the headless node host service                                                                       | Unknown                                   | `subcli` |
| `worker`         | Run the restricted cloud worker runtime                                                                             | Unknown                                   | `subcli` |
| `sandbox`        | Manage sandbox containers (Docker-based agent isolation)                                                            | Unknown                                   | `subcli` |
| `fleet`          | Provision and manage isolated tenant cells (experimental)                                                           | Unknown                                   | `subcli` |
| `worktrees`      | Create, inspect, restore, and clean up managed worktrees                                                            | Unknown                                   | `subcli` |
| `attach`         | Attach Claude Code to a gateway session with scoped MCP tools                                                       | Unknown                                   | `subcli` |
| `tui`            | Open a terminal UI connected to the Gateway                                                                         | Unknown                                   | `subcli` |
| `terminal`       | Open a local terminal UI (alias for tui --local)                                                                    | Unknown                                   | `subcli` |
| `chat`           | Open a local terminal UI (alias for tui --local)                                                                    | Unknown                                   | `subcli` |
| `cron`           | Manage automations (via Gateway)                                                                                    | Unknown                                   | `subcli` |
| `automations`    | Manage automations (alias for cron)                                                                                 | Unknown                                   | `subcli` |
| `dns`            | DNS helpers for wide-area discovery (Tailscale + CoreDNS)                                                           | Unknown                                   | `subcli` |
| `docs`           | Search the live OpenClaw docs                                                                                       | Unknown                                   | `subcli` |
| `proxy`          | Run the OpenClaw debug proxy and inspect captured traffic                                                           | Unknown                                   | `subcli` |
| `hooks`          | Manage internal agent hooks                                                                                         | Unknown                                   | `subcli` |
| `webhooks`       | Webhook helpers and integrations                                                                                    | Unknown                                   | `subcli` |
| `qr`             | Generate a mobile pairing QR code and setup code                                                                    | Unknown                                   | `subcli` |
| `clawbot`        | Legacy clawbot command aliases                                                                                      | Unknown                                   | `subcli` |
| `pairing`        | Secure DM pairing (approve inbound requests)                                                                        | Unknown                                   | `subcli` |
| `plugins`        | Manage OpenClaw plugins and extensions                                                                              | Unknown                                   | `subcli` |
| `channels`       | Manage connected chat channels and accounts                                                                         | Unknown                                   | `subcli` |
| `directory`      | Lookup contact and group IDs (self, peers, groups) for supported chat channels                                      | Unknown                                   | `subcli` |
| `security`       | Audit local config and state for common security foot-guns                                                          | Unknown                                   | `subcli` |
| `secrets`        | Secrets runtime controls                                                                                            | Unknown                                   | `subcli` |
| `skills`         | List and inspect available skills                                                                                   | Unknown                                   | `subcli` |
| `update`         | Update OpenClaw and inspect update channel status                                                                   | Unknown                                   | `subcli` |
| `tools`          | Inspect OpenClaw tool and command metadata                                                                          | Unknown                                   | `subcli` |
| `completion`     | Generate shell completion script                                                                                    | Unknown                                   | `subcli` |
