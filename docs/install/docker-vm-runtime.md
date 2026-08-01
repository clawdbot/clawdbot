---
summary: "Shared Docker VM runtime steps for long-lived OpenClaw Gateway hosts"
read_when:
  - You are deploying OpenClaw on a cloud VM with Docker
  - You need the shared binary bake, persistence, and update flow
title: "Docker VM runtime"
---

Shared runtime steps for VM-based Docker installs such as GCP, Hetzner, and similar VPS providers.

## Bake required binaries into the image

Installing binaries inside a running container is a trap: anything installed
at runtime is lost on restart. Bake every external binary a skill needs into
the image at build time.

The examples below cover three binaries only, alphabetically:

- `gog` (from `gogcli`) for Gmail access
- `goplaces` for Google Places
- `wacli` for WhatsApp

These are examples, not a complete list. Install as many binaries as your
skills need using the same pattern. When you add a skill that needs a new
binary later:

1. Update the Dockerfile.
2. Rebuild the image.
3. Restart the containers.

**Example Dockerfile**

```dockerfile
FROM node:24-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI (gogcli — installs as `gog`)
# Copy the current Linux asset URL from https://github.com/steipete/gogcli/releases
RUN curl -L https://github.com/steipete/gogcli/releases/latest/download/gogcli_linux_amd64.tar.gz \
  | tar -xzO gog > /usr/local/bin/gog; \
  chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
# Copy the current Linux asset URL from https://github.com/steipete/goplaces/releases
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_linux_amd64.tar.gz \
  | tar -xzO goplaces > /usr/local/bin/goplaces; \
  chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
# Copy the current Linux asset URL from https://github.com/steipete/wacli/releases
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli-linux-amd64.tar.gz \
  | tar -xzO wacli > /usr/local/bin/wacli; \
  chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

<Note>
The URLs above are examples. For ARM-based VMs, choose the `arm64` assets. For reproducible builds, pin versioned release URLs.
</Note>

## Build and launch

```bash
docker compose build
docker compose up -d openclaw-gateway
```

If the build fails with `Killed` or exit code 137 during `pnpm install --frozen-lockfile`, the VM is out of memory. Use a larger machine class before retrying.

Verify binaries:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Expected output:

```text
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

Verify the gateway is up:

```bash
docker compose logs -f openclaw-gateway
curl -fsS http://127.0.0.1:18789/healthz
```

`/healthz` returning a 200 response confirms the gateway process is listening and healthy; the built-in image `HEALTHCHECK` polls the same endpoint.

## What persists where

OpenClaw runs in Docker, but Docker is not the source of truth. All long-lived state must survive restarts, rebuilds, and reboots.

| Component              | Location                                               | Persistence mechanism  | Notes                                                                                                               |
| ---------------------- | ------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Gateway config         | `/home/node/.openclaw/`                                | Host volume mount      | Includes `openclaw.json`                                                                                            |
| Channel/provider creds | `/home/node/.openclaw/credentials/`                    | Host volume mount      | Channel and provider credential material                                                                            |
| Model auth profiles    | `/home/node/.openclaw/agents/`                         | Host volume mount      | `agents/<agentId>/agent/auth-profiles.json` (OAuth, API keys)                                                       |
| Legacy OAuth key file  | `/home/node/.config/openclaw/`                         | Host volume mount      | Read-only compat for pre-migration OAuth sidecars; `openclaw doctor --fix` migrates these into `auth-profiles.json` |
| Skill configs          | `/home/node/.openclaw/skills/`                         | Host volume mount      | Skill-level state                                                                                                   |
| Agent workspace        | `/home/node/.openclaw/workspace/`                      | Host volume mount      | Code and agent artifacts                                                                                            |
| WhatsApp session       | `/home/node/.openclaw/`                                | Host volume mount      | Preserves QR login                                                                                                  |
| Gmail keyring          | `/home/node/.openclaw/`                                | Host volume + password | Requires `GOG_KEYRING_PASSWORD`                                                                                     |
| Plugin packages        | `/home/node/.openclaw/npm`, `/home/node/.openclaw/git` | Host volume mount      | Downloadable plugin package roots                                                                                   |
| External binaries      | `/usr/local/bin/`                                      | Docker image           | Must be baked at build time                                                                                         |
| Node runtime           | Container filesystem                                   | Docker image           | Rebuilt every image build                                                                                           |
| OS packages            | Container filesystem                                   | Docker image           | Do not install at runtime                                                                                           |
| Docker container       | Ephemeral                                              | Restartable            | Safe to destroy                                                                                                     |

## Updates

To update OpenClaw on the VM:

```bash
git pull
docker compose build
docker compose up -d
```

## Related

- [Docker](/install/docker)
- [Podman](/install/podman)
- [ClawDock](/install/clawdock)
