---
title: "Native Windows companion app - Installation and Updates Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Native Windows companion app - Installation and Updates Maturity Note

## Summary

Native Windows has meaningful CLI and Gateway install machinery, including
`install.ps1`, Scheduled Task management, Startup-folder fallback, and Parallels
Windows smoke scripts. None of that is an official packaged Windows companion
app. The app packaging story remains open work, with archive evidence pointing
at official downloads and x64/ARM/WSL combinatorics as unresolved.

## Category Scope

Included in this category:

- Official app download: Official app download or installer path for the native Windows companion app.
- MSI/MSIX/App Installer/winget-style packaging: MSI/MSIX/App Installer/winget-style packaging, signing, update, rollback, uninstall, and desktop entries
- Windows architecture handling for x64: Windows architecture handling for x64 and ARM64
- App release channel: App release channel, architecture handling, and update availability.

## Features

- Official app download: Official app download or installer path for the native Windows companion app.
- MSI/MSIX/App Installer/winget-style packaging: MSI/MSIX/App Installer/winget-style packaging, signing, update, rollback, uninstall, and desktop entries
- Windows architecture handling for x64: Windows architecture handling for x64 and ARM64
- App release channel: App release channel, architecture handling, and update availability.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (5%)`
- Positive signals: native Windows CLI/Gateway install and update flows have a PowerShell installer and Parallels smoke coverage.
- Negative signals: there is no official Windows companion app package, installer target, update channel, release metadata, or desktop integration in current main.
- Integration gaps: no app install/update/uninstall path, package signature, app launch, tray registration, or app upgrade proof exists for this surface.

Coverage labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Coverage measures integration, e2e, live, or real runtime-flow evidence across
the component. Unit tests can provide supporting context but never make a feature covered by
themselves.

## Quality Score

- Score: `Experimental (25%)`
- Gitcrawl reports: `#81673` tracks official Windows/Linux companion downloads; `#73315` proposes a desktop companion MVP but remains open.
- Discrawl reports: maintainer discussion says install is not robust yet and the app has x64/ARM/Windows/WSL combinatorics to manage.
- Good qualities: adjacent native Windows CLI install code is platform-aware and the docs clearly separate native CLI/Gateway from the planned companion app.
- Bad qualities: app packaging ownership, release channel, app signing, and update/uninstall semantics are not defined in the supported repo.
- Excluded from quality: unit, integration, e2e, live, and runtime-flow proof were not used to raise or lower Quality.

Quality labels:

- `Lovable`: 95-100
- `Stable`: 80-95
- `Beta`: 70-80
- `Alpha`: 50-70
- `Experimental`: 0-50

At shared boundaries, choose the higher maturity label.

Quality must not use unit, integration, e2e, live, or real runtime test coverage
as a scoring input.

## Completeness Score

- Score: `Experimental (5%)`
- Surface instructions: evaluated against `references/completeness/native-windows-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Official app download, MSI/MSIX/App Installer/winget-style packaging, Windows architecture handling for x64, App release channel.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- No official Windows companion download or packaging target is present.
- No app signing, app identity, update, rollback, or uninstall contract is documented.
- External/prototype Windows companion work is not folded into the supported release path.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:27-43` documents native Windows CLI/Gateway install status and Scheduled Task fallback caveats.
- `/Users/kevinlin/code/openclaw/docs/install/index.md` documents `install.ps1` for Windows CLI install and identifies native Windows service install as Scheduled Task plus Startup-folder fallback.
- `/Users/kevinlin/code/openclaw/docs/platforms/windows.md:246-249` says there is no Windows companion app yet.

### Source

- `/Users/kevinlin/code/openclaw/scripts/install.ps1` implements the Windows CLI installer and handles Node architecture with `Get-WindowsNodeArchitecture`.
- `/Users/kevinlin/code/openclaw/src/daemon/service.ts:288-300` registers `win32` Gateway service support as a Scheduled Task.
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.ts:45-52` falls back from `schtasks` failures to Startup-folder entries.
- No `apps/windows`, `apps/desktop`, `.msix`, `.appinstaller`, or companion package manifest was found in current main.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels-windows-smoke.sh` drives the Parallels Windows smoke harness for native Windows CLI/Gateway install and update.
- `/Users/kevinlin/code/openclaw/scripts/e2e/parallels/windows-smoke.ts` exercises fresh install, provider config, agent turn, Gateway startup, update, and recovery checks for the CLI/Gateway lane, not an app package.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.install.test.ts`
- `/Users/kevinlin/code/openclaw/src/daemon/schtasks.startup-fallback.test.ts`
- `/Users/kevinlin/code/openclaw/src/infra/windows-install-roots.test.ts`
- No companion app packaging unit tests were found.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "official companion downloads Windows Linux" --json`
- `gitcrawl search openclaw/openclaw --query "Tauri desktop companion Windows Linux" --json`

Results:

- `#81673` open issue: build official OpenClaw companion downloads for Windows and Linux.
- `#73315` open PR: add Tauri v2 desktop companion MVP under `apps/desktop` for Linux/Windows.

### Discrawl queries

Query:

- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "official companion downloads Windows Linux"`
- `/Users/kevinlin/.local/bin/discrawl search --limit 6 "Windows companion pairing install x64 arm WSL"`

Results:

- First query returned no messages.
- Second query returned a `2026-05-06` maintainer message saying the Windows native app goal includes install and settings parity, but pairing and install are not robust and x64/ARM/Windows/WSL combinations remain a concern.
