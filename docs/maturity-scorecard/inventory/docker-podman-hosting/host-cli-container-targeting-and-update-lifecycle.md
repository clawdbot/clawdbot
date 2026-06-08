---
title: "Docker / Podman hosting - Host CLI Container Targeting and Update Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Host CLI Container Targeting and Update Lifecycle Maturity Note

## Summary

Host CLI targeting is implemented through `openclaw --container` / `OPENCLAW_CONTAINER`, with runtime detection across Podman and Docker, environment cleanup, loopback proxy safety, and explicit rejection of `openclaw update` in container-target mode. Coverage is beta because code and unit tests cover the core routing contract, and Docker release lanes cover upgrade scenarios, but the docs are clearer for Podman than for Docker. Quality is beta because archive evidence shows Docker update lifecycle confusion remains common.

## Category Scope

- Host CLI routing into running Docker/Podman containers.
- `--container` and `OPENCLAW_CONTAINER` behavior, env handling, ambiguous runtime detection, loopback proxy guard, and blocked update commands.
- Container update/rebuild/restart guidance for Docker and Podman hosts.
- Excludes OpenClaw's general npm/native update path outside containers.

## Features

- Host CLI routing into running Docker/Podman: Host CLI routing into running Docker/Podman containers
- Container Targeting: Covers Container Targeting across Host CLI routing into running Docker/Podman containers. `--container` and `OPENCLAW_CONTAINER` behavior, env handling, ambiguous runtime detection, loopback proxy guard, and related host cli container targeting and update lifecycle behavior.
- Container update/rebuild/restart guidance for Docker: Container update/rebuild/restart guidance for Docker and Podman hosts

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Podman docs explicitly make the host CLI the control plane and show `OPENCLAW_CONTAINER=openclaw`, `openclaw dashboard --no-open`, `openclaw gateway status --deep`, `openclaw doctor`, and channel login (`/Users/kevinlin/code/openclaw/docs/install/podman.md:12-15`, `/Users/kevinlin/code/openclaw/docs/install/podman.md:91-104`). Source implements root-option parsing, runtime detection across Podman/Docker, env cleanup, loopback proxy guard, and update blocking. Tests cover container routing semantics.
- Negative signals: Docker docs still lean on `docker compose run --rm openclaw-cli` more than host CLI `--container`, so the shared abstraction is unevenly documented.
- Integration gaps: no live/real Docker/Podman test proves host CLI routing against running containers across both runtimes and update lifecycle messaging.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query evidence includes Docker/VPS update friction, issue #86612 restart-loop behavior, and issue #39659 for first-class multi-instance management for Docker installs.
- Discrawl reports: Query evidence includes Hostinger/Docker update threads where users tried in-container or provider console update paths and maintainers clarified image redeploy/update manager expectations.
- Good qualities: the CLI prevents the most dangerous class of mistaken in-container update by failing `openclaw update` with a rebuild/restart message, strips host gateway auth/env overrides, and detects ambiguous container names across Podman/Docker.
- Bad qualities: user-facing docs and provider-managed Docker workflows still do not give a single, authoritative update lifecycle story for every container install type.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Host CLI routing into running Docker/Podman, Container Targeting, Container update/rebuild/restart guidance for Docker.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add Docker docs for `openclaw --container <name>` parallel to the Podman host CLI section.
- Add a single container update section: GHCR image pull/redeploy, source rebuild/restart, Podman image rebuild/restart, and managed-provider update path.
- Add a runtime test that asserts the blocked update message and host CLI env cleanup against an actual running Docker/Podman container.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/podman.md:12-15` states host `openclaw` CLI is the control plane and day-to-day management uses `openclaw --container`.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:91-104` documents `OPENCLAW_CONTAINER=openclaw` and common host CLI commands.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:203-209` documents that `openclaw update` fails with `--container` and the image should be rebuilt/pulled then restarted.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:140-148` documents VM Docker updates as `git pull`, `docker compose build`, and `docker compose up -d`.

### Source

- `/Users/kevinlin/code/openclaw/src/cli/container-target.ts:32-64` parses `--container` and `OPENCLAW_CONTAINER`.
- `/Users/kevinlin/code/openclaw/src/cli/container-target.ts:81-127` searches Podman and Docker for a running container and rejects ambiguous names.
- `/Users/kevinlin/code/openclaw/src/cli/container-target.ts:129-176` builds container exec args and rejects loopback `OPENCLAW_PROXY_URL` unless explicitly allowed.
- `/Users/kevinlin/code/openclaw/src/cli/container-target.ts:216-230` strips host profile/gateway auth/env overrides from container-targeted invocations.
- `/Users/kevinlin/code/openclaw/src/cli/container-target.ts:232-282` blocks update commands with `openclaw update is not supported with --container; rebuild or restart the container image instead.`

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:647-658` plans update-migration across baselines and cleanup scenarios.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:844-896` maps `update-channel-switch` and `upgrade-survivor` Docker lane state scenarios.
- `/Users/kevinlin/code/openclaw/test/scripts/targeted-docker-lane-groups.test.ts:20-56` shards published upgrade survivor by baseline.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/container-target.test.ts` covers CLI container target parsing, runtime selection, env stripping, loopback proxy rejection, ambiguous names, and update blocking.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:560-658` covers upgrade survivor and update migration plan expansion.

### Gitcrawl queries

Query: `openclaw update --container rebuild restart container image`

Results:

- Hit issue #86612 with Docker restart-loop context and setup output about rebuilding with `OPENCLAW_INSTALL_DOCKER_CLI`.
- Hit issue #7575 where Docker sandbox update/rebuild is part of a secure runtime proposal.

Query: `Docker VPS`

Results:

- Hit issue #39659 for first-class multi-instance management for Docker installs on VPS/server.
- Hit multiple Docker/VPS issues where runtime and update semantics are part of user support context.

### Discrawl queries

Query: `Docker update VPS OpenClaw`

Results:

- Found a 2026-04-19 Hostinger Docker thread where the correct path was described as Docker Manager/provider update rather than changing `/usr/local/bin/openclaw` inside the container.
- Found a 2026-04-13 Docker VPS update failure thread where users were advised to update the GHCR image and redeploy.

Query: `Podman OpenClaw`

Results:

- Found user reports of Podman container operation, but no high-volume Podman update thread in the returned top results.
