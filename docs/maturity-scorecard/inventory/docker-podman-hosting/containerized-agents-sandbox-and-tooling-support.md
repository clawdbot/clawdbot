---
title: "Docker / Podman hosting - Agent Sandbox and Tooling Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Agent Sandbox and Tooling Maturity Note

## Summary

Container hosting overlaps with OpenClaw's agent sandbox and tooling story: Docker gateway setup can opt into Docker-socket-backed sandboxing, the image can install the Docker CLI, docs explain sandbox scope and resource limits, and source has extensive sandbox tests. Coverage is beta because Docker sandbox behavior is well represented, but this component spans two concepts that are easy for operators to confuse: running the Gateway in a container versus using containers to isolate agent tools. Quality is alpha/beta boundary because archive evidence still shows container filesystem mutability, Docker socket, dependency, and sandbox posture confusion.

## Category Scope

Included in this category:

- Docker gateway setup: Docker gateway setup with OPENCLAW_SANDBOX, Docker CLI build arg, socket mount, sandbox config writes, and rollback behavior
- Docker-backed agent sandbox support: Docker-backed agent sandbox docs, source behavior, and tests that affect container-hosted Gateway operators.
- Container image dependency baking: Container image dependency baking for skills/plugins/tools

## Features

- Docker gateway setup: Docker gateway setup with OPENCLAW_SANDBOX, Docker CLI build arg, socket mount, sandbox config writes, and rollback behavior
- Docker-backed agent sandbox support: Docker-backed agent sandbox docs, source behavior, and tests that affect container-hosted Gateway operators.
- Container image dependency baking: Container image dependency baking for skills/plugins/tools

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (75%)`
- Positive signals: Docker docs explain enabling agent sandbox with `OPENCLAW_SANDBOX=1`, custom Docker socket path, fallback to sandbox off, and the distinction between gateway container and agent sandbox containers (`/Users/kevinlin/code/openclaw/docs/install/docker.md:316-337`, `/Users/kevinlin/code/openclaw/docs/install/docker.md:464-504`). Dockerfile can install Docker CLI with fingerprint verification (`/Users/kevinlin/code/openclaw/Dockerfile:252-289`). Setup script builds the CLI into the image when sandbox is requested and avoids exposing the socket if sandbox config fails. Sandbox source/tests cover Docker backend validation broadly.
- Negative signals: Docker-in-Docker/socket exposure and production container filesystem immutability are high-risk areas with less end-to-end proof than the basic Gateway path.
- Integration gaps: no scenario shows a Docker-hosted Gateway with `OPENCLAW_SANDBOX=1` safely running multiple agent sessions while preserving host Docker socket boundaries and dependency installs.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Query evidence includes issue #86612 for Docker sandbox restart-loop behavior with host `/mnt/...` paths, issue #7575 proposing Sysbox for secure Docker runtime isolation, issue #60827 for default container resource limits, and issue #71420/Discord archive evidence about production containers not having mutable `/app`.
- Discrawl reports: Query evidence includes a 2026-04-25 maintainer report that container dependency fixes assumed `/app` was mutable, which fails in production-style Kubernetes/container setups; it also notes Docker/Podman local setups are more permissive than real deployments.
- Good qualities: setup defers docker.sock mount until prerequisites pass, resets sandbox mode when setup fails, verifies Docker apt signing key fingerprint, documents not mounting host docker.sock into agent sandbox containers, and has explicit bind/network validation logic.
- Bad qualities: the boundary is hard to explain, support archives show real confusion, and some production container assumptions remain sharp edges.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (75%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Docker gateway setup, Docker-backed agent sandbox support, Container image dependency baking.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a threat-model diagram for "Gateway in Docker" versus "agent tools in Docker sandbox".
- Add a Docker-hosted Gateway sandbox smoke that verifies docker.sock handling, sandbox config, resource limits, and failure rollback.
- Document immutable-container dependency strategy more directly for plugins/skills and production orchestrators.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:316-337` documents `OPENCLAW_SANDBOX=1`, custom socket path, setup failure rollback to sandbox off, and warning not to mount host docker.sock into agent sandbox containers.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:464-504` explains the agent sandbox model, scopes, policies, resource limits, and related docs.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:11-31` warns that required external binaries must be baked into the image, not installed at runtime.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:424-439` documents power-user image options for apt, Python, browser, and persisted browser downloads.

### Source

- `/Users/kevinlin/code/openclaw/Dockerfile:252-289` optionally installs Docker CLI after verifying the Docker apt signing key fingerprint.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:281-283` validates the Docker socket path when sandbox is requested.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:428-434` sets `OPENCLAW_INSTALL_DOCKER_CLI=1` for sandbox-enabled local builds.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:460-462` keeps base Compose args without sandbox overlay for rollback paths.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker-backend.test.ts` and related sandbox files cover Docker sandbox manager behavior.

### Integration tests

- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:567-620` verifies sandbox disable behavior and skips restart when sandbox config writes fail.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox-agent-config.agent-specific-sandbox-config.e2e.test.ts` covers agent-specific Docker sandbox config behavior.
- `/Users/kevinlin/code/openclaw/scripts/e2e/plugin-binding-command-escape-docker.sh` and Docker E2E plan tests cover command escaping in Docker lanes.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/agents/sandbox/validate-sandbox-security.test.ts` covers Docker socket, Docker config, reserved container paths, namespace joins, and bind mount validation.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker.test.ts` covers Docker image checks and daemon errors.
- `/Users/kevinlin/code/openclaw/src/agents/sandbox/docker.config-hash-recreate.test.ts` covers shared container recreation and mount hash behavior.
- `/Users/kevinlin/code/openclaw/src/agents/bash-tools.build-docker-exec-args.test.ts` covers Docker exec command shell/PATH behavior.

### Gitcrawl queries

Query: `openclaw update --container rebuild restart container image`

Results:

- Hit issue #86612 for Docker sandbox and restart-loop context.
- Hit issue #7575 proposing Sysbox Docker Runtime for secure container isolation.

Query: `Docker VPS`

Results:

- Hit issue #60827 for default container resource limits for sandbox.
- Hit issue #57713 for default sandbox image missing python3, breaking edit/write.

### Discrawl queries

Query: `container filesystem Docker plugin dependencies`

Results:

- No direct FTS output for that exact query.

Query: `Podman OpenClaw`

Results:

- Found a 2026-04-25 maintainer message: production container/Kubernetes setups generally do not write inside `/app`, and local Podman/Docker setups are more permissive than real-world deployments.
