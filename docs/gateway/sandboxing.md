---
summary: "How OpenClaw sandboxing works: modes, scopes, workspace access, and images"
title: "Sandboxing"
sidebarTitle: "Sandboxing"
read_when: "You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox."
status: active
---

OpenClaw can run tool execution inside a sandbox backend to reduce blast radius. Sandboxing is off by default and controlled by `agents.defaults.sandbox` (global), `agents.entries.*.sandbox` (per-agent), or a required creator-role sandbox policy. The Gateway process always stays on the host; only tool execution moves into the sandbox when enabled.

<Note>
This is not a perfect security boundary, but it materially limits filesystem and process access when the model does something dumb.
</Note>

## What gets sandboxed

- Tool execution: `exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.
- The optional sandboxed browser (`agents.defaults.sandbox.browser`).

Not sandboxed:

- The Gateway process itself.
- Any tool explicitly allowed to run outside an ordinary sandbox via `tools.elevated`. Elevated exec uses the configured escape path (`gateway` by default, or `node` when the exec target is `node`), but cannot escape a session whose creator role requires sandboxing. If sandboxing is off, `tools.elevated` changes nothing since exec already runs on the host. See [Elevated Mode](/tools/elevated).

## Modes, scope, and backend

Three independent settings control sandbox behavior:

| Setting | Key                               | Values                                 | Default  |
| ------- | --------------------------------- | -------------------------------------- | -------- |
| Mode    | `agents.defaults.sandbox.mode`    | `off`, `non-main`, `all`               | `off`    |
| Scope   | `agents.defaults.sandbox.scope`   | `agent`, `session`, `shared`           | `agent`  |
| Backend | `agents.defaults.sandbox.backend` | `docker`, `podman`, `ssh`, `openshell` | `docker` |

**Mode** controls when sandboxing applies:

- `off`: no agent-wide sandboxing; sessions whose creator role requires a sandbox still run sandboxed.
- `non-main`: sandbox every session except the agent's main session. The main session key is always `agent:<agentId>:main` (or `global` when `session.scope` is `"global"`); it is not configurable. Group/channel sessions use their own keys, so they always count as non-main and get sandboxed.
- `all`: every session runs in a sandbox.

Set a named operator role's `sandbox` policy to `"required"` to sandbox that
role's newly created sessions regardless of agent mode. The creator requirement
is immutable for the session; unavailable backends fail closed, and elevated
execution or Gateway/node host overrides cannot bypass it. The default
`"inherit"` preserves existing agent-mode behavior. See
[Named operator roles](/gateway/operator-scopes#named-operator-roles).

**Scope** controls how many containers/environments are created:

- `agent`: one container per agent.
- `session`: one container per session.
- `shared`: one container shared by all sandboxed sessions (per-agent `docker`/`ssh`/`browser` overrides are ignored under this scope).

Non-shared runtime identity also includes the resolved agent workspace path. This prevents co-hosted workspaces that reuse the same agent or session keys from sharing Docker, browser, SSH, OpenShell, or plugin-provided sandbox state. `shared` scope intentionally remains workspace-independent.

The first use after upgrading from an older release creates non-shared runtimes and sandbox workspaces under the workspace-qualified identity. Existing non-shared runtimes are not adopted; this is an intentional one-time reset. They can age out through configured prune settings or be removed with `openclaw sandbox recreate`; the next use provisions the current identity.

**Backend** controls which runtime executes sandboxed tools. Docker and Podman share `agents.defaults.sandbox.docker`; SSH-specific config lives under `agents.defaults.sandbox.ssh`; OpenShell-specific config lives under `plugins.entries.openshell.config`.

|                     | Docker or Podman backend                  | SSH                            | OpenShell                                           |
| ------------------- | ----------------------------------------- | ------------------------------ | --------------------------------------------------- |
| **Where it runs**   | Local Docker or Podman container          | Any SSH-accessible host        | OpenShell managed sandbox                           |
| **Setup**           | Docker and/or Podman                      | SSH key + target host          | OpenShell plugin enabled                            |
| **Workspace model** | Bind-mount or copy                        | Remote-canonical (seed once)   | `mirror` or `remote`                                |
| **Network control** | `docker.network` (default: none)          | Depends on remote host         | Depends on OpenShell                                |
| **Browser sandbox** | Docker engine only                        | Not supported                  | Not supported yet                                   |
| **Bind mounts**     | `docker.binds`                            | N/A                            | N/A                                                 |
| **Best for**        | Local development and container isolation | Offloading to a remote machine | Managed remote sandboxes with optional two-way sync |

## Supported capability matrix

Sandbox backends isolate tool execution. They do not move the Gateway, native
plugins, or control-plane RPC into the sandbox.

| Capability                 | Docker                                                                  | SSH                                                  | OpenShell                                                         |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| Shell and child processes  | Supported inside the container                                          | Supported on the remote host                         | Supported inside the managed sandbox                              |
| File tools                 | Supported through the container filesystem bridge                       | Supported through the SSH filesystem bridge          | Supported through the SSH bridge in `mirror` or `remote` mode     |
| Workspace access           | `none`, `ro`, and `rw`                                                  | `none`, `ro`, and `rw`                               | `none`, `ro`, and `rw`                                            |
| Network restriction        | `docker.network`; defaults to `"none"`                                  | Controlled by the remote host                        | Controlled by the selected OpenShell policy                       |
| Sandboxed browser          | Supported in a separate browser container                               | Not supported                                        | Not supported                                                     |
| Additional host folders    | `docker.binds` with explicit `:ro` or `:rw`                             | Not supported as mounts; seed or copy files instead  | Not supported as mounts; use workspace sync or remote files       |
| Packages and runtimes      | Bake a custom image, or use `setupCommand` with the required privileges | Provision them on the remote host                    | Include them in the source image or install when policy permits   |
| Private certificate roots  | Bake or mount them into the image and configure the consuming runtime   | Configure the remote host trust store                | Include them in the source image or configure them inside sandbox |
| Plugin and MCP tool access | Gateway-side execution, additionally gated by sandbox tool policy       | Gateway-side execution, additionally gated by policy | Gateway-side execution, additionally gated by sandbox tool policy |

Native plugins remain in-process with the Gateway and share its trust boundary.
Sandboxed sessions can use plugin-owned and MCP tools only when normal tool
policy and `tools.sandbox.tools` both allow them. See
[MCP and plugin tools inside sandbox tool policy](/gateway/config-tools#mcp-and-plugin-tools-inside-sandbox-tool-policy)
and [Plugin execution model](/plugins/architecture#execution-model).

## Docker backend

The Docker backend runs tools locally through the `docker` CLI. Its selection and error behavior are unchanged; it does not probe or fall back to Podman.

Defaults: `network: "none"` (no egress), `readOnlyRoot: true`, `capDrop: ["ALL"]`, image `openclaw-sandbox:bookworm-slim`.

This explicit configuration keeps the agent workspace read-only and preserves
the default restricted runtime posture:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "docker",
        scope: "session",
        workspaceAccess: "ro",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          capDrop: ["ALL"],
        },
      },
    },
  },
}
```

