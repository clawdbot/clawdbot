---
summary: "How OpenClaw sandboxing works: modes, scopes, workspace access, and images"
title: "Sandboxing"
sidebarTitle: "Sandboxing"
read_when: "You want a dedicated explanation of sandboxing or need to tune agents.defaults.sandbox."
status: active
---

OpenClaw can run **tools inside sandbox backends** to reduce blast radius. This is **optional** and controlled by configuration (`agents.defaults.sandbox` or `agents.list[].sandbox`). If sandboxing is off, tools run on the host. The Gateway stays on the host; tool execution runs in an isolated sandbox when enabled.

<Note>
This is not a perfect security boundary, but it materially limits filesystem and process access when the model does something dumb.
</Note>

## What gets sandboxed

- Tool execution (`exec`, `read`, `write`, `edit`, `apply_patch`, `process`, etc.).
- Optional sandboxed browser (`agents.defaults.sandbox.browser`).

<AccordionGroup>
  <Accordion title="Sandboxed browser details">
    - By default, the sandbox browser auto-starts (ensures CDP is reachable) when the browser tool needs it. Configure via `agents.defaults.sandbox.browser.autoStart` and `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
    - By default, sandbox browser containers use a dedicated Docker network (`openclaw-sandbox-browser`) instead of the global `bridge` network. Configure with `agents.defaults.sandbox.browser.network`.
    - Optional `agents.defaults.sandbox.browser.cdpSourceRange` restricts container-edge CDP ingress with a CIDR allowlist (for example `172.21.0.1/32`).
    - noVNC observer access is password-protected by default; OpenClaw emits a short-lived token URL that serves a local bootstrap page and opens noVNC with password in URL fragment (not query/header logs).
    - `agents.defaults.sandbox.browser.allowHostControl` lets sandboxed sessions target the host browser explicitly.
    - Optional allowlists gate `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

  </Accordion>
</AccordionGroup>

Not sandboxed:

- The Gateway process itself.
- Any tool explicitly allowed to run outside the sandbox (e.g. `tools.elevated`).
  - **Elevated exec bypasses sandboxing and uses the configured escape path (`gateway` by default, or `node` when the exec target is `node`).**
  - If sandboxing is off, `tools.elevated` does not change execution (already on host). See [Elevated Mode](/tools/elevated).

## Modes

`agents.defaults.sandbox.mode` controls **when** sandboxing is used:

<Tabs>
  <Tab title="off">
    No sandboxing.
  </Tab>
  <Tab title="non-main">
    Sandbox only **non-main** sessions (default if you want normal chats on host).

    `"non-main"` is based on `session.mainKey` (default `"main"`), not agent id. Group/channel sessions use their own keys, so they count as non-main and will be sandboxed.

  </Tab>
  <Tab title="all">
    Every session runs in a sandbox.
  </Tab>
</Tabs>

## Scope

`agents.defaults.sandbox.scope` controls **how many containers** are created:

- `"agent"` (default): one container per agent.
- `"session"`: one container per session.
- `"shared"`: one container shared by all sandboxed sessions.

## Backend

`agents.defaults.sandbox.backend` controls **which runtime** provides the sandbox:

- `"docker"` (default when sandboxing is enabled): local Docker-backed sandbox runtime.
- `"ssh"`: generic SSH-backed remote sandbox runtime.
- `"openshell"`: OpenShell-backed sandbox runtime.

SSH-specific config lives under `agents.defaults.sandbox.ssh`. OpenShell-specific config lives under `plugins.entries.openshell.config`.

### Choosing a backend

|                     | Docker                           | SSH                            | OpenShell                                           |
| ------------------- | -------------------------------- | ------------------------------ | --------------------------------------------------- |
| **Where it runs**   | Local container                  | Any SSH-accessible host        | OpenShell managed sandbox                           |
| **Setup**           | `scripts/sandbox-setup.sh`       | SSH key + target host          | OpenShell plugin enabled                            |
| **Workspace model** | Bind-mount or copy               | Remote-canonical (seed once)   | `mirror` or `remote`                                |
| **Network control** | `docker.network` (default: none) | Depends on remote host         | Depends on OpenShell                                |
| **Browser sandbox** | Supported                        | Not supported                  | Not supported yet                                   |
| **Bind mounts**     | `docker.binds`                   | N/A                            | N/A                                                 |
| **Best for**        | Local dev, full isolation        | Offloading to a remote machine | Managed remote sandboxes with optional two-way sync |

