---
title: "Linux Gateway host - Deployment Targets Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Deployment Targets Maturity Note

## Summary

OpenClaw has broad Linux hosting guidance across VPS, Docker, Hetzner, DigitalOcean, Kubernetes, and Podman. The recommended secure shape is consistent: non-root users, persistent state, loopback-first Gateway, SSH tunnel or Tailscale, explicit auth when exposing beyond loopback, and low-memory tuning. Coverage and quality are beta because the provider/container matrix is wide and archive evidence still shows support friction for Docker/VPS secure contexts, browser relay behavior, XDG config, low-spec hosts, and multi-instance management.

## Category Scope

Included in this category:

- VPS: Defines VPS setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Container: Defines Container setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Cloud Deployment Guidance: Defines Cloud Deployment Guidance setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.

## Features

- VPS: Defines VPS setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Container: Defines Container setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.
- Cloud Deployment Guidance: Defines Cloud Deployment Guidance setup, credential, configuration, and operator verification behavior for Vps, Container, and Cloud Deployment Guidance.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Rationale: docs cover many Linux deployment variants and the source has container/runtime support, but the breadth is larger than the maturity of each provider path.
- Gaps: there is no single support matrix that grades VPS, Docker, Podman, Kubernetes, and specific providers by recommended use, auth posture, persistence model, and known limits.

## Quality Score

- Score: `Beta (72%)`
- Rationale: the deployment story is usable for experienced operators, but archive evidence shows substantial user-facing risk in container/VPS variants.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for VPS, Container, Cloud Deployment Guidance.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a Linux host deployment support matrix for VPS, Docker, Podman, Kubernetes, and provider-specific docs.
- Mark which deployment paths are recommended for normal users versus experienced operators.
- Consolidate low-memory, browser relay, secure context, and XDG config troubleshooting for VPS/container hosts.

## Evidence

### Docs

- `docs/vps.md:11-44` documents Linux server/VPS setup, provider choice, Gateway-owned state, Control UI/Tailscale/SSH access, backups, and secure defaults.
- `docs/vps.md:79-132` documents small-VM and ARM tuning, systemd tuning, compile cache, `OPENCLAW_NO_RESPAWN`, and memory controls.
- `docs/install/docker.md:26-60` documents containerized Gateway setup and token writing; `docs/install/docker.md:216-228` explains LAN vs loopback bind modes.
- `docs/install/hetzner.md:11-24` documents persistent Gateway on Hetzner VPS with Docker and its security model.
- `docs/install/digitalocean.md:41-91` covers non-root users, Node/OpenClaw install, linger, systemd, swap, and journal checks.
- `docs/install/kubernetes.md:143-152` documents auth, TLS, and origins when exposing beyond port-forward.
- `docs/install/podman.md:127-153` documents Quadlet/systemd user operation, logs, and linger.

### Source

- `src/infra/container-environment.ts:3-52` detects container environments from sentinels and cgroups.
- `src/cli/container-target.ts:32-64` parses container target selection and `OPENCLAW_CONTAINER`.
- `src/cli/container-target.ts:159-176` rejects unsafe loopback proxy use unless explicitly allowed.
- `scripts/docker/setup.sh:125-155` syncs Gateway config and allowed origins for non-loopback container access.
- `scripts/run-openclaw-podman.sh:206-213` enforces rootless Podman expectations.
- `scripts/k8s/deploy.sh:85-159` applies secrets through a temporary path and preserves/generated Gateway tokens without writing secrets to the checkout.

### Integration tests

- `test/scripts/docker-build-helper.test.ts`, `test/scripts/docker-e2e-plan.test.ts`, and `test/scripts/live-docker-stage.test.ts` cover Docker build and staged Linux container plans.
- `src/docker-setup.e2e.test.ts` covers Docker setup behavior.
- `src/cli/container-target.test.ts` covers container target execution behavior.

### Unit tests

- `src/dockerfile.test.ts` records Docker runtime, CA, Python/tini, browser dependency, target-platform, and pnpm pruning expectations.
- `src/infra/container-environment.test.ts` covers container detection.
- `src/cli/container-target.test.ts` covers unsafe proxy rejection and environment stripping.

### Gitcrawl queries

- Specific query `VPS Docker container Hetzner DigitalOcean GCP Oracle Kubernetes Podman OpenClaw` returned no hits.
- Broader query `Docker VPS` returned issue #71669 for Docker/VPS Control UI secure-connection warnings, issue #39659 for first-class multi-instance management, issue #32473 for secure-context behavior on Hostinger VPS Docker, issue #53628 for XDG config handling in Docker/Hetzner, issue #53599 for browser relay regression on Docker/VPS, and issue #53600 for constrained VPS performance.

### Discrawl queries

- Query `Docker VPS OpenClaw` found a 2026-05-28 Hetzner Docker install/Gateway/Telegram help request.
- The same query found maintainers discussing low-spec VPS blockers and the practice of testing CLI/source/container-friendly cases in Docker or VPS.
