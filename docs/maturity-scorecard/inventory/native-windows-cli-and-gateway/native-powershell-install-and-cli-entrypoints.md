---
title: "Native Windows - CLI Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows - CLI Maturity Note

## Summary

Native PowerShell install and CLI entrypoints are implemented and documented,
with a real `install.ps1` path, npm and git install modes, portable Node/Git
fallbacks, PATH repair, `openclaw.cmd` wrapper handling, and a packaged
`openclaw` launcher. The evidence is strongest at source and release-check
definition level. Current native Windows operator signal still shows confusion
around PowerShell versus WSL2, PATH visibility, Scheduled Task behavior, and
Windows-specific startup/update friction.

## Category Scope

Included in this category:

- PowerShell installer: Native Windows install.ps1 hosted installer path and flags.
- Node and package-manager bootstrap: Node, Git, pnpm, npm, and PATH bootstrap for native Windows.
- npm global install: npm global install, git checkout install, and generated openclaw.cmd.
- Packaged CLI launcher: Packaged openclaw CLI launcher, version, and doctor entrypoints.
- Windows command shims: Windows .cmd launcher, PATHEXT, and package-manager shim compatibility.
- openclaw onboard: openclaw onboard and openclaw onboard --non-interactive on native Windows
- Local Gateway config: Local Gateway config, auth choice, gateway token/password SecretRef handling, and local endpoint defaults.
- Daemon install flags: Daemon install flags for native Windows onboarding.
- Native-vs-WSL setup boundary: Setup boundary between native Windows Gateway and the recommended WSL2 path.

## Features

- PowerShell installer: Native Windows install.ps1 hosted installer path and flags.
- Node and package-manager bootstrap: Node, Git, pnpm, npm, and PATH bootstrap for native Windows.
- npm global install: npm global install, git checkout install, and generated openclaw.cmd.
- Packaged CLI launcher: Packaged openclaw CLI launcher, version, and doctor entrypoints.
- Windows command shims: Windows .cmd launcher, PATHEXT, and package-manager shim compatibility.
- openclaw onboard: openclaw onboard and openclaw onboard --non-interactive on native Windows
- Local Gateway config: Local Gateway config, auth choice, gateway token/password SecretRef handling, and local endpoint defaults.
- Daemon install flags: Daemon install flags for native Windows onboarding.
- Native-vs-WSL setup boundary: Setup boundary between native Windows Gateway and the recommended WSL2 path.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Beta (74%)`
- Positive signals: the release-check code defines a native Windows installer
  lane that uses the published `install.ps1` URL, resolves the fresh
  `openclaw.cmd` shim from a new PowerShell shell, runs onboarding, exercises
  managed Gateway lifecycle checks, and then switches to a manual Gateway for
  less flaky runtime checks.
- Negative signals: this audit found test definitions and prior archive
  reports, but did not find or run a fresh end-to-end hosted native Windows
  proof from clean machine through `install.ps1`, `openclaw --version`,
  `openclaw doctor`, and managed Gateway health.
- Integration gaps: the installer lane intentionally skips daemon health during
  installed onboarding on native Windows and uses a manual Gateway fallback for
  later runtime checks, which keeps coverage short of a fully managed native
  Windows proof.

## Quality Score

- Score: `Beta (74%)`
- Gitcrawl reports: direct `install.ps1` and PowerShell PATH queries returned
  no exact issue hits; broader native Windows entrypoint queries returned open
  issues around slow onboarding, gateway probes, startup/status hangs, PATH
  workarounds, and stale Startup-folder fallback.
- Discrawl reports: Windows installer threads show users mixing the Linux/WSL
  installer with native PowerShell, needing `%AppData%\npm` on PATH, hitting
  Git/Node confusion, and receiving repeated guidance that WSL2 remains the
  smoother Windows path.
- Good qualities: docs and source agree on `install.ps1`; the installer has
  explicit PowerShell failure handling, portable Node and MinGit fallback,
  npm/git install modes, safe Windows command-shim execution, user PATH repair,
  and post-install version/doctor/onboarding handoff.
- Bad qualities: the native Windows path is still harder to operate than WSL2,
  the installer has no dedicated verbose flag, and Windows PATH, shell, NTFS,
  and Scheduled Task edge cases remain visible in support and issue archives.
- Excluded from quality: validation breadth is recorded under Coverage and
  Evidence only.

## Completeness Score

- Score: `Beta (74%)`
- Surface instructions: evaluated against `references/completeness/native-windows-cli-and-gateway.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for PowerShell installer, Node and package-manager bootstrap, npm global install, Packaged CLI launcher, Windows command shims, openclaw onboard, Local Gateway config, Daemon install flags, Native-vs-WSL setup boundary.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need a current clean native Windows proof artifact for hosted `install.ps1`
  through `openclaw --version`, `openclaw doctor`, onboarding, managed Gateway
  install, and `openclaw gateway status`.
