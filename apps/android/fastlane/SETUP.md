# fastlane setup (OpenClaw Android)

For the standard local setup:

```bash
brew install fastlane
```

For a checksum-locked, reproducible setup:

```bash
cd apps/android
gem install bundler -v 2.6.9
bundle _2.6.9_ install
```

The expected reproducible runtime is recorded in `apps/android/.ruby-version`.
Fastlane and its transitive dependencies are checksum-locked in
`apps/android/Gemfile.lock`. Android release wrappers prefer that bundle when
it is installed. Normal local commands otherwise retain the direct Homebrew
Fastlane and rbenv fallbacks.

Create a Google Play service account JSON key with Google Play Developer API access, then grant that service account access to the OpenClaw app in Play Console.

Recommended local auth:

```bash
GOOGLE_PLAY_JSON_KEY=/absolute/path/to/google-play-service-account.json
```

Optional app targeting:

```bash
GOOGLE_PLAY_PACKAGE_NAME=ai.openclaw.app
```

Android release signing uses the same private `apps-signing` repository and `MATCH_PASSWORD` secret as iOS, but with Android-specific encrypted assets. Pull the shared upload key before release validation:

```bash
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:check
```

The pull command materializes decrypted signing files under `apps/android/build/release-signing/`, which is gitignored. Later Fastlane release commands reload those materialized values and export them to Gradle for the current process.

For the first setup or rotation, provide the Play upload keystore and a local signing properties file, then push encrypted assets to `apps-signing`:

```bash
MATCH_PASSWORD=<signing repo password> \
OPENCLAW_ANDROID_UPLOAD_KEYSTORE=<path-to-upload-keystore.jks> \
OPENCLAW_ANDROID_SIGNING_PROPERTIES=<path-to-android-signing.properties> \
pnpm android:release:signing:sync:push
```

The source signing properties file must contain:

```properties
OPENCLAW_ANDROID_STORE_PASSWORD=<store-password>
OPENCLAW_ANDROID_KEY_ALIAS=<upload-key-alias>
OPENCLAW_ANDROID_KEY_PASSWORD=<key-password>
```

Store the Google Play upload key, not the irreplaceable app signing key, when Play App Signing is enabled.

Validate auth:

```bash
cd apps/android
fastlane android auth_check
```

Use `BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane android auth_check`
when reproducing the protected CI toolchain exactly.

Archive locally without upload:

```bash
pnpm android:release:archive
```

This command is for local archive validation only. It is not a fallback upload
path after `pnpm android:release:upload` fails.

Generate deterministic phone and Wear OS Google Play screenshots:

```bash
pnpm android:screenshots
```

The script creates and boots retained Pixel 2 and Wear OS Large Round AVDs when
needed. Install `system-images;android-36;google_apis;<abi>` and
`system-images;android-34;android-wear;<abi>` first. Use
`--form-factor phone|wear` with `--avd <name>` or `--device <adb-serial>` to
capture one form factor from an explicitly selected emulator.

Upload metadata, release notes, and the Play AAB to the configured Google Play track:

```bash
pnpm android:release:upload
```

## Protected beta CI

`Android Beta Release` is a separate, manual workflow. Dispatch it from trusted
`main` with a canonical `release/YYYY.M.PATCH-mobile` branch and that branch's
exact full commit SHA. The workflow derives the frozen Code SHA from the release
branch and the current trusted Tooling SHA. Every later candidate commit must be
linear and may change only the five generated mobile release metadata files.
All five target files must byte-match regeneration using current trusted tooling
and the frozen Code SHA metadata. Approval of the `android-beta-release`
environment gates all access to signing assets, Google Play credentials, and
immutable release-ref mutation.

Repository/environment secrets required by name:

- `GH_APP_PRIVATE_KEY`
- `MATCH_PASSWORD`
- `GOOGLE_PLAY_JSON_KEY_DATA`

The protected lane uploads the phone AAB to `internal` and the Wear AAB to
`wear:internal` in one Google Play edit, then commits that edit once. The
store-returned phone and Wear version codes are included in the signed release
intent. Intent mode requires the checksum-locked Android bundle and never falls
back to a global or rbenv Fastlane. Production promotion remains manual.

