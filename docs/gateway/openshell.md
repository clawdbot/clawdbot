---
summary: "Use OpenShell as a managed sandbox backend for OpenClaw agents"
title: OpenShell
read_when:
  - You want cloud-managed sandboxes instead of local Docker
  - You are setting up the OpenShell plugin
  - You need to choose between mirror and remote workspace modes
---

OpenShell is a managed sandbox backend: instead of running Docker containers
locally, OpenClaw delegates sandbox lifecycle to the `openshell` CLI, which
provisions remote environments and executes commands over SSH.

The plugin reuses the same SSH transport and remote filesystem bridge as the
generic [SSH backend](/gateway/sandboxing#ssh-backend), and adds OpenShell
lifecycle (`sandbox create/get/delete/ssh-config`) plus an optional `mirror`
workspace sync mode.

## Prerequisites

- OpenShell plugin installed (`openclaw plugins install @openclaw/openshell-sandbox`)
- `openshell` CLI on `PATH` (or a custom path via
  `plugins.entries.openshell.config.command`)
- An OpenShell account with sandbox access
- OpenClaw Gateway running on the host

## Quick start

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

Restart the Gateway. On the next agent turn OpenClaw creates an OpenShell
sandbox and routes tool execution through it. Verify with:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Workspace modes

This is the most important OpenShell decision.

### mirror (default)

`plugins.entries.openshell.config.mode: "mirror"` keeps the **local workspace
canonical**:

- Before `exec`, OpenClaw syncs the local workspace into the sandbox.
- After `exec`, OpenClaw syncs the remote workspace back to local.
- File tools go through the sandbox bridge, but local stays source of truth
  between turns.

Best for development workflows: local edits outside OpenClaw show up on the
next exec, and the sandbox behaves close to the Docker backend.

Tradeoff: upload + download cost on every exec turn.

### remote

`mode: "remote"` makes the **OpenShell workspace canonical**:

- On first sandbox creation, OpenClaw seeds the remote workspace from local
  once.
- After that, `exec`, `read`, `write`, `edit`, and `apply_patch` operate
  directly on the remote workspace. OpenClaw does **not** sync remote changes
  back to local.
- Prompt-time media reads still work (file/media tools read through the
  sandbox bridge).

Best for long-running agents and CI: lower per-turn overhead, and host-local
edits cannot silently clobber remote state.

<Warning>
Editing files on the host outside OpenClaw after the initial seed is invisible to the remote sandbox. Run `openclaw sandbox recreate` to re-seed.
</Warning>

### Choosing a mode

|                          | `mirror`                   | `remote`                  |
| ------------------------ | -------------------------- | ------------------------- |
| **Canonical workspace**  | Local host                 | Remote OpenShell          |
| **Sync direction**       | Bidirectional (every exec) | One-time seed             |
| **Per-turn overhead**    | Higher (upload + download) | Lower (direct remote ops) |
| **Local edits visible?** | Yes, on next exec          | No, until recreate        |
| **Best for**             | Development workflows      | Long-running agents, CI   |

## Configuration reference

All OpenShell config lives under `plugins.entries.openshell.config`:

| Key                       | Type                     | Default       | Description                                                                            |
| ------------------------- | ------------------------ | ------------- | -------------------------------------------------------------------------------------- |
| `mode`                    | `"mirror"` or `"remote"` | `"mirror"`    | Workspace sync mode                                                                    |
| `command`                 | `string`                 | `"openshell"` | Path or name of the `openshell` CLI                                                    |
| `from`                    | `string`                 | `"openclaw"`  | Sandbox source for first-time create                                                   |
| `gateway`                 | `string`                 | unset         | OpenShell gateway name (top-level `--gateway`)                                         |
| `gatewayEndpoint`         | `string`                 | unset         | OpenShell gateway endpoint (top-level `--gateway-endpoint`)                            |
| `policy`                  | `string`                 | unset         | OpenShell policy ID for sandbox creation                                               |
| `providers`               | `string[]`               | `[]`          | Provider names attached at sandbox creation (deduped, one `--provider` flag per entry) |
| `gpu`                     | `boolean`                | `false`       | Request GPU resources (`--gpu`)                                                        |
| `autoProviders`           | `boolean`                | `true`        | Pass `--auto-providers` (or `--no-auto-providers` when false) during create            |
| `remoteWorkspaceDir`      | `string`                 | `"/sandbox"`  | Primary writable workspace inside the sandbox                                          |
| `remoteAgentWorkspaceDir` | `string`                 | `"/agent"`    | Agent workspace mount path (read-only when workspace access is not `rw`)               |
| `timeoutSeconds`          | `number`                 | `120`         | Timeout for `openshell` CLI operations                                                 |

`remoteWorkspaceDir` and `remoteAgentWorkspaceDir` must be absolute paths and
stay under the managed roots `/sandbox` or `/agent`; other absolute paths are
rejected.

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) live under
`agents.defaults.sandbox` like any backend. See
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

```bash
# List all sandbox runtimes (Docker + OpenShell)
openclaw sandbox list

# Inspect effective policy
openclaw sandbox explain

# Recreate (deletes remote workspace, re-seeds on next use)
openclaw sandbox recreate --all
```

For `remote` mode, recreate is especially important: it deletes the canonical
remote workspace for that scope, and the next use seeds a fresh one from
local. For `mirror` mode, recreate mainly resets the remote execution
environment since local stays canonical.

Recreate after changing any of:

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`

## Security hardening

The mirror-mode filesystem bridge pins the local workspace root and rechecks
canonical paths (via realpath) before every read, write, mkdir, remove, and
rename, rejecting mid-path symlinks. A symlink swap or remounted workspace
cannot redirect file access outside the mirrored tree.

## Current limitations

- Sandbox browser is not supported on the OpenShell backend.
- `sandbox.docker.binds` does not apply to OpenShell; sandbox creation fails
  if binds are configured.
- Docker-specific runtime knobs under `sandbox.docker.*` (other than `env`)
  apply only to the Docker backend.

## How it works

1. OpenClaw runs `sandbox get` for the sandbox name (with any configured
   `--gateway`/`--gateway-endpoint`); if that fails it creates one with
   `sandbox create`, passing `--name`, `--from`, `--policy` when set, `--gpu`
   when enabled, `--auto-providers`/`--no-auto-providers`, and one
   `--provider` flag per configured provider.
2. OpenClaw runs `sandbox ssh-config` for the sandbox name to fetch SSH
   connection details.
3. Core writes the SSH config to a temp file and opens an SSH session through
   the same remote filesystem bridge as the generic SSH backend.
4. In `mirror` mode: sync local to remote before exec, run, sync back after.
5. In `remote` mode: seed once on create, then operate directly on the remote
   workspace.

## Related

- [Sandboxing](/gateway/sandboxing) - modes, scopes, and backend comparison
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) - debugging blocked tools
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) - per-agent overrides
- [Sandbox CLI](/cli/sandbox) - `openclaw sandbox` commands
