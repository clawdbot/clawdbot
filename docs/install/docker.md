---
summary: "Optional Docker-based setup and onboarding for Clawdbot"
read_when:
  - You want a containerized gateway instead of local installs
  - You are validating the Docker flow
---

# Docker (optional)

Docker is **optional**. Use it only if you want a containerized gateway or to validate the Docker flow.

This guide covers:
- Containerized Gateway (full Clawdbot in Docker)
- Per-session Agent Sandbox (host gateway + Docker-isolated agent tools)

## Requirements

- Docker Desktop (or Docker Engine) + Docker Compose v2
- Enough disk for images + logs

## Containerized Gateway (Docker Compose)

### Quick start (recommended)

From repo root:

```bash
./docker-setup.sh
```

This script:
- builds the gateway image
- runs the onboarding wizard
- prints optional provider setup hints
- starts the gateway via Docker Compose

It writes config/workspace on the host:
- `~/.clawdbot/`
- `~/clawd`

### Manual flow (compose)

```bash
docker build -t clawdbot:local -f Dockerfile .
docker compose run --rm clawdbot-cli onboard
docker compose up -d clawdbot-gateway
```

### Provider setup (optional)

Use the CLI container to configure providers, then restart the gateway if needed.

WhatsApp (QR):
```bash
docker compose run --rm clawdbot-cli providers login
```

Telegram (bot token):
```bash
docker compose run --rm clawdbot-cli providers add --provider telegram --token "<token>"
```

Discord (bot token):
```bash
docker compose run --rm clawdbot-cli providers add --provider discord --token "<token>"
```

Docs: [WhatsApp](/providers/whatsapp), [Telegram](/providers/telegram), [Discord](/providers/discord)

### Health check

```bash
docker compose exec clawdbot-gateway node dist/index.js health --token "$CLAWDBOT_GATEWAY_TOKEN"
```

### E2E smoke test (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### QR import smoke test (Docker)

```bash
pnpm test:docker:qr
```

### Notes

- Gateway bind defaults to `lan` for container use.
- The gateway container is the source of truth for sessions (`~/.clawdbot/agents/<agentId>/sessions/`).

## Agent Sandbox (host gateway + Docker tools)

### What it does

When `agent.sandbox` is enabled, **non-main sessions** run tools inside a Docker
container. The gateway stays on your host, but the tool execution is isolated:
- scope: `"agent"` by default (one container + workspace per agent)
- scope: `"session"` for per-session isolation
- per-scope workspace folder mounted at `/workspace`
- optional agent workspace access (`agent.sandbox.workspaceAccess`)
- allow/deny tool policy (deny wins)
- inbound media is copied into the active sandbox workspace (`media/inbound/*`) so tools can read it (with `workspaceAccess: "rw"`, this lands in the agent workspace)

Warning: `scope: "shared"` disables cross-session isolation. All sessions share
one container and one workspace.

### Per-agent sandbox profiles (multi-agent)

If you use multi-agent routing, each agent can override sandbox + tool settings:
`routing.agents[id].sandbox` and `routing.agents[id].tools`. This lets you run
mixed access levels in one gateway:
- Full access (personal agent)
- Read-only tools + read-only workspace (family/work agent)
- No filesystem/shell tools (public agent)

See [Multi-Agent Sandbox & Tools](/multi-agent-sandbox-tools) for examples,
precedence, and troubleshooting.

### Default behavior

- Image: `clawdbot-sandbox:bookworm-slim`
- One container per agent
- Agent workspace access: `workspaceAccess: "none"` (default) uses `~/.clawdbot/sandboxes`
  - `"ro"` keeps the sandbox workspace at `/workspace` and mounts the agent workspace read-only at `/agent` (disables `write`/`edit`)
  - `"rw"` mounts the agent workspace read/write at `/workspace`
