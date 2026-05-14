---
summary: "Use OpenShell as a managed sandbox backend for OpenClaw agents"
title: OpenShell
read_when:
  - You want cloud-managed sandboxes instead of local Docker
  - You are setting up the OpenShell plugin
  - You need to choose between mirror and remote workspace modes
---

OpenShell is a managed sandbox backend for OpenClaw. Instead of running Docker
containers locally, OpenClaw delegates sandbox lifecycle to the `openshell` CLI,
which provisions remote environments with SSH-based command execution.

The OpenShell plugin reuses the same core SSH transport and remote filesystem
bridge as the generic [SSH backend](/gateway/sandboxing#ssh-backend). It adds
OpenShell-specific lifecycle (`sandbox create/get/delete`, `sandbox ssh-config`)
and an optional `mirror` workspace mode.

## Prerequisites

- OpenShell plugin installed (`openclaw plugins install @openclaw/openshell-sandbox`)
- The `openshell` CLI installed and on `PATH` (or set a custom path via
  `plugins.entries.openshell.config.command`)
- An OpenShell account with sandbox access
- OpenClaw Gateway running on the host

## Quick start

1. Install and enable the plugin, then set the sandbox backend:

```bash
openclaw plugins install @openclaw/openshell-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
        },
      },
    },
  },
}
```

2. Restart the Gateway. On the next agent turn, OpenClaw creates an OpenShell
   sandbox and routes tool execution through it.

3. Verify:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Workspace modes

This is the most important decision when using OpenShell.

### `mirror`

Use `plugins.entries.openshell.config.mode: "mirror"` when you want the **local
workspace to stay canonical**.

Behavior:

- Before `exec`, OpenClaw syncs the local workspace into the OpenShell sandbox.
- After `exec`, OpenClaw syncs the remote workspace back to the local workspace.
- File tools still operate through the sandbox bridge, but the local workspace
  remains the source of truth between turns.

Best for:

- You edit files locally outside OpenClaw and want those changes visible in the
  sandbox automatically.
- You want the OpenShell sandbox to behave as much like the Docker backend as
  possible.
- You want the host workspace to reflect sandbox writes after each exec turn.

Tradeoff: extra sync cost before and after each exec.

### `remote`

Use `plugins.entries.openshell.config.mode: "remote"` when you want the
**OpenShell workspace to become canonical**.

Behavior:

- When the sandbox is first created, OpenClaw seeds the remote workspace from
  the local workspace once.
- After that, `exec`, `read`, `write`, `edit`, and `apply_patch` operate
  directly against the remote OpenShell workspace.
- OpenClaw does **not** sync remote changes back into the local workspace.
- Prompt-time media reads still work because file and media tools read through
  the sandbox bridge.

Best for:

- The sandbox should live primarily on the remote side.
- You want lower per-turn sync overhead.
- You do not want host-local edits to silently overwrite remote sandbox state.

<Warning>
If you edit files on the host outside OpenClaw after the initial seed, the remote sandbox does **not** see those changes. Use `openclaw sandbox recreate` to re-seed.
</Warning>

### Choosing a mode

|                          | `mirror`                   | `remote`                  |
| ------------------------ | -------------------------- | ------------------------- |
| **Canonical workspace**  | Local host                 | Remote OpenShell          |
| **Sync direction**       | Bidirectional (each exec)  | One-time seed             |
| **Per-turn overhead**    | Higher (upload + download) | Lower (direct remote ops) |
| **Local edits visible?** | Yes, on next exec          | No, until recreate        |
| **Best for**             | Development workflows      | Long-running agents, CI   |

## Configuration reference

All OpenShell config lives under `plugins.entries.openshell.config`:

| Key                       | Type                     | Default       | Description                                           |
| ------------------------- | ------------------------ | ------------- | ----------------------------------------------------- |
| `mode`                    | `"mirror"` or `"remote"` | `"mirror"`    | Workspace sync mode                                   |
| `command`                 | `string`                 | `"openshell"` | Path or name of the `openshell` CLI                   |
| `from`                    | `string`                 | `"openclaw"`  | Sandbox source for first-time create                  |
| `gateway`                 | `string`                 | —             | OpenShell gateway name (`--gateway`)                  |
| `gatewayEndpoint`         | `string`                 | —             | OpenShell gateway endpoint URL (`--gateway-endpoint`) |
| `policy`                  | `string`                 | —             | OpenShell policy ID for sandbox creation              |
| `providers`               | `string[]`               | `[]`          | Provider names to attach when sandbox is created      |
| `gpu`                     | `boolean`                | `false`       | Request GPU resources                                 |
| `autoProviders`           | `boolean`                | `true`        | Pass `--auto-providers` during sandbox create         |
| `remoteWorkspaceDir`      | `string`                 | `"/sandbox"`  | Primary writable workspace inside the sandbox         |
| `remoteAgentWorkspaceDir` | `string`                 | `"/agent"`    | Agent workspace mount path (for read-only access)     |
| `timeoutSeconds`          | `number`                 | `120`         | Timeout for `openshell` CLI operations                |

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) are configured under
`agents.defaults.sandbox` as with any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

