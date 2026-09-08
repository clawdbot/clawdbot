## OpenClaw Android App

OpenClaw Android is the officially released Google Play app. It connects to an OpenClaw Gateway as a companion node for chat, voice, approvals, screen, and device-aware automation.

### App features

- Pair with a Gateway using a QR code, setup code, or manual connection. Gateway credentials are stored encrypted.
- Stream chat replies, choose models and reasoning effort, manage session permissions, and expand task progress. The compact composer keeps one control row; tap the model name for permissions and usage details, or the effort dial for Fast mode. Dictation, voice messages, and Talk are part of Chat, not a separate Voice tab.
- Select agents, pin sessions, and browse available native session catalogs from the sidebar. Connecting creates or adopts a dedicated Android session without resetting its history. Native sessions keep their runtime-owned model: Android shows that ownership instead of offering a model change. New session starts independently of the current native thread. Generic child-session forks and new worktrees are unavailable for those sessions; supported message-level forks remain available.
- Search from Overview or Settings to find settings by their displayed name or category, alongside quick actions and recent threads. Local destinations such as Appearance, Profile, and Licenses work without connecting a Gateway. Back from a settings detail returns to the screen that opened search; Desktop appears only when the connected Gateway supports it.
- Choose a theme family, color mode, accent, and app language in **Settings → Appearance**. Theme and accent edits sync with a connected writable profile. Read-only or unknown-profile edits, including new edits after restarting offline, stay on the device; choose them again after connecting to sync. Already profile-bound edits wait for that profile to reconnect, without discarding or replacing newer device-local choices.
- Configure foreground on-device Voice Wake and Gateway-synced wake words in **Settings → Voice**.
- Use **Settings → OpenClaw** for guided Gateway setup and repair. New replies stay visible at the end of the conversation; scrolling back preserves your reading position until you return or tap **Jump to latest**.
- Enable camera, location, and other phone capabilities through onboarding or Settings. Biometric locking, Gateway/chat notifications, and authenticated background presence are supported.
- View the phone's memory and disk meters on the Control UI Devices page. Connected Android nodes report host resource stats immediately and every 60 seconds; disk meters require an available storage sample and a Gateway that supports host stats.
- Manage installed skills and Gateway-verified ClawHub releases, review Skill Workshop proposals, and inspect or edit automations with the required Gateway access.
- Use the Wear OS companion for sessions, replies, aborts, and realtime Talk through the paired phone without storing Gateway credentials on the watch.

## Open in Android Studio

- Open the folder `apps/android`.

## Session colors

Long-press a row on the **Threads** page and choose **Color**, then select a swatch or **Default** to clear it. The eight colors are red, blue, green, yellow, purple, orange, pink, and cyan. Colored sessions show a narrow leading stripe in the sidebar and Threads page, plus a colored ring around the agent avatar in the open chat header. Unset colors add no indicator. Colors sync through the Gateway and remain visible in the local session cache while offline.

## Foldable layout

With a full-height vertical separator reported by AndroidX WindowManager, the
main app places its sidebar on the reading-direction start plane and the active
page on the other plane. Both use the reported bounds, including off-center
hinges. The sidebar remains visible after selecting a page or session.

Book panes require at least 280 dp for the sidebar, 320 dp for the active page,
and 320 dp of height. Onboarding and layouts without a supported split use the
largest rectangular region clear of separating folds and fully occluding hinges.
Equal regions prefer the top, then the reading-direction start side. Opening
the keyboard does not select a different fallback region for this outer host.
Without an intersecting separator, the app keeps its full-window layout and
modal sidebar.

In Chat, a full-width horizontal separator can place the conversation header,
transcript, and status above the hinge and the same composer below it. Each
usable pane must be at least 320 dp wide. The measured space must fit the complete
header, a transcript band with a complete text line, and status above, with a
complete input line and controls below, accounting for the current font size
and padding.

Layout changes retain the draft, cursor, reader position, and existing local
capture state owners. If keyboard insets or larger text leave too little space,
Chat uses the existing one-region fallback based on the space remaining after
insets, then restores the split when it fits.

Command search and gateway trust prompts retain the single-region host.

