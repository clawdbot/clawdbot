---
title: "macOS Gateway host - Companion App Gateway Integration Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Companion App Gateway Integration Maturity Note

## Summary

The macOS companion app is integrated with the Gateway host through explicit
mode coordination, LaunchAgent management, endpoint resolution, CLI install
detection, and attach-to-existing behavior. The app does not embed the Gateway;
it expects the external CLI, then either manages launchd in local mode or
connects to a remote Gateway and starts the local node host.

Coverage is Beta because most evidence is source/unit/doc based, with less
full-app automation. Quality is Stable because the code has clear boundaries
between local, remote, attach-only, CLI install, and endpoint selection.

## Category Scope

- App local/remote connection mode coordination.
- App-managed Gateway LaunchAgent install/restart/uninstall through the CLI.
- CLI install detection and app install prompt.
- Attach-to-existing local Gateway compatibility checks.
- Gateway endpoint, credential, and control-channel resolution.

## Features

- App local/remote connection mode: App local/remote connection mode coordination
- App-managed Gateway LaunchAgent install/restart/uninstall: App-managed Gateway LaunchAgent install/restart/uninstall through the CLI
- CLI install detection: CLI install detection and app install prompt
- Attach-to-existing local Gateway compatibility: Attach-to-existing local Gateway compatibility checks
- Gateway endpoint: Gateway endpoint, credential, and control-channel resolution

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (76%)`
- Positive signals: docs and app source cover the external CLI model, launchd control, attach-only marker, remote-mode skip behavior, endpoint store, and control-channel setup.
- Negative signals: UI-level test evidence for the full app flow is thinner than Swift source/unit evidence.
- Integration gaps: no inspected release lane clicks the app through CLI install, local Gateway activation, attach-existing, remote switch, and recovery from CLI missing state.

## Quality Score

- Score: `Stable (82%)`
- Gitcrawl reports: `macOS app gateway launchd attach existing install CLI version compatibility` returned no open hits.
- Discrawl reports: `macOS app gateway install CLI` returned mostly release/general support hits rather than direct open app-integration defects; `mac app remote gateway ssh tunnel` returned user confusion about remote app/node behavior.
- Good qualities: app source has a specific mode coordinator, dedicated LaunchAgent manager, CLI installer, endpoint store, remote config resolver, and tunnel manager rather than ad hoc process spawning.
- Bad qualities: docs and product behavior can leave users unsure whether the app installs a global CLI or a local-prefix CLI, and whether remote mode makes the Mac an operator, node, or both.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Beta (76%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for App local/remote connection mode, App-managed Gateway LaunchAgent install/restart/uninstall, CLI install detection, Attach-to-existing local Gateway compatibility, Gateway endpoint.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Align app install docs with the actual `install-cli.sh --prefix ~/.openclaw` source behavior.
- Add app-level automation for local/remote mode switching and launchd activation.
- Provide clearer app status text for attached local Gateway versus app-managed local Gateway.

## Evidence

### Docs

- `docs/platforms/macos.md:9`: states the macOS app owns permissions, manages or attaches to Gateway, and supports local/remote modes.
- `docs/platforms/macos.md:141`: documents the onboarding flow for installing CLI, selecting local/remote mode, and granting permissions.
- `docs/platforms/mac/bundled-gateway.md:10`: states the app no longer bundles Node/Bun/Gateway and expects an external `openclaw`.
- `docs/platforms/mac/bundled-gateway.md:27`: documents app-managed per-user launchd service, CLI management, active toggle, quit behavior, and attach existing.
- `docs/platforms/mac/remote.md:66`: documents app settings and Test Remote behavior.

### Source

- `apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift:19`: local mode stops node/tunnels, starts local Gateway if policy says, waits for readiness, and configures local control.
- `apps/macos/Sources/OpenClaw/ConnectionModeCoordinator.swift:57`: remote mode stops local Gateway, starts node service, ensures remote control tunnel, and configures remote control.
- `apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift:22`: supports launchd writes-disabled marker and attach-only mode.
- `apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift:57`: installs/uninstalls/restarts the Gateway LaunchAgent through the CLI.
- `apps/macos/Sources/OpenClaw/GatewayProcessManager.swift:61`: skips local Gateway management in remote mode.
- `apps/macos/Sources/OpenClaw/GatewayProcessManager.swift:99`: attaches to a compatible existing Gateway before enabling launchd.
- `apps/macos/Sources/OpenClaw/GatewayProcessManager.swift:243`: reports auth/protocol mismatch failures when attaching to an existing Gateway.
- `apps/macos/Sources/OpenClaw/GatewayEndpointStore.swift:43`: wires dependencies for mode, token/password, local host, and remote tunnel.
- `apps/macos/Sources/OpenClaw/CLIInstaller.swift:5`: detects installed `openclaw`.
- `apps/macos/Sources/OpenClaw/CLIInstaller.swift:37`: runs the app CLI installer.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:980`: verifies dashboard load from a local Gateway on a macOS guest.
- `scripts/e2e/parallels/macos-smoke.ts:1006`: verifies first agent turn after macOS setup.
- `scripts/e2e/parallels/macos-discord.ts:27`: configures Discord, runs doctor, restarts Gateway, and probes channels status on a macOS smoke path.

### Unit tests

- `apps/macos/Tests/OpenClawIPCTests/GatewayLaunchAgentManagerTests.swift:5`: attach-only override writes the marker and does not uninstall.
- `apps/macos/Tests/OpenClawIPCTests/GatewayLaunchAgentManagerTests.swift:29`: parses LaunchAgent plist args/env token/password.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:25`: resolves app command paths for `openclaw` and Node.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:148`: builds SSH commands for remote mode.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:210`: keeps local daemon command override independent from remote defaults.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS app gateway launchd attach existing install CLI version compatibility" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "macOS app gateway install CLI"
```

Results:

- Returned release/support chatter but no direct open app Gateway integration defect.
- Returned general Gateway restart support guidance that asks users to identify install type: Docker, systemd, macOS app, or shell Gateway.

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "mac app remote gateway ssh tunnel"
```

Results:

- Returned support guidance that app remote mode should own the SSH tunnel and that Tailscale is simpler for app-to-remote-Gateway operation.
