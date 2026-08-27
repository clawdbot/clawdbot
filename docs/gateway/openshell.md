---
summary: "Use OpenShell as a managed sandbox backend for OpenClaw agents"
title: OpenShell
read_when:
  - You want OpenShell-managed local or remote sandboxes
  - You are setting up the OpenShell plugin
  - You need to choose between mirror and remote workspace modes
---

OpenShell is a managed sandbox backend: OpenClaw delegates sandbox lifecycle to
the `openshell` CLI and executes commands over SSH. The selected OpenShell
gateway can manage sandboxes locally with Docker, Podman, or virtualization, or
run them on separate infrastructure. This OpenShell gateway is distinct from the
OpenClaw Gateway, which continues to run the agent and host-side plugins.

The plugin reuses the same SSH transport and remote filesystem bridge as the
generic [SSH backend](/gateway/sandboxing#ssh-backend), and adds OpenShell
lifecycle (`sandbox create/get/delete/ssh-config`) plus an optional `mirror`
workspace sync mode.

## Prerequisites

- `openshell` CLI installed and on the OpenClaw Gateway process's `PATH` (or a
  custom absolute path via
  `plugins.entries.openshell.config.command`)
- OpenSSH client available on the Gateway host
- OpenShell `v0.0.88` or newer when configuring an OpenShell workspace
- An active, reachable OpenShell gateway with permission to create sandboxes;
  local gateways do not require a cloud account
- A supported compute runtime on the OpenShell gateway host when using local
  sandboxes
- OpenClaw Gateway running on the host