Gateway trust, QR scan-error, Replace gateway setup, and Forget gateway prompts
also stay within one safe region. Their complete contents and actions scroll when
space is limited; opening the keyboard does not move them to another region.
If the keyboard covers that region entirely, dismiss the keyboard to reach the
prompt again.

Chat actions and Add attachment (Photos, Videos, Files) menus stay in the safe
region containing their trigger. These popups remain focusable without becoming
keyboard (IME) targets. If folds, insets, or layout changes invalidate an open
menu, it closes without choosing an action. Reopen it explicitly when space
permits; it does not reopen automatically when the layout recovers. Dismissing
the menu does not reset Chat's draft, editor, or reader state.

Chat's Model picker, its Permissions page, Thinking effort, and Background tasks sheets initially
use the largest safe region with usable sheet space, not the trigger's region.
They keep that region while it remains usable. Valid geometry changes retain
the same sheet and local state. An invalid opening closes without selecting an
option and stays closed until explicitly reopened.

Background tasks remains an agent-wide, read-only list and detail view. Safe
layout changes retain the opening and its reading state. Switching Gateway,
agent, or chat closes it; a same-owner disconnect leaves read errors visible
with Refresh available.

Branch-switching sheets and other dialogs, sheets, and popup menus are not
fold-adapted yet.

## Wear OS companion

The `wear` app is a paired-phone companion with the same application ID and signing identity as the phone app. The watch discovers the phone through Wear OS Data Layer, then uses the phone's existing authenticated operator session. It never receives or stores Gateway tokens, passwords, TLS pins, or device-signing identity.

The watch supports agent and session selection, bounded text-only transcript history, streaming reply state, text and voice replies, abort, realtime Talk within the selected session, paired-phone Gateway controls, local reply notifications, theme and automatic-speech settings, and a launch Tile. Realtime Talk streams watch microphone and playback audio over a temporary Wear OS Data Layer channel; it still uses the phone's authenticated Gateway session and closes when the selected phone or Gateway connection changes. A missing Data Layer event sequence or changed phone-process epoch triggers a fresh history request instead of applying uncertain deltas. Agent and Gateway controls are capability-negotiated so an older paired phone remains usable during staggered updates.

```bash
cd apps/android
./gradlew :wear:testDebugUnitTest :wear:assembleDebug :wear:lintDebug :wear:ktlintCheck
```

## Build / Run

Install the repository's Node.js and pnpm dependencies before building. Gradle
builds the shared Mermaid renderer automatically and packages its local assets
with the app; no CDN or Gateway renderer is needed.

```bash
pnpm install
cd apps/android
./gradlew :app:assemblePlayDebug
./gradlew :app:installPlayDebug
./gradlew :app:testPlayDebugUnitTest
cd ../..
pnpm android:release:archive
```

Third-party debug flavor:

```bash
cd apps/android
./gradlew :app:assembleThirdPartyDebug
./gradlew :app:installThirdPartyDebug
./gradlew :app:testThirdPartyDebugUnitTest
```

## Mermaid diagrams

Chat renders completed `mermaid` code blocks inline. Tap a diagram for a
full-screen view with pinch-to-zoom and panning. The corner menu switches to
source or retries a temporary failure, and the copy button copies the original
Mermaid source. Incomplete streaming blocks remain readable code.

The renderer shares its pinned Mermaid version, sandbox, and SVG sanitizer with
the Control UI. Android keeps bounded bitmap previews in memory and retains the
sanitized SVG for zooming. Math and diagrams share the render queue and lifecycle
owner, with separate lazy WebViews and resource limits. See
[`packages/mermaid-renderer`](../../packages/mermaid-renderer/README.md) for the
shared runtime and build contract.

Repository-backed debug Gradle invocations, including `pnpm android:run` and
`pnpm android:screenshots`, stamp the full checkout commit and capture one UTC
build timestamp shared by every debug variant in that invocation. Release
tasks still require explicit `openclawBuildCommit` and
`openclawBuildTimestamp` properties so signed artifacts remain reproducible.

Prepare and finalize Android release metadata through the shared mobile cutter:

```bash
node --import tsx scripts/mobile-release-version.ts --prepare --version 2026.8.2 --write
pnpm ios:release:plan -- --json > /tmp/ios-release-plan.json
node --import tsx scripts/mobile-release-version.ts --finalize --version 2026.8.2 --plan /tmp/ios-release-plan.json --write
pnpm android:version:check
```