OpenClaw also creates Docker sandbox containers with an init process and
`no-new-privileges`. With `workspaceAccess: "ro"`, the agent workspace is
mounted read-only at `/agent`; write operations to the agent workspace are
rejected, while the configured tmpfs paths remain writable.

To expose host GPUs, set `agents.defaults.sandbox.docker.gpus` (or the per-agent override) to a value like `"all"` or `"device=GPU-uuid"`. This is passed to the selected container engine's Docker-compatible `--gpus` flag and requires compatible host GPU setup. Podman requires version 5.0 or newer for this option.

<Warning>
**Docker-out-of-Docker (DooD) constraints**

If you deploy the OpenClaw Gateway itself as a Docker container, it orchestrates sibling sandbox containers using the host's Docker socket (DooD). This introduces a path mapping constraint:

- **Config requires host paths**: `openclaw.json` `workspace` must contain the **host's absolute path** (e.g. `/home/user/.openclaw/workspaces`), not the internal Gateway container path. The Docker daemon evaluates paths relative to the host OS namespace, not the Gateway's own namespace.
- **Matching volume map required**: The Gateway process also writes bridge files to that `workspace` path. Give the Gateway container an identical volume map (`-v /home/user/.openclaw:/home/user/.openclaw`) so the same host path resolves correctly from inside the Gateway container too. Mismatched mappings surface as `EACCES` when the Gateway writes workspace files.
- **Codex code mode**: when an OpenClaw sandbox is active, OpenClaw disables Codex app-server native Code Mode, user MCP servers, and app-backed plugin execution for that turn (those run from the Gateway-host app-server process, not the OpenClaw sandbox backend), unless the sandbox tool policy exposes the required tools and you opt into the experimental sandbox exec-server path. Shell access then routes through OpenClaw sandbox-backed tools such as `sandbox_exec` and `sandbox_process`. Do not mount the host Docker socket into agent sandbox containers or custom Codex sandboxes. See [Codex Harness](/plugins/codex-harness) for the full behavior.

