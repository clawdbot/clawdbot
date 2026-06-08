---
title: "macOS Gateway host - Gateway Service Lifecycle Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Gateway Service Lifecycle Maturity Note

## Summary

The LaunchAgent lifecycle is a real operator-facing macOS service
implementation. The CLI wires install/start/stop/restart/status through the
Darwin service adapter, the app shells out to the CLI in local mode, and the
launchd adapter handles labels, profiles, KeepAlive, RunAtLoad, secure env
files, token drift, bootstrap repair, stale PID cleanup, and runtime inspection.

Coverage is Stable because there is a live Darwin launchd integration suite plus
broader CLI/status/unit coverage. Quality is Beta because archive evidence still
shows open launchd failures around self-update re-bootstrap, env-wrapper
execution on external home volumes, and misleading status audit output.

## Category Scope

Included in this category:

- Per-user Gateway LaunchAgent install: Per-user Gateway LaunchAgent install, stage, uninstall, start, stop, restart, and status
- launchctl bootstrap: launchctl bootstrap, bootout, enable, disable, kickstart, runtime parsing, installed-but-unloaded repair, and --disable semantics
- LaunchAgent labels: LaunchAgent labels, profile labels, legacy cleanup, service metadata, plist generation, KeepAlive, RunAtLoad, logs, working directory, and temp directory handling
- Gateway token/env handling: Gateway token/env handling, owner-only env files/wrappers, managed service env keys, and config audit/status output
- App-managed LaunchAgent handoff: macOS app integration that manages the Gateway LaunchAgent in local mode and avoids it in remote or attach-only modes.
- openclaw update package/git handoff: openclaw update package/git handoff on macOS
- Managed service refresh: Managed service refresh and LaunchAgent rebootstrap after updates
- Stale updater launchd job detection: Stale updater launchd job detection and cleanup
- openclaw uninstall: openclaw uninstall, service uninstall, state cleanup, and manual launchd removal
- Stranded service recovery: Recovery after partially updated or stranded macOS Gateway services.

## Features