### Docker backend

Sandboxing is off by default. If you enable sandboxing and do not choose a backend, OpenClaw uses the Docker backend. It executes tools and sandbox browsers locally via the Docker daemon socket (`/var/run/docker.sock`). Sandbox container isolation is determined by Docker namespaces.

To expose host GPUs to Docker sandboxes, set `agents.defaults.sandbox.docker.gpus` or the per-agent `agents.list[].sandbox.docker.gpus` override. The value is passed to Docker's `--gpus` flag as a separate argument, for example `"all"` or `"device=GPU-uuid"`, and requires a compatible host runtime such as NVIDIA Container Toolkit.

<Warning>
**Docker-out-of-Docker (DooD) constraints**

If you deploy the OpenClaw Gateway itself as a Docker container, it orchestrates sibling sandbox containers using the host's Docker socket (DooD). This introduces a specific path mapping constraint:

- **Config requires host paths**: The `openclaw.json` `workspace` configuration MUST contain the **Host's absolute path** (e.g. `/home/user/.openclaw/workspaces`), not the internal Gateway container path. When OpenClaw asks the Docker daemon to spawn a sandbox, the daemon evaluates paths relative to the Host OS namespace, not the Gateway namespace.
- **FS bridge parity (identical volume map)**: The OpenClaw Gateway native process also writes heartbeat and bridge files to the `workspace` directory. Because the Gateway evaluates the exact same string (the host path) from within its own containerized environment, the Gateway deployment MUST include an identical volume map linking the host namespace natively (`-v /home/user/.openclaw:/home/user/.openclaw`).

If you map paths internally without absolute host parity, OpenClaw natively throws an `EACCES` permission error attempting to write its heartbeat inside the container environment because the fully qualified path string doesn't exist natively.
</Warning>

### SSH backend

Use `backend: "ssh"` when you want OpenClaw to sandbox `exec`, file tools, and media reads on an arbitrary SSH-accessible machine.

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

<AccordionGroup>
  <Accordion title="How it works">
    - OpenClaw creates a per-scope remote root under `sandbox.ssh.workspaceRoot`.
    - On first use after create or recreate, OpenClaw seeds that remote workspace from the local workspace once.
    - After that, `exec`, `read`, `write`, `edit`, `apply_patch`, prompt media reads, and inbound media staging run directly against the remote workspace over SSH.
    - OpenClaw does not sync remote changes back to the local workspace automatically.

  </Accordion>
  <Accordion title="Authentication material">
    - `identityFile`, `certificateFile`, `knownHostsFile`: use existing local files and pass them through OpenSSH config.
    - `identityData`, `certificateData`, `knownHostsData`: use inline strings or SecretRefs. OpenClaw resolves them through the normal secrets runtime snapshot, writes them to temp files with `0600`, and deletes them when the SSH session ends.
    - If both `*File` and `*Data` are set for the same item, `*Data` wins for that SSH session.

  </Accordion>
  <Accordion title="Remote-canonical consequences">
    This is a **remote-canonical** model. The remote SSH workspace becomes the real sandbox state after the initial seed.

    - Host-local edits made outside OpenClaw after the seed step are not visible remotely until you recreate the sandbox.
    - `openclaw sandbox recreate` deletes the per-scope remote root and seeds again from local on next use.
    - Browser sandboxing is not supported on the SSH backend.
    - `sandbox.docker.*` settings do not apply to the SSH backend.

  </Accordion>
</AccordionGroup>

### OpenShell backend

Use `backend: "openshell"` when you want OpenClaw to sandbox tools in an OpenShell-managed remote environment. For the full setup guide, configuration reference, and workspace mode comparison, see the dedicated [OpenShell page](/gateway/openshell).