On Ubuntu/AppArmor hosts with Docker sandbox mode enabled, Codex app-server `workspace-write` shell execution needs unprivileged user namespaces inside the sandbox container, and this can fail before shell startup when the service user cannot create them. This needs an unprivileged network namespace too when Docker sandbox egress is disabled (`network: "none"`, the default). Common symptoms: `bwrap: setting up uid map: Permission denied` and `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. Run `openclaw doctor`; if it reports a Codex bwrap namespace probe failure, prefer an AppArmor profile that grants the required namespaces to the OpenClaw service process. `kernel.apparmor_restrict_unprivileged_userns=0` is a host-wide fallback with security tradeoffs; use it only when that host posture is acceptable.
</Warning>

### Sandboxed browser

- The sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it. Configure via `agents.defaults.sandbox.browser.autoStart` (default `true`) and `autoStartTimeoutMs` (default 12s).
- Sandbox browser containers use a dedicated Docker network (`openclaw-sandbox-browser`) instead of the global `bridge` network. Configure with `agents.defaults.sandbox.browser.network`.
- Sandbox browser network mode `"none"` is unsupported because browser control requires host-published CDP ports. Use the dedicated default, `bridge`, or another custom bridge network. `openclaw doctor --fix` disables affected persisted sidecars and restores the dedicated network without silently enabling egress.
- `agents.defaults.sandbox.browser.cdpSourceRange` restricts container-edge CDP ingress with a CIDR allowlist (for example `172.21.0.1/32`).
- noVNC observer access is password-protected by default; OpenClaw emits a short-lived token URL that serves a local bootstrap page and opens noVNC with the password in the URL fragment (not query string or header logs).
- `agents.defaults.sandbox.browser.allowHostControl` (default `false`) lets sandboxed sessions target the host browser explicitly.
- Optional allowlists gate `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

## Podman backend

Use `sandbox.backend: "podman"` to select the native `podman` CLI directly. This is a built-in backend, not a plugin. It does not probe or select Docker, even when the `docker` executable is installed.

Podman reuses the existing `sandbox.docker.*` settings and the active native `podman` CLI context; it adds no separate connection configuration surface.

Rootless Podman defaults to `--userns=keep-id` for writable workspace mounts. A long-lived sandbox can reserve subordinate IDs and block unrelated `--userns=auto` workloads; remove it before starting those workloads. Set `sandbox.docker.user` to a nonzero numeric UID or UID:GID to control the container user. Rootless Podman rejects UID or GID 0 because Podman 4.x cannot remap namespace root while preserving workspace bind ownership; bake root-required setup into the image or use rootful Podman. Rootful Podman otherwise uses the workspace owner when available.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "podman",
        scope: "session",
        workspaceAccess: "rw",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          network: "none",
          readOnlyRoot: true,
          capDrop: ["ALL"],
        },
      },
    },
  },
}
```

Build or pull the sandbox image into the selected Podman store before enabling the backend. From a source checkout, build the same sandbox Dockerfile with Podman:

```bash
podman build -t openclaw-sandbox:bookworm-slim -f scripts/docker/sandbox/Dockerfile .
```

Podman notes:

- Browser sandboxing is not supported by Podman; keep `sandbox.browser.enabled` off, or install Docker and select `backend: "docker"`.
- Local Podman engines and Podman Machine are supported. Podman Machine bind sources must be under the host home directory, which is its default shared volume. Arbitrary remote Podman connections are rejected; use the SSH backend for remote execution.
- Custom `tmpfs` or bind mounts must not cover `/run/podman-init`; OpenClaw rejects them so sandbox cleanup continues to work.

<Warning>
**Podman-outside-of-Podman constraints**

A containerized Gateway creates sibling sandboxes through the host's local Podman engine or Podman Machine.

- **Use host paths consistently**: configure `workspace` with its host absolute path, then mount the complete state root and workspace into the Gateway at those same paths. Otherwise the sandbox may mount the workspace while the Gateway cannot write skill-workspace files.
- **Podman Machine setup**: bind sources must be under the host home directory. Set the Gateway `HOME` to that path and point `OPENCLAW_HOME`, `OPENCLAW_STATE_DIR`, and `OPENCLAW_CONFIG_DIR` at the canonical mounted state root. The image needs a compatible Podman client, its named connection and SSH identity, plus a dedicated writable SSH directory for known-host metadata.
- **Keep Podman access Gateway-only**: never mount the engine socket, connection material, or SSH identity into agent sandboxes. Arbitrary remote connections are unsupported; use the SSH backend instead.

</Warning>

## SSH backend

Use `backend: "ssh"` to sandbox `exec`, file tools, and media reads on an arbitrary SSH-accessible machine.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        backend: "ssh",
        scope: "session",
        workspaceAccess: "rw",
        ssh: {
          target: "user@gateway-host:22",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
          identityFile: "~/.ssh/id_ed25519",
          certificateFile: "~/.ssh/id_ed25519-cert.pub",
          knownHostsFile: "~/.ssh/known_hosts",
          // Or use SecretRefs / inline contents instead of local files:
          // identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          // certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          // knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
      },
    },
  },
}
```

