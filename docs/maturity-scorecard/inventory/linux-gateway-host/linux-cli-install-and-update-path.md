---
title: "Linux Gateway host - Host Setup and Updates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux Gateway host - Host Setup and Updates Maturity Note

## Summary

Linux install and update paths are broadly covered: the docs include script install, package-manager install, local-prefix install, channel switching, dry-run/status output, staged npm update, root-owned file recovery, and managed Gateway restart handoff. Quality is still beta because recent archive evidence shows user-visible churn around ownership, package-manager naming, and installer runtime defaults.

## Category Scope

Included in this category:

- Linux CLI install: Linux CLI installation paths and operator verification after install.
- Node runtime prerequisites: Node runtime version requirements and host prerequisite checks for Linux Gateway operation.
- Package-manager policy: Supported package-manager and platform policy for Linux install and update paths.
- Update path: Linux update workflow, package or git handoff, and post-update verification.

## Features

- Linux CLI install: Linux CLI installation paths and operator verification after install.
- Node runtime prerequisites: Node runtime version requirements and host prerequisite checks for Linux Gateway operation.
- Package-manager policy: Supported package-manager and platform policy for Linux install and update paths.
- Update path: Linux update workflow, package or git handoff, and post-update verification.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Rationale: install and update docs cover all normal Linux entrypoints, and update source code handles staged installs, channel switching, repair prompts, and daemon restart handoff.
- Gaps: the docs spread Linux-specific update risk across install, updating, platform, and doctor pages, so operators have to connect multiple pages for root-owned or service-runtime repair cases.

## Quality Score

- Score: `Beta (78%)`
- Rationale: recommended install/update behavior is usable, but current issue evidence shows operator-facing confusion and failure modes still being clarified.
- Excluded from Quality: unit, integration, e2e, live, and runtime-flow test evidence.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/linux-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Linux CLI install, Node runtime prerequisites, Package-manager policy, Update path.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Collapse Linux install/update troubleshooting into a single operator checklist for root-owned paths, package-manager identity, service restarts, and managed Node.
- Ensure update/status/doctor text consistently names the active package manager and install root.

## Evidence

### Docs

- `docs/install/index.md:16-48` documents the installer script and Linux/macOS detection; `docs/install/index.md:52-66` documents the local-prefix managed runtime path.
- `docs/install/index.md:151-163` documents verification plus Linux systemd user service startup.
- `docs/install/updating.md:11-14` says `openclaw update` detects install type, fetches the latest version, runs doctor, and restarts Gateway.
- `docs/install/updating.md:19-46` covers channel switch, dry-run, JSON, and status output.
- `docs/install/updating.md:105-148` covers manual package-manager updates and Linux root-owned EACCES recovery.

### Source

- `src/cli/update-cli/update-command.ts` coordinates update mode, doctor repair guidance, service restart, and daemon install refresh.
- `src/infra/package-update-steps.ts:166-189` performs staged npm install behavior before replacing package contents.
- `src/infra/package-update-steps.ts:200-270` packages git-source installs for safer replacement.
- `src/cli/daemon-cli/install.ts:278-340` refreshes service metadata when token or wrapper drift is detected.

### Integration tests

- `test/scripts/install-cli.test.ts` covers local-prefix installer behavior.
- `test/scripts/test-install-sh-docker.test.ts` exercises installer behavior in a Linux container setting.
- `src/cli/update-cli.test.ts` covers service environment inheritance, systemd stopped-service handling, and service restart/update interactions.

### Unit tests

- `src/infra/package-update-steps.test.ts` covers package update planning behavior.
- `src/cli/update-cli.test.ts` covers package-manager update modes and Linux service handoff branches.

### Gitcrawl queries

- Specific query `Linux install.sh install-cli update channel npm git package manager root` returned no hits.
- Broader query `install.sh update` returned PR #81278 for local-prefix managed Node runtime clarity, issue #79558 for Node defaults between installer paths, issue #87732 for npm install being called pnpm, issue #78493 for mixed ownership after `sudo openclaw update`, and PR #82955 for downloaded-script validation.

### Discrawl queries

- Query `install.sh openclaw update` found beta-release support threads asking users to test updating existing installs, `openclaw status`, and `openclaw doctor`.
- The same query found maintainer discussion that update/doctor became harder because package-swap repair must cover more local install states.
