---
title: "Docker / Podman hosting Maturity Report"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting Maturity Report

## Top-level scores

These rollups are simple arithmetic means over the category-note numeric
scores in
`scores.yaml`. Percentages are rounded to the nearest whole number.

- Coverage: `Beta (77%)`
- Quality: `Beta (73%)`
- Completeness: `Beta (77%)`
- LTS Features: `0/4`

## Summary

This report promotes the archived `docker-podman-hosting` maturity evidence from `/Users/kevinlin/tmp/maturity/docker-podman-hosting` into the current process-version-3 inventory contract.

The category Coverage and Quality scores come from the archived evidence-backed score rows. Completeness is initialized from the same archived evidence breadth and known-gap record, then joined with the surface-specific completeness rubric referenced by taxonomy.

## Matrix

| Category                                                                          | LTS | Coverage       | Quality       | Completeness   | Features to evaluate                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | --- | -------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Container Setup](docker-install-compose-and-first-run-setup.md)                  | ❌  | `Beta (74%)`   | `Beta (76%)`  | `Beta (74%)`   | Local Image Setup Script, Docker Compose gateway, First-run onboarding, Docker-only first-run notes, Podman setup scripts and Quadlet template, Rootless Podman image setup                                                                                                                                              |
| [Container Operations](runtime-configuration-state-volumes-and-secrets.md)        | ❌  | `Beta (76%)`   | `Beta (70%)`  | `Beta (76%)`   | Host CLI routing into running Docker/Podman, Container Targeting, Container update/rebuild/restart guidance for Docker, Docker Compose, Gateway token generation, Ownership, Docker Compose, Container health endpoints, Provider/VPS Docker hosting docs, Docker VM persistence/update guidance, Operator-facing update |
| [Image Release and Validation](image-build-release-packaging-and-attestations.md) | ❌  | `Stable (84%)` | `Beta (78%)`  | `Stable (84%)` | Root Dockerfile build stages, Docker release workflow, Docker E2E package artifact generation, Docker E2E plan/scheduler scripts, Release-path install                                                                                                                                                                   |
| [Agent Sandbox and Tooling](containerized-agents-sandbox-and-tooling-support.md)  | ❌  | `Beta (75%)`   | `Alpha (68%)` | `Beta (75%)`   | Docker gateway setup, Docker-backed agent sandbox support, Container image dependency baking                                                                                                                                                                                                                             |

## Scoring rubric

- Coverage:
  maturity-label rating for integration, e2e, live, or server/runtime flow
  evidence across the category. Unit tests can provide supporting context but never make a
  feature covered by themselves.
- Quality:
  maturity-label rating for implementation and operational robustness. Unit,
  integration, e2e, live, and real runtime-flow test coverage are Coverage
  inputs only; they do not raise or lower Quality.
- Completeness:
  maturity-label rating for how fully the category delivers the intended
  surface-specific capability set. Use the taxonomy-linked completeness
  instructions for this surface.
- LTS:
  calculated as `quality > 80 and coverage > 90`, or when the matching
  taxonomy category sets `human_lts_override`.
- Shared score bands:
  `Lovable = 95-100`, `Stable = 80-95`, `Beta = 70-80`,
  `Alpha = 50-70`, and `Experimental = 0-50`. At shared boundaries, choose the
  higher maturity label.
- Major quality/completeness gaps:
  evidence text only, tracked in the detailed feature inventory rather than as a
  separate scored dimension.

## Detailed feature inventory

### 1. Container Setup

Search anchors: docker / podman hosting docker install, compose, and first-run setup, docker install, compose, and first-run setup, docker / podman hosting podman rootless, quadlet, and host cli, podman rootless, quadlet, and host cli.

Category note: [Container Setup](docker-install-compose-and-first-run-setup.md)

Score decisions:

- Coverage: `Beta (74%)`
- Quality: `Beta (76%)`
- Completeness: `Beta (74%)`
- LTS: ❌

Features:

