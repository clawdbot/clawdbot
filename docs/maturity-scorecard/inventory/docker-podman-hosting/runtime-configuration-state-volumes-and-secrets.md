---
title: "Docker / Podman hosting - Container Operations Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Container Operations Maturity Note

## Summary

OpenClaw has substantial Docker/Podman persistence guidance and source safeguards: Compose and Podman both bind config, workspace, and auth-profile secret state into stable host paths; setup scripts generate or reuse gateway tokens; Docker setup pre-creates directories and repairs ownership; Podman enforces rootless private directory/file permissions. Coverage is stable because docs and tests exercise many persistence and secret paths. Quality is beta because archive evidence shows persistence and update confusion remains common in hosted Docker and VPS environments.

## Category Scope

Included in this category:

- Host CLI routing into running Docker/Podman: Host CLI routing into running Docker/Podman containers
- Container Targeting: Covers Container Targeting across Host CLI routing into running Docker/Podman containers. `--container` and `OPENCLAW_CONTAINER` behavior, env handling, ambiguous runtime detection, loopback proxy guard, and related host cli container targeting and update lifecycle behavior.
- Container update/rebuild/restart guidance for Docker: Container update/rebuild/restart guidance for Docker and Podman hosts
- Docker Compose: Docker Compose and Podman config/workspace/auth-profile secret mounts
- Gateway token generation: Gateway token generation, reuse, .env persistence, and Control UI allowed origins
- Ownership: Ownership, permissions, SELinux mount behavior, and state survival across container replacement
- Docker Compose: Docker Compose and Podman port publishing, bind mode, host local provider access, Bonjour, Tailscale, and Control UI origins
- Container health endpoints: Container health endpoints, Dockerfile/Compose healthchecks, openclaw health, logs, and metrics/OTel docs
- Provider/VPS Docker hosting docs: Provider/VPS Docker hosting docs and operational runbooks
- Docker VM persistence/update guidance: Docker VM persistence/update guidance, Hetzner/Hostinger/DigitalOcean adjacency, Kubernetes/container warnings, and secure exposure
- Operator-facing update: Operator-facing update, backup, persistence, low-memory, and troubleshooting guidance

## Features

- Host CLI routing into running Docker/Podman: Host CLI routing into running Docker/Podman containers
- Container Targeting: Covers Container Targeting across Host CLI routing into running Docker/Podman containers. `--container` and `OPENCLAW_CONTAINER` behavior, env handling, ambiguous runtime detection, loopback proxy guard, and related host cli container targeting and update lifecycle behavior.
- Container update/rebuild/restart guidance for Docker: Container update/rebuild/restart guidance for Docker and Podman hosts
- Docker Compose: Docker Compose and Podman config/workspace/auth-profile secret mounts
- Gateway token generation: Gateway token generation, reuse, .env persistence, and Control UI allowed origins
- Ownership: Ownership, permissions, SELinux mount behavior, and state survival across container replacement
- Docker Compose: Docker Compose and Podman port publishing, bind mode, host local provider access, Bonjour, Tailscale, and Control UI origins
- Container health endpoints: Container health endpoints, Dockerfile/Compose healthchecks, openclaw health, logs, and metrics/OTel docs
- Provider/VPS Docker hosting docs: Provider/VPS Docker hosting docs and operational runbooks
- Docker VM persistence/update guidance: Docker VM persistence/update guidance, Hetzner/Hostinger/DigitalOcean adjacency, Kubernetes/container warnings, and secure exposure
- Operator-facing update: Operator-facing update, backup, persistence, low-memory, and troubleshooting guidance

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: Docker docs describe bind-mounted config/workspace/auth-profile secret dirs, installed plugin package state, disk growth hotspots, permissions/EACCES, and VM persistence tables (`/Users/kevinlin/code/openclaw/docs/install/docker.md:270-299`, `/Users/kevinlin/code/openclaw/docs/install/docker.md:382-396`, `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:120-139`). Podman docs describe host `~/.openclaw` state, `.env`, workspace, token, and bind mounts (`/Users/kevinlin/code/openclaw/docs/install/podman.md:155-192`). Source implements path pinning, token file handling, volume mounts, ownership repair, private path checks, and SELinux mount options.
- Negative signals: coverage does not prove all hosted Docker managers preserve the expected mount paths, and docs leave some provider-specific persistence semantics to external platforms.
- Integration gaps: no recurring hosted-Docker persistence scenario proves API-key deletion, auth profiles, plugin package roots, workspace files, and `.env` across reboot/recreate for Hostinger/Coolify-style deployments.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: Query evidence includes issue #86612 for restart-loop behavior with Docker sandbox and host `/mnt/...` paths, issue #53628 for XDG config handling in a Hetzner Docker install, and Docker/VPS results around persistence, update, and provider confusion.
- Discrawl reports: Query evidence includes Hostinger Docker messages where UI changes/API keys returned after reboot because env-backed credentials or missing `/home/node/.openclaw` persistence were suspected, and a Docker VPS update thread where users were told to update images/redeploy rather than run in-container update.
- Good qualities: Docker setup separates auth-profile secret keys from OpenClaw config, pre-creates agent/session directories, uses host bind mounts, chowns only bounded mounted state, and avoids printing gateway tokens. Podman scripts require rootless execution, private owned directories, and owner-only `.env` permissions.
- Bad qualities: the persistence contract is technically correct but easy to violate in provider-managed Docker, custom Compose, or root/user mismatch setups.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Host CLI routing into running Docker/Podman, Container Targeting, Container update/rebuild/restart guidance for Docker, Docker Compose, Gateway token generation, Ownership, Docker Compose, Container health endpoints, Provider/VPS Docker hosting docs, Docker VM persistence/update guidance, Operator-facing update.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a hosted Docker persistence checklist that names `openclaw.json`, `.env`, auth profiles, auth-profile key dir, plugin roots, sessions, and workspace files.
- Add a Docker/Podman "do not run update inside the container" callout next to persistence docs.
- Record a recurring restart/recreate proof that API key deletion and config changes survive the expected hosted-Docker lifecycle.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:270-299` documents mounted Docker state, auth-profile key storage, plugin package state, and disk growth hotspots.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:382-396` documents uid 1000 ownership requirements and plugin ownership warnings.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:120-139` maps long-lived Docker state versus ephemeral container/image state.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:155-192` documents Podman config, workspace, token, bind mounts, allowed origins, and Quadlet env-file behavior.

