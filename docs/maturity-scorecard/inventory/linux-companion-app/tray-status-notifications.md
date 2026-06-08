---
title: "Linux companion app - Tray, Status, and Native Notifications Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Tray, Status, and Native Notifications Maturity Note

## Summary

Tray, status, and notification affordances are central to the macOS companion app and are visible in open Linux app PRs, but none are landed in the current Linux source. The current supported Linux path exposes Gateway status through CLI/browser flows rather than a native Linux status item or notification surface.

## Category Scope

- Linux tray/status item.
- Runtime status row and native notifications.
- Desktop-environment integration for GNOME/KDE/Wayland/X11 tray behavior.
- Adjacent out-of-scope surfaces: browser Control UI status, CLI `openclaw status`, macOS menu bar status.

## Features

- Linux tray/status item: Linux tray/status item behavior, status, and operator-visible verification.
- Runtime status row: Runtime status row and native notifications
- Desktop-environment integration: Desktop-environment integration for GNOME/KDE/Wayland/X11 tray behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (5%)`
- Positive signals: open PR #59859 reports manual tray/status verification on Ubuntu GNOME, and current docs show the expected macOS menu-bar behavior.
- Negative signals: the checked-in source contains no Linux tray helper, status item, notification code, desktop file, or Linux app runtime.
- Integration gaps: no supported Linux tray or notification path can be exercised from the current source checkout.

## Quality Score

- Score: `Experimental (25%)`
- Gitcrawl reports: `Linux tray notifications companion` returned PR #59859, whose body says Ubuntu GNOME tray/status integration exists in that open PR.
- Discrawl reports: the same query returned Windows companion discussion but no supported Linux release proof; issue #75 comments mention Linux shell/status work in contributor branches.
- Good qualities: the open PRs identify Linux tray risk and isolate AppIndicator/GTK helper boundaries.
- Bad qualities: current docs do not explain Linux tray limitations, supported desktop environments, notification permissions, or fallback behavior because there is no supported app yet.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (5%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Linux tray/status item, Runtime status row, Desktop-environment integration.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Land or reject a specific tray architecture for GNOME/KDE/StatusNotifier/AppIndicator behavior.
- Define notification permission behavior and failure modes on desktop Linux.
- Add docs for status icon states, notification routing, and fallback when a tray host is unavailable.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md:15`: macOS companion app shows native notifications and status in the menu bar.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/menu-bar.md`: macOS has a dedicated menu-bar status page; no Linux equivalent page exists.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:13`: Linux companion apps are planned.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/MenuContentView.swift`: macOS has checked-in menu content source; no `apps/linux` menu/tray source exists in the current checkout.
- `find apps -maxdepth 2 -type d` returned no Linux companion app directory.
- `rg --files apps | rg -i "(tray|status|notification|appindicator|gtk|libadwaita|linux)"` found no current Linux app source.

### Integration tests

- No checked-in Linux tray/status/notification integration test was found.
- Adjacent Linux smoke tests are CLI installer tests only, not desktop status UI tests.

### Unit tests

- No Linux tray/status/notification unit test target was found.
- macOS menu/status behavior has app-specific test and source coverage outside this Linux surface.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux tray notifications companion" --mode keyword --limit 8 --json`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`
- `gitcrawl gh pr view 61576 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The feature query returned open PR #59859 with snippets about exercising tray/status, diagnostics, onboarding/readiness, and dashboard surfaces.
- PR #59859 says it adds a private GTK3 Ayatana/AppIndicator tray helper for Ubuntu GNOME tray/status integration.
- PR #61576 lists "No system tray on tiling WMs (StatusNotifierWatcher absent)" as a known gap.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux tray notifications companion"`
- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux Windows Clawdbot Apps issue 75"`

Results:

- The tray/notifications query returned Windows native companion comments and no supported Linux companion release proof.
- The issue #75 query returned Linux app milestone comments about shell parity and status work, but those comments point to contributor issue/PR activity rather than checked-in current source.