- Need clearer operator diagnostics for PATH and npm-prefix repair when
  `openclaw` installs but is not discoverable in a new PowerShell session.
- Need a first-class verbose installer switch instead of relying on
  PowerShell tracing.
- Native Windows docs still need to reduce confusion between `install.ps1`,
  WSL2 `install.sh`, CLI-only use, and managed Gateway service use.

## Evidence

### Docs

- Command: `nl -ba /Users/kevinlin/code/openclaw/docs/install/index.md | sed -n '1,190p'`
- Results: `docs/install/index.md:10` documents Node 24 recommended or Node
  22.19+ and says native Windows and WSL2 are supported with WSL2 more stable;
  `docs/install/index.md:26` documents `iwr -useb https://openclaw.ai/install.ps1 | iex`;
  `docs/install/index.md:68` documents npm, pnpm, and bun global install
  options; `docs/install/index.md:151` documents `openclaw --version`,
  `openclaw doctor`, and `openclaw gateway status`.
- Command: `nl -ba /Users/kevinlin/code/openclaw/docs/install/installer.md | sed -n '279,435p'`
- Results: `docs/install/installer.md:279` describes the `install.ps1` flow:
  PowerShell 5+, Node install via winget/Chocolatey/Scoop/portable Node,
  npm/git install modes, PATH updates, Gateway service refresh, best-effort
  doctor, scriptblock failure handling, flags, environment variables, and
  Windows troubleshooting.
- Command: `nl -ba /Users/kevinlin/code/openclaw/docs/platforms/windows.md | sed -n '1,190p'`
- Results: `docs/platforms/windows.md:10` states WSL2 is the more stable path;
  `docs/platforms/windows.md:23` says native Windows CLI flows are improving;
  `docs/platforms/windows.md:29` lists website installer via `install.ps1` and
  local CLI use such as `openclaw --version` and `openclaw doctor`; `docs/platforms/windows.md:40`
  documents Scheduled Task first with Startup-folder fallback.
- Command: `nl -ba /Users/kevinlin/code/openclaw/docs/start/getting-started.md | sed -n '1,70p'`
- Results: `docs/start/getting-started.md:20` repeats WSL2 as recommended for
  the full Windows experience and `docs/start/getting-started.md:40` shows the
  native Windows PowerShell install command.

### Source

- Command: `nl -ba /Users/kevinlin/code/openclaw/scripts/install.ps1 | sed -n '1,1540p'`
- Results: `scripts/install.ps1:5` exposes `-Tag`, `-InstallMethod npm|git`,
  `-GitDir`, `-NoOnboard`, `-NoGitUpdate`, and `-DryRun`; `scripts/install.ps1:151`
  requires Node 22.19+; `scripts/install.ps1:183` puts portable Node under
  `%LOCALAPPDATA%\OpenClaw\deps\portable-node`; `scripts/install.ps1:337`
  tries winget, Chocolatey, Scoop, then portable Node; `scripts/install.ps1:458`
  uses `%LOCALAPPDATA%\OpenClaw\deps\portable-git`; `scripts/install.ps1:619`
  resolves `openclaw.cmd` before `openclaw`; `scripts/install.ps1:704` runs
  Windows command shims from a safe local directory; `scripts/install.ps1:757`
  repairs npm global PATH; `scripts/install.ps1:1060` installs `openclaw`
  globally with npm; `scripts/install.ps1:1137` installs from git, builds, and
  writes `%USERPROFILE%\.local\bin\openclaw.cmd`; `scripts/install.ps1:1262`
  runs `openclaw doctor --non-interactive`; `scripts/install.ps1:1418` reads
  `openclaw --version` before printing success; `scripts/install.ps1:1500`
  starts onboarding unless `-NoOnboard` is set.
