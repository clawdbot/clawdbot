---
title: "Docker / Podman hosting - Podman Rootless, Quadlet, and Host CLI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Docker / Podman hosting - Podman Rootless, Quadlet, and Host CLI Maturity Note

## Summary

Podman support has a clear rootless design: current-user setup, host CLI as control plane, host-mounted `~/.openclaw`, optional Quadlet/systemd, loopback published ports, `keep-id` user namespace, and `openclaw --container` routing. Coverage is beta because the docs and scripts are specific and hardened, but fewer Podman-specific e2e and unit proofs are visible than Docker. Quality is beta because archive evidence shows prior Podman setup drift and support questions, even though current scripts address several old failure modes.

## Category Scope

- Podman setup docs, setup script, host run script, and Quadlet container template.
- Rootless Podman image setup, launch, setup/onboarding, host CLI routing, Quadlet autostart, and owner/permission checks.
- Excludes Docker Compose and Kubernetes.

## Features

- Podman setup scripts and Quadlet template: Podman setup docs, scripts/podman/setup.sh, scripts/run-openclaw-podman.sh, and scripts/podman/openclaw.container.in
- Rootless Podman image setup: Rootless Podman image setup, launch, setup/onboarding, host CLI routing, Quadlet autostart, and owner/permission checks

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: Podman docs cover intended model, prerequisites, quick start, setup details, Quadlet, onboarding, model auth, host CLI default, Tailscale, config/storage, useful commands, and troubleshooting (`/Users/kevinlin/code/openclaw/docs/install/podman.md:8-216`). Source validates non-root execution, private dirs/files, image names, ports, path safety, token/config creation, origin sync, `keep-id`, SELinux mount options, and Quadlet install.
- Negative signals: the test inventory has strong Docker setup coverage but much less Podman-specific test visibility; Podman relies on shell script behavior that is harder to verify without runtime smoke.
- Integration gaps: there is no recurring Podman runtime smoke that proves rootless launch, setup/onboarding, host CLI routing, Quadlet autostart, and restart/update guidance across Linux and macOS Podman machine.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: Query evidence includes closed issue #53827 for prior Podman saved-image temp-tar permission failures, PR #63407 / Freshbits archive for wiring `OPENCLAW_INSTALL_BROWSER` into Podman setup, and issue #71493 / PR #71503 for Docker/Podman bridge-interface address selection.
- Discrawl reports: Query evidence includes a 2026-05-11 user describing OpenClaw running in a Podman container on Rocky Linux, a 2026-05-01 user asking for container setup guidance, and Freshbits entries for Podman build-arg and setup hardening.
- Good qualities: the scripts strongly prefer rootless operation, reject unsafe image/path values, keep image work in the invoking user's Podman store, use owner-only `.env`, generate hardened Quadlet defaults, and make `openclaw --container` the host control path.
- Bad qualities: Podman has less visible operator history than Docker, macOS Podman machine device-auth behavior needs special guidance, and Quadlet customization remains manual.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/docker-podman-hosting.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Podman setup scripts and Quadlet template, Rootless Podman image setup.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a Podman smoke lane that covers rootless setup, `launch`, `launch setup`, `openclaw --container`, and Quadlet autostart.
- Add explicit Podman update guidance beside the Docker update guidance.
- Add macOS Podman machine troubleshooting around Control UI device auth and Tailscale access.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/install/podman.md:8-23` defines the intended rootless model and prerequisites.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:24-60` documents quick start, setup details, image selection, config/token creation, and Quadlet setup.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:85-126` documents model auth, host CLI default, macOS device-auth caveat, and Tailscale guidance.
- `/Users/kevinlin/code/openclaw/docs/install/podman.md:127-216` documents Quadlet, config/storage, useful commands, and troubleshooting.

### Source

- `/Users/kevinlin/code/openclaw/scripts/podman/setup.sh:1-17` states the current-user rootless setup model and setup modes.
- `/Users/kevinlin/code/openclaw/scripts/podman/setup.sh:349-414` requires Podman, rejects root, validates paths/image/ports, creates private config/workspace dirs, and builds/pulls the image.
- `/Users/kevinlin/code/openclaw/scripts/podman/setup.sh:416-493` generates token/config, seeds origins, installs Quadlet, and prints next commands.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:206-213` rejects root execution.
- `/Users/kevinlin/code/openclaw/scripts/run-openclaw-podman.sh:491-575` creates token/config, applies user namespace and SELinux mount behavior, runs setup, and launches the gateway container.
- `/Users/kevinlin/code/openclaw/scripts/podman/openclaw.container.in:1-32` defines the rootless Quadlet container, `keep-id`, volume mounts, env file, loopback port publishing, and restart policy.

### Integration tests

- No dedicated Podman runtime smoke test was found in the current local test inventory.
- `/Users/kevinlin/code/openclaw/test/scripts/docker-e2e-plan.test.ts` covers Docker release lanes, but Podman runtime is not a first-class planned lane there.
- `/Users/kevinlin/code/openclaw/src/cli/container-target.test.ts` covers shared Docker/Podman host CLI routing behavior.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/cli/container-target.test.ts` covers `--container` parsing/routing, ambiguous Docker/Podman names, loopback proxy rejection, and blocked update behavior.
- `/Users/kevinlin/code/openclaw/src/infra/container-environment.test.ts` covers Podman/Kubernetes/Docker container sentinel detection.

### Gitcrawl queries

Query: `Podman setup fails loading saved image`

Results:

- Hit closed issue #53827, `Podman setup fails loading saved image as openclaw user due to temp tar permissions`; discrawl archive later records it closed after current setup kept work in the invoking rootless user's Podman context.

Query: `OPENCLAW_INSTALL_BROWSER`

Results:

- Hit PR #61464 and issue #86612 with Docker/Podman setup output involving `OPENCLAW_INSTALL_BROWSER`.

### Discrawl queries

Query: `Podman OpenClaw`

Results:

- Found a 2026-05-11 user report of OpenClaw running in a Podman container on Rocky Linux with credential-injection proxying.
- Found 2026-04-29 Freshbits entries for `podman: wire OPENCLAW_INSTALL_BROWSER build-arg to setup script`.
- Found a 2026-04-25 issue-close note for #53827 describing the current rootless-user Podman setup model.
