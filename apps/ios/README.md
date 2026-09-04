# OpenClaw iOS

OpenClaw iOS is the officially released iPhone app. It connects to an OpenClaw Gateway as a `role: node` for chat, voice, approvals, sharing, and device-aware automation.

## Distribution Status

- Public distribution: App Store.
- App Store Connect uploads use the App Store release Fastlane path.
- Local/manual deploy from source via Xcode remains the default development path for app development.

## Support Notes

- UI and onboarding changes ship through normal app releases.
- Some node commands require foreground access because of iOS platform limits.
- Permissions, background behavior, and push delivery are documented below so release and support checks stay explicit.

## Exact Xcode Manual Deploy Flow

1. Prereqs:
   - Xcode 26.x
   - `pnpm`
   - `xcodegen`
   - Apple Development signing set up in Xcode
2. From repo root:

```bash
pnpm install
pnpm ios:open
```

3. In Xcode:
   - Scheme: `OpenClaw`
   - Destination: connected iPhone (recommended for real behavior)
   - Build configuration: `Debug`
   - Run (`Product` -> `Run`)
4. If signing fails on a personal team:
   - Use unique local bundle IDs via `apps/ios/LocalSigning.xcconfig`.
   - Start from `apps/ios/LocalSigning.xcconfig.example`.

Generate without opening Xcode:

```bash
pnpm ios:gen
```

## App Store Release Flow

Prereqs:

- Xcode 26.x
- `pnpm`
- `xcodegen`
- Ruby 3.4.10 and Bundler 2.6.9 (`fastlane` is installed from `apps/ios/Gemfile.lock`)
- Apple account signed into Xcode for the canonical OpenClaw team (`FWJYW4S8P8`)
- Fastlane Apple Developer Portal session for the canonical OpenClaw team when creating bundle IDs or enabling services
- Release-owner access to the encrypted signing repo password (`MATCH_PASSWORD`)
- App Store Connect app already created for `ai.openclawfoundation.app`
- App Store Connect API key set up in Keychain via `scripts/ios-app-store-connect-keychain-setup.sh` when auto-resolving a build number or uploading to App Store Connect

Release behavior:

- Local development uses the canonical `ai.openclawfoundation.app*` bundle IDs when the OpenClaw team is available, and unique `ai.openclawfoundation.app.test.*` bundle IDs only for non-canonical fallback teams.
- App Store release uses canonical `ai.openclawfoundation.app*` bundle IDs through a temporary generated xcconfig in `apps/ios/build/AppStoreRelease.xcconfig`.
- App Store release uses manual `Apple Distribution` signing with profile names pinned in `apps/ios/Config/AppStoreSigning.json`.
- Fastlane owns one-time Developer Portal setup, encrypted `match` signing sync to the repo/branch pinned in `apps/ios/Config/AppStoreSigning.json`, and release handling.
- App Store release also switches the app to `OpenClawPushMode=appStore`, which derives relay transport, official distribution, the canonical production relay, production APNs, production relay profile, `appleStrict` proof, and the App-Attest-capable entitlement file.
- `pnpm ios:release:upload` generates App Store screenshots, archives and validates the IPA, uploads release notes and the rendered `apps/ios/APP-REVIEW-NOTES.md` attachment, uploads the IPA, and waits for Apple processing.
- Agent-driven App Store uploads must use `pnpm ios:release:upload` as the only release path. If that command fails, stop and fix the failing screenshot, metadata, archive, validation, or upload step before trying again.
- Do not treat `pnpm ios:release:archive`, `asc builds upload`, `asc release stage`, `asc publish appstore`, direct Fastlane lanes, or App Store Connect mutation commands as fallback upload paths after `pnpm ios:release:upload` fails.
- The release archive is validated before upload by inspecting the exported IPA's signed entitlements, embedded App Store profile, and push mode. The upload fails if the IPA is not an App Store production relay build.
- App Review submission is manual in App Store Connect. The release lane uploads a build, public metadata, and the App Review PDF attachment, but it does not submit for review or upload the App Store Connect `Notes` field.
- Before submitting a HealthKit-enabled build, the release owner must update the public privacy policy and App Store Connect privacy details for the Health & Fitness aggregates shared with the user's configured AI provider.
- The release flow does not modify `apps/ios/.local-signing.xcconfig` or `apps/ios/LocalSigning.xcconfig`.
- Release uploads derive the gateway from `apps/mobile/version.json` and the App Store revision/build from live App Store Connect state.
- `apps/ios/CHANGELOG.md` is the iOS-only changelog and release-note source.
- The gateway version must use CalVer like `2026.7.2`.
- Gateway `2026.7.2`, App Store revision `1` becomes:
  - `CFBundleShortVersionString = 2026.7.21`
  - `CFBundleVersion = next App Store Connect build number for 2026.7.21`
