---
title: "Linux companion app - App Distribution Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - App Distribution Maturity Note

## Summary

Linux CLI and Gateway install paths are documented and smoke-tested, but native companion-app packaging is not landed. The active archive record calls out official Windows/Linux companion downloads as an open need, and open Linux PRs explicitly exclude or defer distro artifacts such as `.deb`, `.rpm`, Snap, Flatpak, and AppImage.

## Category Scope

Included in this category:

- Native app package: Native Linux companion-app package availability and installation path.
- Distro package targets: Distro package targets, desktop files, icons, autostart, and update metadata
- Official release metadata: Official release metadata for downstream consoles

## Features

- Native app package: Native Linux companion-app package availability and installation path.
- Distro package targets: Distro package targets, desktop files, icons, autostart, and update metadata
- Official release metadata: Official release metadata for downstream consoles

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (0%)`
- Positive signals: Linux CLI installer smoke exists and docs describe the supported Gateway install path.
- Negative signals: no checked-in Linux companion app installer, package manifest, desktop file, appstream metadata, update feed, or release artifact path exists in the current source tree.
- Integration gaps: no native Linux companion package install/update smoke was found.

## Quality Score

- Score: `Experimental (18%)`
- Gitcrawl reports: issue #81673 is open for official Windows/Linux companion downloads; PR #59859 says it does not add `.deb`, `.rpm`, or Snap artifacts; PR #61576 says there is no Flatpak/deb/AppImage packaging yet.
- Discrawl reports: the packaging-specific searches returned no direct support resolution or release announcement for official Linux companion downloads.
- Good qualities: the current docs do not falsely advertise a Linux app download, and the open issue states downstream packaging acceptance criteria.
- Bad qualities: there is no official packaging target, metadata contract, distro support matrix, update channel, or install UI for a Linux companion app.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (0%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Native app package, Distro package targets, Official release metadata.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Define initial package targets such as Flatpak, AppImage, `.deb`, `.rpm`, or source-build-only.
- Define release metadata and update semantics for docs and downstream consoles.
- Add package verification for install, launch, update, rollback, and uninstall.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:15`: the beginner quick path is Gateway-on-Linux, not a native app install.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:25`: install links are generic CLI/Gateway paths.
- `/Users/kevinlin/code/openclaw/docs/platforms/index.md:42`: service-install guidance covers CLI-managed Gateway services, not Linux companion app packaging.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md:162`: macOS has a native build/dev workflow and app packaging script, showing that native app packaging exists for macOS but not Linux.

### Source

- `find apps -maxdepth 3 -type f \( -name "Package.swift" -o -name "build.gradle.kts" -o -name "package.json" -o -name "*.plist" -o -name "*.desktop" -o -name "*.service" \)` returned Android Gradle files, iOS/macOS plists, Swift packages, and shared packages, but no Linux `.desktop`, appstream, Flatpak, Snap, AppImage, Meson, Cargo, or package manifest in the current checkout.
- `/Users/kevinlin/code/openclaw/package.json` publishes CLI/runtime assets and docs through npm, not native Linux desktop app artifacts.

### Integration tests

- `/Users/kevinlin/code/openclaw/.github/workflows/install-smoke.yml:476`: Rocky Linux installer smoke verifies `install.sh` and `openclaw --version`.
- `/Users/kevinlin/code/openclaw/.github/workflows/install-smoke.yml:485`: Rocky Linux CLI installer smoke verifies `install-cli.sh`, not a companion app.
- No native Linux app package install, desktop launch, update, or uninstall integration test was found.

### Unit tests

- No checked-in Linux app packaging unit tests were found.
- `/Users/kevinlin/code/openclaw/test/scripts/package-mac-app.test.ts:56`: packaging tests exist for the macOS app, illustrating the missing Linux equivalent.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "official companion downloads windows linux" --mode keyword --limit 8 --json`
- `gitcrawl search openclaw/openclaw --query "Linux app AppImage Flatpak Snap tray" --mode keyword --limit 8 --json`
- `gitcrawl gh issue view 81673 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,url`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`
- `gitcrawl gh pr view 61576 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The official-downloads query returned open issue #81673, `Build official OpenClaw companion downloads for Windows and Linux`, plus a broad tracking PR reference.
- The AppImage/Flatpak/Snap query returned no hits.
- Issue #81673 asks for official packaging targets, release artifacts or manifests, support matrix docs, and stable URLs for downstream linking.
- PR #59859 explicitly says distro packaging artifacts such as `.deb`, `.rpm`, and Snap are not included.
- PR #61576 lists no Flatpak/deb/AppImage packaging as a known gap.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "official companion downloads windows linux"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux app AppImage Flatpak Snap tray"`

Results:

- Both packaging-specific searches returned no direct Linux companion app release/download proof.
- Absence of direct release proof is neutral for Quality after freshness checks, but it provides no positive signal for a supported package surface.
