---
summary: "CLI reference for `openclaw agents` (list/add/delete/bindings/bind/unbind/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "Agents"
---

# `openclaw agents`

Manage isolated agents (workspaces + auth + routing). Running `openclaw agents` with no subcommand is equivalent to `openclaw agents list`.

Related:

- [Multi-agent routing](/concepts/multi-agent)
- [Agent workspace](/concepts/agent-workspace)
- [Skills config](/tools/skills-config): skill visibility configuration.

## Examples

```bash
openclaw agents list
openclaw agents list --bindings
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents add work --workspace ~/.openclaw/workspace-work --bind telegram:*
openclaw agents add ops --workspace ~/.openclaw/workspace-ops --bind telegram:ops --non-interactive
openclaw agents bindings
openclaw agents bind --agent work --bind telegram:ops
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## Command surface

### `agents list`

Options: `--json`, `--bindings` (include full routing rules, not only per-agent counts/summaries).

Provider-status labels include optional account display names beside account IDs.
Routing rules continue to identify accounts by channel and account ID.

Provider rows summarize local account status for the displayed binding scopes.
A wildcard includes each locally known account once; message routing still applies
peer and account precedence. Stored bindings with an omitted or blank account id
refer to the literal `default` account key, independently of a channel's preferred
account for commands. Use `--json --bindings` to include provider rows in JSON.

Identity fields saved in config take precedence. Fields that are not configured
fall back to `IDENTITY.md` in the agent's workspace. Unsupported avatar values
and unreadable local images also fall back to the workspace avatar.

### `agents add [name]`

Options: `--workspace <dir>`, `--model <id>`, `--agent-dir <dir>`, `--bind <channel[:accountId]>` (repeatable), `--non-interactive`, `--json`.

- The automation flags `--workspace`, `--model`, `--agent-dir`, `--bind`, and `--non-interactive` select the non-interactive path. Non-interactive mode requires both an agent name and `--workspace`.
- `--json` alone keeps the guided wizard interactive. Prompts and status are written to stderr, and stdout contains one JSON summary after setup completes.
- `main` is an ordinary agent id. Recreating it after another agent owns the installation can require `openclaw doctor --fix` to repair legacy session or shared-auth ownership first.
- Interactive mode offers optional auth copying. When the fleet has no default agent, choose a source agent or **Skip copying auth profiles** (the default). Selecting a source still requires confirmation before copying. Only portable static credentials (`api_key` and static `token` profiles) are copied unless a credential opts out with `copyToAgents: false`; OAuth refresh-token profiles are not copied unless a provider opts in with `copyToAgents: true`. Without a copy, OAuth stays available through the shared auth base. If the source agent has its own local OAuth profile, sign in separately for the new agent.

### `agents bindings`

Options: `--agent <id>`, `--json`.

### `agents bind`

Options: `--agent <id>` (defaults to the current default agent), `--bind <channel[:accountId]>` (repeatable), `--json`.

### `agents unbind`

Options: `--agent <id>` (defaults to the current default agent), `--bind <channel[:accountId]>` (repeatable), `--all`, `--json`. Accepts either `--all` or one or more `--bind` values, not both.

### `agents set-identity`

Options: `--agent <id>`, `--workspace <dir>`, `--identity-file <path>`, `--from-identity`, `--name <name>`, `--theme <theme>`, `--emoji <emoji>`, `--avatar <value>`, `--json`. See [Set identity](#set-identity) below.

### `agents delete <id>`

Options: `--force`, `--json`.

- The only configured agent cannot be deleted.
- Without `--force`, interactive confirmation is required (fails in a non-TTY session; re-run with `--force`).
- Workspace, agent state, and session transcript directories move to Trash, not hard-deleted. If Trash is unavailable, agent config deletion still succeeds and reports paths requiring manual cleanup; `--json` exposes path outcomes in `removed` and `failed` arrays.
- On installations that have not migrated shared auth yet, the legacy owner cannot be deleted. Run `openclaw doctor --fix`; after relocation into shared state SQLite, `main` follows the same deletion rules as any other agent.
- When the Gateway is reachable, deletion routes through the Gateway so config and session-store cleanup share the same writer as runtime traffic. If the Gateway is unreachable, the CLI falls back to the offline local path and removes the agent's scheduled jobs transactionally. If Gateway credentials are unavailable before the CLI can test reachability, deletion still falls back locally but warns that cron cleanup was skipped because a live scheduler may own the store.
- If another agent's workspace is the same path, inside this workspace, or contains this workspace, the workspace is retained, and `--json` reports `workspaceRetained`, `workspaceRetainedReason`, and `workspaceSharedWith`.

## Routing bindings

Use routing bindings to pin inbound channel traffic to a specific agent.

If you also want different visible skills per agent, configure `agents.defaults.skills` and `agents.entries.*.skills` in `openclaw.json`. See [Skills config](/tools/skills-config) and [Configuration reference](/gateway/config-agents/workspace-and-bootstrap#agents-defaults-skills).

List bindings:

```bash
openclaw agents bindings
openclaw agents bindings --agent work
openclaw agents bindings --json
```

Add bindings:

```bash
openclaw agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