OpenShell reuses the same core SSH transport and remote filesystem bridge as the generic SSH backend, and adds OpenShell-specific lifecycle (`sandbox create/get/delete`, `sandbox ssh-config`) plus the optional `mirror` workspace mode.

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
          remoteWorkspaceDir: "/sandbox",
          remoteAgentWorkspaceDir: "/agent",
        },
      },
    },
  },
}
```

OpenShell modes:

- `mirror` (default): local workspace stays canonical. OpenClaw syncs local files into OpenShell before exec and syncs the remote workspace back after exec.
- `remote`: OpenShell workspace is canonical after the sandbox is created. OpenClaw seeds the remote workspace once from the local workspace, then file tools and exec run directly against the remote sandbox without syncing changes back.

<AccordionGroup>
  <Accordion title="Remote transport details">
    - OpenClaw asks OpenShell for sandbox-specific SSH config via `openshell sandbox ssh-config <name>`.
    - Core writes that SSH config to a temp file, opens the SSH session, and reuses the same remote filesystem bridge used by `backend: "ssh"`.
    - In `mirror` mode only the lifecycle differs: sync local to remote before exec, then sync back after exec.

  </Accordion>
  <Accordion title="Current OpenShell limitations">
    - sandbox browser is not supported yet
    - `sandbox.docker.binds` is not supported on the OpenShell backend
    - Docker-specific runtime knobs under `sandbox.docker.*` still apply only to the Docker backend

  </Accordion>
</AccordionGroup>

#### Workspace modes

OpenShell has two workspace models. This is the part that matters most in practice.

<Tabs>
  <Tab title="mirror (local canonical)">
    Use `plugins.entries.openshell.config.mode: "mirror"` when you want the **local workspace to stay canonical**.

    Behavior:

    - Before `exec`, OpenClaw syncs the local workspace into the OpenShell sandbox.
    - After `exec`, OpenClaw syncs the remote workspace back to the local workspace.
    - File tools still operate through the sandbox bridge, but the local workspace remains the source of truth between turns.

    Use this when:

    - you edit files locally outside OpenClaw and want those changes to show up in the sandbox automatically
    - you want the OpenShell sandbox to behave as much like the Docker backend as possible
    - you want the host workspace to reflect sandbox writes after each exec turn

    Tradeoff: extra sync cost before and after exec.

  </Tab>
  <Tab title="remote (OpenShell canonical)">
    Use `plugins.entries.openshell.config.mode: "remote"` when you want the **OpenShell workspace to become canonical**.

    Behavior:

    - When the sandbox is first created, OpenClaw seeds the remote workspace from the local workspace once.
    - After that, `exec`, `read`, `write`, `edit`, and `apply_patch` operate directly against the remote OpenShell workspace.
    - OpenClaw does **not** sync remote changes back into the local workspace after exec.
    - Prompt-time media reads still work because file and media tools read through the sandbox bridge instead of assuming a local host path.
    - Transport is SSH into the OpenShell sandbox returned by `openshell sandbox ssh-config`.

    Important consequences:

    - If you edit files on the host outside OpenClaw after the seed step, the remote sandbox will **not** see those changes automatically.
    - If the sandbox is recreated, the remote workspace is seeded from the local workspace again.
    - With `scope: "agent"` or `scope: "shared"`, that remote workspace is shared at that same scope.

    Use this when:

    - the sandbox should live primarily on the remote OpenShell side
    - you want lower per-turn sync overhead
    - you do not want host-local edits to silently overwrite remote sandbox state

  </Tab>
</Tabs>

Choose `mirror` if you think of the sandbox as a temporary execution environment. Choose `remote` if you think of the sandbox as the real workspace.

#### OpenShell lifecycle

OpenShell sandboxes are still managed through the normal sandbox lifecycle:

- `openclaw sandbox list` shows OpenShell runtimes as well as Docker runtimes
- `openclaw sandbox recreate` deletes the current runtime and lets OpenClaw recreate it on next use
- prune logic is backend-aware too

For `remote` mode, recreate is especially important:

- recreate deletes the canonical remote workspace for that scope
- the next use seeds a fresh remote workspace from the local workspace

For `mirror` mode, recreate mainly resets the remote execution environment because the local workspace remains canonical anyway.

## Workspace access

`agents.defaults.sandbox.workspaceAccess` controls **what the sandbox can see**:

<Tabs>
  <Tab title="none (default)">
    Tools see a sandbox workspace under `~/.openclaw/sandboxes`.
  </Tab>
  <Tab title="ro">
    Mounts the agent workspace read-only at `/agent` (disables `write`/`edit`/`apply_patch`).
  </Tab>
  <Tab title="rw">
    Mounts the agent workspace read/write at `/workspace`.
  </Tab>
</Tabs>

With the OpenShell backend:

- `mirror` mode still uses the local workspace as the canonical source between exec turns
- `remote` mode uses the remote OpenShell workspace as the canonical source after the initial seed
- `workspaceAccess: "ro"` and `"none"` still restrict write behavior the same way

Inbound media is copied into the active sandbox workspace (`media/inbound/*`).

<Note>
**Skills note:** the `read` tool is sandbox-rooted. With `workspaceAccess: "none"`, OpenClaw mirrors eligible skills into the sandbox workspace (`.../skills`) so they can be read. With `"rw"`, workspace skills are readable from `/workspace/skills`.
</Note>

## Custom bind mounts

`agents.defaults.sandbox.docker.binds` mounts additional host directories into the container. Format: `host:container:mode` (e.g., `"/home/user/source:/source:rw"`).

Global and per-agent binds are **merged** (not replaced). Under `scope: "shared"`, per-agent binds are ignored.

`agents.defaults.sandbox.browser.binds` mounts additional host directories into the **sandbox browser** container only.

- When set (including `[]`), it replaces `agents.defaults.sandbox.docker.binds` for the browser container.
- When omitted, the browser container falls back to `agents.defaults.sandbox.docker.binds` (backwards compatible).

Example (read-only source + an extra data directory):

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
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

<Warning>
**Bind security**

- Binds bypass the sandbox filesystem: they expose host paths with whatever mode you set (`:ro` or `:rw`).
- OpenClaw blocks dangerous bind sources (for example: `docker.sock`, `/etc`, `/proc`, `/sys`, `/dev`, and parent mounts that would expose them).
- OpenClaw also blocks common home-directory credential roots such as `~/.aws`, `~/.cargo`, `~/.config`, `~/.docker`, `~/.gnupg`, `~/.netrc`, `~/.npm`, and `~/.ssh`.
- Bind validation is not just string matching. OpenClaw normalizes the source path, then resolves it again through the deepest existing ancestor before re-checking blocked paths and allowed roots.
- That means symlink-parent escapes still fail closed even when the final leaf does not exist yet. Example: `/workspace/run-link/new-file` still resolves as `/var/run/...` if `run-link` points there.
- Allowed source roots are canonicalized the same way, so a path that only looks inside the allowlist before symlink resolution is still rejected as `outside allowed roots`.
- Sensitive mounts (secrets, SSH keys, service credentials) should be `:ro` unless absolutely required.
- Combine with `workspaceAccess: "ro"` if you only need read access to the workspace; bind modes stay independent.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for how binds interact with tool policy and elevated exec.

</Warning>

## Images and setup

Default Docker image: `openclaw-sandbox:bookworm-slim`

<Note>
**Source checkout vs npm install**

The `scripts/sandbox-setup.sh`, `scripts/sandbox-common-setup.sh`, and `scripts/sandbox-browser-setup.sh` helper scripts are only available when running from a [source checkout](https://github.com/openclaw/openclaw). They are not included in the npm package.

If you installed OpenClaw via `npm install -g openclaw`, use the inline `docker build` commands shown below instead.
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

    OpenClaw does not silently substitute plain `debian:bookworm-slim` when `openclaw-sandbox:bookworm-slim` is missing. Sandbox runs that target the default image fail fast with a build instruction until you build it, because the bundled image carries `python3` for sandbox write/edit helpers.

  </Step>
  <Step title="Optional: build the common image">
    For a more functional sandbox image with common tooling (for example `curl`, `jq`, `nodejs`, `python3`, `git`):

    From a source checkout:

    ```bash
    scripts/sandbox-common-setup.sh
    ```

    From an npm install, build the default image first (see above), then build the common image on top using the [`Dockerfile.sandbox-common`](https://github.com/openclaw/openclaw/blob/main/Dockerfile.sandbox-common) from the repository.

    Then set `agents.defaults.sandbox.docker.image` to `openclaw-sandbox-common:bookworm-slim`.

  </Step>
  <Step title="Optional: build the sandbox browser image">
    From a source checkout:

    ```bash
    scripts/sandbox-browser-setup.sh
    ```

    From an npm install, build using the [`Dockerfile.sandbox-browser`](https://github.com/openclaw/openclaw/blob/main/Dockerfile.sandbox-browser) from the repository.

  </Step>
</Steps>

By default, Docker sandbox containers run with **no network**. Override with `agents.defaults.sandbox.docker.network`.

<AccordionGroup>
  <Accordion title="Sandbox browser Chromium defaults">
    The bundled sandbox browser image also applies conservative Chromium startup defaults for containerized workloads. Current container defaults include:

    - `--remote-debugging-address=127.0.0.1`
    - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
    - `--user-data-dir=${HOME}/.chrome`
    - `--no-first-run`
    - `--no-default-browser-check`
    - `--disable-3d-apis`
    - `--disable-gpu`
    - `--disable-dev-shm-usage`
    - `--disable-background-networking`
    - `--disable-extensions`
    - `--disable-features=TranslateUI`
    - `--disable-breakpad`
    - `--disable-crash-reporter`
    - `--disable-software-rasterizer`
    - `--no-zygote`
    - `--metrics-recording-only`
    - `--renderer-process-limit=2`
    - `--no-sandbox` when `noSandbox` is enabled.
    - The three graphics hardening flags (`--disable-3d-apis`, `--disable-software-rasterizer`, `--disable-gpu`) are optional and are useful when containers lack GPU support. Set `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` if your workload requires WebGL or other 3D/browser features.
    - `--disable-extensions` is enabled by default and can be disabled with `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` for extension-reliant flows.
    - `--renderer-process-limit=2` is controlled by `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>`, where `0` keeps Chromium's default.

    If you need a different runtime profile, use a custom browser image and provide your own entrypoint. For local (non-container) Chromium profiles, use `browser.extraArgs` to append additional startup flags.

  </Accordion>
  <Accordion title="Network security defaults">
    - `network: "host"` is blocked.
    - `network: "container:<id>"` is blocked by default (namespace join bypass risk).
    - Break-glass override: `agents.defaults.sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true`.

  </Accordion>
</AccordionGroup>

Docker installs and the containerized gateway live here: [Docker](/install/docker)

For Docker gateway deployments, `scripts/docker/setup.sh` can bootstrap sandbox config. Set `OPENCLAW_SANDBOX=1` (or `true`/`yes`/`on`) to enable that path. You can override socket location with `OPENCLAW_DOCKER_SOCKET`. Full setup and env reference: [Docker](/install/docker#agent-sandbox).

## setupCommand (one-time container setup)

`setupCommand` runs **once** after the sandbox container is created (not on every run). It executes inside the container via `sh -lc`.

Paths:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.list[].sandbox.docker.setupCommand`

<AccordionGroup>
  <Accordion title="Common pitfalls">
    - Default `docker.network` is `"none"` (no egress), so package installs will fail.
    - `docker.network: "container:<id>"` requires `dangerouslyAllowContainerNamespaceJoin: true` and is break-glass only.
    - `readOnlyRoot: true` prevents writes; set `readOnlyRoot: false` or bake a custom image.
    - `user` must be root for package installs (omit `user` or set `user: "0:0"`).
    - Sandbox exec does **not** inherit host `process.env`. Use `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.

  </Accordion>
</AccordionGroup>

## Tool policy and escape hatches

Tool allow/deny policies still apply before sandbox rules. If a tool is denied globally or per-agent, sandboxing doesn't bring it back.

`tools.elevated` is an explicit escape hatch that runs `exec` outside the sandbox (`gateway` by default, or `node` when the exec target is `node`). `/exec` directives only apply for authorized senders and persist per session; to hard-disable `exec`, use tool policy deny (see [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Debugging:

- Use `openclaw sandbox explain` to inspect effective sandbox mode, tool policy, and fix-it config keys.
- See [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) for the "why is this blocked?" mental model.

Keep it locked down.

## Multi-agent overrides

Each agent can override sandbox + tools: `agents.list[].sandbox` and `agents.list[].tools` (plus `agents.list[].tools.sandbox.tools` for sandbox tool policy). See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence.

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

- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) — per-agent overrides and precedence
- [OpenShell](/gateway/openshell) — managed sandbox backend setup, workspace modes, and config reference
- [Sandbox configuration](/gateway/config-agents#agentsdefaultssandbox)
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) — debugging "why is this blocked?"
- [Security](/gateway/security)
