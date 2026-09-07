---
summary: "Control-plane tools, node execution, skills, plugins, sandboxing, and per-agent access profiles"
read_when:
  - Deciding which tools an agent may call
  - Sandboxing an agent or a delegated sub-agent run
  - Giving several agents different levels of access on one Gateway
title: "Tool and agent permissions"
sidebarTitle: "Tool permissions"
---

## Control plane tools

Two built-in tools remain control-plane sensitive:

- `gateway` reads config with `config.schema.lookup` / `config.get` and starts owner-requested OpenClaw updates with `update.run`. It has no config-write or standalone restart action; update restart and completion notices are automatic.
- `cron` creates scheduled jobs that keep running after the original chat/task ends.

The `gateway` tool stays owner-only because config reads can expose secrets and host topology and `update.run` changes the running installation. Updates require an explicit user request. Agents request other persistent config or lifecycle changes through the `openclaw` delegation tool. OpenClaw maps them to typed operations and applies the requesting run's effective permission policy: Full Access, including Default (Full Access), authorizes permitted changes without an approval prompt; restricted runs require human approval. Independent tool, filesystem, sandbox, and operation restrictions still apply, and the host revalidates live authority before execution. See [Session permission modes](/gateway/permission-modes#delegated-setup-and-repair) and [OpenClaw setup agent](/cli/openclaw#operations-and-approval).

For any agent/surface handling untrusted content, deny these by default:

```json5
{
  tools: {
    deny: ["gateway", "cron", "sessions_spawn", "sessions_send"],
  },
}
```

`commands.restart=false` disables `/restart` and external `SIGUSR1` restart requests. The `gateway` agent tool has no restart action.

## Node execution (`system.run`)

If a macOS node is paired, the Gateway can invoke `system.run` on it - this is remote code execution on that Mac.

- Requires node pairing (approval + token). Pairing establishes node identity/trust and token issuance; it is not a per-command approval surface.
- The Gateway applies a coarse global node command policy via `gateway.nodes.commands.allow` / `gateway.nodes.commands.deny`. The deny list matches exact node command names only (for example `system.run`), not shell text inside a command payload - a reconnecting node advertising a different command list is not, by itself, a vulnerability if the gateway global policy and the node's own exec approvals still enforce the boundary.
- The per-node `system.run` policy is the node's own exec approvals file (`exec.approvals.node.*`), controlled on the Mac via Settings -> Exec approvals (security + ask + allowlist); it can be stricter or looser than the gateway's global command-ID policy.
- A node running `security="full"` and `ask="off"` follows the default trusted-operator model - expected behavior, not a bug, unless your deployment needs a tighter stance.
- Approval mode binds exact request context and, when possible, one concrete local script/file operand. If OpenClaw cannot identify exactly one direct local file for an interpreter/runtime command, approval-backed execution is denied rather than promising full semantic coverage.
- For `host=node`, approval-backed runs also store a canonical prepared `systemRunPlan`; later approved forwards reuse that stored plan, and gateway validation rejects caller edits to command/cwd/session context after the approval request was created.
- To disable remote execution entirely: set security to `deny` and remove node pairing for that Mac.

## Dynamic skills (watcher / remote nodes)

OpenClaw can refresh the skills list mid-session: the skills watcher updates the snapshot on the next agent turn when `SKILL.md` changes, and connecting a macOS node can make macOS-only skills eligible (based on bin probing). Treat skill folders as trusted code and restrict who can modify them.

## Plugins

Plugins run in-process with the Gateway - treat them as trusted code.

- Only install from sources you trust; prefer explicit `plugins.allow` allowlists; review plugin config before enabling. Restart the Gateway after plugin code, metadata, or discovery-root changes. With the default hybrid reload mode, ordinary config and enablement changes hot-reload unless the plugin declares a restart-triggering prefix.
- Installing/updating plugins runs executable code:
  - The install path is the per-plugin directory under the active plugin install root.
  - ClawHub packages and OpenClaw's bundled/official catalog are trusted sources. A new arbitrary npm, `npm-pack:`, git, local path/archive, or marketplace source warns before install; noninteractive installs require `--force` after you review and trust that source. `--force` confirms provenance and permits overwrite; it does not bypass `security.installPolicy` or remaining install safety checks. Updates reuse the already selected source.
  - OpenClaw does not run built-in local dangerous-code blocking during install/update. Use `security.installPolicy` for operator-owned local allow/warn/block decisions and `openclaw security audit --deep` for diagnostic scanning.
  - npm and git plugin installs run package-manager dependency convergence only during the explicit install/update flow. Local paths and archives are treated as self-contained packages; OpenClaw copies/references them without running `npm install`.
  - Prefer pinned exact versions (`@scope/pkg@1.2.3`) and inspect the unpacked code before enabling.
  - `security.installPolicy` lets operators run a trusted local command to return `allow`, `warn`, or `block` for skill and plugin installs. It runs after source material is staged but before install continues and applies to ClawHub skills too.
  - A `warn` result stops before commit. Interactive CLI commands ask the operator to type the plugin or skill name using the same wording as suspicious ClawHub releases, then re-evaluate policy before continuing. An over-4,000-character rendered review fails closed before prompting. Declined and non-interactive direct CLI commands can use `--acknowledge-install-policy-warning` as explicit approval after review for every warning in that command invocation. The Control UI exposes the same invocation-wide approval through **Install anyway** for plugin installs. Other Gateway-backed and automatic installs remain blocked when they have no operator-confirmation flow. Every approved warning is re-evaluated before continuing. `block` and policy failures remain terminal. Neither `--force` nor the deprecated plugin install/update flag `--dangerously-force-unsafe-install` approves policy warnings.

