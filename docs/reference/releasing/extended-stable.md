---
summary: "The monthly Gateway extended-stable lane: prepare, publish, verify, and recover"
title: "Extended-stable monthly release"
read_when:
  - You are publishing the monthly .33+ Gateway extended-stable line
  - You need the extended-stable npm and Docker publication commands
  - An extended-stable selector or image needs repair
---

## Monthly Gateway extended-stable publication

For completed month `YYYY.M`, create `extended-stable/YYYY.M.33` and publish
`.33+` from that branch. Tag, branch, checkout, package version, preflight, and
validation must identify one commit. Before `.33`, protected `main` must contain
a later month's final version below patch `33`; later maintenance patches remain
eligible.

### Prepare and stabilize the candidate

Audit the unaudited mainline range, reconcile private security work, approve a
bounded backport set, and land one coordinated PR. Do not push the canonical
branch directly.

On the canonical branch, set `YYYY.M.P`, run `pnpm release:prep`, and require
that version in every publishable official plugin. From the approved ledger,
generate and commit a complete `## YYYY.M.P` section with `### Highlights`,
`### Changes`, and `### Fixes`, citing original merged `main` PRs for equivalent
backports. Preflight rejects a missing or empty section.

Carry the full current-main Docker release-channel unit: workflow, promoter,
policy, shared classifier, tests, and workflow validation. GitHub loads tag
workflows from the tagged commit; an incomplete copy can fail after building or
move regular aliases. Run focused checks.

Freeze the full branch-tip SHA. Before tagging, run Full Release Validation
against that SHA; it also prepares and qualifies the exact npm and Docker bytes:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"

gh workflow run full-release-validation.yml \
  --ref extended-stable/YYYY.M.33 \
  -f ref=extended-stable/YYYY.M.33 \
  -f expected_sha="$RELEASE_SHA" \
  -f release_profile=stable
```

Run validation on the canonical branch; publish binds its workflow ref,
head/target SHA, run ID, and attempt. Save the successful run ID and
`run_attempt`. Use that ID for both npm preflight and full validation evidence
when the manifest contains `publicationArtifacts.npmPreflight`. Historical
manifests without it still need a standalone npm preflight for the same SHA.

Classify failures before editing:

- Product: land another approved backport PR.
- Frozen-target tooling: backport only the smallest compatibility repair that
  tests the old product unchanged.
- Provider, approval, runner, or service: keep the candidate unchanged and use
  the bounded retry path.

Any branch change invalidates both gates. Once they pass, require the tip still
equals `RELEASE_SHA`, then push signed `vYYYY.M.P`. Later changes need the next
patch; never move or delete the tag. Tagging fixes the immutable release
identity; it does not publish Docker images.

### Publish the npm packages

Publish every npm-publishable official plugin from the same SHA and save the
successful run ID:

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
gh workflow run plugin-npm-release.yml \
  --ref extended-stable/YYYY.M.33 \
  -f publish_scope=all-publishable \
  -f ref="$RELEASE_SHA" \
  -f npm_dist_tag=extended-stable
```

The workflow covers all `all-publishable` packages, including unchanged ones,
and verifies every exact version and selector. Reruns reuse published versions.

Then publish the prepared core tarball with all three saved run identities:

```bash
gh workflow run openclaw-npm-release.yml \
  --ref extended-stable/YYYY.M.33 \
  -f tag=vYYYY.M.P \
  -f preflight_only=false \
  -f npm_dist_tag=extended-stable \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f plugin_npm_run_id=<plugin-npm-run-id>
```

If the immutable candidate has already passed its saved preflight and Full
Release Validation but core publication needs a workflow-only recovery, dispatch
the trusted current-`main` workflow instead. Keep the same tag and evidence
identities; do not move the tag or republish plugins:

```bash
gh workflow run openclaw-npm-release.yml \
  --ref main \
  -f tag=vYYYY.M.P \
  -f preflight_only=false \
  -f npm_dist_tag=extended-stable \
  -f release_candidate_branch=extended-stable/YYYY.M.33 \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f plugin_npm_run_id=<plugin-npm-run-id>
```

This recovery path checks out and publishes the immutable tag and requires the
canonical branch implied by that tag. It accepts Full Release Validation
evidence from the canonical candidate branch directly, from current `main`
directly when its workflow SHA is reachable from current `main`, or from the
trusted main-pinned harness. Every accepted form must attest the immutable
tag's SHA. Use it only when the candidate source and recorded evidence are
unchanged.

For non-production rehearsal only, add
`-f bypass_extended_stable_guard=true` to preflight and publish. It bypasses the
month guard only, never canonical-ref, SHA/tag/version equality, provenance,
approval, or readback checks. Never use it for production.

### Verify and recover

From a separate clean current-`main` checkout, not the frozen branch, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P
npm view openclaw@YYYY.M.P version --userconfig "$(mktemp)"
npm view openclaw@extended-stable version --userconfig "$(mktemp)"
```

Require signatures and npm provenance for the canonical branch, plus publish,
preflight, and tarball-digest binding to the release SHA. Both commands must
return `YYYY.M.P`. Verify every prepared core package and `all-publishable`
official plugin at its exact version and selector.

If only the root selector fails, use the generated
`npm dist-tag add openclaw@YYYY.M.P extended-stable` repair command printed in
the workflow summary. Repair existing plugin or other prepared-core selectors
through approved credential-isolated tooling; the OIDC source cannot mutate
them. Never republish an immutable version.

Require `Docker Release` to verify exact default, slim, browser, and architecture
images in GHCR and Docker Hub, including attestations and platform versions. It
must advance only
`extended-stable`, `extended-stable-slim`, and `extended-stable-browser` by
digest; regular aliases remain unchanged and automatic rollback is rejected.

After that core registry readback succeeds, start Docker publication only through
`OpenClaw Release Publish`. Its Docker-only extended-stable path rechecks the
saved npm preflight artifact, exact `Full Release Validation` evidence, exact npm
version and `extended-stable` selector, and published tarball digest before it
calls the reusable `Docker Release` workflow. A tag push never publishes Docker
images by itself:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.P \
  -f preflight_run_id=<npm-preflight-run-id> \
  -f full_release_validation_run_id=<full-validation-run-id> \
  -f full_release_validation_run_attempt=<full-validation-run-attempt> \
  -f npm_dist_tag=extended-stable \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

For alias repair, run approval-gated `Docker Channel Promotion` from current
`main` with the tag. It repeats digest, attestation, and platform checks, allows
an explicit rollback, and never rebuilds images.

Slack, Discord, and Codex are the initial documented support surfaces, not a
release allowlist: every npm-publishable official plugin ships. The regular
checklist alone owns beta/`latest`, GitHub Releases, ClawHub, native apps, mobile,
website, and private dist-tags; do not run those steps for this Gateway path.

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