After the committed edit, the workflow records
`refs/openclaw/mobile-releases/android/<version-name>-<phone-version-code>` at
the exact candidate SHA. A failed post-upload recording step may be recovered
with the workflow's `record-only` operation, the original failed run ID, and the
same release ref/SHA tuple. Recovery enters `android-beta-release`, executes
only trusted workflow-SHA tooling, and fails on missing artifacts, replay,
moved refs, mismatched digests, or a conflicting immutable ref.

Direct Fastlane entry point:

```bash
cd apps/android
fastlane android release_upload
```

For the exact protected-CI toolchain:

```bash
BUNDLE_GEMFILE="$PWD/Gemfile" bundle _2.6.9_ exec fastlane android release_upload
```

Use these direct Fastlane entry points only for maintainer debugging when
explicitly requested. Agent-driven releases must use
`pnpm android:release:upload` and stop if it fails.

Release rules:

- `apps/android/version.json` is the pinned Android release version source.
- `apps/android/Config/Version.properties` is generated from that source and read by Gradle.
- `apps/mobile/version.json` is the shared mobile gateway version source.
- `apps/ios/CHANGELOG.md` supplies shared mobile release notes.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is committed by the shared mobile cutter.
- `apps/android/CHANGELOG.md` remains historical Android release documentation and is not a release-preparation input.
- `apps/android/Config/ReleaseSigning.json` pins the encrypted Android signing assets in the shared signing repo.
- `apkCertificateSha256` in that manifest pins the upload certificate accepted for standalone release APKs; rotate it only with the encrypted keystore.
- `MATCH_PASSWORD` enables Fastlane to pull encrypted Android signing assets into `apps/android/build/release-signing/` before release validation or archive builds.
- Supported pinned Android versions use CalVer: `YYYY.M.PATCH`.
- Phone `versionCode` uses `YYYYMMDDNN`, where `NN` is `01` through `49`; the matching Wear APK adds `50` and uses `51` through `99`.
- `scripts/mobile-release-version.ts` is the sole owner that prepares Android version metadata and release notes.
- `pnpm android:version:pin` and `pnpm android:version:sync` are retired release entry points and fail without writing.
- `pnpm android:version:check` validates checked-in Android version artifacts without changing them.
- `pnpm android:release:preflight` validates Google Play auth, Android release signing, committed cutter outputs, release notes, and prints the package/track/version/versionCode that will be uploaded.
- `pnpm android:release:signing:sync:pull` pulls encrypted Android signing assets from `apps-signing`.
- `pnpm android:release:signing:sync:push` creates or refreshes encrypted Android signing assets in `apps-signing`.
- `pnpm android:screenshots` builds and installs the phone and Wear OS debug
  apps, launches deterministic screenshot scenes, and writes Play-ready JPEGs
  to the matching `phoneScreenshots` and `wearScreenshots` metadata folders.
- `pnpm android:release:archive` builds the signed phone Play AAB, Wear AAB, and third-party APK into `apps/android/build/release-artifacts/`.
- `pnpm android:release:upload` commits the phone AAB, Wear AAB, metadata, and screenshots in one Google Play edit across the configured phone and `wear:` form-factor tracks. The default tracks are `internal` and `wear:internal`.
- Stable GitHub Release APK publication is separate from Google Play: `OpenClaw Release Publish` dispatches `.github/workflows/android-release.yml`, whose protected `android-release` environment provides `MATCH_PASSWORD`; the repository GitHub App reads the encrypted signing repo.
- Production promotion remains manual in Google Play Console.
- If `pnpm android:release:upload` fails, agent-driven releases must stop and report the failing step. Do not fall back to `pnpm android:release:archive`, `pnpm android:release:metadata`, direct Fastlane lanes, Gradle release artifacts plus Google Play upload commands, or mobile release ref recording.

Screenshots:

- Android screenshot capture writes Play screenshots under
  `apps/android/fastlane/metadata/android/<locale>/images/phoneScreenshots/`
  and `apps/android/fastlane/metadata/android/<locale>/images/wearScreenshots/`.
- Set `SUPPLY_UPLOAD_SCREENSHOTS=1` to include those screenshots in `fastlane android metadata`.
- Do not commit generated screenshot captures unless they become intentional store metadata assets.
