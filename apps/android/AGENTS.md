# Android Release Agent Policy

Root rules still apply. This file adds the Android release guardrails.

## Google Play Releases

- Agent-driven Google Play uploads must use only `pnpm android:release:upload`.
- If `pnpm android:release:upload` exits non-zero, stop immediately and report the failing step.
- After a failed `pnpm android:release:upload`, do not continue with `pnpm android:release:archive`, `pnpm android:release:metadata`, `fastlane android play_store`, `fastlane android metadata`, direct Gradle release artifacts plus Google Play upload commands, Google Play API mutation commands, or mobile release ref recording.
- Do not promote an Android release to production. Production promotion stays manual in Google Play Console unless the user explicitly asks to promote a specific already-prepared release after the failed state has been reported.
- `pnpm android:release:archive` is for local archive validation only. It is not a fallback release path after screenshot, metadata, signing, validation, or upload-lane failure.

## Licenses Screen

- Maintain the Settings-tab Licenses screen when Android app dependencies change.
- Bundled license files live in `apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/`.
- License files must be UTF-8 `.txt` files. Do not add Markdown, HTML, RTF, JSON, XML, or generated notice bundles for this screen.
- The Licenses screen discovers bundled `.txt` files at runtime through `AndroidLicenseNotices`; do not hardcode individual license rows in Compose.
- License rows are ordered alphabetically in code by derived display title, case-insensitive, with filename as the tiebreaker. Do not use numeric filename prefixes for ordering.
- The display title is the license filename without the `.txt` extension.
- Filenames should be plain dependency names, for example `Manrope.txt`; the filename is the row title and must not be shown as a row subtitle.
- Do not add OpenClaw, OpenClaw Foundation, or other first-party/self-owned license entries. The screen is for third-party/open-source dependency acknowledgements.
- When adding, removing, or upgrading Android dependencies, audit whether `apps/android/THIRD_PARTY_LICENSES/openclaw/licenses/` needs updates. Exclude dependencies owned by OpenClaw Foundation from the published license list.
- Keep license detail bodies rendered as verbatim monospace text.
- Keep the Settings `Licenses` section at the bottom of Settings, after `Account`, with a single `Licenses` row and no row subtitle unless product direction changes.
- When changing license loading or presentation, update `apps/android/app/src/test/java/ai/openclaw/app/AndroidLicenseNoticesTest.kt`, then run focused Android validation.
