---
summary: "Use Docker's sbx CLI as a sandbox backend for OpenClaw agents"
title: sbx
read_when:
  - You want to sandbox agents with Docker's sbx CLI instead of raw Docker
  - You are setting up the sbx plugin
  - You want native bind-mounted sandbox workspaces with no upload/sync step
---

`sbx` (Docker Sandboxes) is a sandbox backend for OpenClaw. OpenClaw delegates
sandbox lifecycle to the `sbx` CLI (or the `docker sandbox` plugin form), which
runs a plain `shell` sandbox container and bind-mounts the workspace at the
same path inside the container as on the host.

Because the workspace is a real bind mount (not an upload or a remote copy),
there is no sync step: files written through the sandbox filesystem bridge, or
edited directly on the host, are visible on both sides immediately.

## Prerequisites

- sbx plugin installed (`openclaw plugins install @openclaw/sbx-sandbox`)
- The `sbx` CLI installed and on `PATH` (Docker Desktop's Sandboxes feature, or
  the standalone `sbx` binary), or a custom path via
  `plugins.entries.sbx.config.command`
- OpenClaw Gateway running on the same host as the `sbx`/Docker daemon

## Quick start

1. Install and enable the plugin, then set the sandbox backend:

```bash
openclaw plugins install @openclaw/sbx-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
      },
    },
  },
}
```

2. Restart the Gateway. On the next agent turn, OpenClaw creates an sbx
   sandbox and routes tool execution through it.

3. Verify:

```bash
openclaw sandbox list
openclaw sandbox explain
```

## Configuration reference

All sbx config lives under `plugins.entries.sbx.config`:

| Key              | Type                                   | Default     | Description                                     |
| ---------------- | -------------------------------------- | ----------- | ----------------------------------------------- |
| `command`        | `string`                               | `"sbx"`     | Path or name of the `sbx` CLI                   |
| `agent`          | `string`                               | `"shell"`   | sbx agent/kit used when creating the sandbox    |
| `template`       | `string`                               | —           | Container image override (`--template`)         |
| `pull`           | `"always"` \| `"missing"` \| `"never"` | `"missing"` | Image pull policy (`--pull`)                    |
| `timeoutSeconds` | `number`                               | `120`       | Timeout for `sbx` CLI operations such as create |

GPU passthrough is not exposed through this plugin yet: upstream `sbx create --gpu`
is still an experimental, feature-gated flag (hidden from `sbx create --help`
unless the host has opted into `feature.sandbox-gpu`), so this plugin does not
pass it until it is a stable, generally available part of the `sbx` CLI
contract.

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) are configured under
`agents.defaults.sandbox` as with any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

## Workspace model

Unlike the [SSH backend](/gateway/sandboxing#ssh-backend) or
[OpenShell](/gateway/openshell), sbx does not need to seed, mirror, or
download the workspace:

- `sbx create` bind-mounts the OpenClaw sandbox workspace directory at the
  identical absolute path inside the sandbox container.
- When `workspaceAccess` is `"ro"` or `"rw"` and the real agent workspace
  differs from the sandbox workspace, it is bind-mounted the same way as a
  second workspace argument.
- Tool exec runs via `sbx exec <name> -- sh -lc <command>`.
- File tools (`read`, `write`, `edit`, `apply_patch`) run through the shared
  remote-shell sandbox filesystem bridge, executing small shell scripts inside
  the container. Because the container sees the same files as the host (bind
  mount, not a copy), reads and writes are immediately consistent both ways.

## Examples

### Minimal rw setup

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      sbx: { enabled: true },
    },
  },
}
```

### Custom template and pull policy

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "sbx",
        scope: "agent",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
        config: {
          template: "my-registry/my-sandbox-image:latest",
          pull: "always",
          timeoutSeconds: 180,
        },
      },
    },
  },
}
```

### Per-agent sbx with a custom agent/kit

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
          backend: "sbx",
          scope: "agent",
          workspaceAccess: "rw",
        },
      },
    ],
  },
  plugins: {
    entries: {
      sbx: {
        enabled: true,
        config: {
          agent: "opencode",
        },
      },
    },
  },
}
```

## Lifecycle management

sbx sandboxes are managed through the normal sandbox CLI:

```bash
# List all sandbox runtimes (Docker + sbx + others)
openclaw sandbox list

# Inspect effective policy
openclaw sandbox explain

# Recreate (removes the sbx sandbox; a fresh one is created on next use)
openclaw sandbox recreate --all
```

Recreate after changing `agents.defaults.sandbox.backend`,
`plugins.entries.sbx.config.agent`, or `plugins.entries.sbx.config.template`.

## Current limitations

- Sandbox browser is not supported on the sbx backend.
- `sandbox.docker.binds` does not apply to the sbx backend.
- Docker-specific runtime knobs under `sandbox.docker.*` apply only to the
  Docker backend.
- The sandbox image must include the tools your skills need. The default
  `shell` agent/kit image (`docker/sandbox-templates:shell-docker`) already
  includes `python3` for the sandbox filesystem bridge helpers; use `template`
  to point at a custom image if a skill needs something else.

## How it works

1. OpenClaw calls `sbx create <agent> <workspaceDir>[:ro] [<agentWorkspaceDir>[:ro]] --name <name> --pull <pull>`
   (plus `--template` when configured), bind-mounting the workspace(s)
   at their host paths.
2. Tool exec runs via `sbx exec -i [-t] -w <workdir> [-e KEY=VALUE ...] <name> /bin/sh -lc <command>`.
3. File tools run small shell scripts via `sbx exec -i <name> /bin/sh -c <script>`,
   using the same remote-shell filesystem bridge the SSH backend uses -- but
   against a bind-mounted (not remote-copied) workspace.

## Related

- [Sandboxing](/gateway/sandboxing) -- modes, scopes, and backend comparison
- [OpenShell](/gateway/openshell) -- managed remote sandbox backend
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- debugging blocked tools
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides
- [Sandbox CLI](/cli/sandbox) -- `openclaw sandbox` commands
