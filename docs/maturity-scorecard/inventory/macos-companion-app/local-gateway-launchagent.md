---
title: "macOS companion app - Local Gateway and Launchagent Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Local Gateway and Launchagent Maturity Note

## Summary

Local mode is a real operator workflow: the app attaches to an existing Gateway, manages the per-user LaunchAgent through the CLI, avoids local Gateway startup in remote mode, exposes health/log paths, and has focused tests around launchd and packaging. Coverage is Beta because the lifecycle is implemented through CLI/launchd pathways with focused supporting proof, but no complete live app scenario was found. Quality is Alpha because archive evidence shows LaunchAgent update/restart, port conflict, TCC, and env-wrapper failures remain high-impact operational risks.

## Category Scope

- Local mode Gateway attach/start/stop.
- LaunchAgent install/update/restart/uninstall through app-managed CLI calls.
- Existing-listener detection, port guarding, and launchd log path.
- Out of scope: Linux/systemd Gateway service.

## Features

- Local mode Gateway attach/start/stop: Local mode Gateway attach/start/stop behavior, status, and operator-visible verification.
- LaunchAgent install/update/restart/uninstall: LaunchAgent install/update/restart/uninstall through app-managed CLI calls
- Existing-listener detection: Existing-listener detection, port guarding, and launchd log path

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: Docs cover external CLI requirement, app-owned LaunchAgent, attach-to-existing behavior, version compatibility, and smoke checks. Source has explicit local/remote guards, attach-existing health probes, launchd commands, and port guardian behavior. Swift and TS tests cover launchd manager, Gateway process manager, package scripts, and restart/update helpers.
- Negative signals: Tests do not prove destructive LaunchAgent self-update or long-running app-managed Gateway restart behavior on a real installed system.
- Integration gaps: Need a signed-app scenario that enables launchd, survives app quit, updates/restarts the Gateway, detects a stale service, and recovers without manual shell repair.

## Quality Score

- Score: `Alpha (65%)`
- Gitcrawl reports: Results include PR #81725 for skipping CLI gateway repair when the app owns launchd, issue #65619 for loopback bind resolving to `0.0.0.0`, issue #78049 for launchd-managed Gateway TCC folder access, issue #86104 for one-shot update relaunch, issue #87199 for env-wrapper/missing `gateway run`, and issue #87402 for managed listener port conflict during restart.
- Discrawl reports: Maintainer archive includes v2026.5.12 self-update failures across macOS LaunchAgent instances, manual SSH repair, stale transient update LaunchAgent cleanup, and a release note saying macOS LaunchAgent recovery was a major fix area.
- Good qualities: Source deliberately avoids child-process Gateway spawning, uses the external CLI daemon path, attaches to existing healthy gateways, and skips launchd writes in attach-only/remote modes.
- Bad qualities: Operational failure modes can strand the service offline or conflict with update/restart flows. Several current reports involve non-obvious launchd, permission, or listener state.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Local mode Gateway attach/start/stop, LaunchAgent install/update/restart/uninstall, Existing-listener detection.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need real destructive macOS LaunchAgent self-update QA, including package-current/service-offline states.
- Need an app-facing recovery path for env-wrapper, stale update job, port conflict, and TCC-protected-folder failures.
- Need repeated release proof for local Gateway startup, restart, update, and health from a packaged signed app.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/bundled-gateway.md` documents external CLI install, app-owned LaunchAgent, attach-existing behavior, launchd log path, version compatibility, and smoke check.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` documents local mode, LaunchAgent label, and troubleshooting for silent stops and launchd respawn protection.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/child-process.md` documents that the app manages Gateway through launchd and does not spawn it as a child process.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/GatewayProcessManager.swift` handles local-mode activation, attach-existing probes, environment refresh, launchd enable, log refresh, and remote-mode skip.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift` routes launchd changes through `openclaw gateway` daemon commands and resolves status/log path.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift` starts local Gateway and control channel in local mode, and stops local Gateway in remote/unconfigured modes.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/PortGuardian.swift` detects expected and unexpected port listeners.

### Integration tests

- `/Users/kevinlin/code/openclaw/test/scripts/restart-mac.test.ts`, `package-mac-app.test.ts`, and `package-mac-dist.test.ts` cover app packaging/restart script behavior.
- No full live LaunchAgent update/recovery scenario was found.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/GatewayProcessManagerTests.swift`, `GatewayLaunchAgentManagerTests.swift`, `LaunchAgentManagerTests.swift`, `LaunchctlTests.swift`, `GatewayAutostartPolicyTests.swift`, and `PortGuardian` coverage in `LowCoverageHelperTests.swift`.
- `/Users/kevinlin/code/openclaw/src/daemon/launchd*.ts` has broader Gateway daemon tests outside the native app.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS LaunchAgent gateway local mode" --json`

Results:

- PR #81725 `macOS: skip CLI gateway repair when app owns launchd`.
- Issue #65619 `macOS: gateway bind=loopback resolves to 0.0.0.0 and refuses to start`.
- Issue #78049 `macOS launchd-managed Gateway cannot reliably access TCC-protected folders via CLI tools`.
- Issue #86104 `macOS: launchctl submit can relaunch one-shot update jobs after clean exit`.
- Issue #87199 `macOS LaunchAgent generated by 2026.5.22 uses env-wrapper and missing gateway run`.
- Issue #87402 `Gateway restart treats managed listener as port conflict`.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS LaunchAgent gateway"`

Results:

- 2026-05-14 maintainer report: v2026.5.12 self-update failure across three macOS LaunchAgent instances; manual outside-OpenClaw repair was required.
- 2026-05-08 maintainer note: stale transient update LaunchAgent repeatedly killed Gateway restarts and left canonical Gateway disabled.
- 2026-05-06 PR note: launchd `disable` and unnecessary `kickstart` bugs fixed.
