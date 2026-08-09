# App Store metadata (Fastlane deliver)

This directory is used by `fastlane deliver` for App Store Connect text metadata.

## Upload public metadata and App Review attachment

```bash
cd apps/ios
APP_STORE_CONNECT_APP_ID=YOUR_APP_STORE_CONNECT_APP_ID \
DELIVER_METADATA=1 fastlane ios metadata release_version:2026.7.2 app_store_revision:1
```

## Release notes and App Review attachment

`pnpm ios:release:upload` uses this mode after local archive validation so the editable App Store version has current release notes and the App Review PDF attachment without rewriting all metadata:

```bash
cd apps/ios
DELIVER_RELEASE_NOTES=1 fastlane ios metadata release_version:2026.7.2 app_store_revision:1
```

## Optional: include screenshots

```bash
cd apps/ios
DELIVER_METADATA=1 DELIVER_SCREENSHOTS=1 fastlane ios metadata release_version:2026.7.2 app_store_revision:1
```

## Auth

The `ios metadata` lane uses App Store Connect API key auth from `apps/ios/fastlane/.env`:

- Keychain-backed (recommended on macOS):
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEYCHAIN_SERVICE` (default: `openclaw-app-store-connect-key`)
  - `APP_STORE_CONNECT_KEYCHAIN_ACCOUNT` (default: current user)
- File/path fallback:
  - `APP_STORE_CONNECT_KEY_ID`
  - `APP_STORE_CONNECT_ISSUER_ID`
  - `APP_STORE_CONNECT_KEY_PATH`

Or set `APP_STORE_CONNECT_API_KEY_PATH`.

## Notes

- Locale files live under `metadata/<locale>/`, for example `metadata/en-US/` and `metadata/sv-SE/`. Each locale directory should use the public metadata filenames consumed by the `ios metadata` lane.
- Release notes are generated from `apps/ios/CHANGELOG.md` into temporary Fastlane metadata during upload; use `pnpm ios:release:plan -- --json` and `pnpm ios:release:cut` to prepare the exact encoded section.
- Do not check in `release_notes.txt` under locale metadata directories; the lane strips copied release-note files and writes the current generated en-US release notes when requested.
- `apps/ios/APP-REVIEW-NOTES.md` is rendered to `apps/ios/build/app-review/APP-REVIEW-NOTES.pdf` and uploaded as the App Review attachment when metadata is uploaded.
- Production release notes require the exact encoded App Store heading, such as `## 2026.7.21`; they do not fall back to the gateway or `## Unreleased` section.
- Generated App Store release notes begin with the associated gateway version.
- The release upload flow uploads release notes, screenshots, and the App Review PDF attachment before the IPA, and never submits for App Review.
- `privacy_url.txt` is set to `https://openclaw.ai/privacy`.
- If app lookup fails in `deliver`, set one of:
  - `APP_STORE_CONNECT_APP_IDENTIFIER` (bundle ID)
  - `APP_STORE_CONNECT_APP_ID` (numeric App Store Connect app ID, e.g. from `/apps/<id>/...` URL)
- App Review submission is manual. Keep review contact, demo account, and the App Store Connect `Notes` field outside this repo and enter them directly in App Store Connect when submitting for review. Do not add `metadata/review_information/notes.txt`; the lane refuses to upload that field.