- Each App Store version has its own build sequence beginning at `1`.
- Local defaults and release planning derive the gateway from `apps/mobile/version.json`; App Store Connect versions and build uploads determine the release revision and build.
- See `apps/ios/VERSIONING.md` for the full workflow.

Relay behavior for App Store builds:

- App Store release builds use the canonical hosted relay at `https://ios-push-relay.openclaw.ai`.
- App Store release builds reject custom relay URL overrides. Future self-hosted relay support should use a separate explicit release path, not the public App Store build lane.

Signing setup commands:

```bash
pnpm ios:release:signing:plan
pnpm ios:release:signing:check
pnpm ios:release:signing:setup
MATCH_PASSWORD=... pnpm ios:release:signing:sync:push
MATCH_PASSWORD=... pnpm ios:release:signing:sync:pull
```

Release-owner secrets:

- App Store Connect API auth uses Keychain for private key material plus non-secret `apps/ios/fastlane/.env` variables.
- The encrypted signing repo password lives outside this repo in the release-owner vault and is exposed locally as `MATCH_PASSWORD`.
- The share sheet requires the Apple Developer App Group in `apps/ios/Config/AppStoreSigning.json` to be associated with both the app and share-extension bundle IDs before App Store profiles are regenerated.
- Relay registration requires the App Attest capability on the main app ID before App Store profiles are regenerated.
- Apple Distribution private keys, certificates, provisioning profiles, and decrypted signing sync output stay under `apps/ios/build/` or Keychain and are gitignored.
- Rotating release signing means refreshing Fastlane `match` assets and pushing a fresh encrypted sync state.

Prepare the generated release xcconfig/project without archiving:

```bash
pnpm ios:release:prepare -- --version 2026.7.2 --revision 1 --build-number 3
```

Archive without upload:

```bash
pnpm ios:release:archive -- --version 2026.7.2 --revision 1
```

This command is for local archive validation only. It is not a fallback upload
path after `pnpm ios:release:upload` fails.

Prepare and finalize the shared mobile release:

```bash
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
```

Review and commit the five cutter outputs, then archive and upload to App Store Connect:

```bash
pnpm ios:release:upload
```

Explicit `--version`, `--revision`, and `--build-number` values are checked
overrides and must match the live plan.

### Maintainer Quick Release Checklist

Use this when a clone is missing local iOS release setup and you want the shortest path to an App Store Connect upload.

1. Confirm Fastlane auth is set up:

```bash
cd apps/ios
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane ios auth_check
```

2. If auth is missing, bootstrap it once on this Mac:

```bash
scripts/ios-app-store-connect-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

This should create `apps/ios/fastlane/.env` with non-secret App Store Connect variables while the private key stays in Keychain.

3. Confirm the App Store Connect app and Apple Developer identifiers/capabilities exist for:
   - `ai.openclawfoundation.app`
   - `ai.openclawfoundation.app.share`
   - `ai.openclawfoundation.app.activitywidget`
   - `ai.openclawfoundation.app.watchkitapp`

   The main app and share extension must both be associated with the App Group pinned in `apps/ios/Config/AppStoreSigning.json`. The main app must also have App Attest enabled.

   Use `pnpm ios:release:signing:setup` for the initial portal setup, then `MATCH_PASSWORD=... pnpm ios:release:signing:sync:push` to publish encrypted Fastlane match assets to the shared private repo.

4. Prepare the shared release, capture the plan, and finalize all five release artifacts:

```bash
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
```

5. Review and commit the five cutter outputs, then upload:

```bash
pnpm ios:release:upload
```

6. If `pnpm ios:release:upload` fails, stop at that failure. Do not archive
   and upload the IPA through another command. Fix the failing release-lane
   step, then rerun `pnpm ios:release:upload`.

7. Expected behavior:
   - Fastlane resolves the gateway, revision, and next build from repository and App Store Connect state
   - validates iOS versioning inputs for that version
   - resolves the next App Store Connect build number for that short version
   - generates deterministic App Store screenshots
   - uploads release notes, screenshots, and the App Review PDF attachment to the editable App Store version
   - generates `apps/ios/build/AppStoreRelease.xcconfig`
   - archives `OpenClaw`
   - validates the exported IPA's push mode, signed entitlements, and embedded App Store profile
   - validates the IPA with Apple, uploads it, and waits for App Store Connect processing
   - leaves App Review submission for a maintainer to complete manually

8. Expected outputs after a successful run:
   - `apps/ios/build/app-store/OpenClaw-<version>.ipa`
   - `apps/ios/build/app-store/OpenClaw-<version>.app.dSYM.zip`
   - Fastlane log line like `Uploaded iOS App Store build: version=<version> short=<short> build=<build>`
   - a complete App Store Connect build-upload record for that version and build

9. If this is a fresh clone on a maintainer machine that already works elsewhere, it is OK to copy the non-secret `apps/ios/fastlane/.env` from another trusted local clone on the same Mac. The Keychain-backed private key remains machine-local and is not stored in the repo.

## iOS Versioning Workflow

- Release gateway version: `apps/mobile/version.json`, with an optional checked `--version` override
- App Store revision and build: deterministic App Store Connect plan
- Local default version: `apps/mobile/version.json`
- iOS-only changelog: `apps/ios/CHANGELOG.md`
- Generated local artifacts:
  - `apps/ios/build/Version.xcconfig`
  - `apps/ios/SwiftSources.input.xcfilelist`
  - temporary Fastlane metadata containing release notes rendered from `apps/ios/CHANGELOG.md`
- Useful commands:

```bash
pnpm ios:version
pnpm ios:version:check
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
pnpm ios:filelist:gen
```

Recommended flow:

### App Store Connect iteration on an existing train

1. Run the shared mobile cutter `--prepare` phase for the selected gateway.
2. Capture `pnpm ios:release:plan -- --json`, then run the cutter `--finalize` phase.
3. Review and commit all five cutter outputs.
4. Run `pnpm ios:release:upload`.
5. Failed, processing, and complete Apple-visible uploads all advance the next numeric build.

### Starting the next App Store revision

1. Select the target gateway version for `apps/mobile/version.json`.
2. Add release notes under `## Unreleased`.
3. Run the shared cutter `--prepare` phase and capture the live iOS plan; released history determines the next revision.
4. Run the cutter `--finalize` phase, review and commit all five outputs, then run `pnpm ios:release:upload`.
5. Keep rerunning the planner-driven upload until the release candidate is ready.

