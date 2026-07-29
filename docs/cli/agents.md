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

### `agents add [name]`

Options: `--workspace <dir>`, `--model <id>`, `--agent-dir <dir>`, `--bind <channel[:accountId]>` (repeatable), `--non-interactive`, `--json`.

- Passing any explicit add flag switches the command into the non-interactive path.
- Non-interactive mode requires both an agent name and `--workspace`.
- `main` is reserved and cannot be used as the new agent id.
- Interactive mode seeds auth by copying only portable static credentials (`api_key` and static `token` profiles) unless a credential opts out with `copyToAgents: false`; OAuth refresh-token profiles are not copied unless a provider opts in with `copyToAgents: true`. Without a copy, OAuth stays available only through read-through inheritance from the real `main` agent store. If the configured default agent is not `main`, sign in separately for OAuth profiles on the new agent.

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

- `main` cannot be deleted.
- Without `--force`, interactive confirmation is required (fails in a non-TTY session; re-run with `--force`).
- Workspace, agent state, and session transcript directories move to Trash, not hard-deleted. If Trash is unavailable, agent config deletion still succeeds and reports paths requiring manual cleanup.
- When the Gateway is reachable, deletion routes through the Gateway so config and session-store cleanup share the same writer as runtime traffic. If the Gateway is unreachable, the CLI falls back to the offline local path.
- If another agent's workspace is the same path, inside this workspace, or contains this workspace, the workspace is retained, and `--json` reports `workspaceRetained`, `workspaceRetainedReason`, and `workspaceSharedWith`.

## Routing bindings

Use routing bindings to pin inbound channel traffic to a specific agent.

If you also want different visible skills per agent, configure `agents.defaults.skills` and `agents.entries.*.skills` in `openclaw.json`. See [Skills config](/tools/skills-config) and [Configuration reference](/gateway/config-agents#agentsdefaultsskills).

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

- A stored binding without `accountId` matches the channel default account only.
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

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```

## Related

- [CLI reference](/cli)
- [Multi-agent routing](/concepts/multi-agent)
- [Agent workspace](/concepts/agent-workspace)
