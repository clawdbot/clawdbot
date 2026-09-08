---
summary: "The agents.defaults.sandbox block: image, mounts, workspace mode, and network policy"
read_when:
  - Running the embedded agent inside a container
  - Choosing a sandbox workspace mode or network policy
  - Building or pinning the sandbox image
title: "Configuration — agent sandboxing"
---

`agents.defaults.sandbox` in full: image selection, workspace mode, mounts, and network policy for the embedded agent.

<a id="agentsdefaultssandbox"></a>

## `agents.defaults.sandbox`

Optional sandboxing for the embedded agent. See [Sandboxing](/gateway/sandboxing) for the full guide.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off (default) | non-main | all
        backend: "docker", // docker (default) | openshell | podman | ssh
        scope: "agent", // session | agent (default) | shared
        workspaceAccess: "none", // none (default) | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          gpus: "all",
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/home/user/source:/source:rw"],
        },
        ssh: {
          target: "user@gateway-host:22",
          command: "ssh",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
          identityFile: "~/.ssh/id_ed25519",
          certificateFile: "~/.ssh/id_ed25519-cert.pub",
          knownHostsFile: "~/.ssh/known_hosts",
          // SecretRefs / inline contents also supported:
          // identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          // certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          // knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          cdpSourceRange: "172.21.0.1/32",
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          noVncEnabled: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24,
          maxAgeDays: 7,
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Defaults shown above (`off`/`docker`/`agent`/`none`/`bookworm-slim` image/`none` network/etc.) are the actual OpenClaw defaults, not just illustrative values.

<Accordion title="Sandbox details">

**Backend:**

- `docker`: local Docker runtime (default)
- `openshell`: OpenShell-managed local or remote runtime
- `podman`: local Podman runtime using Docker-compatible settings
- `ssh`: generic SSH-backed remote runtime

Plugin-managed backends keep runtime-specific settings under their plugin entries:

- OpenShell: `plugins.entries.openshell.config`; see [OpenShell](/gateway/openshell)

**SSH backend config:**

- `target`: SSH target in `user@host[:port]` form
- `command`: SSH client command (default: `ssh`)
- `workspaceRoot`: absolute remote root used for per-scope workspaces (default: `/tmp/openclaw-sandboxes`)
- `identityFile` / `certificateFile` / `knownHostsFile`: existing local files passed to OpenSSH
- `identityData` / `certificateData` / `knownHostsData`: inline contents or SecretRefs that OpenClaw materializes into temp files at runtime
- `strictHostKeyChecking` / `updateHostKeys`: OpenSSH host-key policy knobs (both default `true`)

**SSH auth precedence:**

- `identityData` wins over `identityFile`
- `certificateData` wins over `certificateFile`
- `knownHostsData` wins over `knownHostsFile`
- SecretRef-backed `*Data` values are resolved from the active secrets runtime snapshot before the sandbox session starts

**SSH backend behavior:**

- seeds the remote workspace once after create or recreate
- then keeps the remote SSH workspace canonical
- routes `exec`, file tools, and media paths over SSH
- does not sync remote changes back to the host automatically
- does not support sandbox browser containers

**Workspace access:**

- `none`: per-scope sandbox workspace under `~/.openclaw/sandboxes` (default)
- `ro`: sandbox workspace at `/workspace`, agent workspace mounted read-only at `/agent`
- `rw`: agent workspace mounted read/write at `/workspace`

**Scope:**

- `session`: per-session container + workspace
- `agent`: one container + workspace per agent (default)
- `shared`: shared container and workspace (no cross-session isolation)

**OpenShell plugin config:**

```json5
{
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          mode: "mirror", // mirror (default) | remote
          command: "openshell",
          from: "openclaw",
          remoteWorkspaceDir: "/sandbox",
          remoteAgentWorkspaceDir: "/agent",
          gateway: "lab", // optional
          gatewayEndpoint: "https://lab.example", // optional
          workspace: "research", // optional existing OpenShell workspace
          policy: "/etc/openclaw/openshell-policy.yaml", // optional host-side YAML file
          providers: ["openai"], // optional
          gpu: false,
          autoProviders: true,
          timeoutSeconds: 120,
        },
      },
    },
  },
}
```

**OpenShell mode:**

- `mirror`: seed remote from local before exec, sync back after exec; local workspace stays canonical
- `remote`: seed remote once when the sandbox is created, then keep the remote workspace canonical

In `remote` mode, host-local edits made outside OpenClaw are not synced into the sandbox automatically after the seed step.
Transport is SSH into the OpenShell sandbox, but the plugin owns sandbox lifecycle and optional mirror sync.
`workspace` selects an existing OpenShell control-plane workspace for the whole plugin; it is separate from the agent's filesystem workspace. `policy` must point to a YAML file readable by the OpenClaw Gateway, not a named policy ID. See [OpenShell](/gateway/openshell) for setup, prerequisites, and troubleshooting.

**`setupCommand`** runs once after container creation (via `sh -lc`). Needs network egress, writable root, root user.

**Containers default to `network: "none"`** — set to `"bridge"` (or a custom bridge network) if the agent needs outbound access.
`"host"` is blocked. `"container:<id>"` is blocked by default unless you explicitly set
`sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true` (break-glass).
Codex app-server turns in an active OpenClaw sandbox use this same egress setting for their native code-mode network access.

**Inbound attachments** are staged into `media/inbound/*` in the active workspace.

**`docker.binds`** mounts additional host directories; global and per-agent binds are merged.

**Sandboxed browser** (`sandbox.browser.enabled`, default `false`): Chromium + CDP in a container. Does not require `browser.enabled` in `openclaw.json`.
noVNC observer access is password-protected and brokered through a one-time, authenticated bootstrap URL. The observer URL is deliberately omitted from model-visible system prompt context.

- `allowHostControl: false` (default) blocks sandboxed sessions from targeting the host browser.
- `network` defaults to `openclaw-sandbox-browser` (dedicated bridge network). Set to `bridge` only when you explicitly want global bridge connectivity. `"none"` is unsupported because CDP ports must be published to the host; `"host"` is blocked too. On upgrade, `openclaw doctor --fix` disables sidecars affected by a persisted `"none"` value and restores the dedicated network without silently enabling egress.
- `cdpSourceRange` optionally restricts CDP ingress at the container edge to a CIDR range (for example `172.21.0.1/32`).
- `sandbox.browser.binds` mounts additional host directories into the sandbox browser container only. When set (including `[]`), it replaces `docker.binds` for the browser container.
- The sandbox browser container's Chromium always launches with `--no-sandbox --disable-setuid-sandbox` (containers do not have the kernel primitives Chrome's own sandbox needs); there is no config toggle for this.
- Launch defaults are defined in `scripts/sandbox-browser-entrypoint.sh` and tuned for container hosts:
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
  - `--disable-3d-apis`, `--disable-gpu`, and `--disable-software-rasterizer` are
    enabled by default and can be disabled with
    `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` if WebGL/3D usage requires it.
  - `--disable-extensions` (default enabled); `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0`
    re-enables extensions if your workflow depends on them.
  - `--renderer-process-limit=2` by default; change with
    `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>`, set `0` to use Chromium's
    default process limit.
  - `--headless=new` only when `headless` is enabled.
  - Defaults are the container image baseline; use a custom browser image with a custom
    entrypoint to change container defaults.

</Accordion>

Browser sandboxing requires the Docker engine. `sandbox.docker.binds` applies to both the Docker and Podman backends.

Build images (from a source checkout):

```bash
scripts/sandbox-setup.sh           # main sandbox image
scripts/sandbox-browser-setup.sh   # optional browser image
```

For npm installs without a source checkout, see [Sandboxing § Images and setup](/gateway/sandboxing#images-and-setup) for inline `docker build` commands.