Defaults: `command: "ssh"`, `workspaceRoot: "/tmp/openclaw-sandboxes"`, `strictHostKeyChecking: true`, `updateHostKeys: true`.

- **Lifecycle**: OpenClaw creates a per-scope remote root under `sandbox.ssh.workspaceRoot`. On first use after create or recreate, it seeds that remote workspace from the local workspace once. After that, `exec`, `read`, `write`, `edit`, `apply_patch`, prompt media reads, and inbound media staging run directly against the remote workspace over SSH. OpenClaw does not sync remote changes back to the local workspace automatically.
- **Authentication material**: `identityFile`/`certificateFile`/`knownHostsFile` reference existing local files. `identityData`/`certificateData`/`knownHostsData` accept inline strings or SecretRefs, resolved through the normal secrets runtime snapshot, written to temp files with mode `0600`, and deleted when the SSH session ends. If both a `*File` and `*Data` variant are set for the same item, `*Data` wins for that session.
- **Remote-canonical consequences**: the remote SSH workspace becomes the real sandbox state after the initial seed. Host-local edits made outside OpenClaw after the seed step are not visible remotely until you recreate the sandbox. `openclaw sandbox recreate` deletes the per-scope remote root and seeds again from local on next use. Browser sandboxing is not supported on this backend, and `sandbox.docker.*` settings do not apply to it.

## OpenShell backend

Use `backend: "openshell"` to sandbox tools in an OpenShell-managed remote environment. OpenShell reuses the same SSH transport and remote filesystem bridge as the generic SSH backend, and adds OpenShell lifecycle (`sandbox create/get/delete/ssh-config`) plus an optional `mirror` workspace sync mode.

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
          mode: "remote", // mirror | remote
        },
      },
    },
  },
}
```

`mode: "mirror"` (default) keeps the local workspace canonical: OpenClaw syncs local into the sandbox before `exec` and syncs back after. `mode: "remote"` seeds the remote workspace once from local, then runs `exec`/`read`/`write`/`edit`/`apply_patch` directly against the remote workspace without syncing back; local edits after the seed are invisible until you `openclaw sandbox recreate`. Under `scope: "agent"` or `scope: "shared"`, that remote workspace is shared at the same scope. Current limitations: sandbox browser isn't supported yet, and `sandbox.docker.binds` doesn't apply to this backend.

`openclaw sandbox list`/`recreate`/prune all treat OpenShell runtimes the same as Docker runtimes; prune logic is backend-aware.

For the full prerequisites, configuration reference, workspace-mode comparison, and lifecycle details, see [OpenShell](/gateway/openshell).

## Workspace access

`agents.defaults.sandbox.workspaceAccess` controls what the sandbox can see:

| Value            | Behavior                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `none` (default) | Tools see an isolated sandbox workspace under `~/.openclaw/sandboxes`.                    |
| `ro`             | Mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`). |
| `rw`             | Mounts the agent workspace read/write at `/workspace`.                                    |

With the OpenShell backend, `mirror` mode still uses the local workspace as the canonical source between exec turns, `remote` mode uses the remote OpenShell workspace as canonical after the initial seed, and `workspaceAccess: "ro"`/`"none"` still restrict write behavior the same way.

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).

