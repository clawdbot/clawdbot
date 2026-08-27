---
summary: "Use Daytona cloud sandboxes as a sandbox backend for OpenClaw agents"
title: Daytona
read_when:
  - You want cloud sandboxes instead of local Docker
  - You are setting up the Daytona plugin
  - You need agent tool execution isolated from the Gateway host
---

Daytona is a cloud sandbox backend: instead of running Docker containers
locally, OpenClaw creates [Daytona](https://www.daytona.io) sandboxes through
the Daytona API and executes commands and file operations over the Daytona
toolbox API (HTTPS). No SSH keys or inbound connectivity are required.

The plugin reuses the same remote filesystem bridge as the generic
[SSH backend](/gateway/sandboxing#ssh-backend) with a remote-canonical
workspace model: the sandbox workspace is seeded once at creation and stays
canonical until you recreate it.

## Prerequisites

- Daytona plugin installed (`openclaw plugins install @openclaw/daytona-sandbox`)
- A Daytona API key (`https://app.daytona.io/dashboard/keys`)
- OpenClaw Gateway running on the host

## Quick start

```bash
openclaw plugins install @openclaw/daytona-sandbox
```

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "daytona",
        scope: "session",
        workspaceAccess: "rw",
      },
    },
  },
  plugins: {
    entries: {
      daytona: {
        enabled: true,
        config: {
          apiKey: { source: "env", provider: "default", id: "DAYTONA_API_KEY" },
        },
      },
    },
  },
}
```

Export `DAYTONA_API_KEY` in the Gateway environment (or store the key with a
SecretRef as above, or as a plaintext string). Restart the Gateway. On the
next agent turn OpenClaw creates a Daytona sandbox and routes tool execution
through it. Verify with:

```bash
openclaw sandbox list
openclaw sandbox explain
```

New sandboxes block all network egress by default, matching the Docker
backend's no-network stance. If your agents need to install packages or reach
the network from inside the sandbox, opt in explicitly with
`networkBlockAll: false`, or grant selective egress with `networkAllowList`
or `domainAllowList`.

## How execution works

- **Sandbox per scope**: one Daytona sandbox per sandbox scope (`agent`,
  `session`, or `shared`). Sandboxes are labeled `openclaw.sandbox=1` and
  adopted across Gateway restarts through the OpenClaw sandbox registry.
- **Exec**: each `exec` call runs inside the sandbox through a Daytona session
  (or a Daytona PTY when the tool requests a TTY). Exit codes, stdout, stderr,
  stdin, and terminal resizes all flow through the toolbox API.
- **Files**: `read`, `write`, `edit`, `apply_patch`, and media reads go through
  the sandbox filesystem bridge, so file tools operate on the remote workspace
  with the same path and writability rules as the SSH backend.
- **Auto-stop**: Daytona stops idle sandboxes automatically (default 15
  minutes). OpenClaw restarts a stopped sandbox on the next use, so idle
  sandboxes cost nothing while state stays warm.

## Workspace model

The session workspace is uploaded once when the sandbox is created
(remote-canonical, like the SSH backend). Host-local edits made after the seed
are not visible remotely until you recreate the sandbox:

```bash
openclaw sandbox recreate --session <sessionKey>
```

This deletes the Daytona sandbox; the next agent turn provisions a fresh one
and seeds it from the current local workspace.

## Configuration reference

All settings live under `plugins.entries.daytona.config`:

| Key                       | Type              | Default                   | Description                                                                                                                                                                                          |
| ------------------------- | ----------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                  | string, SecretRef | unset                     | Daytona API key. Falls back to the `DAYTONA_API_KEY` environment variable.                                                                                                                           |
| `apiUrl`                  | string            | Daytona cloud             | Daytona API base URL. Falls back to `DAYTONA_API_URL`.                                                                                                                                               |
| `target`                  | string            | Daytona default           | Target region for new sandboxes. Falls back to `DAYTONA_TARGET`.                                                                                                                                     |
| `snapshot`                | string            | Daytona default snapshot  | Snapshot for new sandboxes. The image needs `sh`, `tar`, `base64`, `stat`, and `python3` on `PATH`. Mutually exclusive with `image`.                                                                 |
| `image`                   | string            | unset                     | Docker image for new sandboxes, pulled or built by Daytona on first create. Mutually exclusive with `snapshot`.                                                                                      |
| `resources`               | object            | unset                     | `{ cpu, gpu, memory, disk }` for image-based sandboxes (memory and disk in GiB). Omitted fields use the Daytona defaults (1 vCPU, 1 GB, 3 GiB). Snapshot sandboxes size from the snapshot.           |
| `user`                    | string            | snapshot default          | OS user for the sandbox. Align the remote workspace dirs with that user's writable paths.                                                                                                            |
| `volumes`                 | array             | unset                     | Daytona volumes to mount, as `{ volumeId, mountPath }` entries. Reachable from `exec`; outside the file-tool workspace mounts.                                                                       |
| `autoStopInterval`        | integer (minutes) | `15` (Daytona default)    | Minutes of inactivity before Daytona stops the sandbox. `0` keeps it running continuously.                                                                                                           |
| `autoPauseInterval`       | integer (minutes) | disabled                  | Minutes of inactivity before Daytona pauses the sandbox (VM-based runners; pause preserves memory state). At most one of auto-stop and auto-pause may be non-zero.                                   |
| `autoArchiveInterval`     | integer (minutes) | `7` days (Daytona)        | Minutes a stopped sandbox waits before archiving to cold storage. `0` uses the Daytona maximum.                                                                                                      |
| `autoDeleteInterval`      | integer (minutes) | disabled                  | Minutes a sandbox may stay stopped before Daytona deletes it. `0` deletes immediately on stop.                                                                                                       |
| `networkBlockAll`         | boolean           | `true` (egress blocked)   | Block all sandbox network egress, matching the Docker backend's no-network default. Set `false` for open egress; configuring an allow list implies selective egress.                                 |
| `networkAllowList`        | string            | unset                     | Comma-separated CIDR addresses the sandbox may reach. Setting this (with `networkBlockAll` unset) enables selective egress.                                                                          |
| `domainAllowList`         | string            | unset                     | Comma-separated domains the sandbox may reach. Setting this (with `networkBlockAll` unset) enables selective egress.                                                                                 |
| `remoteWorkspaceDir`      | string            | `/home/daytona/workspace` | Absolute path of the session workspace inside the sandbox.                                                                                                                                           |
| `remoteAgentWorkspaceDir` | string            | `/home/daytona/agent`     | Absolute path mirroring the real agent workspace when `workspaceAccess` is not `none`.                                                                                                               |
| `timeoutSeconds`          | number            | `120`                     | Timeout for Daytona API operations (create, upload, filesystem commands). Image-based creates automatically get a higher floor to cover image pulls; raise this when declarative builds need longer. |

## Lifecycle management

```bash
# List all sandbox runtimes (Docker + Daytona)
openclaw sandbox list

