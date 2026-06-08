---
title: "Docker / Podman hosting - Provider-hosted VPS and Operator Runbooks Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Provider-hosted VPS and Operator Runbooks Maturity Note

## Summary

Provider-hosted Docker/VPS usage is well represented in docs through Docker VM runtime, Hetzner, Hostinger, DigitalOcean, Kubernetes, and generic VPS guidance. Coverage is beta because docs are broad and practical, and source supports the required Docker primitives, but scenario proof is weaker across provider-specific managers. Quality is beta/alpha boundary because archive evidence shows active operator confusion around Hostinger/Coolify updates, secure Control UI contexts, Telegram/Gateway setup, persistent state, and low-spec VPS behavior.

## Category Scope

- Provider/VPS Docker hosting docs and operational runbooks.
- Docker VM persistence/update guidance, Hetzner/Hostinger/DigitalOcean adjacency, Kubernetes/container warnings, and secure exposure.
- Operator-facing update, backup, persistence, low-memory, and troubleshooting guidance.
- Excludes native Linux systemd Gateway hosting except where docs compare it to Docker.

## Features

- Provider/VPS Docker hosting docs: Provider/VPS Docker hosting docs and operational runbooks
- Docker VM persistence/update guidance: Docker VM persistence/update guidance, Hetzner/Hostinger/DigitalOcean adjacency, Kubernetes/container warnings, and secure exposure
- Operator-facing update: Operator-facing update, backup, persistence, low-memory, and troubleshooting guidance

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docker docs point VPS users to Hetzner and Docker VM Runtime docs (`/Users/kevinlin/code/openclaw/docs/install/docker.md:458-462`). Docker VM Runtime covers binary baking, build/launch, persistence table, and updates (`/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:11-148`). Linux host scoring already found broader VPS/container/cloud docs in `docs/vps.md`, `docs/install/hetzner.md`, `docs/install/digitalocean.md`, `docs/install/kubernetes.md`, and `docs/install/podman.md`.
- Negative signals: provider-specific Docker managers and one-click hosts are operationally different from source checkout Compose, and the scorecard row explicitly says promotion needs recurring release smoke for upgrade and volume behavior.
- Integration gaps: no provider-backed release smoke captures Hostinger/Coolify/Hetzner Docker update plus persistence behavior end to end.

## Quality Score

- Score: `Beta (70%)`
- Gitcrawl reports: Query evidence includes issue #32473 for Hostinger Docker secure-context/device identity, #71669 for warning UX, #39659 for Docker multi-instance management, #53628 for XDG config in Hetzner Docker, #53599 for Docker/VPS browser relay regression, #53600 for constrained VPS performance, and #75827 for stale GHCR `main` tag.
- Discrawl reports: Query evidence includes recent Hetzner Docker install help, Hostinger Docker update/persistence issues, Docker VPS upgrade questions, Coolify/OpenClaw old-container update confusion, and low-spec VPS release blocker comments.
- Good qualities: docs tell operators to bake binaries, persist state outside containers, rebuild/restart images for updates, secure exposed Gateway access, and avoid runtime installs.
- Bad qualities: provider-hosted Docker remains a support-heavy surface with many deployment shapes that docs cannot fully normalize.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Provider/VPS Docker hosting docs, Docker VM persistence/update guidance, Operator-facing update.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add provider-specific Docker runbooks for Hostinger/Coolify/Hetzner that name supported update paths, persistence locations, and reverse-proxy secure-context requirements.
- Add recurring smoke for Docker image upgrade plus volume persistence on a VM-shaped environment.
- Add an operator checklist for "is this a Docker issue, VPS issue, provider manager issue, or OpenClaw config issue?"

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:458-462` links Docker VPS users to Hetzner and Docker VM Runtime.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:11-31` warns that binaries installed at runtime are lost on restart.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:82-118` documents build/launch, OOM during build, binary verification, and Gateway logs.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:120-148` documents state persistence and update flow.
- `/Users/kevinlin/code/openclaw/docs/install/hetzner.md` documents Hetzner Docker VPS setup.
- `/Users/kevinlin/code/openclaw/docs/install/hostinger.md` and `/Users/kevinlin/code/openclaw/docs/install/kubernetes.md` cover adjacent hosted/container deployment paths.

### Source

- `/Users/kevinlin/code/openclaw/docker-compose.yml:41-68` provides the base Compose persistence and port shape provider docs can adapt.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:538-555` builds or pulls the requested image.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:557-619` fixes data-dir permissions, runs onboarding, syncs config, and starts the gateway.
- `/Users/kevinlin/code/openclaw/scripts/lib/docker-build.sh:88-125` wraps Docker builds with BuildKit retries and timeout handling.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:647-658` verifies update-migration baseline/scenario expansion.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:898-925` maps install E2E to provider-specific package install lanes.
- `/Users/kevinlin/code/openclaw/test/scripts/targeted-docker-lane-groups.test.ts:20-56` shards published upgrade survivor by baseline for targeted runs.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/scripts/docker-build-helper.test.ts` verifies Docker build helper behavior, timeouts, cleanup, and package mounts.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` verifies Docker package/release workflow wiring.

### Gitcrawl queries

Query: `Docker VPS`

Results:

- Hit issues #71669, #39659, #32473, #53628, #53599, #53600, #64293, #83960, #60827, #57713, and other Docker/VPS-related support and regression threads.

Query: `Hostinger Docker`

Results:

- Hit issue #32473 for Hostinger VPS Docker Control UI secure-context/device identity behavior.

### Discrawl queries

Query: `Docker VPS`

Results:

- Found a 2026-05-28 Hetzner Docker install help request.
- Found a 2026-05-23 Docker VPS update question.
- Found a 2026-04-22 Coolify/Docker user asking about old OpenClaw container update problems.

Query: `Docker update VPS OpenClaw`

Results:

- Found a 2026-04-19 Hostinger Docker thread with update and persistence issues and guidance about provider/Docker Manager update paths.