<Note>
**Skills**: the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`, OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so they can be read. With `"rw"`, workspace skills are readable from `/workspace/skills`, and eligible managed, bundled, or plugin skills are materialized into the generated read-only path `/workspace/.openclaw/sandbox-skills/skills`.
</Note>

## Multiple folders for one agent

Use Docker bind mounts when one sandboxed agent needs more than its primary workspace. Each entry maps a host folder to a container path with an explicit access mode:

```text
host-directory:container-directory:ro
host-directory:container-directory:rw
```

- `ro` makes the mounted folder read-only inside the sandbox.
- `rw` lets sandboxed tools and processes change the host folder.
- The container path is the path the agent uses. Host paths are not exposed automatically.

This example gives the `research` agent a writable primary workspace, read-only reference material at `/reference`, and a separate writable output folder at `/drafts`:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        scope: "agent",
      },
    },
    entries: {
      research: {
        default: true,
        workspace: "/srv/openclaw/research-workspace",
        sandbox: {
          workspaceAccess: "rw",
          docker: {
            binds: ["/srv/shared/reference:/reference:ro", "/srv/shared/drafts:/drafts:rw"],
            // Required because these sources are outside the agent workspace.
            dangerouslyAllowExternalBindSources: true,
          },
        },
      },
    },
  },
}
```

`workspaceAccess` and bind modes are independent:

| Setting                          | Controls                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `workspaceAccess: "none"`        | Uses an isolated sandbox workspace; does not expose the agent workspace.    |
| `workspaceAccess: "ro"`          | Mounts the agent workspace read-only at `/agent`.                           |
| `workspaceAccess: "rw"`          | Mounts the agent workspace read/write at `/workspace`.                      |
| `docker.binds` entry `:ro`/`:rw` | Controls only that additional host folder at its configured container path. |

Changing `workspaceAccess` does not change an additional bind from `ro` to `rw`, or vice versa. Global and per-agent `docker.binds` are merged. Keep `scope: "agent"` or `"session"` for per-agent binds; `scope: "shared"` ignores all per-agent Docker overrides and uses only global binds.

Bind mounts are the supported multi-folder boundary because Docker constructs the container's filesystem view with mount isolation, and the `ro`/`rw` mode applies to every process in the sandbox. That boundary covers `exec`, filesystem tools, child processes, and libraries without duplicating path-authorization checks across each OpenClaw code path. A host-side path allowlist cannot provide the same complete boundary when an allowed shell or dependency can access files directly.

The opt-in `dangerouslyAllowExternalBindSources` only permits sources outside the workspace roots. It does not disable OpenClaw's blocked system, credential, Docker socket, symlink-parent, or reserved-target checks. Prefer the smallest folder, use `ro` unless writes are required, and recreate the sandbox after changing mounts:

```bash
openclaw sandbox recreate --agent research
```

### Other bind behavior

`agents.defaults.sandbox.docker.binds` configures global mounts. The format is the same `host:container:mode` form (for example, `"/home/user/source:/source:rw"`).

`agents.defaults.sandbox.browser.binds` mounts additional host directories into the **sandbox browser** container only. When set (including `[]`), it replaces `docker.binds` for the browser container; when omitted, the browser container falls back to `docker.binds`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/data/myapp:/data:ro"],
        },
      },
    },
    entries: {
      build: {
        default: true,
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    },
  },
}
```

<Warning>
**Bind security**

- Binds bypass the sandbox filesystem: they expose host paths with whatever mode you set (`:ro` or `:rw`).
- OpenClaw blocks dangerous bind sources by default: system paths (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`), Docker socket directories (`/run`, `/var/run`, and their `docker.sock` variants), and common home-directory credential roots (`~/.aws`, `~/.cargo`, `~/.config`, `~/.docker`, `~/.gnupg`, `~/.netrc`, `~/.npm`, `~/.ssh`).
- Validation normalizes the source path, then resolves it again through the deepest existing ancestor before re-checking blocked paths and allowed roots, so symlink-parent escapes fail closed even when the final leaf doesn't exist yet (e.g. `/workspace/run-link/new-file` still resolves as `/var/run/...` if `run-link` points there).
- Bind targets that shadow the reserved container mount points (`/workspace`, `/agent`) are also blocked by default; override with `agents.defaults.sandbox.docker.dangerouslyAllowReservedContainerTargets: true`.
- Bind sources outside the workspace/agent-workspace allowlisted roots are blocked by default; override with `agents.defaults.sandbox.docker.dangerouslyAllowExternalBindSources: true`. Allowed roots are canonicalized the same way, so a path that only looks inside the allowlist before symlink resolution is still rejected as outside allowed roots.
- Sensitive mounts (secrets, SSH keys, service credentials) should be `:ro` unless absolutely required.
- Combine with `workspaceAccess: "ro"` if you only need read access to the workspace; bind modes stay independent.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for how binds interact with tool policy and elevated exec.