Details: [Plugins](/tools/plugin)

## Sandboxing

Dedicated doc: [Sandboxing](/gateway/sandboxing)

Two complementary approaches:

- **Full Gateway in Docker** (container boundary): [Docker](/install/docker)
- **Tool sandbox** (`agents.defaults.sandbox`; host gateway + sandbox-isolated tools; built-in Docker and Podman backends): [Sandboxing](/gateway/sandboxing)

<Note>
To prevent cross-agent access, keep `agents.defaults.sandbox.scope` at `"agent"` (default) or use `"session"` for stricter per-session isolation. `scope: "shared"` uses a single container or workspace.
</Note>

Agent workspace access inside the sandbox (`agents.defaults.sandbox.workspaceAccess`):

- `"none"` (default): tools see a sandbox workspace under `~/.openclaw/sandboxes`; agent workspace is off-limits.
- `"ro"`: mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`).
- `"rw"`: mounts the agent workspace read/write at `/workspace`.

Extra `sandbox.docker.binds` are validated against normalized, canonicalized source paths. A blocked-path denylist covers `/etc`, `/private/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, and directories that commonly contain or alias the Docker socket (`/run`, `/var/run`, and `docker.sock` under them), plus HOME credential subpaths (`.aws`, `.cargo`, `.config`, `.docker`, `.gnupg`, `.netrc`, `.npm`, `.ssh`). Parent-symlink tricks and canonical home aliases are resolved through existing ancestors and re-checked, so they still fail closed if they resolve into a blocked root.

<Note>
`tools.elevated` is the global baseline escape hatch that runs exec outside the sandbox. The effective host is `gateway` by default, or `node` when the exec target is configured to `node`. Keep `tools.elevated.allowFrom` tight and do not enable it for strangers. Further restrict per agent via `agents.entries.*.tools.elevated`. See [Elevated mode](/tools/elevated).
</Note>

### Sub-agent delegation guardrail

If you allow session tools, treat delegated sub-agent runs as another boundary decision:

- Deny `sessions_spawn` unless the agent truly needs delegation.
- Keep `agents.defaults.subagents.allowAgents` and any per-agent `agents.entries.*.subagents.allowAgents` overrides restricted to known-safe target agents.
- For workflows that must remain sandboxed, call `sessions_spawn` with `sandbox: "require"` (default is `"inherit"`); `"require"` fails fast when the target child runtime is not sandboxed.

### Read-only mode

Build a read-only profile by combining `agents.defaults.sandbox.workspaceAccess: "ro"` (or `"none"` for no workspace access) with tool allow/deny lists that block `write`, `edit`, `apply_patch`, `exec`, `process`, etc.

- `tools.exec.applyPatch.workspaceOnly: true` (default): keeps `apply_patch` from writing/deleting outside the workspace directory even with sandboxing off. Set `false` only if you intentionally want `apply_patch` to touch files outside the workspace.
- `tools.fs.workspaceOnly: true` (optional): restricts `read`/`write`/`edit`/`apply_patch` paths and native prompt image auto-load paths to the workspace directory.
- Keep filesystem roots narrow - avoid broad roots like your home directory for agent/sandbox workspaces, which can expose sensitive local files (for example state/config under `~/.openclaw`) to filesystem tools.

## Per-agent access profiles (multi-agent)

Each agent can have its own sandbox + tool policy: full access, read-only, or no access. See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence rules.

Common patterns: personal agent (full access, no sandbox), family/work agent (sandboxed + read-only tools), public agent (sandboxed + no filesystem/shell tools).

Tool profiles do not narrow session-tool reach, and sandboxing only clamps the sandboxed caller to its spawn tree; an unsandboxed agent can still read a sandboxed agent's sessions. Session visibility is Gateway-wide and agent-to-agent messaging is on by default, so pair persona profiles with `tools.sessions.visibility` and `tools.agentToAgent` when agents on one Gateway should not see or message each other (see the last example below).

### Full access (no sandbox)

```json5
{
  agents: {
    entries: {
      personal: {
        default: true,
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    },
  },
}
```

### Read-only tools + read-only workspace

```json5
{
  agents: {
    entries: {
      family: {
        default: true,
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
        tools: {
          allow: ["read"],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    },
  },
}
```

### No filesystem/shell access (provider messaging allowed)

```json5
{
  // The default "all" covers every session on the Gateway, including other agents' and other users' transcripts.
  // Explicit tree scope limits non-main callers to current + spawned sessions.
  // Use visibility: "self" for strict current-session access, including main.
  tools: { sessions: { visibility: "tree" } }, // self | tree | agent | all
  agents: {
    entries: {
      public: {
        default: true,
        workspace: "~/.openclaw/workspace-public",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "discord",
            "slack",
            "telegram",
            "whatsapp",
          ],
          deny: [
            "apply_patch",
            "browser",
            "canvas",
            "cron",
            "edit",
            "exec",
            "gateway",
            "image",
            "nodes",
            "process",
            "read",
            "write",
          ],
        },
      },
    },
  },
}
```
