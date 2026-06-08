---
title: "macOS Gateway host - Permissions and Native Capabilities Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS Gateway host - Permissions and Native Capabilities Maturity Note

## Summary

macOS permissions and native node capabilities are implemented, but this is the
weakest component in the macOS Gateway host surface. The app has explicit
permission managers for Accessibility, AppleScript, Screen Recording, audio,
camera, speech, location, notifications, and voice wake. Docs explain the node
capabilities and security stance. The live proof trail is thinner, and archive
evidence shows user-visible gaps around `screen.record` and `system.run`
capability advertising.

## Category Scope

Included in this category:

- macOS TCC permission prompts/status: macOS TCC permission prompts/status for Accessibility, AppleScript, Screen Recording, Microphone, Speech Recognition, Camera, Location, Notifications, and Voice Wake
- Native node capability exposure: Native node capability exposure for screen/canvas/browser/system operations
- system.run policy: system.run policy and local/remote node execution expectations
- Permission-driven support: Permission-driven support and operator diagnostics

## Features

- macOS TCC permission prompts/status: macOS TCC permission prompts/status for Accessibility, AppleScript, Screen Recording, Microphone, Speech Recognition, Camera, Location, Notifications, and Voice Wake
- Native node capability exposure: Native node capability exposure for screen/canvas/browser/system operations
- system.run policy: system.run policy and local/remote node execution expectations
- Permission-driven support: Permission-driven support and operator diagnostics

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (62%)`
- Positive signals: docs, app PermissionManager source, targeted Swift tests, and support docs cover intended permission and capability behavior.
- Negative signals: true macOS TCC flows are difficult to automate, and inspected evidence did not show end-to-end proof for every permission turning into the expected remote node capability.
- Integration gaps: `screen.record`, `system.run.prepare`, exec approvals, and remote node registration need stronger full-stack macOS app-to-Gateway proofs.

## Quality Score

- Score: `Beta (73%)`
- Gitcrawl reports: `macOS node system.run capability screen recording permissions` returned open #57169 for macOS node screen capability advertised while runtime blocks `screen.record`.
- Discrawl reports: `macOS permissions screen recording system.run` returned March and April support threads where users had granted macOS permissions but `system.run` or `system.run.prepare` was missing or rejected.
- Good qualities: the app centralizes permission checks and exposes a permission status map; docs distinguish CLI/headless node host from macOS app node capabilities and call out the security-sensitive nature of `system.run`.
- Bad qualities: capability advertising and permission state can diverge from the runtime's allowlist/policy behavior, making the failure mode hard for operators to reason about.
- Excluded from quality: Coverage-only evidence was considered only in the Coverage score, not in this Quality score.

## Completeness Score

- Score: `Alpha (62%)`
- Surface instructions: evaluated against `references/completeness/macos-gateway-host.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for macOS TCC permission prompts/status, Native node capability exposure, system.run policy, Permission-driven support.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add a live macOS app lane that grants or stubs TCC permissions and proves node capability registration.
- Make `system.run` prerequisites and `system.run.prepare` availability visible in app diagnostics.
- Add a clearer operator distinction between macOS app node mode and CLI/headless node host mode.

## Evidence

### Docs

- `docs/platforms/macos.md:52`: documents node capabilities and local IPC for native macOS operations.
- `docs/platforms/macos.md:77`: documents exec approvals and environment filtering.
- `docs/platforms/mac/remote.md:84`: documents remote permissions and security notes for the macOS app.
- `docs/platforms/macos.md:141`: documents onboarding permissions as part of app setup.

### Source

- `apps/macos/Sources/OpenClaw/PermissionManager.swift:25`: ensures requested permissions.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:54`: handles notification permissions.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:77`: handles AppleScript automation.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:85`: handles Accessibility.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:96`: handles Screen Recording.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:104`: handles Microphone.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:122`: handles Speech Recognition.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:134`: handles Camera.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:152`: handles Location.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:177`: handles Voice Wake permissions.
- `apps/macos/Sources/OpenClaw/PermissionManager.swift:188`: builds permission status map.

### Integration tests

- `scripts/e2e/parallels/macos-smoke.ts:1006`: verifies a macOS agent turn after setup, but does not prove all native node permissions.
- `test/gateway.multi.e2e.test.ts:27`: covers node pairing contracts relevant to remote node capability registration.

### Unit tests

- `apps/macos/Tests/OpenClawIPCTests/PermissionManagerLocationTests.swift:5`: covers Location permission behavior.
- `apps/macos/Tests/OpenClawIPCTests/TailscaleIntegrationSectionTests.swift:49`: verifies app configuration hydration without clobbering existing remote settings, relevant to remote node setup.
- `apps/macos/Tests/OpenClawIPCTests/CommandResolverTests.swift:148`: covers remote SSH command construction for node-oriented remote mode.

### Gitcrawl queries

Query:

```bash
gitcrawl search issues "macOS permissions screen recording accessibility system.run gateway node" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Returned `[]`.

Query:

```bash
gitcrawl search issues "macOS node system.run capability screen recording permissions" -R openclaw/openclaw --state open --json number,title,url,state --limit 5
```

Results:

- Open #57169: `[Bug]: macOS node advertises screen capability but runtime blocks screen.record via platform allowlist`.

### Discrawl queries

Query:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 /Users/kevinlin/.local/bin/discrawl search --limit 5 "macOS permissions screen recording system.run"
```

Results:

- Returned an April 2026 support report where a macOS node re-registered but `system.run` no longer appeared in capabilities despite permissions being granted.
- Returned March 2026 reports where `system.run` or `system.run.prepare` was missing/rejected even with Accessibility, AppleScript, Screen Recording, and exec approval settings configured.
- Returned guidance distinguishing CLI/headless node host command execution from macOS app camera/screen/location capabilities.