You can also add bindings when creating an agent:

```bash
openclaw agents add work --workspace ~/.openclaw/workspace-work --bind telegram:* --bind discord:*
```

If you omit `accountId` (`--bind <channel>`), OpenClaw resolves it from plugin setup hooks, forced account binding, or the channel's configured account count.

If you omit `--agent` for `bind` or `unbind`, OpenClaw targets the current default agent.

### `--bind` format

| Format                       | Meaning                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `--bind <channel>:*`         | Match all accounts on the channel.                                                                 |
| `--bind <channel>:<account>` | Match one account.                                                                                 |
| `--bind <channel>`           | Match the default account only, unless the CLI can safely resolve a plugin-specific account scope. |

### Binding scope behavior

- A stored binding without `accountId` matches the literal `default` account key only.
- `accountId: "*"` is the channel-wide fallback (all accounts) and is less specific than an explicit account binding.
- If the same agent already has a matching channel binding without `accountId`, and you later bind with an explicit or resolved `accountId`, OpenClaw upgrades that existing binding in place instead of adding a duplicate.

Examples:

```bash
# match all accounts on the channel
openclaw agents bind --agent work --bind telegram:*

# match a specific account
openclaw agents bind --agent work --bind telegram:ops

# initial channel-only binding
openclaw agents bind --agent work --bind telegram

# later upgrade to account-scoped binding
openclaw agents bind --agent work --bind telegram:alerts
```

After the upgrade, routing for that binding is scoped to `telegram:alerts`. If you also want default-account routing, add it explicitly (for example `--bind telegram:default`).

Remove bindings:

```bash
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents unbind --agent work --all
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:

- Example path: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`).

Avatar paths resolve relative to the workspace root and cannot escape it, even through a symlink.

## Set identity

`set-identity` writes fields into `agents.entries.*.identity`: `name`, `theme`, `emoji`, `avatar` (workspace-relative path, http(s) URL, or data URI).

- `--agent` or `--workspace` selects the target agent. If `--workspace` matches more than one agent, the command fails and asks you to pass `--agent`.
- `--workspace` and `--identity-file` only select the agent or identity file. They do not change `agents.entries.*.workspace`.
  For `--json`, `workspace` is the resolved identity directory: the `--workspace` locator, the parent of `--identity-file`, or the agent's workspace when identity is read from there. It is `null` only when identity is supplied through flags with no identity directory. `storedWorkspace` reports the agent's persisted workspace.
- Relocate an existing agent with `openclaw config set agents.entries.<id>.workspace <dir>`, then follow the CLI restart hint and confirm with `openclaw agents list`.
- Local workspace-relative avatar image files are limited to 2 MB. HTTP(S) URLs and `data:` URIs are not checked against the local file-size limit.
- When no explicit identity fields are provided, the command reads identity data from `IDENTITY.md`.

Load from `IDENTITY.md`:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

Override fields explicitly:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

Relocate the stored workspace:

```bash
openclaw config set agents.entries.work.workspace ~/.openclaw/workspace-work
openclaw agents list
```

Config sample:

```json5
{
  agents: {
    entries: {
      main: {
        default: true,
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    },
  },
}
```

## Related

- [CLI reference](/cli)
- [Multi-agent routing](/concepts/multi-agent)
- [Agent workspace](/concepts/agent-workspace)
