---
title: "macOS companion app - Permissions, Privacy, and Tcc Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# macOS companion app - Permissions, Privacy, and Tcc Maturity Note

## Summary

The app has a clear permission model: the signed app owns TCC-facing prompts and reports permission state to agents. It covers Notifications, Accessibility, Screen Recording, Microphone, Speech Recognition, Automation/AppleScript, Camera, and Location. Coverage is Alpha because permission state and settings paths are implemented, but no live TCC prompt matrix was found. Quality is Alpha because the source and docs are thoughtful, yet archive evidence shows TCC scoping, launchd context, and platform allowlist mismatches remain recurring risk.

## Category Scope

- Permission requests, status polling, settings UI, and node permission advertisement.
- TCC persistence, signing requirements, and safe app-owned permission guidance.
- Out of scope: upstream OS bugs and non-macOS permission models.

## Features

- Permission requests: Permission requests, status polling, settings UI, and node permission advertisement
- TCC persistence: TCC persistence, signing requirements, and safe app-owned permission guidance

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Alpha (64%)`
- Positive signals: Docs explain TCC persistence and recovery. Source implements interactive and non-interactive permission checks for all major capabilities and exposes a settings page with refresh/retry behavior. Tests query non-interactive permission status and settings rendering.
- Negative signals: No live signed-app TCC prompt scenario was found. Tests do not prove actual Accessibility, Screen Recording, Speech, Microphone, Camera, Location, Automation, and Notification prompts across clean/rebuilt app identities.
- Integration gaps: Need a signed-app permission matrix across first install, rebuild, app path change, remote mode, node service, and LaunchAgent process context.

## Quality Score

- Score: `Alpha (68%)`
- Gitcrawl reports: Results include issue #69799 about dedicated/bundled Node binary for TCC permission scoping, issue #78049 about launchd-managed Gateway accessing TCC-protected folders, issue #57169 about macOS node advertising screen capability while runtime blocks `screen.record`, and issue #79289 about Automation permission assigned to SSH wrapper.
- Discrawl reports: Discord archive includes #69799 discussion confirming TCC scopes to binary path and #69561 closeout saying the app-owned TCC model is safer. It also includes #71848 SRE note linking launchd, Aqua session, memory pressure, and TCC blocking process spawn.
- Good qualities: Docs strongly warn against granting Accessibility to a generic `node` runtime, source keeps prompts in the app, and permissions are advertised to agents through the node permission map.
- Bad qualities: Permission behavior depends on signing identity, bundle path, process context, LaunchAgent/SSH origin, and platform command allowlists. Users can still hit a "permission granted but command blocked" mismatch.
- Excluded from quality: Unit, integration, e2e, live, and real runtime-flow test coverage was not used to raise or lower Quality.

## Completeness Score

- Score: `Alpha (64%)`
- Surface instructions: evaluated against `references/completeness/macos-companion-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Permission requests, TCC persistence.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Need live TCC prompt proof for all advertised capabilities from the packaged app.
- Need an operator path that distinguishes missing OS permission from Gateway/platform allowlist denial.
- Need release proof that permission grants survive signed rebuilds, updates, and app path stability assumptions.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/mac/permissions.md` documents TCC persistence requirements, signed app identity, Accessibility risk for generic Node, recovery checklist, and files/folders permissions.
- `/Users/kevinlin/code/openclaw/docs/platforms/macos.md` states the app owns TCC prompts and exposes macOS-only tools while reporting a permission map.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/signing.md` ties signing and fixed bundle identity to permission persistence.
- `/Users/kevinlin/code/openclaw/docs/platforms/mac/peekaboo.md` documents permission-aware UI automation through the app bundle.

### Source

- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/PermissionManager.swift` implements permission ensure/status for Notifications, AppleScript, Accessibility, Screen Recording, Microphone, Speech Recognition, Camera, and Location.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/PermissionsSettings.swift` renders summary, per-capability request buttons, refresh behavior, and onboarding restart.
- `/Users/kevinlin/code/openclaw/apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift` builds the node `permissions` map from `PermissionManager.status()`.

### Integration tests

- No full live TCC permission matrix was found.
- Packaging/signing script tests verify signing-related script hygiene but do not exercise macOS permission prompts.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/PermissionManagerTests.swift` covers non-interactive permission helper behavior and status query shape.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/PermissionManagerLocationTests.swift` covers location authorization helper behavior.
- `/Users/kevinlin/code/openclaw/apps/macos/Tests/OpenClawIPCTests/SettingsViewSmokeTests.swift` renders `PermissionsSettings`.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "macOS TCC" --json`

Results:

- Issue #69799 `Ship a dedicated/bundled Node binary so macOS TCC permissions are scoped to OpenClaw only`.
- Issue #78049 `macOS launchd-managed Gateway cannot reliably access TCC-protected folders via CLI tools`.
- Issue #57169 `macOS node advertises screen capability but runtime blocks screen.record via platform allowlist`.
- Issue #79289 `iMessage remote-SSH pattern can fail when macOS assigns Automation permission to sshd-keygen-wrapper`.

Query:

`gitcrawl search openclaw/openclaw --query "screen.record macOS node permissions" --json`

Results:

- Issue #57169 and sister issue #86707 show advertised macOS node capabilities blocked by platform allowlist.
- Issue #83958 reports macOS app node flapping and Gateway invoke timeouts.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "macOS permissions TCC"`

Results:

- 2026-04-25 GitHub mirror comment on #69561 says current main documents the safer app-owned TCC permission model.
- 2026-04-22 GitHub mirror comment on #69799 says TCC scoping to the Node binary is a real security issue.
- 2026-04-26 SRE mirror on #71848 links launchd failure to TCC/Aqua session/process-context problems.
