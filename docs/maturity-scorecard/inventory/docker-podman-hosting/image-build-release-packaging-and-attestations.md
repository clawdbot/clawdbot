---
title: "Docker / Podman hosting - Image Release and Validation Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Image Release and Validation Maturity Note

## Summary

The official Docker image pipeline is one of the stronger parts of the surface: the Dockerfile is multi-stage, digest-pinned, non-root, BuildKit-oriented, and release workflows publish amd64, arm64, slim, browser, and multi-platform manifests with SBOM/provenance attestation checks. Coverage is stable because source, workflow, and test evidence all exercise the pipeline. Quality remains beta/stable boundary because archive evidence shows stale `main` tag and healthcheck cold-start issues that affect operator trust in published images.

## Category Scope

Included in this category:

- Root Dockerfile build stages: Root Dockerfile build stages, runtime image contents, optional browser and Docker CLI build args
- Docker release workflow: Docker release workflow for GHCR publishing, multi-arch tags, manifests, and attestation verification
- Docker E2E package artifact generation: Docker E2E package artifact generation and shared build helpers
- Docker E2E plan/scheduler scripts: Docker E2E plan/scheduler scripts, lane metadata, targeted grouping, package artifact generation, and GitHub hydration action
- Release-path install: Release-path install, update, upgrade survivor, live-provider, plugin, Open WebUI, and cleanup scenario planning

## Features

- Root Dockerfile build stages: Root Dockerfile build stages, runtime image contents, optional browser and Docker CLI build args
- Docker release workflow: Docker release workflow for GHCR publishing, multi-arch tags, manifests, and attestation verification
- Docker E2E package artifact generation: Docker E2E package artifact generation and shared build helpers
- Docker E2E plan/scheduler scripts: Docker E2E plan/scheduler scripts, lane metadata, targeted grouping, package artifact generation, and GitHub hydration action
- Release-path install: Release-path install, update, upgrade survivor, live-provider, plugin, Open WebUI, and cleanup scenario planning

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals: Dockerfile coverage includes digest-pinned base images, optimized manifest copies, BuildKit cache mounts, production prune, optional browser and Docker CLI build args, pre-created state directories, non-root runtime, `tini`, and built-in healthcheck (`/Users/kevinlin/code/openclaw/Dockerfile:10-24`, `/Users/kevinlin/code/openclaw/Dockerfile:70-142`, `/Users/kevinlin/code/openclaw/Dockerfile:236-330`). Docker release workflow builds amd64 and arm64 images, browser variants, manifests, and attestation checks (`/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:156-192`, `/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:347-383`, `/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:517-654`).
- Negative signals: build/release coverage is mostly CI and static pipeline proof; it does not prove every runtime dependency installed by user-provided build args.
- Integration gaps: no single report ties each GHCR tag policy, image flavor, base digest refresh, attestation, and post-publish smoke result together for operators.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: Query evidence includes issue #75827 for a stale `ghcr.io/openclaw/openclaw:main` Docker tag, issue #75701 and PR #75809 for `HEALTHCHECK --start-period=15s` cold-start false unhealthy behavior, and PR #87508 for release workflow matrix filtering.
- Discrawl reports: Query evidence includes Freshbits entries for release-package and Podman/Docker build-arg fixes, plus a release/upgrade smoke discussion clarifying that upgrade smoke exists but was not a named checklist.
- Good qualities: release builds use pinned Docker actions, digest-pinned base images, multi-platform publishing, explicit browser variants, SBOM/provenance, attestation verification, and dedicated package artifact tooling.
- Bad qualities: `main` image freshness and healthcheck behavior have open archive reports; those are operator-facing because they affect "pull latest image" and orchestration health semantics.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Root Dockerfile build stages, Docker release workflow, Docker E2E package artifact generation, Docker E2E plan/scheduler scripts, Release-path install.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Publish a compact Docker image release contract covering exact tag semantics for `latest`, `main`, version, `slim`, browser, amd64, arm64, and manual backfill.
- Resolve or explicitly document the Dockerfile healthcheck start-period issue for cold-start hosts and orchestrators.
- Add a visible release artifact summary for attestation verification and image smoke results.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:36-45` documents use of pre-built GHCR images and common tags.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:146-154` documents image-time apt and Python package build args.
- `/Users/kevinlin/code/openclaw/docs/install/docker.md:449-454` documents base-image metadata and Dependabot digest refresh.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:11-31` explains that required external binaries must be baked into images, then rebuilt/restarted when changed.

### Source

- `/Users/kevinlin/code/openclaw/Dockerfile:10-24` pins Node and Bun base image digests and explains base refresh.
- `/Users/kevinlin/code/openclaw/Dockerfile:70-142` uses BuildKit cache mounts, target architecture install/prune settings, and production dependency pruning.
- `/Users/kevinlin/code/openclaw/Dockerfile:167-208` installs runtime system utilities, copies runtime assets, and prepares pnpm/Corepack for non-root use.
- `/Users/kevinlin/code/openclaw/Dockerfile:236-330` supports optional browser/Docker CLI build args, creates node-owned state dirs, runs as `node`, and defines the OCI healthcheck.
- `/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:156-192` builds/pushes amd64 normal and browser images with SBOM and provenance.
- `/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:347-383` builds/pushes arm64 normal and browser images with SBOM and provenance.
- `/Users/kevinlin/code/openclaw/.github/workflows/docker-release.yml:517-654` creates multi-platform manifests and verifies Docker attestations.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/docker-build-helper.test.ts:106-132` verifies BuildKit build routing and shell script build helper usage.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts:235-296` verifies Docker E2E package and published upgrade survivor workflow wiring.
- `/Users/kevinlin/code/openclaw/test/scripts/verify-docker-attestations.test.ts:54-133` verifies image-index attestation resolution and missing SBOM/provenance reporting.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/dockerfile.test.ts:30-115` verifies bookworm/slim runtime stages, CA/Python/tini, optional browser dependencies, and target-platform install/prune settings.
- `/Users/kevinlin/code/openclaw/src/dockerfile.test.ts:117-251` verifies native addon checks, install manifests, lifecycle script copying, build commands, prune, and runtime asset copies.
- `/Users/kevinlin/code/openclaw/src/docker-image-digests.test.ts:125-148` verifies selected Dockerfile base images are pinned to sha256 digests and Dependabot Docker updates remain enabled.

### Gitcrawl queries

Query: `Docker release ghcr image main latest`

Results:

- Hit issue #75827, `ghcr.io/openclaw/openclaw:main Docker tag is not auto-rebuilt on commits to git main; stale by weeks`.
- Hit issue #75701 for current `latest`, `main`, and version images affected by healthcheck cold-start behavior.

Query: `Docker HEALTHCHECK`

Results:

- Hit issue #75701 and PR #75809 about cold-start `HEALTHCHECK --start-period=15s` false unhealthy behavior.
- Hit issue #78136 about Docker in-process restart leaving queues draining while health endpoints report OK.

### Discrawl queries

Query: `Docker E2E release upgrade survivor`

Results:

- Found a 2026-05-02 discussion clarifying that explicit release/upgrade smoke machinery exists, including install smoke, cross-OS fresh and upgrade lanes, and `scripts/e2e/upgrade-survivor-docker.sh`.

Query: `Podman OpenClaw`

Results:

- Found Freshbits entries for `fix(ci): build complete release package artifacts` and Podman build-arg wiring, showing release/build hardening was active in the archive.
