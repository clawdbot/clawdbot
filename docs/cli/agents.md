---
summary: "CLI reference for `openclaw agents` (roles, teams, workspaces, routing, and identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
  - You want to create an agent from a role or set up a coordinated team
  - You want to export or import a portable agent template
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
openclaw agents add research --role researcher --non-interactive
openclaw agents export research --out ./research-template
openclaw agents import ./research-template --id research-copy --non-interactive
openclaw agents team create --non-interactive
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

Identity fields saved in config take precedence. Fields that are not configured
fall back to `IDENTITY.md` in the agent's workspace. Unsupported avatar values
and unreadable local images also fall back to the workspace avatar.

### `agents add [name]`

Options: `--role <role>`, `--workspace <dir>`, `--model <id>`, `--agent-dir <dir>`, `--bind <channel[:accountId]>` (repeatable), `--non-interactive`, `--json`.

- The automation flags `--workspace`, `--model`, `--agent-dir`, `--bind`, and `--non-interactive` select the non-interactive path. Non-interactive mode requires an agent name and, unless `--role` is supplied, `--workspace`.
- `--json` alone keeps the guided wizard interactive. Prompts and status are written to stderr, and stdout contains one JSON summary after setup completes.
- Non-interactive `--json` reports normalized agent IDs in the summary without extra stdout status messages.
- `main` is an ordinary agent id. Recreating it after another agent owns the installation can require `openclaw doctor --fix` to repair legacy session or shared-auth ownership first.
- Interactive mode offers optional auth copying. When the fleet has no default agent, choose a source agent or **Skip copying auth profiles** (the default). Selecting a source still requires confirmation before copying. Only portable static credentials (`api_key` and static `token` profiles) are copied unless a credential opts out with `copyToAgents: false`; OAuth refresh-token profiles are not copied unless a provider opts in with `copyToAgents: true`. Without a copy, OAuth stays available through the shared auth base. If the source agent has its own local OAuth profile, sign in separately for the new agent.

#### Role templates

`--role` works in interactive and non-interactive creation, including `--json`.
Available roles:

| Role          | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `coordinator` | Delegate bounded tasks to matching specialists and verify their results. |
| `researcher`  | Gather evidence and return a cited research brief.                       |
| `writer`      | Turn a brief and source material into a usable draft.                    |
| `reviewer`    | Check artifacts against requirements and return actionable findings.     |

A role seeds `AGENTS.md`, `SOUL.md`, and a complete `IDENTITY.md`; `USER.md`
still uses the standard template. Existing workspace files are preserved. The
role's name, emoji, and theme are saved in agent config, and new role workspaces
skip the identity ceremony: no `BOOTSTRAP.md` is created. A manifest's `skills`
allowlist applies only when present; the bundled roles leave skills unchanged.
Role delegation settings are also applied. Standalone coordinators target the
standard specialist ids; use the team command to create and wire all four agents.
Unknown roles are rejected with the available role names. A workspace with an
unfinished bootstrap cannot adopt a role; complete its bootstrap or choose a
new workspace.

<a id="agents-export" />

### `agents export <id>`

Options: `--out <dir>` (required), `--force`, `--json`.

Exports a portable template directory containing `manifest.json`,
`workspace/AGENTS.md`, `workspace/SOUL.md`, `workspace/IDENTITY.md`, and optional
`automations.json`. The manifest carries identity, explicit agent-level skills
and model settings, and delegation settings. It does not copy inherited skills
or model defaults.

The output directory must be empty unless `--force` is supplied. The omissions
report identifies excluded material, including `USER.md`, memory, credentials,
sessions, and unsupported automations. Only `agentTurn` jobs both owned by and
executed by the exported agent qualify; `systemEvent`, `command`, and `script`
payloads are skipped. Automations omit delivery destinations and runtime state.

Export refuses probable secrets in Markdown or JSON and reports the file and
line without printing the matched value. Remove the secret from the source and
retry; there is no `--allow-secrets` bypass. Detection is a conservative check,
so review the bundle for sensitive content before sharing it. Embedded absolute
local paths must also be removed for portability.

### `agents import <dir>`

Options: `--id <newId>`, `--workspace <dir>`, `--non-interactive`, `--json`.

When omitted, `--id` defaults to the normalized identity name from the manifest;
`--workspace` uses the normal workspace default for that agent id.

Validates a template, shows a summary, and confirms before writing in interactive
mode. Use `--non-interactive` for unattended import. `--json` returns a structured
summary. Import refuses an existing agent id or a workspace containing files;
choose a new id and workspace instead of overwriting an existing agent.

The new agent receives the template identity and workspace program files,
explicit skills and model settings, and `delegationMode` unchanged. Delegation
targets remain agent ids: import keeps only ids already present in the target
installation and warns with the dropped ids. If all targets are dropped,
`subagents.allowAgents` is omitted. No role-name matching occurs.

Imported automations are created **disabled**, with their owner and execution
agent retargeted to the new id. Review their instructions and schedules before
enabling them. Import skips the identity ceremony and creates no `BOOTSTRAP.md`.

Both commands enforce file size and path restrictions. See the
[Agent template format](/reference/agent-templates) for the exact manifest,
automation fields, exclusions, and limits.

### `agents team create`

Options: `--preset <name>` (default and only bundled preset: `team`),
`--coordinator <id>` (default: `coordinator`), `--prefix <p>`,
`--workspace-root <dir>`, `--non-interactive`, `--json`.

Creates a coordinator plus `researcher`, `writer`, and `reviewer` from the role
templates. Each workspace lives at `<workspace-root>/<agentId>`; the default
root is the installation's default workspace directory. `--prefix editorial`
namespaces every id, producing `editorial-coordinator`, `editorial-researcher`,
`editorial-writer`, and `editorial-reviewer`. It also prefixes a custom
`--coordinator` id. If any resulting id exists, the command reports the conflicts
and adds no agents.

Existing agents remain in place, including an implicit `main` on an already
configured installation.

```bash
openclaw agents team create --prefix editorial --workspace-root ~/agents --non-interactive --json
openclaw agent --agent editorial-coordinator --message "Research this topic and draft a brief."
```

The coordinator's `subagents.allowAgents` names the three specialist ids and
`delegationMode` is `"prefer"`. Specialists receive `subagents.allowAgents: []`
and instructions to return results without further delegation. This does not
change global delegation defaults or tool policy. See [Team preset](/concepts/multi-agent#team-preset).

The coordinator is an explicit chat target, not a universal default agent. If
`agents.defaults.systemAgent.agentId` is unset, team creation sets it to the
coordinator for ambient system work. An existing ambient owner is preserved and
reported. Channel routing still needs bindings to the intended agent.
With `--json`, the summary includes `coordinatorId`, the created `agents` and
their paths, `ambientOwnerId`, and a `note` when another ambient owner is retained.

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

If you also want different visible skills per agent, configure `agents.defaults.skills` and `agents.entries.*.skills` in `openclaw.json`. See [Skills config](/tools/skills-config) and [Configuration reference](/gateway/config-agents#agents-defaults-skills).

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