## Examples

### Minimal remote setup

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
        },
      },
    },
  },
}
```

### Mirror mode with GPU

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "openshell",
        scope: "agent",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "mirror",
          gpu: true,
          providers: ["openai"],
          timeoutSeconds: 180,
        },
      },
    },
  },
}
```

### Per-agent OpenShell with custom gateway

```json5
{
  agents: {
    defaults: {
      sandbox: { mode: "off" },
    },
    list: [
      {
        id: "researcher",
        sandbox: {
          mode: "all",
          backend: "openshell",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
    ],
  },
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          from: "openclaw",
          mode: "remote",
          gateway: "lab",
          gatewayEndpoint: "https://lab.example",
          policy: "strict",
        },
      },
    },
  },
}
```

## Lifecycle management

OpenShell sandboxes are managed through the normal sandbox CLI:

```bash
# List all sandbox runtimes (Docker + OpenShell)
openclaw sandbox list

# Inspect effective policy
openclaw sandbox explain

# Recreate (deletes remote workspace, re-seeds on next use)
openclaw sandbox recreate --all
```

For `remote` mode, **recreate is especially important**: it deletes the canonical
remote workspace for that scope. The next use seeds a fresh remote workspace from
the local workspace.

For `mirror` mode, recreate mainly resets the remote execution environment because
the local workspace remains canonical.

### When to recreate

Recreate after changing any of these:

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`

```bash
openclaw sandbox recreate --all
```

## Security hardening

OpenShell pins the workspace root fd and rechecks sandbox identity before each
read, so symlink swaps or a remounted workspace cannot redirect reads out of
the intended remote workspace.

## Current limitations

- Sandbox browser is not supported on the OpenShell backend.
- `sandbox.docker.binds` does not apply to OpenShell.
- Docker-specific runtime knobs under `sandbox.docker.*` apply only to the Docker
  backend.

## How it works

1. OpenClaw calls `openshell sandbox create` (with `--from`, `--gateway`,
   `--policy`, `--providers`, `--gpu` flags as configured).
2. OpenClaw calls `openshell sandbox ssh-config <name>` to get SSH connection
   details for the sandbox.
3. Core writes the SSH config to a temp file and opens an SSH session using the
   same remote filesystem bridge as the generic SSH backend.
4. In `mirror` mode: sync local to remote before exec, run, sync back after exec.
5. In `remote` mode: seed once on create, then operate directly on the remote
   workspace.

## Related

- [Sandboxing](/gateway/sandboxing) -- modes, scopes, and backend comparison
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- debugging blocked tools
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides
- [Sandbox CLI](/cli/sandbox) -- `openclaw sandbox` commands
