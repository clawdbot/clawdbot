---
summary: "Release version formats, git tags, npm dist-tags, and the beta-first cadence"
title: "Version naming and cadence"
read_when:
  - You need the exact version and tag format for a release
  - You need to know which npm dist-tag a version may publish to
  - You want the branch and cadence rules before cutting a release
---

## Version naming

- Monthly Gateway extended-stable release version: `YYYY.M.PATCH`, with `PATCH >= 33`, git tag `vYYYY.M.PATCH`
- Daily/regular final release version: `YYYY.M.PATCH`, with `PATCH < 33`, git tag `vYYYY.M.PATCH`
- Regular fallback correction release version: `YYYY.M.PATCH-N`, git tag `vYYYY.M.PATCH-N`
- Beta prerelease version: `YYYY.M.PATCH-beta.N`, git tag `vYYYY.M.PATCH-beta.N`
- Alpha prerelease version: `YYYY.M.PATCH-alpha.N`, git tag `vYYYY.M.PATCH-alpha.N`
- Never zero-pad month or patch
- `PATCH` is a sequential monthly release-train number, not a calendar day. Regular final and beta releases advance the current train; alpha-only tags never consume or advance the beta/regular patch number, so ignore legacy alpha-only tags with higher patch numbers when selecting a beta or regular train.
- Alpha/nightly builds use the next unreleased patch train and increment only `alpha.N` for repeated builds. Once that patch has a beta, new alpha builds move to the following patch.
- npm versions are immutable: never delete, republish, or reuse a published tag. Cut the next prerelease number or the next monthly patch instead.
- `latest` continues to follow the current regular/daily npm line; `beta` is the current beta install target
- `extended-stable` means the supported trailing-month Gateway distribution, beginning at patch `33`; patch `34` and later are maintenance releases on that monthly line
- Regular final and regular correction releases publish to npm `beta` by default; release operators can target `latest` explicitly, or promote a vetted beta build later
- Gateway extended-stable publishes core, every npm-publishable official plugin,
  and its Docker images at one exact version; see the dedicated
  [Extended-stable monthly release](/reference/releasing/extended-stable) workflow.
- Regular final releases publish the npm package first and finalize the GitHub release after npm and Docker verification. macOS, signed Windows Hub installers, and the signed standalone Android APK publish independently in parallel or afterward; app readiness never delays npm or GitHub publication. Verify each native release separately before announcing all platforms complete. Beta releases normally validate and publish the npm/package path first, with native app build/sign/notarize/promote reserved for regular final unless explicitly requested.

## Release cadence

- Releases move beta-first; stable follows only after the latest beta is validated
- Maintainers normally cut releases from a `release/YYYY.M.PATCH` branch created from current `main`, so release validation and fixes do not block new development on `main`
- If a beta tag has been pushed or published and needs a fix, maintainers cut the next `-beta.N` tag instead of deleting or recreating the old one
- Detailed release procedure, approvals, credentials, and recovery notes are maintainer-only

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
