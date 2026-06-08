---
title: "iOS app - Gateway Setup and Diagnostics Maturity Note"
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# iOS app - Gateway Setup and Diagnostics Maturity Note

## Summary

The iOS app has a substantial Settings and diagnostics surface: gateway selection, manual host/port/TLS, setup-code and QR intake, camera/location/talk/voice wake toggles, notification state, privacy access rows, discovery logs, Gateway problem banners/details, copyable request IDs/commands, and diagnostics issue counting. Coverage is Experimental because the proof is primarily SwiftUI/source and unit tests, not an end-to-end app walkthrough from first launch to failure recovery. Quality is high Experimental because operator-facing errors and settings are concrete, but archive evidence shows pairing, TLS, permissions, and mobile support still require hands-on maintainer guidance.

## Category Scope

Included in this category:

- Bonjour/local: Bonjour/local and wide-area gateway discovery
- Manual host/port: Manual host/port and QR/setup-code onboarding
- Gateway connect configuration persistence: Gateway connect configuration persistence behavior, status, and operator-visible verification.
- TLS fingerprint trust prompt: TLS fingerprint trust prompt and pinning behavior
- Pairing approval: Pairing approval, device auth/keychain storage, and node+operator session auth
- Pairing/auth diagnostics for users: Pairing/auth diagnostics for users and operators
- Settings tab: Settings tab, Gateway settings, manual networking helpers, QR/setup-code intake, permission toggles and requests, discovery logs, Gateway problem details, diagnostics issue list, notification authorization state, and visible recovery actions

## Features

- Bonjour/local: Bonjour/local and wide-area gateway discovery
- Manual host/port: Manual host/port and QR/setup-code onboarding
- Gateway connect configuration persistence: Gateway connect configuration persistence behavior, status, and operator-visible verification.
- TLS fingerprint trust prompt: TLS fingerprint trust prompt and pinning behavior
- Pairing approval: Pairing approval, device auth/keychain storage, and node+operator session auth
- Pairing/auth diagnostics for users: Pairing/auth diagnostics for users and operators
- Settings tab: Settings tab, Gateway settings, manual networking helpers, QR/setup-code intake, permission toggles and requests, discovery logs, Gateway problem details, diagnostics issue list, notification authorization state, and visible recovery actions

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with `version=0.2.1`, `last_sync_at=2026-05-28T19:09:52.784704Z`, `repository_count=2`, `thread_count=29810`, `open_thread_count=11181`, `cluster_count=18594`, `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`, `api_supported=false`, `github_token_present=false`, and `openai_key_present=true`.
- discrawl: `discrawl status --json` succeeded with `state=current`, `generated_at=2026-05-30T14:10:20Z`, `last_sync_at=2026-05-29T19:27:40Z`, `messages=1487536`, `channels=25831`, `threads=25603`, `embedding_backlog=0`, `database_path=/Users/kevinlin/Library/Application Support/discrawl/discrawl.db`, `database_bytes=8035926016`, `share.remote=git@github.com-personal:openclaw/discord-store.git`, and `share.needs_update=true`.

## Coverage Score

- Score: `Experimental (41%)`
- Positive signals: Unit tests cover settings networking helpers, Gateway status classification, permission request bridge behavior, manual endpoint fallback, capability toggles, and QR/setup-code adjacent connection state. Docs and README provide manual troubleshooting checklists.
- Negative signals: No automated UI walkthrough was found for onboarding, gateway selection, QR scanning, permissions, diagnostics, discovery logs, notification authorization, and recovery after a pairing/TLS/network failure.
- Integration gaps: Need a real-device UI scorecard that starts from first launch, connects via QR and manual host, exercises permission rows, records discovery logs, triggers known Gateway errors, and verifies operator recovery copy.

## Quality Score