Install the CLI and configure an OpenShell gateway using the
[NVIDIA OpenShell documentation](https://docs.nvidia.com/openshell/latest).
Before configuring OpenClaw, verify the OpenShell CLI as the same operating
system user that runs the OpenClaw Gateway:

```bash
openshell --version
openshell gateway list
openshell sandbox list
```

`gateway list` marks the active gateway with `*`. If no gateway is selected,
run `openshell gateway select <gateway-name>`. To register an existing local
gateway endpoint, run `openshell gateway add http://127.0.0.1:8080 --local`;
replace the endpoint with the address of your running gateway. For an
authenticated remote gateway, follow its login flow with
`openshell gateway login <gateway-name>`.

The OpenClaw Gateway service must see the same OpenShell CLI, gateway
registration, credentials, and workspace selection as these preflight commands.
A shell-only `PATH` or `OPENSHELL_WORKSPACE` setting does not automatically
reach a background service.

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

Validate the configuration and restart the OpenClaw Gateway:

```bash
openclaw config validate
openclaw gateway restart
```

On the next agent turn OpenClaw creates an OpenShell sandbox and routes tool
execution through it. Verify both the plugin and the effective sandbox:

```bash
openclaw plugins inspect openshell --runtime --json
openclaw sandbox list
openclaw sandbox explain
openshell sandbox list
```

`openclaw sandbox list` is empty until a sandboxed agent turn first needs a
runtime.

## Workspace modes

This is the most important OpenShell decision.

OpenShell also has a control-plane resource named a **workspace**. That is
separate from the filesystem workspace described below: it scopes sandboxes,
providers, policies, inference routes, and membership. Set
`plugins.entries.openshell.config.workspace` to use an existing non-default
OpenShell workspace. The plugin does not create OpenShell workspaces or manage
their membership. When this setting is unset, the plugin preserves the
OpenShell CLI's ambient `OPENSHELL_WORKSPACE` selection, or the CLI's `default`
fallback when no ambient selection exists.

### mirror (default)

`plugins.entries.openshell.config.mode: "mirror"` keeps the **local workspace
canonical**:

- Before `exec`, OpenClaw syncs the local workspace into the sandbox.
- After `exec`, OpenClaw syncs the remote workspace back to local.
- Within one OpenClaw Gateway process, commands and file-tool operations sharing
  a workspace wait for the current operation to finish. The lock covers the
  complete upload, command, and download, or the complete file read/mutation and
  its synchronization; separate backend handles share the same lock.
- File tools go through the sandbox bridge, but local stays source of truth
  between turns.

Best for development workflows: local edits outside OpenClaw show up on the
next exec, and the sandbox behaves close to the Docker backend.

Tradeoff: upload + download cost on every exec turn.

External editors and other Gateway processes do not participate in that lock.
Avoid changing the host workspace while a mirrored command is running, because
its download can replace those external edits.

### remote

`mode: "remote"` makes the **OpenShell workspace canonical**:

- On first use after sandbox creation, OpenClaw seeds the remote workspace
  from local once. If the Gateway restarts before that first use, the next use
  detects the still-empty remote workspace and seeds it; a workspace that
  already holds content is never re-seeded.
- After that, `exec`, `read`, `write`, `edit`, and `apply_patch` operate
  directly on the remote workspace. OpenClaw does **not** sync remote changes
  back to local.
- Prompt-time media reads still work (file/media tools read through the
  sandbox bridge).
- Outbound images and other attachments can use paths under the configured
  remote workspace, such as `/sandbox/chart.png`.

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
| `workspace`               | `string`                 | unset         | Existing OpenShell control-plane workspace used for every CLI operation                |
| `policy`                  | `string`                 | unset         | Path to a sandbox policy YAML file on the OpenClaw Gateway host                        |
| `providers`               | `string[]`               | `[]`          | Provider names attached at sandbox creation (deduped, one `--provider` flag per entry) |
| `gpu`                     | `boolean`                | `false`       | Request GPU resources (`--gpu`)                                                        |
| `autoProviders`           | `boolean`                | `true`        | Pass `--auto-providers` (or `--no-auto-providers` when false) during create            |
| `remoteWorkspaceDir`      | `string`                 | `"/sandbox"`  | Primary writable workspace inside the sandbox                                          |
| `remoteAgentWorkspaceDir` | `string`                 | `"/agent"`    | Agent workspace mount path (read-only when workspace access is not `rw`)               |
| `timeoutSeconds`          | `number`                 | `120`         | Timeout for `openshell` CLI operations                                                 |

`remoteWorkspaceDir` and `remoteAgentWorkspaceDir` must be absolute paths and
stay under the managed roots `/sandbox` or `/agent`; other absolute paths are
rejected. Choose distinct, non-overlapping directories because OpenClaw manages
their contents independently; previously configured overlapping roots remain
accepted for upgrade compatibility.

`timeoutSeconds` applies to ordinary OpenShell CLI operations. Sandbox creation
always receives at least 300 seconds so image builds and first-time provisioning
are not cut short by the default 120-second command timeout.

`policy` is a file path, not a policy name or ID. Prefer an absolute path such
as `/etc/openclaw/openshell-policy.yaml`; relative paths are resolved from the
agent's local workspace during sandbox creation. An explicit policy overrides
the OpenShell CLI's `OPENSHELL_SANDBOX_POLICY` environment variable. When
neither is set, OpenShell uses its normal policy selection and defaults.

`providers` names existing OpenShell credential providers in the selected
workspace. With `autoProviders: true`, OpenShell may create missing providers
from credentials already available to the Gateway process. With
`autoProviders: false`, create required providers first and verify them with
`openshell --workspace <workspace-name> provider list`. Keep API keys in
OpenShell providers rather than adding them to sandbox environment variables.

`workspace` must match OpenShell's current workspace-name contract: 1-19
lowercase alphanumeric characters or single hyphens, with no leading,
trailing, or consecutive hyphen. Create it first with
`openshell workspace create --name <name>`. OpenShell rejects sandbox
operations when the selected workspace does not exist or is being deleted.
Set it to `"default"` to override an ambient non-default Workspace explicitly.

The setting applies to every OpenShell sandbox managed by this plugin instance;
it cannot select different OpenShell workspaces per OpenClaw agent or session.
Changing it does not migrate existing sandboxes. Delete OpenClaw's OpenShell
sandboxes while the old workspace is still configured, then change the setting
and restart the Gateway.

Sandbox-level settings (`mode`, `scope`, `workspaceAccess`) live under
`agents.defaults.sandbox` like any backend. See
[Sandboxing](/gateway/sandboxing) for the full matrix.

To pass non-secret environment values into sandboxed commands, use the existing
`agents.defaults.sandbox.docker.env` setting; the OpenShell backend also
applies those values during command execution. OpenShell does not currently
inject them into sandbox creation or background services. Keep credentials in
OpenShell providers or another dedicated secret-delivery mechanism.

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
    entries: {
      researcher: {
        default: true,
        sandbox: {
          mode: "all",
          backend: "openshell",
          scope: "agent",
          workspaceAccess: "rw",
        },
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
          gateway: "lab",
          gatewayEndpoint: "https://lab.example",
          workspace: "research",
          policy: "/etc/openclaw/openshell-policy.yaml",
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

# Recreate only one agent or the exact session scope shown by sandbox list
openclaw sandbox recreate --agent researcher
openclaw sandbox recreate --session "agent:researcher:main"
```

For `remote` mode, recreate is especially important: it deletes the canonical
remote workspace for that scope, and the next use seeds a fresh one from
local. For `mirror` mode, recreate mainly resets the remote execution
environment since local stays canonical.

Sandbox CLI commands activate the configured backend's owning plugin before
looking up runtime status or deleting a sandbox. Unrelated plugins are not
loaded for these operations, and browser-only commands remain independent of
the OpenShell backend.

OpenClaw keeps a registered sandbox's shipped legacy runtime name after an
upgrade so its remote workspace remains addressable. Recreating that scope
deletes the legacy runtime; the next use creates the current 19-character
runtime name.

OpenShell v0.0.92 can still locate a sandbox record created by v0.0.68, but a
Docker-backed sandbox may remain in a non-Ready phase after the gateway
upgrade. OpenClaw preserves the registered runtime identity, refuses to create
a replacement implicitly, and reports the scoped `openclaw sandbox recreate`
command. Treat that recreation as destructive in `remote` mode because the
remote workspace is canonical.

Recreate after changing any of:

- `agents.defaults.sandbox.backend`
- `plugins.entries.openshell.config.from`
- `plugins.entries.openshell.config.mode`
- `plugins.entries.openshell.config.policy`
- `plugins.entries.openshell.config.providers`, `gpu`, or `autoProviders`
- `plugins.entries.openshell.config.remoteWorkspaceDir` or
  `remoteAgentWorkspaceDir`

When changing the OpenShell gateway or control-plane workspace, recreate the
affected sandboxes while the old gateway and workspace are still selected;
otherwise cleanup targets the new location instead of the existing sandbox.

If OpenShell cannot delete a sandbox, OpenClaw reports the failure and keeps the
runtime registry entry so recreation or pruning can be retried safely. Restore
the original gateway, workspace, authentication, and connectivity, inspect the
runtime with `openshell --workspace <workspace-name> sandbox get <sandbox-name>`,
and rerun the scoped `openclaw sandbox recreate` command. Do not switch the
configured workspace or delete the registry entry to hide the failure.

## Security hardening

The mirror-mode filesystem bridge pins the local workspace root and rechecks
canonical paths (via realpath) before every read, write, mkdir, remove, and
rename, rejecting mid-path symlinks. A symlink swap or remounted workspace
cannot redirect file access outside the mirrored tree.

Workspace synchronization excludes `.git`, `hooks`, and `git-hooks` in both
directions. Repository credentials, history, and trusted hook code remain on
the OpenClaw Gateway host instead of being copied into an untrusted sandbox.

## Custom image contract

The OpenShell source image owns the remote operating system and package set.
OpenClaw does not apply Docker image, root-filesystem, network, user, or package
settings to this backend.

Custom images used with the OpenClaw filesystem bridge must provide:

- `/bin/sh`
- `sleep` for the persistent sandbox main process on current OpenShell releases
- `python3` or `python` for pinned write, edit, rename, and remove operations
- GNU-compatible `stat` and `find`
- standard `mkdir`, `mv`, `rm`, and `rmdir` utilities

When the agent workspace differs from the sandbox workspace, the sandbox user
and policy also need write access to both configured remote roots. Standard
unprivileged images often cannot create the default `/agent` directory. Either
create and grant access to `/agent` in the image and policy, or configure two
non-overlapping directories beneath the already-writable sandbox root:

```json5
{
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          remoteWorkspaceDir: "/sandbox/workspace",
          remoteAgentWorkspaceDir: "/sandbox/agent",
        },
      },
    },
  },
}
```

Package installation and private certificate roots must be included in the
source image or installed from inside the sandbox. The selected OpenShell
policy must permit the required network destinations, and the sandbox user and
filesystem must permit the writes. `sandbox.docker.network`,
`sandbox.docker.readOnlyRoot`, `sandbox.docker.user`, and
`sandbox.docker.setupCommand` do not configure OpenShell.

## Current limitations

- Sandbox browser is not supported on the OpenShell backend.
- One plugin instance uses one OpenShell workspace; per-agent or per-session
  OpenShell workspace selection is not supported.
- `sandbox.docker.binds` does not apply to OpenShell; sandbox creation fails
  if binds are configured.
- Docker-specific runtime knobs under `sandbox.docker.*` (other than `env`)
  apply only to the Docker backend.
- Native plugin code and Gateway RPC stay on the Gateway host. Plugin-owned and
  MCP tools are available to sandboxed sessions only when sandbox tool policy
  allows them.

## Troubleshooting

First separate OpenClaw Gateway health, plugin activation, and OpenShell
gateway connectivity:

```bash
openclaw gateway status --deep --require-rpc
openclaw plugins inspect openshell --runtime --json
openclaw sandbox explain
openclaw sandbox list
openshell gateway list
openshell sandbox list
openclaw logs --follow
```

- **Plugin missing or backend unavailable:** Install
  `@openclaw/openshell-sandbox`, set `plugins.entries.openshell.enabled: true`,
  validate the config, and restart the OpenClaw Gateway. Run
  `openclaw plugins inspect openshell --runtime --json` to check the running
  Gateway rather than only the on-disk plugin registration.
- **`openshell` not found:** Install the CLI for the user running the Gateway,
  or set `plugins.entries.openshell.config.command` to its absolute executable
  path. A working interactive shell does not prove the managed service has the
  same `PATH`.
- **No active gateway, unauthorized, or connection failed:** Check
  `openshell gateway list`, select the intended gateway, and reauthenticate with
  `openshell gateway login <gateway-name>` when its deployment requires login.
  Set `plugins.entries.openshell.config.gateway` explicitly when the service
  should not depend on the interactive CLI's active selection.
- **Workspace missing or the wrong sandbox list:** Verify the selected
  control-plane workspace with `openshell workspace list`, then run
  `openshell --workspace <workspace-name> sandbox list`. Create missing
  workspaces with `openshell workspace create --name <workspace-name>` before
  enabling them in OpenClaw. Remember that the Gateway service may not inherit
  `OPENSHELL_WORKSPACE` from your interactive shell.
- **Policy file cannot be read or outbound traffic is denied:** Configure an
  existing YAML policy file using an absolute host path, check its permissions,
  and verify that the policy permits the destination and requesting binary.
  Inspect a running sandbox with
  `openshell sandbox get <sandbox-name> --policy-only`. Docker network settings
  do not change OpenShell policy.
- **Provider creation fails:** Inspect the selected workspace with
  `openshell provider list`, then create or refresh the required provider using
  OpenShell's documented credential flow. If `autoProviders` is disabled,
  required providers must already exist.
- **Remote files are missing locally:** This is expected in `remote` mode;
  remote files are canonical and are not synchronized back to the host. Use
  `mirror` mode when host-visible changes are required. Recreating a remote
  sandbox destroys its remote-only files.
- **An image or attachment cannot be sent:** Use a path under the configured
  `remoteWorkspaceDir`, such as `/sandbox/report.png`, rather than assuming
  every backend uses Docker's `/workspace` directory.
- **Recreate or prune cannot delete a sandbox:** Restore access to the original
  OpenShell gateway and workspace, confirm the sandbox still exists with
  `openshell --workspace <workspace-name> sandbox get <sandbox-name>`, and retry
  the scoped recreation. OpenClaw retains the registry entry until deletion
  succeeds.

## How it works

1. OpenClaw runs `sandbox get` for the sandbox name (with the selected
   OpenShell workspace and any configured `--gateway`/`--gateway-endpoint`); if
   that fails it creates one in the same OpenShell workspace with
   `sandbox create`, passing `--name`, `--from`, `--policy` when set, `--gpu`
   when enabled, `--auto-providers`/`--no-auto-providers`, and one
   `--provider` flag per configured provider.
2. OpenClaw runs `sandbox ssh-config` for the sandbox name to fetch SSH
   connection details.
3. Core writes the SSH config to a temp file and opens an SSH session through
   the same remote filesystem bridge as the generic SSH backend.
4. In `mirror` mode: sync local to remote before exec, run, sync back after.
5. In `remote` mode: seed once on first use, then operate directly on the
   remote workspace.

## Related

- [Sandboxing](/gateway/sandboxing) - modes, scopes, and backend comparison
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) - debugging blocked tools
- [Multi-Agent Sandbox and Tools](/tools/multi-agent-sandbox-tools) - per-agent overrides
- [Sandbox CLI](/cli/sandbox) - `openclaw sandbox` commands