### Source

- `/Users/kevinlin/code/openclaw/docker-compose.yml:12-44` pins container-side state/config/workspace paths and bind-mounts config, workspace, and auth-profile secret dirs.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:59-123` reads gateway tokens from config or `.env`.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:264-320` initializes host config/workspace/auth secret dirs and exports Docker setup paths.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:557-573` repairs bind-mounted data directory ownership without crossing workspace mount boundaries.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:161-195` reads a restricted Podman `.env` allowlist after validating owner-only file and directory permissions.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:491-575` creates/reuses token/config, syncs origins, applies SELinux mount options, and bind-mounts config/workspace into setup and gateway containers.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:262-301` verifies Docker env persistence, home-volume config, token suppression, and config sync.
- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:439-511` verifies config identity dirs, agent/session dirs, auth-profile secret dir separation, and bounded ownership repair.
- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:513-565` verifies config-token and `.env` token reuse behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/config/config.sandbox-docker.test.ts` covers Docker-related sandbox config behavior.
- `/Users/kevinlin/code/openclaw/src/security/audit-sandbox-docker-config.test.ts` covers Docker sandbox security audit behavior.
- `/Users/kevinlin/code/openclaw/src/infra/container-environment.test.ts` covers container environment detection.

### Gitcrawl queries

Query: `Docker volume EACCES OPENCLAW_WORKSPACE_DIR OPENCLAW_CONFIG_DIR`

Results:

- Hit issue #86612 for Docker gateway restart loop involving `OPENCLAW_CONFIG_DIR`, `OPENCLAW_WORKSPACE_DIR`, sandbox mode, and host `/mnt/...` paths.

Query: `Docker VPS`

Results:

- Hit issue #53628 for `${XDG_CONFIG_HOME}` handling in a Hetzner Docker install.
- Hit issue #32473 for Hostinger VPS Docker secure-context/device identity behavior.

### Discrawl queries

Query: `Docker update VPS OpenClaw`

Results:

- Found a 2026-04-19 Hostinger Docker thread where API keys/settings returned after reboot, with suspected causes including env-backed credentials or missing `/home/node/.openclaw` persistence.
- Found a 2026-04-13 Docker VPS update failure thread where users discussed updating the GHCR image/redeploying rather than changing the Dockerfile or updating inside the container.

Query: `Docker VPS`

Results:

- Found a 2026-05-28 Hetzner Docker install help request and 2026-05-23 Docker VPS update discussion, showing persistence/update guidance remains active support terrain.
