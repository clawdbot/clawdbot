---
title: "Linux companion app - Desktop Capabilities Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Linux companion app - Desktop Capabilities Maturity Note

## Summary

No supported Linux companion app permission, secret-storage, or sandbox model exists in checked-in docs or source. Existing docs are strong for macOS TCC and generic exec approvals, while open Linux PRs identify security review, TLS/device identity, token persistence, and packaging as unresolved.

## Category Scope

Included in this category:

- Linux desktop permissions: Linux desktop permissions for notifications, microphone, screen, camera, accessibility, portals, and desktop-environment APIs
- Secret storage: Secret storage for Gateway token, device identity, approval socket token, and app settings
- Sandbox/package posture: Sandbox/package posture for Flatpak/Snap/AppImage or system packages
- Linux native node identity: Linux native node identity and capability advertisement
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop tools: Desktop tools such as screen, camera, notifications, Canvas, and local command execution
- Linux native Talk: Linux native Talk, push-to-talk, voice wake, and transcription
- Microphone capture: Microphone capture, screen/camera capture, desktop context sensing, and local media attachment flows
- Native media permissions: Native media permissions and foreground/background behavior

## Features

- Linux desktop permissions: Linux desktop permissions for notifications, microphone, screen, camera, accessibility, portals, and desktop-environment APIs
- Secret storage: Secret storage for Gateway token, device identity, approval socket token, and app settings
- Sandbox/package posture: Sandbox/package posture for Flatpak/Snap/AppImage or system packages
- Linux native node identity: Linux native node identity and capability advertisement
- Host command execution: Host command execution through system.run and related desktop tools.
- Desktop tools: Desktop tools such as screen, camera, notifications, Canvas, and local command execution
- Linux native Talk: Linux native Talk, push-to-talk, voice wake, and transcription
- Microphone capture: Microphone capture, screen/camera capture, desktop context sensing, and local media attachment flows
- Native media permissions: Native media permissions and foreground/background behavior

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (0%)`
- Positive signals: generic exec approval and security docs exist for host execution.
- Negative signals: no Linux app permission prompts, secret storage integration, portal model, sandbox profile, or package permission manifest exists in current source.
- Integration gaps: no Linux companion permission or secrets runtime proof exists.

## Quality Score

- Score: `Experimental (24%)`
- Gitcrawl reports: Linux permission/Secret Service/Wayland/X11 query returned no direct hits; open PR #61576 flags security review, device identity, TLS verification, and token persistence as known gaps.
- Discrawl reports: the same feature query returned no direct Linux companion permission proof.
- Good qualities: current docs avoid claiming Linux permission support and the open PRs openly identify security concerns.
- Bad qualities: there is no public Linux permission map, secret store decision, portal/sandbox posture, desktop-environment compatibility model, or safe fallback semantics.
- Excluded from quality: unit, integration, e2e, live, and real runtime-flow test evidence is excluded from this Quality score.

## Completeness Score

- Score: `Experimental (0%)`
- Surface instructions: evaluated against `references/completeness/linux-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Linux desktop permissions, Secret storage, Sandbox/package posture, Linux native node identity, Host command execution, Desktop tools, Linux native Talk, Microphone capture, Native media permissions.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Decide whether Linux secrets use Secret Service, file-backed encrypted storage, or Gateway config references.
- Define permission prompts and failure codes for notifications, mic, screen, camera, and desktop control.
- Define sandbox/package security expectations before official downloads.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/permissions.md:11`: macOS permission grants are tied to code signature, bundle identifier, and path.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md:16`: macOS app owns Notifications, Accessibility, Screen Recording, Microphone, Speech Recognition, and Automation prompts.
- `/Users/kevinlin/code/openclaw/docs/tools/exec-approvals.md:11`: exec approvals are a companion app / node host guardrail for real-host execution.
- `/Users/kevinlin/code/openclaw/docs/platforms/linux.md:13`: native Linux companion apps are planned, with no Linux permission model documented.

### Source

- No Linux Secret Service, XDG portal, Wayland/X11 permission, Flatpak manifest, Snap confinement, or Linux app sandbox source exists in the current checkout.
- `/Users/kevinlin/code/openclaw/src/infra/exec-approvals.ts` and related files implement generic host exec approvals, not Linux desktop app permissions.

### Integration tests

- No Linux companion permission, secret-storage, portal, or sandbox integration test was found.
- Existing security tests cover generic exec/config behavior and other app platforms.

### Unit tests

- No Linux companion permission or secrets unit tests were found.
- Generic exec approval tests are adjacent, not Linux app proof.

### Gitcrawl queries

Query:

- `gitcrawl search openclaw/openclaw --query "Linux companion permissions Secret Service portal Wayland X11" --mode keyword --limit 8 --json`
- `gitcrawl gh pr view 61576 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`
- `gitcrawl gh pr view 59859 --repo openclaw/openclaw --json number,title,state,author,updatedAt,body,headRefName,baseRefName,url`

Results:

- The feature query returned no hits.
- PR #61576 lists security review needed for device identity handling, TLS verification flow, and token persistence.
- PR #59859 says the Linux companion introduces a new native desktop surface with local runtime context, service state, Gateway connections, config editing, and management mutations; it remains open.

### Discrawl queries

Query:

- `DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --mode hybrid --limit 6 "Linux companion permissions Secret Service portal Wayland X11"`

Results:

- The feature query returned no direct results.
- Absence of direct reports is neutral after freshness checks, but it provides no positive signal for a supported Linux permission or secrets model.
