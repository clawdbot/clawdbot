---
title: "Docker / Podman hosting - Container Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Container Setup Maturity Note

## Summary

The Docker first-run path is documented and implemented around `scripts/docker/setup.sh`, `docker-compose.yml`, automatic onboarding, token generation/reuse, pre-start config writes, and host access to the Control UI. Coverage is stable because the setup flow has focused e2e tests plus broad Docker release-lane reuse. Quality remains beta because archive evidence still shows Docker setup confusion around sandbox mode, host path leaks, healthchecks, secure contexts, and VPS/provider update expectations.

## Category Scope

Included in this category:

- Local Image Setup Script: Covers Local Image Setup Script across `./scripts/docker/setup.sh` local-image and GHCR-image setup. Docker Compose gateway and sidecar CLI shape. First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands. Docker-only first-run notes, and related docker install, compose, and first-run setup behavior.
- Docker Compose gateway: Docker Compose gateway and sidecar CLI shape
- First-run onboarding: First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands
- Docker-only first-run notes: Docker-only first-run notes, excluding Podman rootless setup and general Gateway protocol internals
- Podman setup scripts and Quadlet template: Podman setup docs, scripts/podman/setup.sh, scripts/run-openclaw-podman.sh, and scripts/podman/openclaw.container.in
- Rootless Podman image setup: Rootless Podman image setup, launch, setup/onboarding, host CLI routing, Quadlet autostart, and owner/permission checks

## Features

- Local Image Setup Script: Covers Local Image Setup Script across `./scripts/docker/setup.sh` local-image and GHCR-image setup. Docker Compose gateway and sidecar CLI shape. First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands. Docker-only first-run notes, and related docker install, compose, and first-run setup behavior.
- Docker Compose gateway: Docker Compose gateway and sidecar CLI shape
- First-run onboarding: First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands
- Docker-only first-run notes: Docker-only first-run notes, excluding Podman rootless setup and general Gateway protocol internals
- Podman setup scripts and Quadlet template: Podman setup docs, scripts/podman/setup.sh, scripts/run-openclaw-podman.sh, and scripts/podman/openclaw.container.in
- Rootless Podman image setup: Rootless Podman image setup, launch, setup/onboarding, host CLI routing, Quadlet autostart, and owner/permission checks

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Docker docs cover prerequisites, build/pull, automatic onboarding, Control UI access, CLI sidecar usage, channel setup, manual setup, environment variables, health probes, and troubleshooting (`/Users/kevinlin/code/openclaw/docs/install/docker.md:17-228`, `/Users/kevinlin/code/openclaw/docs/install/docker.md:506-554`). `scripts/docker/setup.sh` implements dependency checks, token reuse/generation, pre-start CLI env pinning, onboarding, config sync, and gateway startup (`/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:245-362`, `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:575-619`). `src/docker-setup.e2e.test.ts` verifies home-volume mounts, build args, token redaction, pre-start onboarding, pre-created dirs, sandbox fallback, and config path pinning (`/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:262-620`).
- Negative signals: coverage is strongest for the supported Compose helper, but thinner for unmanaged Compose variants, provider-hosted Docker wrappers, and GUI Docker managers.
- Integration gaps: release evidence proves many Docker lanes through the scheduler, but there is no recurring first-run scenario matrix for Docker Desktop, Linux Engine, Hostinger/Coolify-style wrappers, and sandbox-enabled Compose in the same artifact.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Query evidence includes open issue #86612 for a Docker gateway restart loop with `OPENCLAW_SANDBOX=1` and host `/mnt/...` paths, issue #71669 and #32473 for Control UI secure-context rejection on Docker/VPS, and issue #75701 / PR #75809 for Dockerfile healthcheck cold-start behavior.
- Discrawl reports: Query evidence includes a 2026-05-28 Hetzner Docker install help request where Telegram and Gateway setup failed, a 2026-05-23 maintainer discussion of Docker/VPS repro practice, and Freshbits entries for the `OPENCLAW_SKIP_ONBOARDING` Docker setup addition.
- Good qualities: the first-run script validates mounts, avoids using `openclaw-cli` before the gateway container exists, suppresses token printing, pins container-side state paths, and repairs bind-mount ownership before onboarding.
- Bad qualities: the supported path still expects operators to understand Docker host networking, mounted state, sandbox socket risks, and provider-specific update behavior; archive evidence shows those areas are active support sources.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local Image Setup Script, Docker Compose gateway, First-run onboarding, Docker-only first-run notes, Podman setup scripts and Quadlet template, Rootless Podman image setup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a first-run support matrix that separates Docker Engine, Docker Desktop, Hostinger/Coolify wrappers, and sandbox-enabled Docker setup.
- Publish a short "Docker update path" warning near first-run setup so users do not run `openclaw update` inside recreated containers.
- Capture recurring release smoke for Docker first-run with and without `OPENCLAW_SKIP_ONBOARDING`, `OPENCLAW_HOME_VOLUME`, and sandbox enabled.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:17-94` documents Docker prerequisites, setup script, pre-built image option, onboarding, Control UI token entry, and channel setup commands.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:96-145` documents manual Docker Compose setup and setup environment variables.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:216-228` explains Docker LAN versus loopback bind behavior.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:532-553` documents pairing and Docker target troubleshooting.

