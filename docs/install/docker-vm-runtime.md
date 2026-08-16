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

These are examples, not a complete list. Docker Compose builds the repo-root
`Dockerfile`, so extend that file rather than creating a standalone example or
replacing its contents. The repository Dockerfile has required
`workspace-deps`, build, runtime-assets, and final runtime stages. Its manifest
extraction covers the `packages/*` and selected `extensions/*` workspaces before
`pnpm install --frozen-lockfile`.

For Debian packages, prefer the existing build argument:

```bash
export OPENCLAW_IMAGE_APT_PACKAGES="socat"
```

For downloaded release binaries such as `gog`, `goplaces`, or `wacli`, add the
download and install commands to the repo-root `Dockerfile` final runtime stage,
after its package-install blocks and before `USER node`. Preserve the existing
non-root uid 1000 setup, `tini` entrypoint, health check, and `openclaw` symlink.
Then rebuild and restart the containers.

<Note>
The repository Dockerfile digest-pins its Node and Bun base images. Keep those
reviewed pins instead of changing them to floating `FROM node:24-bookworm`
references. For ARM-based VMs, choose `arm64` release assets for extra binaries;
for reproducible builds, use versioned asset URLs and verify their checksums.
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

## Common pitfall: never file-bind `openclaw.json`

Mount the gateway config **as a directory**, never as a single file. The repo
`docker-compose.yml` mounts the whole state directory, which is the supported
setup:

```yaml
# Correct: whole state directory mount.
- "${OPENCLAW_CONFIG_DIR:-${HOME:-/tmp}/.openclaw}:/home/node/.openclaw"
```

```yaml
# Broken: single-file bind — do not use this.
# - "./openclaw.json:/home/node/.openclaw/openclaw.json:ro"
```

A single-file bind breaks in two ways:

- **Stale inode**: Docker binds a single file by its inode. OpenClaw persists
  `openclaw.json` by writing a temp file and renaming it into place (atomic
  replace), which swaps the inode every time. The container then keeps reading
  the *old* inode while the host path points to the new file, so config edits
  appear to do nothing.
- **EBUSY / EACCES**: atomic rename over a bind-mounted file is refused with
  `EBUSY` (and `EACCES` once `:ro` is added), so OpenClaw cannot persist its
  config at all.

Symptoms: `docker exec openclaw-gateway cat /home/node/.openclaw/openclaw.json`
differs from the host file after an edit; gateway logs show `EBUSY`/`EACCES`
when saving config; `openclaw doctor` reports config drift.

Fix: edit `openclaw.json` on the host inside the mounted directory; the
container picks it up on its next read.

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