- Per-user Gateway LaunchAgent install: Per-user Gateway LaunchAgent install, stage, uninstall, start, stop, restart, and status
- launchctl bootstrap: launchctl bootstrap, bootout, enable, disable, kickstart, runtime parsing, installed-but-unloaded repair, and --disable semantics
- LaunchAgent labels: LaunchAgent labels, profile labels, legacy cleanup, service metadata, plist generation, KeepAlive, RunAtLoad, logs, working directory, and temp directory handling
- Gateway token/env handling: Gateway token/env handling, owner-only env files/wrappers, managed service env keys, and config audit/status output
- App-managed LaunchAgent handoff: macOS app integration that manages the Gateway LaunchAgent in local mode and avoids it in remote or attach-only modes.
- openclaw update package/git handoff: openclaw update package/git handoff on macOS
- Managed service refresh: Managed service refresh and LaunchAgent rebootstrap after updates
- Stale updater launchd job detection: Stale updater launchd job detection and cleanup
- openclaw uninstall: openclaw uninstall, service uninstall, state cleanup, and manual launchd removal
- Stranded service recovery: Recovery after partially updated or stranded macOS Gateway services.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (86%)`
- Positive signals: live Darwin launchd integration covers install, restart with PID replacement, raw SIGTERM KeepAlive recovery, stop/start, stop/restart, and missing-bootstrap repair.
- Negative signals: the strongest live proof calls launchd adapter functions directly rather than exercising the packaged `openclaw gateway install/status --deep/restart` commands end to end from the CLI binary.
- Integration gaps: no visible live proof covers external-home env-wrapper execution, shell-wrapped service status parsing, or an app toggle that installs, status-checks, restarts, and disables the LaunchAgent through the UI.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: launchd-focused searches found open #85133 for self-update leaving `ai.openclaw.gateway` unregistered, open #87199 for env-wrapper/permission failure on external home volumes, open #81751 for false "missing gateway subcommand" status audit on shell-wrapped LaunchAgents, and open PR #75545 for making `gateway start` idempotent when already running.
- Discrawl reports: launchd archive searches returned historical restart/bootout failures now marked implemented, operator reports of LaunchAgent bootout from SSH/headless contexts, and repeated status output showing token/PATH/version-manager service drift.
- Good qualities: the launchd adapter has secure plist/env-file permissions, owner-only env wrapper files, GUI-domain bootstrap guidance, profile-aware labels, legacy cleanup, default bootout stop preserving future KeepAlive, persistent `--disable`, port-release assertions, restart handoff support, and deep status/audit surfaces.
- Bad qualities: active reports show the service can still be lost after update, fail on env-wrapper execution in some home-volume setups, or produce misleading diagnostics.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Stable (86%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Per-user Gateway LaunchAgent install, launchctl bootstrap, LaunchAgent labels, Gateway token/env handling, App-managed LaunchAgent handoff, openclaw update package/git handoff, Managed service refresh, Stale updater launchd job detection, openclaw uninstall, Stranded service recovery.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Self-update LaunchAgent handoff is not fully proven robust by archive evidence: #85133 reports a valid plist rewritten while launchd is no longer supervising the job.
- Env-wrapper execution still has edge-case risk on external home volumes.
- App integration is source-backed and unit-covered but lacks a visible live app-to-launchd proof path in the inspected evidence.

## Evidence

### Docs

- `docs/platforms/macos.md:24`: local mode attaches to a running local Gateway or enables launchd with `openclaw gateway install`; remote mode connects over SSH/Tailscale and never starts a local Gateway.
- `docs/platforms/macos.md:35`: documents per-user LaunchAgent labels, profile labels, legacy label cleanup, `launchctl kickstart -k`, and `launchctl bootout`.
- `docs/platforms/mac/bundled-gateway.md:27`: documents label, plist path, app/CLI managers, Active toggle semantics, app quit behavior, and stdout/stderr paths.
- `docs/cli/gateway.md:267`: documents `gateway status`, JSON output, `--require-rpc`, `--no-probe`, and `--deep`.
- `docs/cli/gateway.md:449`: documents service lifecycle, wrapper, auth SecretRefs, and macOS stop behavior.
- `docs/gateway/index.md:209`: documents macOS launchd install/status/restart/stop, bootout/disable, labels, and doctor audits.

### Source

- `src/daemon/service.ts:73`: defines the Gateway service abstraction.
- `src/daemon/service.ts:261`: binds Darwin to LaunchAgent install/uninstall/stop/restart/isLoaded/readCommand/readRuntime.
- `src/daemon/launchd.ts:111`: computes LaunchAgent labels and plist paths.
- `src/daemon/launchd.ts:189`: writes owner-only env files and env wrapper scripts.
- `src/daemon/launchd.ts:441`: enables before bootstrap and handles unsupported GUI domains with actionable guidance.
- `src/daemon/launchd.ts:533`: reads launchd load/runtime state via `launchctl print`.
- `src/daemon/launchd.ts:596`: repairs installed-but-unloaded LaunchAgents.
- `src/daemon/launchd.ts:779`: defaults stop to bootout and preserves future KeepAlive recovery unless `--disable` is requested.
- `src/daemon/launchd.ts:1016`: restarts through in-service detached handoff, stale port cleanup, plist rewrite/reload, kickstart, bootstrap fallback, and loaded-after-failure repair.
- `apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift:57`: app skips launchd changes in remote mode, respects attach-only marker, installs with `openclaw gateway install --force --port ... --runtime node`, uninstalls when disabled, and restarts through the CLI.

### Integration tests

- `src/daemon/launchd.integration.e2e.test.ts:177`: live Darwin launchd suite creates an isolated LaunchAgent label and temp home, then exercises real launchctl behavior.
- `src/daemon/launchd.integration.e2e.test.ts:205`: restarts launchd service and verifies the runtime keeps running with a new PID.
- `src/daemon/launchd.integration.e2e.test.ts:213`: kills the process with raw SIGTERM and verifies LaunchAgent supervision replaces the PID.
- `src/daemon/launchd.integration.e2e.test.ts:222`: stops, verifies not-running, starts through `startGatewayService`, and verifies a new PID.
- `src/daemon/launchd.integration.e2e.test.ts:246`: bootouts a valid installed plist and verifies repair re-registers and restarts without extra kickstart.
- `src/cli/daemon-cli/install.integration.test.ts:136`: install auto-mints a token and avoids embedding `OPENCLAW_GATEWAY_TOKEN` into service env.

### Unit tests

- `src/daemon/launchd.test.ts:597`: bootstrap repair covers enable/bootstrap ordering, already-loaded handling, and kickstart behavior.
- `src/daemon/launchd.test.ts:685`: install tests cover enable-before-bootstrap, owner-only env files, env-wrapper repair, TMPDIR creation, KeepAlive policy, plist rewrite, and permission tightening.
- `src/daemon/launchd.test.ts:897`: stop tests cover default bootout, port-release postconditions, `--disable`, degraded fallback, and failure propagation.
- `src/daemon/launchd.test.ts:1208`: restart tests cover kickstart, reload after plist rewrite, stale cleanup, busy-port failure, bootstrap fallback, detached handoff, GUI-domain guidance, and invalid labels.
- `src/cli/daemon-cli/lifecycle.test.ts:276`: CLI start re-bootstraps an installed LaunchAgent when not loaded.
- `apps/macos/Tests/OpenClawIPCTests/GatewayLaunchAgentManagerTests.swift:5`: attach-only override writes the marker and does not uninstall the Gateway LaunchAgent.
- `apps/macos/Tests/OpenClawIPCTests/GatewayLaunchAgentManagerTests.swift:29`: app-side LaunchAgent plist snapshot parsing extracts port, bind, token, and password.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS LaunchAgent gateway install restart status ai.openclaw.gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #87199: `[Bug]: macOS LaunchAgent generated by 2026.5.22 uses env-wrapper and missing gateway run, causing EX_CONFIG / Permission denied on external home volumes`.

Query:

```bash
gitcrawl search issues "self-update macOS LaunchAgent not loaded gateway" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #85133: `Gateway launchd agent gets unloaded during self-update and never re-bootstrapped (macOS)`.
- Open #75250: `Bug: OpenClaw breaks after Homebrew updates due to mixed Homebrew Node/runtime/plugin cache drift`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "gateway service launchd"
```

Results:

- Returned 2026-05-14 maintainer reports of self-update failures across three macOS LaunchAgent instances, including one current package with Gateway offline and one unloaded LaunchAgent.
- Returned 2026-05-06 release notes for fixes making `gateway stop` use bootout by default and avoiding unnecessary kickstart.
- Returned stale updater job analysis where a sibling launchd update job kept terminating the Gateway.
