---
summary: "The orchestrated eight-step regular stable release sequence and dist-tag promotion"
title: "Beta and latest release sequence"
read_when:
  - You are cutting a regular orchestrated stable release
  - You need to promote a stable version from beta to latest
---

## Regular beta/latest stable release sequence

This legacy sequence is for the regular orchestrated release that also owns plugins, GitHub Release, Windows, and other platform work. It is not the monthly `.33+` Gateway extended-stable path documented in [Extended-stable monthly release](/reference/releasing/extended-stable).

When cutting a regular orchestrated stable release:

1. Run `OpenClaw NPM Release` with `preflight_only=true`. Before a tag exists, you may use the current full workflow-branch commit SHA for a validation-only dry run of the preflight workflow.
2. Choose `npm_dist_tag=beta` for the normal beta-first flow, or `latest` only when you intentionally want a direct stable publish.
3. Run `Full Release Validation` on the release branch, release tag, or full commit SHA when you want normal CI plus live prompt cache, Docker, QA Lab, Matrix, and Telegram coverage from one manual workflow. If you intentionally only need the deterministic normal test graph, run the manual `CI` workflow on the release ref instead.
4. Optionally select the exact non-prerelease `openclaw/openclaw-windows-node` release tag whose signed x64 and ARM64 installers should attach after publication. Save it as `windows_node_tag`, with the validated `windows_node_installer_digests` map. The release-candidate helper records both when given `--windows-node-tag`; omit the option if Windows is not ready.
5. Save the successful `preflight_run_id`, `full_release_validation_run_id`, and exact `full_release_validation_run_attempt`.
6. Run `OpenClaw Release Publish` from the protected `release-publish/<sha12>-<epoch>` tooling tag with the same `tag`, the same `npm_dist_tag`, the optional Windows input pair, the saved `preflight_run_id`, `full_release_validation_run_id`, and `full_release_validation_run_attempt`. It starts plugin npm and ClawHub in parallel, then promotes the prepared OpenClaw npm package once plugin npm succeeds. GitHub finalization waits for npm and Docker evidence; apps attach independently afterward.
7. If the release landed on `beta`, use the `openclaw/releases/.github/workflows/openclaw-npm-dist-tags.yml` workflow to promote that stable version from `beta` to `latest`.
8. If the release intentionally published directly to `latest` and `beta` should follow the same stable build immediately, use that same release workflow to point both dist-tags at the stable version, or let its scheduled self-healing sync move `beta` later.

The dist-tag mutation lives in the release ledger repo because it still requires `NPM_TOKEN`, while the source repo keeps OIDC-only publish. That keeps the direct publish path and the beta-first promotion path both documented and operator-visible.

If a maintainer must fall back to local npm authentication, run any 1Password CLI (`op`) commands only inside a dedicated tmux session. Do not call `op` directly from the main agent shell; keeping it inside tmux makes prompts, alerts, and OTP handling observable and prevents repeated host alerts.

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