- Local Image Setup Script: Covers Local Image Setup Script across `./scripts/docker/setup.sh` local-image and GHCR-image setup. Docker Compose gateway and sidecar CLI shape. First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands. Docker-only first-run notes, and related docker install, compose, and first-run setup behavior.
- Docker Compose gateway: Docker Compose gateway and sidecar CLI shape
- First-run onboarding: First-run onboarding, token handling, bind/origin defaults, and post-start channel setup commands
- Docker-only first-run notes: Docker-only first-run notes, excluding Podman rootless setup and general Gateway protocol internals
- Podman setup scripts and Quadlet template: Podman setup docs, scripts/podman/setup.sh, scripts/run-openclaw-podman.sh, and scripts/podman/openclaw.container.in
- Rootless Podman image setup: Rootless Podman image setup, launch, setup/onboarding, host CLI routing, Quadlet autostart, and owner/permission checks

Primary docs:

- `docs/install/docker.md`
- `docs/install/podman.md`

### 2. Container Operations

Search anchors: docker / podman hosting host cli container targeting and update lifecycle, host cli container targeting and update lifecycle, docker / podman hosting runtime configuration, state persistence, volumes, and secrets, runtime configuration, state persistence, volumes, and secrets, docker / podman hosting networking, control ui, health, and observability, networking, control ui, health, and observability, docker / podman hosting provider-hosted vps and operator runbooks, provider-hosted vps and operator runbooks.

Category note: [Container Operations](runtime-configuration-state-volumes-and-secrets.md)

Score decisions:

- Coverage: `Beta (76%)`
- Quality: `Beta (70%)`
- Completeness: `Beta (76%)`
- LTS: ❌

Features:

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

Primary docs:

- `docs/install/podman.md`
- `docs/install/docker-vm-runtime.md`
- `docs/install/docker.md`
- `docs/install/hetzner.md`
- `docs/install/hostinger.md`

### 3. Image Release and Validation

Search anchors: docker / podman hosting image build, release packaging, and attestations, image build, release packaging, and attestations, docker / podman hosting docker e2e release smoke and scheduler, docker e2e release smoke and scheduler.

Category note: [Image Release and Validation](image-build-release-packaging-and-attestations.md)

Score decisions:

- Coverage: `Stable (84%)`
- Quality: `Beta (78%)`
- Completeness: `Stable (84%)`
- LTS: ❌

Features:

- Root Dockerfile build stages: Root Dockerfile build stages, runtime image contents, optional browser and Docker CLI build args
- Docker release workflow: Docker release workflow for GHCR publishing, multi-arch tags, manifests, and attestation verification
- Docker E2E package artifact generation: Docker E2E package artifact generation and shared build helpers
- Docker E2E plan/scheduler scripts: Docker E2E plan/scheduler scripts, lane metadata, targeted grouping, package artifact generation, and GitHub hydration action
- Release-path install: Release-path install, update, upgrade survivor, live-provider, plugin, Open WebUI, and cleanup scenario planning

Primary docs:

- `docs/install/docker.md`
- `docs/install/docker-vm-runtime.md`
- `docs/reference/full-release-validation.md`

### 4. Agent Sandbox and Tooling

Search anchors: docker / podman hosting containerized agents, sandbox, and tooling support, containerized agents, sandbox, and tooling support.

Category note: [Agent Sandbox and Tooling](containerized-agents-sandbox-and-tooling-support.md)

Score decisions:

- Coverage: `Beta (75%)`
- Quality: `Alpha (68%)`
- Completeness: `Beta (75%)`
- LTS: ❌

Features:

- Docker gateway setup: Docker gateway setup with OPENCLAW_SANDBOX, Docker CLI build arg, socket mount, sandbox config writes, and rollback behavior
- Docker-backed agent sandbox support: Docker-backed agent sandbox docs, source behavior, and tests that affect container-hosted Gateway operators.
- Container image dependency baking: Container image dependency baking for skills/plugins/tools

Primary docs:

- `docs/install/docker.md`
- `docs/install/docker-vm-runtime.md`

## Recommended scorecard interpretation

Use this migrated score as the current inventory baseline. Refresh individual categories with live category-agent research before treating a high score as an LTS promotion gate.

## Out of scope for this surface

- Redefining taxonomy category boundaries; taxonomy remains the source of truth for category identity, features, docs, and search anchors.

## Audit provenance

- Score source:
  `docs/kevinslin/maturity-scorecard/inventory/docker-podman-hosting/scores.yaml`.
- Taxonomy metadata source:
  `.agents/skills/claw-score/taxonomy.yaml`.
- Archived evidence source:
  `/Users/kevinlin/tmp/maturity/docker-podman-hosting`.