See `apps/ios/VERSIONING.md` for the detailed spec.

## APNs Expectations For Local/Manual Builds

- The app calls `registerForRemoteNotifications()` at launch.
- `apps/ios/Sources/OpenClaw.entitlements` derives `aps-environment` from the active build configuration/signing override.
- App Attest relay builds use `apps/ios/Sources/OpenClawAppAttest.entitlements`; local/direct builds do not require App Attest provisioning.
- APNs token registration to gateway happens only after gateway connection (`push.apns.register`).
- Local/manual Debug builds default to `OpenClawPushMode=localSandbox`, direct APNs registration, and a development `aps-environment` entitlement. Local/manual Release builds default to `OpenClawPushMode=localProduction` and direct production APNs registration.
- Your selected team/profile must support Push Notifications for the app bundle ID you are signing.
- If push capability or provisioning is wrong, APNs registration fails at runtime (check Xcode logs for `APNs registration failed`).
- The gateway host also needs direct APNs auth configured separately with `OPENCLAW_APNS_TEAM_ID`, `OPENCLAW_APNS_KEY_ID`, and either `OPENCLAW_APNS_PRIVATE_KEY_P8` or `OPENCLAW_APNS_PRIVATE_KEY_PATH`.
- Recommended gateway-host storage for the APNs `.p8` file is `~/.openclaw/credentials/apns/AuthKey_<KEYID>.p8` with restrictive permissions, then point `OPENCLAW_APNS_PRIVATE_KEY_PATH` at that file.
- `apps/ios/fastlane/.env` only covers App Store Connect / Fastlane auth; it does not provide gateway APNs credentials for local direct-push testing.
- Debug builds default to sandbox APNs through `OpenClawPushMode=localSandbox`; Release builds default to production APNs through `OpenClawPushMode=localProduction`.

## APNs Expectations For Official Builds

- Official App Store builds register with the external push relay before they publish `push.apns.register` to the gateway.
- The gateway registration for relay mode contains an opaque relay handle, a registration-scoped send grant, relay origin metadata, and installation metadata instead of the raw APNs token.
- The relay registration is bound to the gateway identity fetched from `gateway.identity.get`, so another gateway cannot reuse that stored registration.
- The app persists the relay handle metadata locally so reconnects can republish the gateway registration without re-registering on every connect.
- If the relay base URL changes in a later build, the app refreshes the relay registration instead of reusing the old relay origin.
- App Store release mode uses the internal `production` relay profile, production APNs, App Attest, and a StoreKit app transaction JWS during registration.
- Gateway-side relay sending is configured through `gateway.push.apns.relay.baseUrl` in `openclaw.json`. `OPENCLAW_APNS_RELAY_BASE_URL` remains a temporary env override only.

## Official Build Relay Trust Model

- `iOS -> gateway`
  - The app must pair with the gateway and establish both node and operator sessions.
  - The operator session is used to fetch `gateway.identity.get`.