- Auto-prune: idle > 24h OR age > 7d
- Network: `none` by default (explicitly opt-in if you need egress)
- Default allow: `bash`, `process`, `read`, `write`, `edit`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`
- Default deny: `browser`, `canvas`, `nodes`, `cron`, `discord`, `gateway`

### Enable sandboxing

```json5
{
  agent: {
    sandbox: {
      mode: "non-main", // off | non-main | all
      scope: "agent", // session | agent | shared (agent is default)
      workspaceAccess: "none", // none | ro | rw
      workspaceRoot: "~/.clawdbot/sandboxes",
      docker: {
        image: "clawdbot-sandbox:bookworm-slim",
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
        ulimits: {
          nofile: { soft: 1024, hard: 2048 },
          nproc: 256
        },
        seccompProfile: "/path/to/seccomp.json",
        apparmorProfile: "clawdbot-sandbox",
        dns: ["1.1.1.1", "8.8.8.8"],
        extraHosts: ["internal.service:10.0.0.5"]
      },
      tools: {
        allow: ["bash", "process", "read", "write", "edit", "sessions_list", "sessions_history", "sessions_send", "sessions_spawn"],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"]
      },
      prune: {
        idleHours: 24, // 0 disables idle pruning
        maxAgeDays: 7  // 0 disables max-age pruning
      }
    }
  }
}
```

Hardening knobs live under `agent.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`, `memorySwap`, `cpus`, `ulimits`,
`seccompProfile`, `apparmorProfile`, `dns`, `extraHosts`.

Multi-agent: override `agent.sandbox.{docker,browser,prune}.*` per agent via `routing.agents.<agentId>.sandbox.{docker,browser,prune}.*`
(ignored when `agent.sandbox.scope` / `routing.agents.<agentId>.sandbox.scope` is `"shared"`).

### Build the default sandbox image

```bash
scripts/sandbox-setup.sh
```

This builds `clawdbot-sandbox:bookworm-slim` using `Dockerfile.sandbox`.

### Sandbox common image (optional)
If you want a sandbox image with common build tooling (Node, Go, Rust, etc.), build the common image:

```bash
scripts/sandbox-common-setup.sh
```

This builds `clawdbot-sandbox-common:bookworm-slim`. To use it:

```json5
{
  agent: { sandbox: { docker: { image: "clawdbot-sandbox-common:bookworm-slim" } } }
}
```

### Sandbox browser image

To run the browser tool inside the sandbox, build the browser image:

```bash
scripts/sandbox-browser-setup.sh
```

This builds `clawdbot-sandbox-browser:bookworm-slim` using
`Dockerfile.sandbox-browser`. The container runs Chromium with CDP enabled and
an optional noVNC observer (headful via Xvfb).

Notes:
- Headful (Xvfb) reduces bot blocking vs headless.
- Headless can still be used by setting `agent.sandbox.browser.headless=true`.
- No full desktop environment (GNOME) is needed; Xvfb provides the display.

Use config:

```json5
{
  agent: {
    sandbox: {
      browser: { enabled: true }
    }
  }
}
```

Custom browser image:

```json5
{
  agent: {
    sandbox: { browser: { image: "my-clawdbot-browser" } }
  }
}
```

When enabled, the agent receives:
- a sandbox browser control URL (for the `browser` tool)
- a noVNC URL (if enabled and headless=false)

Remember: if you use an allowlist for tools, add `browser` (and remove it from
deny) or the tool remains blocked.
Prune rules (`agent.sandbox.prune`) apply to browser containers too.

### Custom sandbox image

Build your own image and point config to it:

```bash
docker build -t my-clawdbot-sbx -f Dockerfile.sandbox .
```

```json5
{
  agent: {
    sandbox: { docker: { image: "my-clawdbot-sbx" } }
  }
}
```

### Tool policy (allow/deny)

- `deny` wins over `allow`.
- If `allow` is empty: all tools (except deny) are available.
- If `allow` is non-empty: only tools in `allow` are available (minus deny).

### Pruning strategy

Two knobs:
- `prune.idleHours`: remove containers not used in X hours (0 = disable)
- `prune.maxAgeDays`: remove containers older than X days (0 = disable)

Example:
- Keep busy sessions but cap lifetime:
  `idleHours: 24`, `maxAgeDays: 7`
- Never prune:
  `idleHours: 0`, `maxAgeDays: 0`

### Security notes

- Hard wall only applies to **tools** (bash/read/write/edit).  
- Host-only tools like browser/camera/canvas are blocked by default.  
- Allowing `browser` in sandbox **breaks isolation** (browser runs on host).

## Troubleshooting

- Image missing: build with [`scripts/sandbox-setup.sh`](https://github.com/clawdbot/clawdbot/blob/main/scripts/sandbox-setup.sh) or set `agent.sandbox.docker.image`.
- Container not running: it will auto-create per session on demand.
- Permission errors in sandbox: set `docker.user` to a UID:GID that matches your
  mounted workspace ownership (or chown the workspace folder).
