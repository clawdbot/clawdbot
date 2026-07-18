# OpenClaw Android Versioning

Android release builds use pinned app metadata instead of auto-bumping `build.gradle.kts`.

## Version model

- `apps/android/version.json` is the source of truth.
- `version` is the Play `versionName` and uses CalVer: `YYYY.M.D`.
- `versionCode` uses `YYYYMMDDNN`, where phone build number `NN` is `01` through `49`.
- The matching Wear APK reserves `51` through `99` by adding `50` to the pinned phone `versionCode`; Play requires a unique code per form factor under the shared application ID.
- `apps/android/Config/Version.properties` is generated from `version.json` and read by Gradle.
- `apps/android/CHANGELOG.md` is the Android-only changelog and release-note source.
- `apps/android/fastlane/metadata/android/en-US/release_notes.txt` is generated from the changelog.

Examples:

- `version = 2026.6.2`
- `versionCode = 2026060201`
- matching Wear `versionCode = 2026060251`
- another upload on the same release train: `versionCode = 2026060202`

## Commands

```bash
pnpm android:version
pnpm android:version:check
pnpm android:version:sync
pnpm android:version:pin -- --from-gateway
pnpm android:version:pin -- --version 2026.6.5 --version-code 2026060501
pnpm android:release:signing:plan
MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull
pnpm android:release:preflight
```

## Release-note resolution order

When generating `apps/android/fastlane/metadata/android/en-US/release_notes.txt`, the tooling reads the first available changelog section in this order:

1. exact pinned version, for example `## 2026.6.2`
2. `## Unreleased`

Recommended workflow:

- while iterating on a Google Play release train, keep pending notes under `## Unreleased`
- before the production release, move or copy the final notes under `## <pinned version>` and run sync again

## Release Workflow

1. Pin Android to the intended release version.
2. Run `pnpm android:version:sync`.
3. Update `apps/android/CHANGELOG.md`, then run `pnpm android:version:sync` again if needed.
4. Run `MATCH_PASSWORD=<signing repo password> pnpm android:release:signing:sync:pull` to materialize encrypted Android signing assets from `apps-signing`.
5. Run `pnpm android:release:preflight` to validate Play auth, signing, synced versioning, and release notes.
6. Run `pnpm android:screenshots` to refresh raw Google Play screenshots with the script-managed no-cutout emulator.
7. Run `pnpm android:release:archive` to produce the signed phone Play AAB, Wear AAB, and third-party APK.
8. Run `pnpm android:release:upload` to upload metadata, screenshots, the phone AAB, and the Wear AAB to their phone and `wear:` tracks in one atomic Google Play edit.
9. For a regular final or correction OpenClaw release, let `OpenClaw Release Publish` dispatch the protected `Android Release` workflow. It builds the signed third-party APK from the exact tag and attaches the verified APK, checksum manifest, and GitHub provenance before the release draft can publish. Before tagging a correction with its own package version, increment the pinned `versionCode`; the workflow verifies it is higher than the preceding final or correction APK. A same-commit fallback correction reuses the base release's verified APK and adds provenance for the correction tag.
10. Complete production rollout manually in Google Play Console when needed.

If `pnpm android:release:upload` fails, stop at that failure. Do not continue by
uploading archived artifacts through `pnpm android:release:archive`,
`pnpm android:release:metadata`, direct Fastlane lanes, Gradle release artifacts,
Google Play API mutation commands, or Play Console mutation commands. Fix the
failing release-lane step, then rerun `pnpm android:release:upload`.

The third-party flavor is archived as a signed APK for non-Play distribution. The Play release lane never uploads it. Official GitHub distribution is owned only by `.github/workflows/android-release.yml`, which publishes regular final and correction tags through the protected `android-release` environment as `OpenClaw-Android.apk`.

## Release SHA tracking

Successful Play build uploads create a non-tag Git ref that records the source
commit for the uploaded store build:

```text
refs/openclaw/mobile-releases/android/<versionName>-<versionCode>
```

Example:

```text
refs/openclaw/mobile-releases/android/2026.6.10-2026061008
```

These refs are intentionally outside `refs/tags/*` and `refs/heads/*`. They do
not appear on GitHub release or tag pages, and they do not participate in the
core OpenClaw release machinery.

`pnpm android:release:upload` checks the ref before uploading the Play build and
records it only after the atomic phone and Wear Play edit commits. Existing refs are
immutable: the same ref at the same SHA is accepted, while the same ref at a
different SHA fails. `GOOGLE_PLAY_VALIDATE_ONLY=1` still checks the ref but does
not record it because no Play build is published.

Do not create this ref after a manual fallback upload. The ref is release-lane
evidence, not a repair mechanism for a failed `pnpm android:release:upload` run.

Useful direct commands:

```bash
pnpm mobile:release:preflight -- --platform android --version 2026.6.10 --version-code 2026061008
pnpm mobile:release:resolve -- --platform android --version 2026.6.10 --version-code 2026061008
```

## Signing model

`apps/android/Config/ReleaseSigning.json` pins the Android signing assets in the shared private `apps-signing` repo. The Android pipeline uses the same `MATCH_PASSWORD` release-owner secret as iOS, but the Android files are managed by `scripts/android-release-signing.mjs` instead of Fastlane `match`.

`sync:pull` decrypts the Play upload keystore and Gradle signing properties into `apps/android/build/release-signing/`. That directory is gitignored, and Fastlane exports the materialized values as Gradle project properties for the current release command.

If `MATCH_PASSWORD` is not set, the existing manual Gradle-property signing path still works: provide `OPENCLAW_ANDROID_STORE_FILE`, `OPENCLAW_ANDROID_STORE_PASSWORD`, `OPENCLAW_ANDROID_KEY_ALIAS`, and `OPENCLAW_ANDROID_KEY_PASSWORD` through your local Gradle user properties before running release tasks.

Agent-driven releases must not use those lower-level signing and upload surfaces
to bypass a failed `pnpm android:release:upload` attempt. Report the failing
step and wait for maintainer direction instead.