- Command: `nl -ba /Users/kevinlin/code/openclaw/openclaw.mjs | sed -n '1,560p'`
- Results: `openclaw.mjs:1` is the packaged Node launcher; `openclaw.mjs:11`
  defines the Node 22.19 floor; `openclaw.mjs:87` includes Windows signal
  handling; `openclaw.mjs:332` prints recovery for unbuilt source installs and
  recommends `npm install -g openclaw@latest`; `openclaw.mjs:448` supports
  precomputed root help before importing the full runtime.
- Command: `nl -ba /Users/kevinlin/code/openclaw/package.json | sed -n '1,36p;1684,1696p;1778,1790p'`
- Results: `package.json:16` maps the `openclaw` bin to `openclaw.mjs`;
  `package.json:1786` defines `test:windows:ci` with Windows-focused command,
  runtime import, process, install-root, and runner checks.
- Command: `nl -ba /Users/kevinlin/code/openclaw/src/daemon/schtasks.ts | sed -n '1,280p'`
- Results: `src/daemon/schtasks.ts:45` defines native Windows fallback
  conditions for Scheduled Task failures; `src/daemon/schtasks.ts:121` builds
  Task Scheduler XML; `src/daemon/schtasks.ts:236` reads back the generated
  task command.

### Integration tests

- Command: `nl -ba /Users/kevinlin/code/openclaw/scripts/openclaw-cross-os-release-checks.ts | sed -n '1122,1185p;1891,1925p;1990,2022p;3824,3833p'`
- Results: `scripts/openclaw-cross-os-release-checks.ts:1122` runs an installed
  Windows browser override import smoke; `scripts/openclaw-cross-os-release-checks.ts:1132`
  runs installed onboarding; `scripts/openclaw-cross-os-release-checks.ts:1142`
  exercises managed Gateway lifecycle after install; `scripts/openclaw-cross-os-release-checks.ts:1161`
  documents the Windows manual Gateway fallback after validating Scheduled Task
  registration; `scripts/openclaw-cross-os-release-checks.ts:1891` verifies the
  fresh Windows shell `openclaw --version` path; `scripts/openclaw-cross-os-release-checks.ts:2016`
  adds `--install-daemon` when the lane requests managed Gateway install;
  `scripts/openclaw-cross-os-release-checks.ts:3828` resolves the published
  native Windows installer URL to `https://openclaw.ai/install.ps1`.
- Command: `nl -ba /Users/kevinlin/code/openclaw/test/openclaw-launcher.e2e.test.ts | sed -n '100,180p;520,570p'`
- Results: `test/openclaw-launcher.e2e.test.ts:136` aligns launcher, runtime
  guard, and package Node floor; `test/openclaw-launcher.e2e.test.ts:539`
  verifies source-install recovery messaging; `test/openclaw-launcher.e2e.test.ts:556`
  verifies source-checkout compile-cache behavior.

### Unit tests

- Command: `nl -ba /Users/kevinlin/code/openclaw/test/scripts/install-ps1.test.ts | sed -n '1,560p'`
- Results: `test/scripts/install-ps1.test.ts:63` covers install.ps1 failure
  handling; `test/scripts/install-ps1.test.ts:91` covers npm install defaults;
  `test/scripts/install-ps1.test.ts:116` covers Windows command shim execution;
  `test/scripts/install-ps1.test.ts:192` covers portable Node fallback;
  `test/scripts/install-ps1.test.ts:232` covers portable Git persistence;
  `test/scripts/install-ps1.test.ts:251` covers repo-pinned pnpm activation and
  git install behavior; `test/scripts/install-ps1.test.ts:349` covers
  interactive onboarding launch.
- Command: `nl -ba /Users/kevinlin/code/openclaw/test/scripts/openclaw-cross-os-release-checks.test.ts | sed -n '612,770p;790,905p'`
- Results: `test/scripts/openclaw-cross-os-release-checks.test.ts:621` covers
  fresh Windows CLI lookup under npm prefix; `test/scripts/openclaw-cross-os-release-checks.test.ts:680`
  serves `scripts/install.ps1` as UTF-8 text; `test/scripts/openclaw-cross-os-release-checks.test.ts:756`
  maps win32 to `install.ps1`; `test/scripts/openclaw-cross-os-release-checks.test.ts:796`
  keeps Windows installer runtime on manual Gateway after managed lifecycle
  checks; `test/scripts/openclaw-cross-os-release-checks.test.ts:838`
  normalizes installed Windows CLI paths to `.cmd`; `test/scripts/openclaw-cross-os-release-checks.test.ts:886`
  wraps installed Windows CLI `.cmd` fallbacks safely.
