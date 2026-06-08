---
title: "Docker / Podman hosting - Networking, Control Ui, Health, and Observability Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Networking, Control Ui, Health, and Observability Maturity Note

## Summary

Docker and Podman hosting have well-documented networking defaults: Docker Compose publishes Gateway/bridge ports, defaults the Gateway to `lan` inside the container, maps `host.docker.internal`, disables Bonjour by default, and documents health probes plus authenticated metrics. Podman publishes loopback-only by default and recommends host-managed Tailscale. Coverage is beta/stable boundary because real e2e lanes cover networking paths, but source/archive evidence still shows healthcheck, bridge IP, secure-context, and restart-readiness risks.

## Category Scope

- Docker Compose and Podman port publishing, bind mode, host local provider access, Bonjour, Tailscale, and Control UI origins.
- Container health endpoints, Dockerfile/Compose healthchecks, `openclaw health`, logs, and metrics/OTel docs.
- Excludes general Gateway protocol semantics not specific to container hosting.

## Features

- Docker Compose: Docker Compose and Podman port publishing, bind mode, host local provider access, Bonjour, Tailscale, and Control UI origins
- Container health endpoints: Container health endpoints, Dockerfile/Compose healthchecks, openclaw health, logs, and metrics/OTel docs

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: Docker docs cover health endpoints, authenticated deep health, LAN versus loopback, host local providers, Bonjour defaults, OTel, Prometheus, Control UI pairing, and Docker target troubleshooting (`/Users/kevinlin/code/openclaw/docs/install/docker.md:162-228`, `/Users/kevinlin/code/openclaw/docs/install/docker.md:230-268`, `/Users/kevinlin/code/openclaw/docs/install/docker.md:532-553`). Podman docs cover loopback publishing and Tailscale guidance (`/Users/kevinlin/code/openclaw/docs/install/podman.md:106-126`, `/Users/kevinlin/code/openclaw/docs/install/podman.md:172-192`). Source covers Compose healthchecks, port publishing, origin sync, and gateway bind selection.
- Negative signals: container network behavior differs across Docker Desktop, Linux Engine, Podman machine, macvlan, VPS reverse proxies, and provider managers; not all variants have direct scenario proof.
- Integration gaps: no single e2e matrix proves Control UI secure context, host provider access, Tailscale, healthcheck cold start, and restart-readiness across Docker and Podman.

## Quality Score

- Score: `Beta (72%)`
- Gitcrawl reports: Query evidence includes issue #75701 / PR #75809 for healthcheck cold-start false unhealthy behavior, issue #78136 for healthz/readyz reporting OK while queue draining after Docker restart, issue #71493 / PR #71503 around `gateway.bind=lan` advertising Docker bridge IPs, and issue #71669 / #32473 for Control UI secure-context friction.
- Discrawl reports: Query evidence includes Docker/VPS install help, low-spec VPS release blocker comments, and Freshbits entries for bridge-interface handling and Podman/Docker hardening.
- Good qualities: docs clearly separate published host ports from container bind mode, use authenticated metrics routes, map host local providers, and prefer loopback/host-managed Tailscale for Podman.
- Bad qualities: health/readiness semantics and secure-context/pairing behavior are still frequent operator pitfalls; bridge/virtual interface handling is subtle enough to have needed issue-driven fixes.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Docker Compose, Container health endpoints.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a container networking troubleshooting map from symptom to likely host/runtime: Docker Desktop DNS, Linux Engine host gateway, Podman machine, raw VPS IP, Tailscale, reverse proxy.
- Resolve or document the Dockerfile healthcheck start-period and restart-readiness issues.
- Add release smoke that probes Control UI device-auth from host browser context, not only `/healthz` and CLI status.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:162-195` documents OTel outbound export and authenticated Prometheus scraping.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:197-214` documents `/healthz`, `/readyz`, built-in healthcheck, and authenticated deep health.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:216-255` documents LAN versus loopback and `host.docker.internal` for host local providers.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:257-268` documents Bonjour/mDNS limitations in Docker bridge networking.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:106-126` recommends host-managed Tailscale for Podman and loopback published ports.

### Source

- `/Users/kevinlin/code/openclaw/docker-compose.yml:53-90` maps host local providers, drops networking capabilities, publishes ports, starts the Gateway with `--bind lan`, and defines the Compose healthcheck.
- `/Users/kevinlin/code/openclaw/scripts/docker/setup.sh:125-155` syncs `gateway.mode`, `gateway.bind`, and Control UI allowed origins for Docker.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:349-481` syncs local Control UI origins for Podman config.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:561-575` publishes Podman gateway and bridge ports on the configured host interface and starts the gateway.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/gateway-network-docker.sh` is the Docker networking e2e lane.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:844-896` verifies Docker lane state scenarios include gateway/network-adjacent and update scenarios in the plan.
- `/Users/kevinlin/code/openclaw/src/docker-setup.e2e.test.ts:370-412` verifies setup-time Docker networking avoids the sidecar before the gateway exists and pins setup env paths.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/shared/gateway-bind-url.test.ts` covers `gateway.bind` URL resolution.
- `/Users/kevinlin/code/openclaw/src/infra/container-environment.test.ts` covers Docker/Podman/Kubernetes container detection.
- `/Users/kevinlin/code/openclaw/src/dockerfile.test.ts:253-330` verifies runtime templates and Dockerfile runtime behavior.

### Gitcrawl queries

Query: `Docker HEALTHCHECK`

Results:

- Hit issue #75701 and PR #75809 for cold-start false unhealthy behavior.
- Hit issue #78136 for in-process Docker gateway restart leaving queues draining while healthz/readyz report OK.

Query: `Docker VPS`

Results:

- Hit issue #71669 for secure-connection warning UX and issue #32473 for Hostinger VPS Docker secure-context/device-identity behavior.
- Hit issue #53599 for browser relay regression affecting remote Docker/VPS use.

### Discrawl queries

Query: `Docker VPS`

Results:

- Found a 2026-05-28 Hetzner Docker install request where Telegram and Gateway problems appeared during final testing.
- Found a 2026-05-27 low-spec VPS release blocker comment and a 2026-05-23 maintainer discussion about Docker/VPS repro strategy.

Query: `Podman OpenClaw`

Results:

- Found archive references to Podman container usage and maintainers discussing bridge/virtual interface selection in `gateway.bind=lan` fixes.
