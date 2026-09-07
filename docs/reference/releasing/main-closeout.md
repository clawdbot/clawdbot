---
summary: "Bringing main to the shipped release state and recovering a failed closeout"
title: "Stable main closeout"
read_when:
  - A stable release published and main must carry the shipped state
  - You are repairing or replaying an evidence-backed stable closeout
  - You are shipping a fallback correction release
---

## Stable main closeout

Stable publication is not complete until `main` carries the actual shipped release state.

1. Start from fresh latest `main`. Audit `release/YYYY.M.PATCH` against it and forward-port real fixes absent from `main`. Do not blindly merge release-only compatibility, test, or validation adapters into newer `main`.
2. For the normal path, set `main` to the shipped stable version. A late closeout may use `main` after it has advanced to a later stable OpenClaw CalVer; do not downgrade an already-started release train solely to close the prior release. The validator still requires the exact shipped changelog section and records the actual `main` version and SHA. It requires the matching appcast entry once the macOS release has published; until then it records `appcast: pending`. Run `pnpm release:prep` after any root version change.
3. Make `CHANGELOG.md`'s `## YYYY.M.PATCH` section on `main` exactly match the tagged release branch. Include the stable `appcast.xml` update when the mac release published one.
4. Do not add `YYYY.M.PATCH+1`, a beta version, or an empty future changelog section to `main` until the operator explicitly starts that release train.
5. Run `pnpm release:generated:check`, `pnpm deps:npm-lock:check`, and `OPENCLAW_TESTBOX=1 pnpm check:changed`. Push, then verify `origin/main` contains the shipped version and changelog before calling the stable release done.
6. Keep the repository variables `RELEASE_ROLLBACK_DRILL_ID` and `RELEASE_ROLLBACK_DRILL_DATE` current after each private rollback drill.

`OpenClaw Stable Main Closeout` starts from the `main` push that carries the shipped version and changelog after stable publication; apps may still be pending. Include the appcast once macOS publishes. It reads immutable postpublish evidence to bind the shipped tag to its Full Release Validation and Publish runs, then verifies the stable main state, release, mandatory stable soak, and blocking performance evidence. It attaches an immutable closeout manifest and checksum to the GitHub release. The manifest records `appPlatforms` with `macos`, `windows`, and `android` each `pending` or `attached`; aggregate `apps` is `attached` only when every required platform asset has a lowercase `sha256:<64hex>` digest. At the first closeout, `appcast` is `pending` unless the full macOS zip/DMG/dSYM asset set is attached with canonical digests; a complete macOS set requires appcast verification and records `verified`. Replay preserves the initial app snapshot and requires every recorded asset name and digest to match exactly. Later canonical app attachments are allowed, while changed or deleted recorded assets and unrelated additions remain errors. Recorded app, recovery, and asset fields remain byte-identical while authoritative release fields are recomputed. When macOS attaches after closeout, replay also checks its entry in the current main appcast; it preserves an appcast already verified at the original closeout. The automatic push trigger skips legacy releases that predate immutable postpublish evidence and never treats that skip as a completed closeout.

A complete closeout requires the closeout manifest asset and its matching checksum. A partial manifest replays its recorded `main` SHA and rollback drill to regenerate identical bytes, then attaches the missing checksum; an invalid pair, or a checksum without a manifest, stays blocking. A push-triggered run without rollback drill repository variables skips without completing closeout; a missing or more-than-90-day-old drill record still blocks manual evidence-backed closeout. Private recovery commands remain in the maintainer-only runbook. Use manual dispatch only to repair or replay an evidence-backed stable closeout.

If the Release Publish parent failed only after immutable npm/plugin evidence was attached, repair and verify the required npm, Docker, and GitHub publication surfaces. A maintainer may then manually dispatch closeout with `allow_failed_publish_recovery=true`; that mode accepts only a completed failed parent and preserves the publication evidence checks. Pending apps do not block recovery; the closeout records their state, and a published macOS release still requires a valid appcast. Automatic push closeout never enables this recovery mode.

A legacy fallback correction tag may reuse base-package evidence only when the correction tag resolves to the same source commit as the base stable tag. Its Android release reuses the base tag's verified APK and adds provenance for the correction tag. A correction with different source must publish and verify its own package evidence and use a higher Android `versionCode`.

For correction artifact preparation, validate the immutable SHA with `--target-ref release/YYYY.M.PATCH-N` before tagging, or the exact `vYYYY.M.PATCH-N` context after tagging. The existing `target_context_ref` workflow input carries the same context. This preserves the intended correction tag in both npm and Docker artifacts; a base-version package is accepted only when `vYYYY.M.PATCH` resolves to that same SHA. The package bytes keep their original version, and publishers still require artifacts sealed for the exact final tag. A base-context Full Release Validation run does not authorize reusing its base-tag publication artifacts for a correction.

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