Release-owner signing sync:

```bash
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:check
```

The signing sync pulls encrypted Android upload-key assets from the shared `apps-signing` repo and materializes decrypted files under `apps/android/build/release-signing/`.
Standalone release APK verification also requires that key's public certificate SHA-256 fingerprint to match `Config/ReleaseSigning.json`.

Generate phone and Wear OS Google Play screenshots:

```bash
pnpm android:screenshots
```

The screenshot script captures both form factors with retained
`OpenClaw_Screenshots_API36` (Pixel 2) and
`OpenClaw_Wear_Screenshots_API34` (Wear OS Large Round) AVDs. It creates a
missing AVD, boots it headlessly, waits for Android to finish booting, disables
animations, captures the screenshots, then shuts down the emulator it started.
Install the API 36 Google APIs and API 34 Wear OS system images in the local
Android SDK. Use `--form-factor phone|wear` with `--avd` or `--device` to
explicitly capture one form factor from another emulator.

`pnpm android:release:archive` builds signed release artifacts into `apps/android/build/release-artifacts/` and writes `.sha256` checksum files:

- Play build: `openclaw-<version>-play-release.aab`
- Wear build: `openclaw-<version>-wear-release.aab`
- Third-party build: `openclaw-<version>-third-party-release.apk`

`pnpm android:bundle:release` is an alias for the same Fastlane archive lane.

Regular final and correction OpenClaw releases publish the signed third-party APK as `OpenClaw-Android.apk` with a checksum manifest and GitHub Actions provenance. `.github/workflows/android-release.yml` is the only automated GitHub Release upload path. When the tagged Android pin matches the stable release train, `OpenClaw Release Publish` qualifies Android independently and dispatches it after core npm succeeds. A mismatched pin records an explicit skip. Android does not hold npm or GitHub release finalization, so verified APK assets may attach after the release is public.

The protected `android-release` environment supplies `MATCH_PASSWORD`; the repository's read-only GitHub App token checks out encrypted material from `openclaw/apps-signing`. The workflow builds the exact release tag, refuses to replace different existing bytes, and re-downloads the APK for checksum, certificate, and provenance verification.

`pnpm android:release:archive` is for local archive validation only. It is not a
fallback upload path after `pnpm android:release:upload` fails.

Agent-driven Google Play uploads must use `pnpm android:release:upload` as the
only release path. If that command fails, stop and fix the failing screenshot,
metadata, signing, validation, archive, or upload step before trying again. Do
not upload archived artifacts through direct Fastlane lanes, Gradle artifacts,
Google Play API commands, or Play Console mutation commands.

The release lane uploads the phone and Wear bundles in one atomic Google Play
edit. It publishes the phone bundle to `GOOGLE_PLAY_TRACK` and maps the Wear
bundle to the corresponding form-factor track (`wear:<track>`), so the default
internal channel publishes to `internal` and `wear:internal`.

See `apps/android/VERSIONING.md` and `apps/android/fastlane/SETUP.md` for the release workflow.

Prefer `pnpm android:release:archive`, which stamps and validates the full Git commit and one UTC build timestamp before signing. Flavor-specific direct Gradle release tasks must pass the same metadata explicitly:

```bash
cd apps/android
commit="$(git -C ../.. rev-parse HEAD)"
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
./gradlew -PopenclawBuildCommit="$commit" -PopenclawBuildTimestamp="$built_at" :app:bundlePlayRelease
./gradlew -PopenclawBuildCommit="$commit" -PopenclawBuildTimestamp="$built_at" :wear:bundleRelease
./gradlew -PopenclawBuildCommit="$commit" -PopenclawBuildTimestamp="$built_at" :app:bundleThirdPartyRelease
```

## Kotlin Lint + Format

```bash
pnpm android:lint
pnpm android:format
```

Android framework/resource lint (separate pass):

```bash
pnpm android:lint:android
```

Direct Gradle tasks:

```bash
cd apps/android
./gradlew :app:ktlintCheck :benchmark:ktlintCheck :wear:ktlintCheck :wear-shared:ktlintCheck
./gradlew :app:ktlintFormat :benchmark:ktlintFormat :wear:ktlintFormat :wear-shared:ktlintFormat
./gradlew :app:lintPlayDebug :app:lintThirdPartyDebug :wear:lintDebug :wear-shared:lintDebug
```