# Inspect effective policy
openclaw sandbox explain

# Recreate (deletes the Daytona sandbox, re-seeds on next use)
openclaw sandbox recreate --session <sessionKey>
```

Idle pruning (`agents.defaults.sandbox.prune`) treats Daytona runtimes the same
as Docker runtimes: pruned entries delete the Daytona sandbox.

## Cost controls

- `autoStopInterval` (default 15 minutes) stops idle sandboxes; stopped
  sandboxes restart automatically on next use. `autoPauseInterval` pauses
  instead, on sandbox classes that support pausing.
- `autoArchiveInterval` moves long-stopped sandboxes to cold storage;
  `autoDeleteInterval` deletes sandboxes that stay stopped, if you prefer
  Daytona-side cleanup in addition to OpenClaw pruning.
- OpenClaw prune (`sandbox.prune.idleHours` / `maxAgeDays`) deletes registered
  sandboxes from the OpenClaw side.

## Current limitations

- Browser sandboxing is not supported on this backend.
- `sandbox.docker.*` settings (image, binds, network) do not apply; use
  `snapshot`/`image` and the network allow-list options instead.
  `sandbox.docker.binds` is rejected; Daytona `volumes` cover shared storage.
- Volume mount paths are reachable from `exec` commands only; the file tools
  stay inside the managed workspace mounts.
- The workspace is seeded once (remote-canonical); there is no mirror mode.
- Exec stdin is line-oriented text (Daytona session input); binary stdin
  streams are not preserved byte-for-byte in non-PTY execs.

## Related

- [Sandboxing overview](/gateway/sandboxing)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
