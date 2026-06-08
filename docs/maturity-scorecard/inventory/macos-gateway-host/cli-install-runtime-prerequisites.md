---
title: "macOS Gateway host - CLI Setup Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - CLI Setup Maturity Note

## Summary

The macOS Gateway host has a concrete CLI and runtime prerequisite path. Docs
cover install scripts, Node requirements, PATH repair, npm/pnpm/bun guidance,
and the macOS app's expectation that `openclaw` is externally installed. Source
backs the app's CLI detection/install flow and the CLI installer's local-prefix
path.

Coverage is Stable because docs, source, runtime guards, and Parallels macOS
smoke flows all exercise this path. Quality is Beta because current archive
evidence still shows package-manager/runtime drift on macOS, especially after
Homebrew or update operations.

## Category Scope

Included in this category:

- Hosted installer: Hosted installer and local-prefix install paths on macOS
- Node 24 recommendation: Node 24 recommendation and Node 22.19+ compatibility floor
- App-triggered CLI install: App-triggered CLI install and runtime discovery
- Shell PATH and version-manager drift: Shell PATH, package-manager, and version-manager drift that affect the host Gateway.

## Features

- Hosted installer: Hosted installer and local-prefix install paths on macOS
- Node 24 recommendation: Node 24 recommendation and Node 22.19+ compatibility floor
- App-triggered CLI install: App-triggered CLI install and runtime discovery
- Shell PATH and version-manager drift: Shell PATH, package-manager, and version-manager drift that affect the host Gateway.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals: installer docs, Node docs, app CLI installer source, runtime locator checks, and Parallels macOS install/update smoke coverage all cover the main install path.
- Negative signals: the strongest live coverage is release-smoke oriented and does not exhaustively cover Homebrew, npm global, local prefix, version-manager, and app-triggered install combinations.
- Integration gaps: there is no single live lane that starts from a clean macOS desktop app, installs the CLI through the app, verifies Node/PATH, and then proves Gateway launchd startup from that same app-managed install.

## Quality Score

- Score: `Beta (76%)`
- Gitcrawl reports: `macOS install openclaw CLI Node PATH command not found` returned open #80387 for the `openclaw` command disappearing after a Homebrew Node major upgrade. `self-update macOS LaunchAgent not loaded gateway` returned open #75250 for mixed Homebrew Node/runtime/plugin cache drift.
- Discrawl reports: `macOS install openclaw command not found` returned recent macOS update/install support threads, including a 2026-04-18 recovery note where an agent repair left the CLI missing or PATH-broken and the recommended recovery was rerunning the installer from Terminal.
- Good qualities: docs state the Node floor clearly, the app detects `openclaw`, the app install flow uses the hosted `install-cli.sh` with JSON/no-onboard flags, and CLI docs separate full install from local-prefix install.
- Bad qualities: the install surface crosses shell PATH, Node managers, Homebrew, npm globals, local prefixes, and app-launched noninteractive processes; archive signal shows these boundaries can still break user-visible Gateway startup.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Stable (82%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Hosted installer, Node 24 recommendation, App-triggered CLI install, Shell PATH and version-manager drift.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- App-triggered install should have a release gate that verifies the exact command the app runs and then proves `openclaw gateway status` from the installed CLI.
- Homebrew/Node major upgrade recovery remains an active watch item.
- PATH guidance is spread across install, Node, and macOS app docs rather than one macOS host runbook.

## Evidence

### Docs

- `docs/platforms/macos.md:9`: macOS app owns permissions and manages or attaches to the Gateway, with CLI install preference support.
- `docs/platforms/mac/bundled-gateway.md:10`: the app no longer bundles Node, Bun, or Gateway and expects an external `openclaw` CLI.
- `docs/platforms/mac/bundled-gateway.md:15`: documents Node 24 default, Node 22.19+ compatibility, npm global install, and the app Install CLI preference.
- `docs/install/installer.md:67`: documents `install.sh` flow, Node 24, Git, npm/git install, post-install service refresh, doctor, and onboarding.
- `docs/install/installer.md:178`: documents `install-cli.sh` local-prefix install and refresh of loaded services.
- `docs/install/node.md:10`: documents Node 22.19+ required and Node 24 recommended.
- `docs/install/node.md:87`: documents PATH troubleshooting when shells cannot find Node/npm/openclaw.

### Source

- `apps/macos/Sources/OpenClaw/CLIInstaller.swift:5`: detects whether `openclaw` is installed and captures CLI metadata.
- `apps/macos/Sources/OpenClaw/CLIInstaller.swift:37`: runs the app's CLI install flow and surfaces install output.
- `apps/macos/Sources/OpenClaw/CLIInstaller.swift:63`: installs to `~/.openclaw` via `curl -fsSL https://openclaw.bot/install-cli.sh | bash -s -- --json --no-onboard --prefix ... --version ...`.
- `apps/macos/Sources/OpenClaw/GatewayLaunchAgentManager.swift:151`: resolves `openclaw gateway` commands with a preferred PATH for app-managed local mode.
- `src/cli/daemon-cli/install.ts:80`: validates runtime, port, config, wrapper, and default `gateway.mode=local` before installing the service.
- `src/commands/daemon-install-helpers.ts:246`: builds service PATH from explicit runtime directories and preserved environment data.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:757`: installs the latest release in a macOS guest through the release installer path.
- `scripts/e2e/parallels/macos-smoke.ts:827`: performs noninteractive local onboarding with `--install-daemon`.
- `scripts/e2e/parallels/macos-smoke.ts:873`: exercises a dev update through the package/git update flow.
- `scripts/e2e/parallels/macos-smoke.ts:923`: verifies `openclaw gateway status --deep --require-rpc` after install/update.

### Unit tests

- `apps/macos/Tests/OpenClawIPCTests/RuntimeLocatorTests.swift:16`: accepts a valid Node 22.19 runtime.
- `apps/macos/Tests/OpenClawIPCTests/RuntimeLocatorTests.swift:31`: rejects Node 22.18.9 as unsupported.
- `apps/macos/Tests/OpenClawIPCTests/RuntimeLocatorTests.swift:77`: includes searched paths in failure messages.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:25`: resolves `openclaw` and Node fallback command paths.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:138`: honors preferred command paths.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS install openclaw CLI Node PATH command not found" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #80387: `[Bug]: Openclaw command disappears after brew upgrade installs a new Node major`.
- Other returned issues were broader runtime/channel reports and less directly tied to macOS CLI install.

Query:

```bash
gitcrawl search issues "macOS install openclaw CLI Node PATH command not found" -R openclaw/openclaw --state closed --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "macOS install openclaw command not found"
```

Results:

- Returned a 2026-04-18 recovery thread where a macOS repair left the CLI missing/PATH-broken and the advised recovery was rerunning the installer from Terminal.
- Returned 2026-05-27 macOS packaging discussion around `openclaw-qmd` wrapper build failure.
- Returned 2026-04-22 package/runtime dependency drift after npm global update.
