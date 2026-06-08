---
title: "Docker / Podman hosting - Docker e2e Release Smoke and Scheduler Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Docker e2e Release Smoke and Scheduler Maturity Note

## Summary

The Docker E2E infrastructure is broad: it plans release-path lanes, live lanes, package-backed lanes, install/update lanes, plugin sweeps, update migration, upgrade survivor, Open WebUI, credentials, shared images, scheduler limits, stale-container cleanup, and Docker package artifacts. Coverage is stable for Docker because many major runtime flows have named lanes. Quality is beta because the breadth is complex, mostly Docker-specific, and archive discussion confirms some release-smoke matrices are implicit combinations rather than one named canonical checklist.

## Category Scope

- Docker E2E plan/scheduler scripts, lane metadata, targeted grouping, package artifact generation, and GitHub hydration action.
- Release-path install, update, upgrade survivor, live-provider, plugin, Open WebUI, and cleanup scenario planning.
- Excludes Podman runtime smoke, which is scored in the Podman component.

## Features

- Docker E2E plan/scheduler scripts: Docker E2E plan/scheduler scripts, lane metadata, targeted grouping, package artifact generation, and GitHub hydration action
- Release-path install: Release-path install, update, upgrade survivor, live-provider, plugin, Open WebUI, and cleanup scenario planning

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (84%)`
- Positive signals: Docker lane planning covers release path, beta release path, Open WebUI, package/live image needs, provider credentials, install-e2e, update-channel, upgrade survivor, update migration, bundled plugin sweeps, and state scenarios (`/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:98-180`, `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:560-959`). Scheduler tests cover CLI parsing, resource/weight limits, live OpenAI serialization, stale container cleanup, bounded output, and operator limit text (`/Users/kevinlin/code/openclaw/test/scripts/docker-all-scheduler.test.ts:39-294`).
- Negative signals: this machinery is Docker-only and does not automatically prove Podman; some important lanes are planner proof unless CI/lane artifacts are separately inspected.
- Integration gaps: no aggregate report ties recent release Docker lane outcomes to Docker/Podman maturity scores and archive regressions.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports: Query evidence includes PR #87508 for release workflow matrix filtering and archive issues that stress Docker release behavior, including stale GHCR `main` tag and healthcheck false unhealthy reports.
- Discrawl reports: Query evidence includes a 2026-05-02 discussion clarifying release/upgrade smoke machinery exists but that one named "matrix" was an abstraction, not a canonical checklist; this lowers operator clarity rather than test depth.
- Good qualities: lane planning is explicit, credential requirements are derived, state scenarios are surfaced, scheduler concurrency is bounded by resource/weight classes, and stale containers are cleaned before runs.
- Bad qualities: the system is complex enough that operator trust requires reading planner and workflow outputs; Podman is not included as a peer runtime in this scheduler.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (84%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Docker E2E plan/scheduler scripts, Release-path install.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Produce a release-run summary artifact that lists Docker lane names, status, image refs, package artifact, baselines, and upgrade scenarios.
- Add Podman smoke lanes or explicitly mark Podman as docs/source-covered but not release-smoke-covered.
- Turn the implicit release/upgrade smoke grouping into a named checklist for scorecard use.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/docker.md:458-462` points VM deployments to shared runtime update steps.
- `/Users/kevinlin/code/openclaw/docs/install/docker-vm-runtime.md:140-148` documents update build/restart commands that upgrade smoke should exercise.
- `/Users/kevinlin/code/openclaw/docs/reference/full-release-validation.md` is referenced in archive discussion as the release umbrella including install smoke and cross-OS fresh/upgrade lanes.

### Source

- `/Users/kevinlin/code/openclaw/scripts/lib/docker-e2e-plan.mjs` owns Docker E2E lane definitions and release-path planning.
- `/Users/kevinlin/code/openclaw/scripts/test-docker-all.mjs` owns Docker lane scheduling, resource limits, preflight, and plan JSON.
- `/Users/kevinlin/code/openclaw/scripts/package-openclaw-for-docker.mjs:1-14` owns Docker E2E package artifact build/inventory/pack sequence.
- `/Users/kevinlin/code/openclaw/.github/actions/docker-e2e-plan/action.yml:58-133` creates plans, emits outputs, downloads package artifacts, and pulls shared Docker images.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:98-180` verifies release-path and beta release-path lane planning.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:560-658` verifies upgrade survivor and update migration baseline/scenario expansion.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts:696-959` verifies live/package-backed Docker lanes, Open WebUI, state scenarios, install-e2e mapping, plugin sweep mapping, and unknown-lane errors.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-all-scheduler.test.ts:123-294` verifies scheduler limits, live OpenAI serialization, stale container cleanup, bounded output, and operator-readable limits.

### Unit tests

- `/Users/kevinlin/code/openclaw/test/scripts/targeted-docker-lane-groups.test.ts:4-68` covers targeted lane grouping and upgrade-survivor sharding.
- `/Users/kevinlin/code/openclaw/test/scripts/package-acceptance-workflow.test.ts` covers package/release workflow wiring for Docker E2E.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-build-helper.test.ts` covers Docker build helper behavior used by lanes.

### Gitcrawl queries

Query: `Docker E2E lane release path`

Results:

- Hit PR #87508, `ci: filter release workflow matrices`, describing release workflow matrix planning for profile-gated Docker E2E chunks.

Query: `Docker release ghcr image main latest`

Results:

- Hit issue #75827 for stale `main` Docker tag and issue #75701 for current image healthcheck behavior.

### Discrawl queries

Query: `Docker E2E release upgrade survivor`

Results:

- Found a 2026-05-02 discussion stating explicit release/upgrade smoke machinery exists, including install smoke, cross-OS fresh/upgrade lanes, and `scripts/e2e/upgrade-survivor-docker.sh`; it also clarified that a named "matrix" phrasing was an abstraction rather than a canonical checklist.

Query: `Docker VPS`

Results:

- Found maintainer discussion about testing container-friendly cases in Docker or VPS before taking issue work, reinforcing the practical use of Docker lanes for repro.
