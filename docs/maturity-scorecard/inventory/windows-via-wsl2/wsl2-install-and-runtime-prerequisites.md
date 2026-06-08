---
title: "Windows via WSL2 - WSL Setup and Updates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Windows via WSL2 - WSL Setup and Updates Maturity Note

## Summary

WSL2 install/runtime readiness is the strongest part of this surface outside core systemd service management. Docs clearly recommend WSL2 for Windows, describe WSL2 + Ubuntu setup, require systemd for service install, and route users into the Linux install/getting-started flow. Source contains explicit WSL/WSL2 detection and WSL2-specific network family handling. The remaining risk is operator confusion across native Windows PowerShell, WSL shells, Node/pnpm install methods, and source/package flows.

## Category Scope

Included in this category:

- WSL2 + Ubuntu installation: WSL2 and Ubuntu installation requirements.
- Node runtime: Node 24 and Node 22.19+ runtime requirements inside WSL2.
- Linux install flow inside WSL2: Linux install and getting-started flow run inside WSL2.
- WSL2 runtime boundary: WSL2 runtime boundary and its distinction from native Windows installs.
- WSL2 network-family requirements: WSL2-specific network-family requirements that affect Gateway startup.
- Source install and build inside WSL2: Source install and build workflow inside the WSL2 distribution.
- openclaw update: openclaw update, channel switching, dry-run/status diagnostics
- npm/pnpm/git package-root: npm/pnpm/git package-root and install-mode switching
- Managed systemd Gateway restart: Managed systemd Gateway restart and update handoff
- Service metadata refresh: Service metadata refresh after WSL2 Gateway updates.
- Package-manager caveats: Package-manager caveats seen from WSL2 source and package installs.

## Features

- WSL2 + Ubuntu installation: WSL2 and Ubuntu installation requirements.
- Node runtime: Node 24 and Node 22.19+ runtime requirements inside WSL2.
- Linux install flow inside WSL2: Linux install and getting-started flow run inside WSL2.
- WSL2 runtime boundary: WSL2 runtime boundary and its distinction from native Windows installs.
- WSL2 network-family requirements: WSL2-specific network-family requirements that affect Gateway startup.
- Source install and build inside WSL2: Source install and build workflow inside the WSL2 distribution.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (78%)`
- Positive signals: docs state WSL2 is the recommended Windows path; step-by-step WSL2 install guidance exists; README and getting-started docs define the Node floor and daemon onboarding path; source detects WSL/WSL2 and applies WSL2-specific network behavior.
- Negative signals: the strongest real-scenario proof is a Windows runner WSL2 probe plus Linux/systemd flows, not a full install/onboard/update WSL2 acceptance run.
- Integration gaps: no current end-to-end WSL2 first-install scorecard was found that proves WSL install, OpenClaw install, onboard, Gateway service, dashboard, update, and doctor in one run.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: `WSL2 install Node openclaw onboard` returned open issue #63740 for a WSL2 source/runtime syntax failure, PR #74163 summarizing Windows/onboard slowness, and issue #86612 for Docker/WSL2 path and sandbox interactions.
- Discrawl reports: WSL2 install/support queries returned user-facing guidance that WSL2 is the more stable Windows path, but also repeated confusion around whether to run commands in PowerShell or Ubuntu, Node/pnpm setup, and native Windows fallback behavior.
- Good qualities: docs are honest about WSL2 being the recommended full-experience path, and source separates WSL detection from native Windows behavior instead of hiding WSL behind platform strings.
- Bad qualities: install guidance spans official WSL setup, package installs, source builds, systemd enablement, and native-Windows contrast, which leaves room for users to execute the right command in the wrong shell.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Beta (78%)`
- Surface instructions: evaluated against `references/completeness/windows-via-wsl2.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for WSL2 + Ubuntu installation, Node runtime, Linux install flow inside WSL2, WSL2 runtime boundary, WSL2 network-family requirements, Source install and build inside WSL2.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a repeated live WSL2 install/onboard/update scorecard from a fresh Windows machine or runner.
- Need more explicit guardrails when users start in native PowerShell but intend to follow the WSL2 path.
- Need first-class docs or diagnostics for workspace location performance, especially avoiding long-running source/dev work under `/mnt/c/...`.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:10`: WSL2 is the more stable Windows path and runs CLI, Gateway, and tooling inside Linux.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:17`: WSL2 section links getting-started, install/update, and official Microsoft WSL install docs.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:183`: step-by-step WSL2 install begins with `wsl --install` and Ubuntu selection.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:198`: WSL systemd is required for Gateway install.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:221`: OpenClaw install inside WSL follows the Linux getting-started/source flow.
- `/Users/kevinlin/code/openclaw/docs/start/getting-started.md:15`: Node 24 is recommended and Node 22.19+ is supported.
- `/Users/kevinlin/code/openclaw/docs/start/getting-started.md:20`: getting started tells Windows users WSL2 is more stable and recommended.
- `/Users/kevinlin/code/openclaw/README.md:33`: onboarding works on Windows via WSL2 and calls that path strongly recommended.

