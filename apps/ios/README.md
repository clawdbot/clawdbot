# OpenClaw iOS (Super Alpha)

This iPhone app is super-alpha and internal-use only. It connects to an OpenClaw Gateway as a `role: node`.

## Distribution Status

- Public distribution: not available.
- Internal beta distribution: local archive + TestFlight upload via Fastlane.
- Local/manual deploy from source via Xcode remains the default development path.

## Super-Alpha Disclaimer

- Breaking changes are expected.
- UI and onboarding flows can change without migration guarantees.
- Foreground use is the only reliable mode right now.
- Treat this build as sensitive while permissions and background behavior are still being hardened.

## Exact Xcode Manual Deploy Flow

1. Prereqs:
   - Xcode 16+
   - `pnpm`
   - `xcodegen`
   - Apple Development signing set up in Xcode
2. From repo root:

```bash
pnpm install
./scripts/ios-configure-signing.sh
cd apps/ios
xcodegen generate
open OpenClaw.xcodeproj
```

3. In Xcode:
   - Scheme: `OpenClaw`
   - Destination: connected iPhone (recommended for real behavior)
   - Build configuration: `Debug`
   - Run (`Product` -> `Run`)
4. If signing fails on a personal team:
   - Use unique local bundle IDs via `apps/ios/LocalSigning.xcconfig`.
   - Start from `apps/ios/LocalSigning.xcconfig.example`.

Shortcut command (same flow + open project):

```bash
pnpm ios:open
```

## Local Beta Release Flow

Prereqs:

- Xcode 16+
- `pnpm`
- `xcodegen`
- `fastlane`
- Apple account signed into Xcode for automatic signing/provisioning
- App Store Connect API key set up in Keychain via `scripts/ios-asc-keychain-setup.sh` when auto-resolving a beta build number or uploading to TestFlight

Release behavior:

- Local development keeps using unique per-developer bundle IDs from `scripts/ios-configure-signing.sh`.
- Beta release uses canonical `ai.openclaw.client*` bundle IDs through a temporary generated xcconfig in `apps/ios/build/BetaRelease.xcconfig`.
- Beta release also switches the app to `OpenClawPushTransport=relay`, `OpenClawPushDistribution=official`, and `OpenClawPushAPNsEnvironment=production`.
- The beta flow does not modify `apps/ios/.local-signing.xcconfig` or `apps/ios/LocalSigning.xcconfig`.
- `apps/ios/version.json` is the pinned iOS release version source.
- `apps/ios/CHANGELOG.md` is the iOS-only changelog and release-note source.
- The pinned iOS version must use CalVer like `2026.4.10`.
- That pinned value becomes:
  - `CFBundleShortVersionString = 2026.4.10`
  - `CFBundleVersion = next TestFlight build number for 2026.4.10`
- Changing the root gateway version does not change the iOS app version until you explicitly pin from the gateway.
- See `apps/ios/VERSIONING.md` for the full workflow.

Required env for beta builds:

- `OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com`
  This must be a plain `https://host[:port][/path]` base URL without whitespace, query params, fragments, or xcconfig metacharacters.

Archive without upload:

```bash
pnpm ios:beta:archive
```

Archive and upload to TestFlight:

```bash
pnpm ios:beta
```

If you need to force a specific build number:

```bash
pnpm ios:beta -- --build-number 7
```

### Maintainer Quick Release Checklist

Use this when a clone is missing local iOS release setup and you want the shortest path to a TestFlight upload.

1. Confirm Fastlane auth is set up:

```bash
cd apps/ios
fastlane ios auth_check
```

2. If auth is missing, bootstrap it once on this Mac:

```bash
scripts/ios-asc-keychain-setup.sh \
  --key-path /absolute/path/to/AuthKey_XXXXXXXXXX.p8 \
  --issuer-id YOUR_ISSUER_ID \
  --write-env
```

This should create `apps/ios/fastlane/.env` with the non-secret ASC variables while the private key stays in Keychain.

3. Set the official/TestFlight relay URL for the build:

```bash
export OPENCLAW_PUSH_RELAY_BASE_URL=https://relay.example.com
```

4. If you are starting a brand-new production release train, pin iOS to the current gateway version first:

```bash
pnpm ios:version:pin -- --from-gateway
```

5. Upload the beta:

```bash
pnpm ios:beta
```

6. Expected behavior:
   - Fastlane reads `apps/ios/version.json`
   - verifies synced iOS versioning artifacts
   - resolves the next TestFlight build number for that short version
   - generates `apps/ios/build/BetaRelease.xcconfig`
   - archives `OpenClaw`
   - uploads the IPA to TestFlight

7. Expected outputs after a successful run:
   - `apps/ios/build/beta/OpenClaw-<version>.ipa`
   - `apps/ios/build/beta/OpenClaw-<version>.app.dSYM.zip`
   - Fastlane log line like `Uploaded iOS beta: version=<version> short=<short> build=<build>`

8. If this is a fresh clone on a maintainer machine that already works elsewhere, it is OK to copy the non-secret `apps/ios/fastlane/.env` from another trusted local clone on the same Mac. The Keychain-backed private key remains machine-local and is not stored in the repo.

## iOS Versioning Workflow