### Source

- `/Users/kevinlin/code/openclaw/docker-compose.yml:1-129` defines the `openclaw-gateway` service, sidecar `openclaw-cli`, state/config/workspace mounts, shared network namespace, security options, ports, command, and healthcheck.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:245-362` validates Docker/Compose, mount paths, sandbox socket, timezone, state dirs, token reuse/generation, and setup env exports.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:575-619` runs onboarding through the gateway container, syncs gateway config, prints channel setup commands, and starts the gateway.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:262-301` verifies env defaults, home-volume mounts, build args, token suppression, pre-start onboarding, and config sync.
- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:370-412` verifies the setup script avoids the shared-network CLI before gateway start and pins setup-time state paths inside the container.
- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:439-620` verifies identity dir creation, timezone persistence, agent dirs, auth-profile secret dir, token reuse, sandbox disable, and sandbox fallback behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/dockerfile.test.ts:22-94` verifies the Dockerfile base/runtime shape, runtime utilities, optional browser install, and build ordering.
- `/Users/kevinlin/code/openclaw/src/docker-image-digests.test.ts:125-148` verifies digest-pinned Docker base images and Dependabot Docker updates.

### Gitcrawl queries

Query: `Docker setup OPENCLAW_SKIP_ONBOARDING OPENCLAW_HOME_VOLUME`

Results:

- Hit open issue #86612, `Docker gateway container restart loop when OPENCLAW_SANDBOX=1 and OPENCLAW_HOME=/mnt/...`.
- Hit open PR #61464, `Docker: add Mac migration and keep-awake helpers`, with real Docker setup output.

Query: `Docker VPS`

Results:

- Hit issue #71669 for warning UX when Control UI config rejects non-secure Docker/VPS connections.
- Hit issue #32473 for Hostinger VPS Docker secure-context/device-identity behavior.
- Hit issue #39659 for first-class multi-instance management for Docker installs.

### Discrawl queries

Query: `Docker setup OPENCLAW_SKIP_ONBOARDING OPENCLAW_HOME_VOLUME`

Results:

- No matches returned by `discrawl search --mode fts --limit 10`.

Query: `Docker VPS`

Results:

- Found a 2026-05-28 Hetzner Docker install help request reporting Telegram and Gateway problems.
- Found a 2026-05-23 maintainer discussion about using Docker/VPS for fresh issue repro checks.
- Found a 2026-05-23 user asking how to update a Docker VPS from OpenClaw 4.15 to latest.