Set `ANDROID_HOME` to your installed Android SDK, or set `sdk.dir` in the local `apps/android/local.properties` file. For Homebrew's command-line tools, the SDK may be at `/opt/homebrew/share/android-commandlinetools`.

## Macrobenchmark (Startup + Frame Timing)

```bash
cd apps/android
./gradlew :benchmark:connectedDebugAndroidTest
```

Reports are written under:

- `apps/android/benchmark/build/reports/androidTests/connected/`

## Perf CLI (low-noise)

Deterministic startup measurement + hotspot extraction with compact CLI output:

```bash
cd apps/android
./scripts/perf-startup-benchmark.sh
./scripts/perf-startup-hotspots.sh
```

Benchmark script behavior:

- Runs only `StartupMacrobenchmark#coldStartup` (10 iterations).
- Prints median/min/max/COV in one line.
- Writes timestamped snapshot JSON to `apps/android/benchmark/results/`.
- Auto-compares with previous local snapshot (or pass explicit baseline: `--baseline <old-benchmarkData.json>`).

Hotspot script behavior:

- Ensures debug app installed, captures startup `simpleperf` data for `.MainActivity`.
- Prints top DSOs, top symbols, and key app-path clues (Compose/MainActivity/WebView).
- Writes raw `perf.data` path for deeper follow-up if needed.

## Run on a Real Android Phone (USB)

1. On phone, enable **Developer options** + **USB debugging**.
2. Connect by USB and accept the debugging trust prompt on phone.
3. Verify ADB can see the device:

```bash
adb devices -l
```

4. Install + launch debug build:

```bash
pnpm android:install
pnpm android:run
```

If `adb devices -l` shows `unauthorized`, re-plug and accept the trust prompt again.

### USB-only gateway testing (no LAN dependency)

Use `adb reverse` so Android `localhost:18789` tunnels to your laptop `localhost:18789`.

Terminal A (gateway):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

Terminal B (USB tunnel):

```bash
adb reverse tcp:18789 tcp:18789
```

Then open **Settings → Gateway → Manual Gateway** (or **Set up manually** during first-run setup):

- Host: `127.0.0.1`
- Port: `18789`
- Connection security: **Unencrypted**

## Hot Reload / Fast Iteration

This app is native Kotlin + Jetpack Compose.

- For Compose UI edits: use Android Studio **Live Edit** on a debug build (works on physical devices; project `minSdk=31` already meets API requirement).
- For many non-structural code/resource changes: use Android Studio **Apply Changes**.
- For structural/native/manifest/Gradle changes: do full reinstall (`pnpm android:run`).

## Connect / Pair

1. Start the gateway (on your main machine):

```bash
pnpm openclaw gateway --port 18789 --verbose
```

2. In the Android app:

- Follow the first-run connection screen, or open **Settings → Gateway** to change a saved connection.
- Scan a QR code, paste a setup code, or enter the Gateway manually.

Gateway credentials and setup codes are masked and accept paste. The app requests password input with autocorrection disabled; this does not guarantee how a keyboard stores or learns from input.

3. Approve pairing (on the gateway machine):

```bash
openclaw devices list
openclaw devices approve <requestId>
```

More details: `docs/platforms/android.md`.

## Permissions

- Discovery:
  - Android 13+ (`API 33+`): `NEARBY_WIFI_DEVICES`
  - Android 12 and below: `ACCESS_FINE_LOCATION` (required for NSD scanning)
- Location:
  - Both flavors: `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` for foreground checks.
  - Third-party flavor only: `ACCESS_BACKGROUND_LOCATION` plus `FOREGROUND_SERVICE_LOCATION` for user-enabled `Always` checks.