- Pinned iOS release version: `apps/ios/version.json`
- iOS-only changelog: `apps/ios/CHANGELOG.md`
- Generated checked-in artifacts:
  - `apps/ios/Config/Version.xcconfig`
  - `apps/ios/fastlane/metadata/en-US/release_notes.txt`
- Useful commands:

```bash
pnpm ios:version
pnpm ios:version:check
pnpm ios:version:sync
pnpm ios:version:pin -- --from-gateway
pnpm ios:version:pin -- --version 2026.4.10
```

Recommended flow:

### TestFlight iteration on an existing train

1. Keep `apps/ios/version.json` pinned to the current train version.
2. Update `apps/ios/CHANGELOG.md`, usually under `## Unreleased` while iterating.
3. Run `pnpm ios:version:sync` after changelog changes.
4. Upload more TestFlight builds with `pnpm ios:beta`.
5. Let Fastlane bump only the numeric build number.

### Starting the next production release train

1. Pin iOS to the current gateway version:

```bash
pnpm ios:version:pin -- --from-gateway
```

2. Update `apps/ios/CHANGELOG.md` for the new release as needed.
3. Run `pnpm ios:version:sync`.
4. Submit the first TestFlight build for that newly pinned version.
5. Keep iterating on that same version until the release candidate is ready.

See `apps/ios/VERSIONING.md` for the detailed spec.

## APNs Expectations For Local/Manual Builds

- The app calls `registerForRemoteNotifications()` at launch.
- `apps/ios/Sources/OpenClaw.entitlements` sets `aps-environment` to `development`.
- APNs token registration to gateway happens only after gateway connection (`push.apns.register`).
- Local/manual builds default to `OpenClawPushTransport=direct` and `OpenClawPushDistribution=local`.
- Your selected team/profile must support Push Notifications for the app bundle ID you are signing.
- If push capability or provisioning is wrong, APNs registration fails at runtime (check Xcode logs for `APNs registration failed`).
- The gateway host also needs direct APNs auth configured separately with `OPENCLAW_APNS_TEAM_ID`, `OPENCLAW_APNS_KEY_ID`, and either `OPENCLAW_APNS_PRIVATE_KEY_P8` or `OPENCLAW_APNS_PRIVATE_KEY_PATH`.
- Recommended gateway-host storage for the APNs `.p8` file is `~/.openclaw/credentials/apns/AuthKey_<KEYID>.p8` with restrictive permissions, then point `OPENCLAW_APNS_PRIVATE_KEY_PATH` at that file.
- `apps/ios/fastlane/.env` only covers App Store Connect / Fastlane auth; it does not provide gateway APNs credentials for local direct-push testing.
- Debug builds default to `OpenClawPushAPNsEnvironment=sandbox`; Release builds default to `production`.

## APNs Expectations For Official Builds

- Official/TestFlight builds register with the external push relay before they publish `push.apns.register` to the gateway.
- The gateway registration for relay mode contains an opaque relay handle, a registration-scoped send grant, relay origin metadata, and installation metadata instead of the raw APNs token.
- The relay registration is bound to the gateway identity fetched from `gateway.identity.get`, so another gateway cannot reuse that stored registration.
- The app persists the relay handle metadata locally so reconnects can republish the gateway registration without re-registering on every connect.
- If the relay base URL changes in a later build, the app refreshes the relay registration instead of reusing the old relay origin.
- Relay mode requires a reachable relay base URL and uses App Attest plus a StoreKit app transaction JWS during registration.
- Gateway-side relay sending is configured through `gateway.push.apns.relay.baseUrl` in `openclaw.json`. `OPENCLAW_APNS_RELAY_BASE_URL` remains a temporary env override only.

## Official Build Relay Trust Model

- `iOS -> gateway`
  - The app must pair with the gateway and establish both node and operator sessions.
  - The operator session is used to fetch `gateway.identity.get`.
- `iOS -> relay`
  - The app registers with the relay over HTTPS using App Attest plus a StoreKit app transaction JWS.
  - The relay requires the official production/TestFlight distribution path, which is why local
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

- Pairing via setup code flow (`/pair` then `/pair approve` in Telegram).
- Gateway connection via discovery or manual host/port with TLS fingerprint trust prompt.
- Chat + Talk surfaces through the operator gateway session.
- iPhone node commands in foreground: camera snap/clip, canvas present/navigate/eval/snapshot, screen record, location, contacts, calendar, reminders, photos, motion, local notifications.
- Share extension deep-link forwarding into the connected gateway session.

## Computer Use Relationship

The iOS app is not a Codex Computer Use backend. Computer Use and `cua-driver mcp` are macOS desktop-control paths; iOS exposes device capabilities as OpenClaw node commands through the gateway. Agents can drive the iPhone canvas, camera, screen, location, voice, and other node capabilities with `node.invoke`, subject to iOS foreground/background limits.

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
- Background command limits are strict: `canvas.*`, `camera.*`, `screen.*`, and `talk.*` are blocked when backgrounded.
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
   - `ai.openclaw.ios`
   - `GatewayDiag`
   - `APNs registration failed`
7. Validate background expectations:
   - repro in foreground first
   - then test background transitions and confirm reconnect on return
