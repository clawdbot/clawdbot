---
name: release-openclaw-mac
description: "Run or recover OpenClaw macOS release signing, notarization, appcast, and asset promotion."
---

# OpenClaw Mac Release

Use with `$release-openclaw-maintainer`, `$release-openclaw-ci`, `$one-password`, and `$release-private` if it exists when stable macOS assets, release-ops mac preflight, notarization, appcast promotion, or mac release recovery is involved.

## Credentials

- Resolve Peter-owned ASC item refs, key ids, issuer ids, and service-token provenance from `$release-private`.
- Fields: `private_key_p8`, `key_id`, `issuer_id`.
- Stale/revoked key symptom: `xcrun notarytool submit` fails with `HTTP status code: 401. Unauthenticated`.
- Validate candidate ASC credentials with `xcrun notarytool history` before setting GitHub secrets.

## 1Password

- Use `$one-password`: all `op` work inside one persistent tmux session, no secret output.
- Use the service-token guidance from `$release-private` when available.
- If a service token fails, run status-only checks: token present/length and `op whoami`; never print token values.
- If desktop app auth is needed but Touch ID is unavailable, set `OP_BIOMETRIC_UNLOCK_ENABLED=false` for the manual `op account add --signin` path.

## GitHub Secrets

Target release-ops repo environment: `openclaw/releases`, env `mac-release`.

Set only after local notary auth validation:

- `APP_STORE_CONNECT_API_KEY_P8`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

Do not update these from mixed sources. All three ASC fields must come from the same 1Password item.

## Workflow Shape

- `openclaw/openclaw` is the public product repo. Its GitHub Releases page is
  where macOS assets are ultimately attached.
- `openclaw/openclaw` `macos-release.yml` is public handoff validation only.
  It never signs, notarizes, or uploads macOS assets, regardless of
  `preflight_only`.
- `openclaw/releases` is the restricted release-ops repo. Its macOS workflows
  sign, notarize, validate, and promote assets onto the
  `openclaw/openclaw` GitHub release.
- Public release branch may carry mac-only packaging fixes after the stable tag/npm are already live.
- Use `source_ref=release/YYYY.M.PATCH` for release-ops mac preflight/validation when building that branch variation.
- Keep `tag=vYYYY.M.PATCH` pointing at the original stable release commit.
- Real mac publish must reuse:
  - a successful release-ops mac preflight run for the same tag/source SHA
  - a successful release-ops mac validation run for the same tag/source SHA
- Release-ops preflight and real publish enter the protected `mac-release`
  environment in the `build_sign_and_package` job. Operators may be able to
  trigger the workflow while Vincent or another environment reviewer approves
  the paused deployment before signing/notarization/promotion proceeds.
- If preflight source SHA differs from tag SHA, validation must also use the same `source_ref`; promotion rejects mismatched proof.

## Notarization

- OpenClaw uses `scripts/notarize-mac-artifact.sh`.
- `xcrun notarytool submit` should use `--no-s3-acceleration`; accelerated upload can surface misleading 401s even when `notarytool history` succeeds.
- If signing succeeds but notarization fails immediately with 401, check ASC key freshness first.
- If notarization stays in progress for several minutes after key-file write, that is normal Apple wait time; do not edit blindly.

## Dispatch

The public handoff workflow validates the tag, source, build, and package
metadata before publication. It does not require a GitHub release page because
it does not upload assets. Keep this validation before the real publish
workflow; the publisher owns draft creation and final undraft.

Public handoff validation:

```bash
gh workflow run macos-release.yml --repo openclaw/openclaw \
  --ref release/YYYY.M.PATCH \
  -f tag=vYYYY.M.PATCH \
  -f preflight_only=true \
  -f public_release_branch=release/YYYY.M.PATCH
```

- Use the public release branch as the workflow ref so the Actions list displays
  `release/YYYY.M.PATCH`, matching prior stable macOS handoff runs.
- Do not use `--ref main` or `--ref vYYYY.M.PATCH` for this public handoff
  validation. The workflow checks out the tag from the `tag` input internally.

Release-ops preflight:

```bash
gh workflow run openclaw-macos-publish.yml --repo openclaw/releases --ref main \
  -f tag=vYYYY.M.PATCH \
  -f source_ref=release/YYYY.M.PATCH \
  -f preflight_only=true \
  -f smoke_test_only=false \
  -f allow_late_calver_recovery=false \
  -f public_release_branch=release/YYYY.M.PATCH
```

Wait for the run to reach the `mac-release` environment approval if GitHub
pauses it, then get approval from Vincent or another configured environment
reviewer. Record the successful preflight run id.

Release-ops validation for a branch-variation preflight:

```bash
gh workflow run openclaw-macos-validate.yml --repo openclaw/releases --ref main \
  -f tag=vYYYY.M.PATCH \
  -f source_ref=release/YYYY.M.PATCH
```

Record the successful validation run id.

Real publish:

```bash
gh workflow run openclaw-macos-publish.yml --repo openclaw/releases --ref main \
  -f tag=vYYYY.M.PATCH \
  -f preflight_only=false \
  -f smoke_test_only=false \
  -f preflight_run_id=<successful-preflight-run> \
  -f validate_run_id=<successful-validation-run> \
  -f allow_late_calver_recovery=false \
  -f public_release_branch=release/YYYY.M.PATCH
```

Wait for the `mac-release` environment approval again if GitHub pauses the real
publish run before it promotes assets.

- Release-ops `openclaw/releases` publish/validate workflows run from their own
  trusted `main` workflow ref. Real publish has a guard that rejects any other
  workflow ref. That displayed `main` ref is expected; the public OpenClaw
  source is selected by `tag` and optional `source_ref`.

## Verify

- `gh release view vYYYY.M.PATCH --repo openclaw/openclaw` shows zip, dmg, dSYM zip, not draft, not prerelease.
- Public `main` `appcast.xml` points at `OpenClaw-YYYY.M.PATCH.zip`.
- Appcast entry has `sparkle:version`, `sparkle:shortVersionString`, length, and `sparkle:edSignature`.