- Score: `Experimental (47%)`
- Gitcrawl reports: `iOS settings gateway` found PR #80656 for Swift device-auth compatibility with a live iOS simulator and live per-user Gateway, PR #80802 for iOS settings persistence and hardening, and issue #68581 referencing iOS-style location mode settings. `iOS permissions` found PR #40877 for main-thread warnings in CLLocationManager/SFSpeechRecognizer and several permission-adjacent records.
- Discrawl reports: `iOS settings permissions diagnostics gateway` returned no hits. Broader `iOS app` returned a same-day iOS Alpha support exchange where a `wss://<IP>:28443` QR path was likely failing iOS TLS trust because a bare IP lacked a valid certificate SAN, with guidance to use a real DNS name and valid cert.
- Good qualities: Gateway problems have structured owner/action/docs fields, details sheets copy request IDs and commands, discovery logs are copyable, settings distinguish manual TLS/host/port, and diagnostics count visible reviewer checks.
- Bad qualities: Recovery still depends on expert interpretation of pairing, token, TLS, APNs, Bonjour, and foreground/background constraints; there is not yet a public support promise or fully guided first-run failure flow.
- Excluded from quality: Settings and Gateway unit tests were not used as Quality inputs.

## Completeness Score

- Score: `Experimental (41%)`
- Surface instructions: evaluated against `references/completeness/ios-app.md`.
- Positive signals: archived docs, source, test, Gitcrawl, and Discrawl evidence cover the taxonomy scope for Bonjour/local, Manual host/port, Gateway connect configuration persistence, TLS fingerprint trust prompt, Pairing approval, Pairing/auth diagnostics for users, Settings tab.
- Negative signals: the archived note predated process-version-3 Completeness scoring, so this score is initialized from the same evidence breadth and known-gap record used for the archived Coverage score.
- Missing capability branches: see `## Known Gaps` and `## Evidence` below for the recorded missing branches and operator-visible caveats.

## Known Gaps

- Add an iOS onboarding/settings failure-recovery scorecard with screenshots or logs for QR, manual host, TLS trust, and pairing approval.
- Surface TLS/IP certificate mismatch more directly in app copy.
- Add a single copyable diagnostics export that includes gateway config source, discovery logs, permission states, notification state, and last Gateway problem.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/platforms/ios.md` includes quick start, manual host/port, common errors, debugging checklist, and related docs.
- `/Users/kevinlin/code/openclaw/apps/ios/README.md` includes super-alpha limitations, exact Xcode deployment, APNs setup expectations, known issues, and a debugging checklist.
- `/Users/kevinlin/code/openclaw/docs/channels/pairing.md` documents the recommended pairing path used by iOS.

### Source

- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Design/SettingsProTab.swift` defines settings state for Gateway, manual host/port/TLS, camera, location, Talk, voice wake, diagnostics, QR, and notification status.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Settings/PrivacyAccessSectionView.swift` exposes contacts, calendar, and reminders permission actions.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Gateway/GatewayProblemView.swift` presents structured connection recovery details.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Gateway/GatewayDiscoveryDebugLogView.swift` exposes copyable discovery logs.
- `/Users/kevinlin/code/openclaw/apps/ios/Sources/Status/GatewayStatusBuilder.swift` maps connection state into UI status.

### Integration tests

- No automated iOS settings/onboarding UI e2e artifact was found.
- Manual docs instruct Xcode/local device operation and troubleshooting.

### Unit tests

- `/Users/kevinlin/code/openclaw/apps/ios/Tests/SettingsNetworkingHelpersTests.swift` covers diagnostics issue counting and host/port parsing.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/GatewayStatusBuilderTests.swift` covers paused error status versus transient reconnect status.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/PermissionRequestBridgeTests.swift` covers permission request continuation behavior.
- `/Users/kevinlin/code/openclaw/apps/ios/Tests/GatewayConnectionControllerTests.swift` covers manual endpoint fallback and capability toggles.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "iOS settings gateway" --json`

Results:

- PR #80656 `fix(swift): keep device auth compatible with v2 gateways`.
- PR #80802 `[codex] Harden Talk, Canvas, and add macOS ambient overlay`.
- Issue #68581 `Android node: support location.enabledMode: always`, referencing iOS-style settings.

Additional query context:

- `gitcrawl search openclaw/openclaw --query "iOS permissions" --json` found PR #40877 for main-thread warnings in CLLocationManager and SFSpeechRecognizer.

### Discrawl queries

Query:

`/Users/kevinlin/.local/bin/discrawl search --mode fts --limit 5 "iOS settings permissions diagnostics gateway"`

Results:

- No hits.

Additional query context:

- `discrawl search --mode fts --limit 5 "iOS app"` found a 2026-05-29 iOS Alpha support exchange explaining that a `wss://<IP>:28443` QR path is likely to fail iOS TLS policy without a real DNS name and valid certificate SAN.