- `iOS -> relay`
  - The app registers with the relay over HTTPS using App Attest plus a StoreKit app transaction JWS.
  - The relay requires the official App Store distribution path, which is why local
    Xcode/dev installs cannot use the hosted relay.
- `gateway delegation`
  - The app includes the gateway identity in relay registration.
  - The relay returns a relay handle and registration-scoped send grant delegated to that gateway.
- `gateway -> relay`
  - The gateway signs relay send requests with its own device identity.
  - The relay verifies both the delegated send grant and the gateway signature before it sends to
    APNs.
- `relay -> APNs`
  - Production APNs credentials and raw official-build APNs tokens stay in the relay deployment,
    not on the gateway.

This exists to keep the hosted relay limited to genuine OpenClaw official builds and to ensure a
gateway can only send pushes for iOS devices that paired with that gateway.

## What Works Now (Concrete)

- Pairing via QR or setup code flow (`/pair qr` or `/pair`, then `/pair approve` in Telegram).
- Gateway connection via discovery or manual host/port with TLS fingerprint trust prompt.
- One Chat surface for text, realtime voice, dictation, and voice notes through the operator gateway session.
- iOS node commands in foreground: camera snap/clip, screen record, location, contacts, calendar, reminders, photos, motion, local notifications.
- Authenticated background `node.presence.alive` beacons that update gateway last-seen metadata when the app moves between foreground and background, without treating suspended sockets as connected.
- Connected nodes publish CPU count and memory immediately and every 60 seconds through `node.host.stats`, supplying the Control UI Devices meters. iOS reports neither load averages nor disk capacity (Apple's required-reason API policy does not allow sending disk-space values off-device). Reporting stops when the node route disconnects or changes, and iOS suspension can pause updates.
- Share extension deep-link forwarding into the connected gateway session.

## Computer Use Relationship

The iOS app is not a Codex Computer Use backend. Computer Use and `cua-driver mcp` are macOS desktop-control paths; iOS exposes device capabilities as OpenClaw node commands through the gateway. Agents can drive the iPhone camera, screen recorder, location, voice, and other node capabilities with `node.invoke`, subject to iOS foreground/background limits.

## Location Automation Use Case (Testing)

Use this for automation signals ("I moved", "I arrived", "I left"), not as a keep-awake mechanism.

- Product intent:
  - movement-aware automations driven by iOS location events
  - example: arrival/exit geofence, significant movement, visit detection
- Non-goal:
  - continuous GPS polling just to keep the app alive

Test path to include in QA runs:

1. Enable location permission in app:
   - set `Always` permission
   - verify background location capability is enabled in the build profile
2. Background the app and trigger movement:
   - walk/drive enough for a significant location update, or cross a configured geofence
3. Validate gateway side effects:
   - node reconnect/wake if needed
   - expected location/movement event arrives at gateway
   - automation trigger executes once (no duplicate storm)
4. Validate resource impact:
   - no sustained high thermal state
   - no excessive background battery drain over a short observation window

Pass criteria:

- movement events are delivered reliably enough for automation UX
- no location-driven reconnect spam loops
- app remains stable after repeated background/foreground transitions

## Known Issues / Limitations / Problems

- Foreground-first: iOS can suspend sockets in background; reconnect recovery is still being tuned.
- Background command limits are strict: `camera.*`, `screen.*`, and `talk.*` are blocked when backgrounded.
- Background location requires `Always` location permission.
- Pairing/auth errors intentionally pause reconnect loops until a human fixes auth/pairing state.
- Voice Wake and Talk contend for the same microphone; Talk suppresses wake capture while active.
- APNs reliability depends on local signing/provisioning/topic alignment.
- Expect rough UX edges and occasional reconnect churn during active development.

## Current In-Progress Workstream

Automatic wake/reconnect hardening:

- improve wake/resume behavior across scene transitions
- reduce dead-socket states after background -> foreground
- tighten node/operator session reconnect coordination
- reduce manual recovery steps after transient network failures

## Debugging Checklist

1. Confirm build/signing baseline:
   - regenerate project (`xcodegen generate`)
   - verify selected team + bundle IDs
2. In app `Settings -> Gateway`:
   - confirm status text, server, and remote address
   - verify whether status shows pairing/auth gating
3. If pairing is required:
   - run `/pair approve` from Telegram, then reconnect
4. If discovery is flaky:
   - enable `Discovery Debug Logs`
   - inspect `Settings -> Gateway -> Discovery Logs`
5. If network path is unclear:
   - switch to manual host/port + TLS in Gateway Advanced settings
6. In Xcode console, filter for subsystem/category signals:
   - `ai.openclawfoundation.app`
   - `GatewayDiag`
   - `APNs registration failed`
7. Validate background expectations:
   - repro in foreground first
   - then test background transitions and confirm reconnect on return