- Command: `nl -ba /Users/kevinlin/code/openclaw/src/infra/windows-install-roots.test.ts | sed -n '1,260p'`
- Results: `src/infra/windows-install-roots.test.ts:14` rejects invalid Windows
  install roots; `src/infra/windows-install-roots.test.ts:27` prefers HKLM
  registry roots over environment values; `src/infra/windows-install-roots.test.ts:136`
  falls back safely when registry and environment roots are invalid.
- Command: `nl -ba /Users/kevinlin/code/openclaw/test/openclaw-npm-postpublish-verify.test.ts | sed -n '220,278p'`
- Results: `test/openclaw-npm-postpublish-verify.test.ts:241` expects the
  Windows npm shim path to be `<prefix>\openclaw.cmd`; `test/openclaw-npm-postpublish-verify.test.ts:260`
  wraps the Windows installed npm shim through `cmd.exe` without shell mode.

### Gitcrawl queries

Query:

```bash
gitcrawl doctor --json
gitcrawl search issues "install.ps1 Windows PowerShell openclaw version doctor npm global PATH" -R openclaw/openclaw --state open --json number,title,url,state --limit 8
gitcrawl search issues "install.ps1 Windows PowerShell openclaw version doctor npm global PATH" -R openclaw/openclaw --state closed --json number,title,url,state --limit 8
gitcrawl search issues "native Windows installer openclaw command not found PATH Node portable Git" -R openclaw/openclaw --state open --json number,title,url,state --limit 8
gitcrawl search issues "windows openclaw command not found" -R openclaw/openclaw --state open --json number,title,url,state --limit 8
gitcrawl search issues "windows openclaw command not found" -R openclaw/openclaw --state closed --json number,title,url,state --limit 8
gitcrawl search issues "windows gateway schtasks" -R openclaw/openclaw --state open --json number,title,url,state --limit 8
```

Results:

- Freshness command returned the gitcrawl archive state recorded above.
- Exact `install.ps1 Windows PowerShell openclaw version doctor npm global PATH`
  returned `[]` for open and closed issues.
- Exact `native Windows installer openclaw command not found PATH Node portable Git`
  returned `[]` for open issues.
- `windows openclaw command not found` returned 8 open hits, including
  #18985 MSYS/Fish support, #82594 slow Windows onboarding, #79099 gateway
  probe unreachable while health is OK, #82735 stable runtime/spawn error
  codes, #73814 shell installer stdin issue, #76563 doctor repair failure,
  #87353 unrelated destructive operation report, and #86752 WSL2/Docker
  gateway starvation.
- `windows openclaw command not found` returned `[]` for closed issues.
- `windows gateway schtasks` returned 7 open hits: #44559 PowerShell-window
  close disconnects Gateway, #70788 Startup-folder cmd window flash, #84600
  heartbeat cmd window visible, #84001 Windows status hang, #76553 PATH
  workaround plus Gateway restart loop, #87156 doctor update leaves stale
  Startup-folder fallback, and #78571 Telegram connection report.

### Discrawl queries

Query:

```bash
/Users/kevinlin/.local/bin/discrawl status --json
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "install.ps1 Windows PowerShell openclaw version doctor npm global PATH"
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "native Windows installer openclaw command not found PATH Node portable Git"
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows openclaw command not found"
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows install.ps1 WSL2 PowerShell"
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "windows gateway schtasks"
```

Results:

- Freshness command returned the discrawl archive state recorded above.
- Exact install.ps1/PowerShell/PATH and native installer/portable Git queries
  returned no stdout hits.
- `windows openclaw command not found` returned support threads about Windows
  Telegram startup, poor native Windows experience, checking `openclaw --version`
  plus Node/npm versions, adding `%AppData%\npm` to PATH, Git-for-Windows
  recovery, and avoiding `openclaw reset` for PATH/service/config problems.
- `windows install.ps1 WSL2 PowerShell` returned threads where users had run
  the Linux/WSL installer from native PowerShell, were told to use
  `install.ps1` in PowerShell or `install.sh` inside WSL2, and were given
  direct `openclaw.cmd --version` and onboarding commands when PATH was suspect.
- `windows gateway schtasks` returned native Windows summaries for installer,
  onboarding, Scheduled Task startup, console-window polish, update work, and
  concrete Scheduled Task fallback/debug discussions.