### Source

- `/Users/kevinlin/code/openclaw/src/infra/wsl.ts:11`: WSL detection checks `WSL_INTEROP`, `WSL_DISTRO_NAME`, and `WSLENV`.
- `/Users/kevinlin/code/openclaw/src/infra/wsl.ts:22`: sync WSL detection checks Linux platform plus `/proc/version`.
- `/Users/kevinlin/code/openclaw/src/infra/wsl.ts:40`: WSL2 detection checks WSL state plus kernel markers such as `wsl2` and `microsoft-standard`.
- `/Users/kevinlin/code/openclaw/src/infra/net/undici-family-policy.ts:12`: WSL2 disables Node auto-family selection to force IPv4 for Windows-host service reachability.

### Integration tests

- `/Users/kevinlin/code/openclaw/.github/workflows/windows-testbox-probe.yml:76`: Windows workflow probes WSL2 availability.
- `/Users/kevinlin/code/openclaw/.github/workflows/windows-testbox-probe.yml:127`: workflow can import a throwaway Ubuntu WSL2 distro before probing.
- `/Users/kevinlin/code/openclaw/.github/workflows/windows-testbox-probe.yml:142`: workflow executes Linux commands inside the selected WSL distro.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/infra/wsl.test.ts:62`: unit tests cover WSL env-var detection.
- `/Users/kevinlin/code/openclaw/src/infra/wsl.test.ts:71`: unit tests cover `/proc/version` WSL detection.
- `/Users/kevinlin/code/openclaw/src/infra/wsl.test.ts:84`: unit tests cover WSL2 kernel markers.
- `/Users/kevinlin/code/openclaw/src/infra/net/undici-global-dispatcher.test.ts:621`: unit tests prove WSL2 disables `autoSelectFamily`.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "WSL2 install Node openclaw onboard" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Windows WSL2 OpenClaw" --mode keyword --limit 12 --json`

Results:

- `WSL2 install Node openclaw onboard` returned 3 hits: issue #63740 (`Source code corruption in dist/run-main-*.js`, WSL2 Ubuntu), PR #74163 (Microsoft issue refresh including Windows onboard slowness), and issue #86612 (Docker gateway restart loop with WSL2 path context).
- `Windows WSL2 OpenClaw` returned 12 hits, including WSL2 GPU/driver lockup #86048, WSL environment diagnostics PR #58853, WSL/VM reachability issue #73152, browser profile WSL issue #81873, gateway stall #61616, and multiple Windows/WSL2 Control UI/Gateway reports.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "WSL2 install Node openclaw onboard"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 8 "Windows WSL2 OpenClaw"`

Results:

- WSL2 install/onboard search returned 8 hits, including support guidance that WSL2 is the recommended Windows path, native Windows install caveats, WSL2 source install reports, and first-install prerequisite guidance.
- Windows WSL2 OpenClaw search returned 8 hits, including recent user help around WSL2 recommendation, Windows runtime forcing questions, and Windows users being routed toward WSL2 for stable operation.
