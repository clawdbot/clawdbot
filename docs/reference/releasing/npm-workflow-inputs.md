---
summary: "Operator-controlled inputs for the npm release, publish, and release-check workflows"
title: "NPM workflow inputs"
read_when:
  - You are filling in a release workflow dispatch form
  - You need the dist-tag rules for a version
---

## NPM workflow inputs

`OpenClaw NPM Release` accepts these operator-controlled inputs:

- `tag`: required release tag such as `v2026.4.2`, `v2026.4.2-1`, `v2026.4.2-beta.1`, or `v2026.4.2-alpha.1`; when `preflight_only=true`, it may also be the current full 40-character workflow-branch commit SHA for validation-only preflight
- `preflight_only`: `true` for validation/build/package only, `false` for the real publish path
- `preflight_run_id`: existing successful preflight run id, required on the real publish path so the workflow reuses the prepared tarball instead of rebuilding it
- `full_release_validation_run_id`: successful `Full Release Validation` run id for this tag/SHA, required for real publish. Beta publishes may proceed on preflight alone with a warning, but stable/`latest` promotion still requires it.
- `full_release_validation_run_attempt`: exact positive run attempt paired with `full_release_validation_run_id`; required whenever the run id is provided so reruns cannot change the authorization evidence during publish.
- `release_publish_run_id`: approved `OpenClaw Release Publish` run id; required when this workflow is dispatched by that parent (bot-actor real-publish calls)
- `plugin_npm_run_id`: successful exact-head `Plugin NPM Release` run id; required for a real `extended-stable` core publish
- `npm_dist_tag`: npm target tag for the publish path; accepts `alpha`, `beta`, `latest`, or `extended-stable` and defaults to `beta`. Final patch `33` and later must use `extended-stable`; by default, `extended-stable` rejects earlier patches, and it always rejects non-final tags.
- `bypass_extended_stable_guard`: testing-only boolean, default `false`; with `npm_dist_tag=extended-stable`, bypasses monthly extended-stable eligibility while preserving release identity, artifact, approval, and readback checks.

`Plugin NPM Release` accepts `npm_dist_tag=default` for existing release
behavior or `npm_dist_tag=extended-stable` for the guarded monthly path. The
extended-stable option requires `publish_scope=all-publishable`, an empty
`plugins` input, a final patch at or above `33`, and the canonical
`extended-stable/YYYY.M.33` branch at its exact tip. It never moves plugin
`latest` or `beta`. New package versions receive `extended-stable` atomically
through OIDC trusted publication (`npm publish --tag extended-stable`); this
source workflow does not use token-authenticated `npm dist-tag add`. Retries
skip exact versions already present in npm, then fail closed unless complete
readback confirms that every exact package and `extended-stable` tag converged.

`OpenClaw Release Publish` accepts these operator-controlled inputs:

- `tag`: required release tag; must already exist
- `preflight_run_id`: successful `OpenClaw NPM Release` preflight run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_id`: successful `Full Release Validation` run id; required when `publish_openclaw_npm=true` or `plugin_publish_scope=all-publishable`
- `full_release_validation_run_attempt`: exact positive attempt paired with `full_release_validation_run_id`; required whenever the run id is provided
- `windows_node_tag`: optional exact non-prerelease `openclaw/openclaw-windows-node` release tag for detached Windows promotion after stable GitHub publication; omit both Windows inputs to skip dispatch
- `windows_node_installer_digests`: candidate-approved compact JSON map of the current Windows installer names to pinned `sha256:` digests; required only when `windows_node_tag` is supplied
- `npm_telegram_run_id`: optional successful `NPM Telegram Beta E2E` run id to include in final release evidence
- `npm_dist_tag`: npm target tag for the OpenClaw package, one of `alpha`, `beta`, `latest`, or `extended-stable`
- `publish_docker_only`: beta, regular stable (`latest`), or extended-stable recovery/closeout path. It requires `publish_openclaw_npm=false`, complete preflight and Full Release Validation evidence, then verifies the exact npm package, selected dist-tag, and tarball digest before invoking Docker publication.
- `plugin_publish_scope`: defaults to `all-publishable`; use `selected` only for focused plugin-only repair work with `publish_openclaw_npm=false`
- `plugins`: comma-separated `@openclaw/*` package names when `plugin_publish_scope=selected`
- `publish_openclaw_npm`: defaults to `true`; set `false` only when using the workflow as a plugin-only repair orchestrator
- `release_profile`: release coverage profile used for release evidence summaries; defaults to `from-validation`, which reads it from the validation manifest, or override with `beta`, `stable`, or `full`
- `wait_for_clawhub`: defaults to `false`; set `true` when parent workflow completion must include ClawHub completion. Core npm starts after plugin npm succeeds under either setting.

`OpenClaw Release Checks` accepts these operator-controlled inputs:

- `ref`: branch, tag, or full commit SHA to validate. Secret-bearing checks require the resolved commit to be reachable from an OpenClaw branch or release tag.
- `run_release_soak`: opt into exhaustive live/E2E, Docker release-path, and reported-issue upgrade-survivor soak for beta release checks. It is forced on by `release_profile=stable` and `release_profile=full`.

Rules:

- Regular final and correction versions below patch `33` may publish to either `beta` or `latest`. Final versions at patch `33` or above must publish to `extended-stable`, and correction-suffix versions at that boundary are rejected.
- Beta prerelease tags may publish only to `beta`; alpha prerelease tags may publish only to `alpha`
- For `OpenClaw NPM Release`, full commit SHA input is allowed only when `preflight_only=true`
- `OpenClaw Release Checks` and `Full Release Validation` are always validation-only
- The real publish path must use the same `npm_dist_tag` used during preflight; the workflow verifies that metadata before publish continues

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