- Foreground service notification (Android 13+): `POST_NOTIFICATIONS`
- Camera:
  - `CAMERA` for `camera.snap` and `camera.clip`
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`

## Google Play Restricted Permissions

As of March 19, 2026, these manifest permissions are the main Google Play policy risk for this app:

- `READ_SMS`
- `SEND_SMS`
- `READ_CALL_LOG`

Why these matter:

- Google Play treats SMS and Call Log access as highly restricted. In most cases, Play only allows them for the default SMS app, default Phone app, default Assistant, or a narrow policy exception.
- Review usually involves a `Permissions Declaration Form`, policy justification, and demo video evidence in Play Console.
- The Play build removes these behind the `play` flavor.
- Photo library access is also removed from the Play build. Use third-party builds for `photos.latest`.

Current OpenClaw Android implication:

- APK / sideload build can keep SMS, Call Log, and recent-photo features.
- Google Play build excludes SMS send/search, Call Log search, and recent-photo access unless the product is intentionally positioned and approved under the relevant policy exception.
- The repo now ships this split as Android product flavors:
  - `play`: removes `READ_SMS`, `SEND_SMS`, `READ_CALL_LOG`, `READ_MEDIA_IMAGES`, `READ_MEDIA_VISUAL_USER_SELECTED`, `READ_EXTERNAL_STORAGE`, and background location; hides SMS, Call Log, Photos, and `Always` location surfaces.
  - Installed-app listing is user controlled. `device.apps` is advertised only after the user enables **Settings > Phone Capabilities > Installed Apps**. The command defaults to launcher-visible apps and does not require `QUERY_ALL_PACKAGES`.
  - `thirdParty`: keeps the full permission set and the existing SMS / Call Log / Photos functionality, and offers explicit `Always` location opt-in through Android settings.

Policy links:

- [Google Play SMS and Call Log policy](https://support.google.com/googleplay/android-developer/answer/10208820?hl=en)
- [Google Play sensitive permissions policy hub](https://support.google.com/googleplay/android-developer/answer/16558241)
- [Android default handlers guide](https://developer.android.com/guide/topics/permissions/default-handlers)

Other Play-restricted surfaces to watch if added later:

- `ACCESS_BACKGROUND_LOCATION`
- `MANAGE_EXTERNAL_STORAGE`
- `QUERY_ALL_PACKAGES`
- `REQUEST_INSTALL_PACKAGES`
- `AccessibilityService`

Reference links:

- [Background location policy](https://support.google.com/googleplay/android-developer/answer/9799150)
- [AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en-GB)
- [Photo and Video Permissions policy](https://support.google.com/googleplay/android-developer/answer/14594990)

## Integration Capability Test (Preconditioned)

This suite assumes setup is already done manually. It does **not** install/run/pair automatically.

Pre-req checklist:

1. Gateway is running and reachable from the Android app.
2. Android app is connected to that gateway and `openclaw nodes status` shows it as paired + connected.
3. App stays unlocked and in foreground for the whole run.
4. Grant runtime permissions for capabilities you expect to pass (camera/mic/location/notification listener/location, etc.).
5. No interactive system dialogs should be pending before test start.
6. Local operator test client pairing is approved. If first run fails with `pairing required`, preview the latest pending request, approve the printed request ID, then rerun:

```bash
openclaw devices list
openclaw devices approve --latest   # preview only; copy the requestId from output
openclaw devices approve <requestId>
```

Run:

```bash
pnpm android:test:integration
```

Optional overrides:

- `OPENCLAW_ANDROID_GATEWAY_URL=ws://...` (default: from your local OpenClaw config)
- `OPENCLAW_ANDROID_GATEWAY_TOKEN=...`
- `OPENCLAW_ANDROID_GATEWAY_PASSWORD=...`
- `OPENCLAW_ANDROID_NODE_ID=...` or `OPENCLAW_ANDROID_NODE_NAME=...`

What it does:

- Reads `node.describe` command list from the selected Android node.
- Invokes advertised non-interactive commands.
- Skips `screen.record` and `talk.ptt.*` in this suite because they require
  interactive capture. Use `apps/android/scripts/voice-e2e.sh` for microphone
  and voice-path proof.
- Asserts command contracts (success or expected deterministic error for safe-invalid calls like `sms.send` and `notifications.actions`).

Common failure quick-fixes:

- `pairing required` before tests start:
  - list pending requests (`openclaw devices list`), then approve with the exact ID (`openclaw devices approve <requestId>`) and rerun.

## Contributions

Maintainer: @obviyus. For issues/questions/contributions, please open an issue or reach out on Discord.