</Warning>

## Images and setup

Default Docker image: `openclaw-sandbox:bookworm-slim`

<Note>
**Source checkout vs npm install**

The `scripts/sandbox-setup.sh`, `scripts/sandbox-common-setup.sh`, and `scripts/sandbox-browser-setup.sh` helper scripts are only available when running from a [source checkout](https://github.com/openclaw/openclaw). They are not included in the npm package.

If you installed the global OpenClaw npm package, use the inline `docker build`
commands shown below instead.
</Note>

<Steps>
  <Step title="Build the default image">
    From a source checkout:

    ```bash
    scripts/sandbox-setup.sh
    ```

    From an npm install (no source checkout needed):

    ```bash
    docker build -t openclaw-sandbox:bookworm-slim - <<'DOCKERFILE'
    FROM debian:bookworm-slim
    ENV DEBIAN_FRONTEND=noninteractive
    RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq python3 ripgrep \
      && rm -rf /var/lib/apt/lists/*
    RUN useradd --create-home --shell /bin/bash sandbox
    USER sandbox
    WORKDIR /home/sandbox
    CMD ["sleep", "infinity"]
    DOCKERFILE
    ```

    The default image does **not** include Node. If a skill needs Node (or other runtimes), either bake a custom image or install via `sandbox.docker.setupCommand` (requires network egress + writable root + root user).

    OpenClaw does not silently substitute plain `debian:bookworm-slim` when `openclaw-sandbox:bookworm-slim` is missing. Sandbox runs that target the default image fail fast with a build instruction until you build it, because the bundled image carries `python3` for the sandbox write/edit helpers.

  </Step>
  <Step title="Optional: build the common image">
    For a more functional sandbox image with common tooling (for example `curl`, `jq`, Node 24, pnpm, `python3`, and `git`):

    From a source checkout:

    ```bash
    scripts/sandbox-common-setup.sh
    ```

    From an npm install, build the default image first (see above), then build the common image on top using [`scripts/docker/sandbox/Dockerfile.common`](https://github.com/openclaw/openclaw/blob/main/scripts/docker/sandbox/Dockerfile.common) from the repository.

    Then set `agents.defaults.sandbox.docker.image` to `openclaw-sandbox-common:bookworm-slim`.

  </Step>
  <Step title="Optional: build the sandbox browser image">
    From a source checkout:

    ```bash
    scripts/sandbox-browser-setup.sh
    ```

    The npm package does not include the browser Dockerfile or entrypoint. Use a source checkout to build this image.

  </Step>
</Steps>

By default, local container sandboxes run with **no network**. Override with `agents.defaults.sandbox.docker.network`.

The default-off [secret egress proxy](/gateway/secrets#secret-egress-proxy) is Gateway-loopback only. Sandbox exec receives neither its proxy/CA environment nor protected sentinels. Sandbox/container proxy reachability is not implemented; do not enable sandbox networking expecting secret substitution to work in this release.

<Note>
Package installation and certificate-store changes are image provisioning, not
normal sandbox-turn behavior. The defaults deliberately combine no network,
a read-only root filesystem, and a non-root image user, so an in-turn package
install should fail. Prefer a custom image that already contains packages and
private certificate roots. If a Node process needs a private CA, also configure
the CA path for Node, for example with `NODE_EXTRA_CA_CERTS`, through the custom
image or `sandbox.docker.env`.
</Note>

<AccordionGroup>
  <Accordion title="Sandbox browser Chromium defaults">
    The bundled sandbox browser image applies conservative Chromium startup flags for containerized workloads:

    - `--remote-debugging-address=127.0.0.1`
    - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
    - `--user-data-dir=${HOME}/.chrome`
    - `--no-first-run`
    - `--no-default-browser-check`
    - `--disable-dev-shm-usage`
    - `--disable-background-networking`
    - `--disable-breakpad`
    - `--disable-crash-reporter`
    - `--no-zygote`
    - `--metrics-recording-only`
    - `--password-store=basic`
    - `--use-mock-keychain`
    - `--headless=new` when `browser.headless` is enabled.
    - `--no-sandbox --disable-setuid-sandbox` (always enabled in the sandbox browser container).
    - `--disable-3d-apis`, `--disable-gpu`, `--disable-software-rasterizer` by default; these graphics-hardening flags help containers without GPU support. Set `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` if your workload needs WebGL or other 3D features.
    - `--disable-extensions` by default; set `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` for extension-reliant flows.
    - `--renderer-process-limit=2` by default; controlled by `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>`, where `0` keeps Chromium's default.

    If you need a different runtime profile, use a custom browser image and provide your own entrypoint. For local (non-container) Chromium profiles, use `browser.extraArgs` to append additional startup flags.

  </Accordion>
  <Accordion title="Network security defaults">
    - `network: "host"` is blocked.
    - `network: "container:<id>"` is blocked by default (namespace join bypass risk).
    - Break-glass override: `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`.

  </Accordion>
</AccordionGroup>

Docker installs and the containerized gateway live here: [Docker](/install/docker)

For Docker gateway deployments, `scripts/docker/setup.sh` can bootstrap sandbox config. Set `OPENCLAW_SANDBOX=1` (or `true`/`yes`/`on`) to enable that path. Override the socket location with `OPENCLAW_DOCKER_SOCKET`. Full setup and env reference: [Docker](/install/docker#agent-sandbox).

## setupCommand (one-time container setup)

`setupCommand` runs **once** after the sandbox container is created (not on every run). It executes inside the container via `sh -lc`.

Paths:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.entries.*.sandbox.docker.setupCommand`

<AccordionGroup>
  <Accordion title="Common pitfalls">
    - Default `docker.network` is `"none"` (no egress), so package installs will fail.
    - `docker.network: "container:<id>"` requires `dangerouslyAllowContainerNamespaceJoin: true` and is break-glass only.
    - `readOnlyRoot: true` prevents writes; set `readOnlyRoot: false` or bake a custom image.
    - `user` must be root for package installs. Docker can omit `user` or set
      `user: "0:0"`; rootful Podman must set `user: "0:0"` because its default
      preserves workspace ownership. Rootless Podman rejects zero-valued users;
      bake packages into the image or use rootful Podman.
    - Sandbox exec does **not** inherit host `process.env`. Use `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.
    - Values in `agents.defaults.sandbox.docker.env` remain visible through container metadata commands such as `docker inspect` or `podman inspect`. Docker and Podman require portable environment names and single-line, non-NUL values because secure engine environment files are line-delimited; config validation and `openclaw doctor` reject invalid entries before sandbox use. Rename invalid keys, use single-line values, or deliver multiline material through a mounted file or custom image; this requires manual remediation because `doctor --fix` cannot safely preserve the original value. SSH and OpenShell backends still support multiline values. Use a custom image, mounted secret file, or another secret delivery path if metadata exposure is not acceptable.

  </Accordion>
</AccordionGroup>

## Tool policy and escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied globally or per-agent, sandboxing doesn't bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` outside the sandbox (`gateway` by default, or `node` when the exec target is `node`). `/exec` directives only apply for authorized senders and persist per session; to hard-disable `exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- `openclaw sandbox list` shows sandbox containers, status, image match, age, idle time, and associated session/agent.
- `openclaw sandbox explain [--session <key>] [--agent <id>]` inspects effective sandbox mode, host workspace, runtime workdir, Docker mounts, tool policy, and fix-it config keys. Its `workspaceRoot` field remains the configured sandbox root; `effectiveHostWorkspaceRoot` shows where the active workspace actually lives.
- `openclaw sandbox recreate [--all | --session <key> | --agent <id>] [--browser] [--force]` removes containers/environments so they get recreated with current config on next use.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the "why is this blocked?" mental model.

## Multi-agent overrides

Each agent can override sandbox + tools: `agents.entries.*.sandbox` and `agents.entries.*.tools` (plus `agents.entries.*.tools.sandbox.tools` for sandbox tool policy). See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

## Minimal enable example

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Related

- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) -- per-agent overrides and precedence
- [OpenShell](/gateway/openshell) -- managed sandbox backend setup, workspace modes, and config reference
- [Sandbox configuration](/gateway/config-agents#agentsdefaultssandbox)
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) -- debugging "why is this blocked?"
- [Security](/gateway/security)
