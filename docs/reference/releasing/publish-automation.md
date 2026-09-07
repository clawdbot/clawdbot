---
summary: "OpenClaw Release Publish order, tooling tags, and Windows, Android, and ClawHub recovery"
title: "Release publish automation"
read_when:
  - You are running the mutating publish sequence after the tag exists
  - You need the protected release-publish tooling tag commands
  - You are recovering Docker, Windows, Android, or ClawHub publication
---

## Regular release publish automation

For beta, `latest`, plugin, GitHub Release, and platform publication,
`OpenClaw Release Publish` is the normal mutating entrypoint. The monthly
`.33+` Gateway extended-stable path does not use this orchestrator. The
regular workflow orchestrates the trusted-publisher workflows in the order the
release needs. Linux cross-OS validation remains blocking; Windows/macOS
cross-OS conclusions are advisory and cannot block the saved validation
evidence. macOS app signing, notarization, appcast updates, and Windows Hub asset
promotion can run in parallel with or after npm publication and never delay
npm. Their artifact contracts still govern platform readiness and GitHub
release closeout. Full Release Validation and qualified package artifacts must already be green; no app artifact is a prerequisite:

1. Check out the release tag and resolve its commit SHA.
2. Verify the tag is reachable from `main` or `release/*` (or a Tideclaw alpha branch for alpha prereleases).
3. Run `pnpm plugins:sync:check`.
4. Dispatch `Plugin NPM Release` with `publish_scope=all-publishable` and `ref=<release-sha>`.
5. Dispatch `Plugin ClawHub Release` with the same scope and SHA.
6. After plugin npm succeeds, dispatch `OpenClaw NPM Release` with the release tag, npm dist-tag, and saved `preflight_run_id` after verifying the saved `full_release_validation_run_id` and exact run attempt. ClawHub proceeds in parallel.
7. Verify the published npm package and selector readback, then call reusable `Docker Release` with the immutable tag and SHA. Finalize the draft GitHub release after npm and Docker evidence succeeds; Docker remains part of the Gateway distribution.
8. For stable, optionally dispatch `Windows Node Release` after finalization with both `windows_node_tag` and candidate-approved `windows_node_installer_digests`. It attaches signed installers and checksums to the public release as a detached child. Omit both inputs to skip Windows dispatch. When the tagged `apps/android/version.json` matches the release train, qualify and dispatch `Android Release` independently for its exact-tag signed APK, checksum, and provenance; run macOS validation/preflight/publish through `openclaw/releases` in parallel or afterward. No app workflow delays npm or GitHub release finalization. Track app failures through their summaries and evidence, then recover only the failed platform.

The Android train is pinned independently. If its tagged version differs from
the stable tag's base version, the parent skips both native qualification and
APK publication and records the pin, expected train, and remedy in its summary
and release proof. Before the next tag, prepare the shared mobile release with
`node --import tsx scripts/mobile-release-version.ts --prepare --version YYYY.M.PATCH --write`.
When preparing the core and mobile release together, use
`pnpm release:prepare --version YYYY.M.PATCH --android --write`; its Android
selection uses the same shared mobile preparation and reads pending notes from
`apps/ios/CHANGELOG.md`. The generated Android notes must fit
[Google Play's 500 Unicode character limit](https://support.google.com/googleplay/android-developer/answer/9859348),
including the final newline. iOS App Store finalization remains a separate step.
A matching pin still requires successful native qualification; a failed run is
never recorded as a pin mismatch skip.

Android approval binds the release tag and target SHA to the approving parent's
run ID, exact attempt, full ref, and workflow SHA. npm-stable publication adds the
native CI run, exact attempt, and tooling ref in a v3 receipt; full validation
retains the historical v2 receipt. The child verifies the attested receipt and
the live parent identity, including the protected tooling tag or main ancestry.
Normal Android admission accepts an active or successfully completed
parent and the exact stable target release, whether draft or public. Failed or
cancelled parents remain rejected; explicit recovery can separately admit a
completed failed parent. Before provenance publication and each asset upload,
Android rechecks the live release tag target and stable classification, protected
tooling identity, native CI qualification when present, and exact parent attempt/state.
The parent also rechecks native qualification immediately before dispatch.
These are fresh boundary checks,
not an atomic GitHub validation-and-write transaction. A dispatched run link is
pending publication evidence, not an APK download claim. Monitor and approve the
linked Android run separately;
if dispatch cannot be confirmed, inspect existing runs before retrying.
For explicit Android recovery, pass `release_publish_run_attempt`,
`release_publish_full_ref`, and `release_publish_workflow_sha` from that same
parent alongside its run ID and ref; a rerun requires its own matching receipt.
Older immutable release tags retain their original Android workflow contract.
Tags without the v3 consumer, including `v2026.8.2` and its same-source corrections,
require `release_profile=full` and their matching frozen release tooling;
npm-only qualification is rejected before core publication for those targets.

For real core npm, plugin npm, or ClawHub publication, run the parent from a
protected lightweight `release-publish/<sha12>-<epoch>` tag at the frozen Tooling
SHA. Parent and child provenance must carry that same full ref. Create and push
the tooling tag before running the publish command:

```bash
TOOLING_SHA="<recorded-full-tooling-sha>"
PUBLISH_REF="release-publish/$(printf '%s' "$TOOLING_SHA" | cut -c1-12)-$(date +%s)"
git tag "$PUBLISH_REF" "$TOOLING_SHA"
git push origin "refs/tags/$PUBLISH_REF"
```

Pass `--ref "$PUBLISH_REF"` to `gh workflow run`; real child publication from
`main` is rejected before work starts. Docker-only recovery may use `main`;
the matching Tideclaw alpha branch route is unchanged.

Beta publish example (using the tooling tag above):

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

Include `plugin_sdk_api_acknowledgement` only when the npm preflight's Plugin SDK API report contains changes.

If a beta or regular stable package is already published but its container images are missing,
do not rerun npm or plugin publication. Reuse the immutable release tag plus its
successful npm preflight and Full Release Validation evidence through the
Docker-only recovery path. The workflow rechecks the exact npm version, the
selected npm dist-tag, and the published tarball digest before building containers:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref main \
  -f tag=vYYYY.M.PATCH-beta.N \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f npm_dist_tag=beta \
  -f publish_openclaw_npm=false \
  -f publish_docker_only=true
```

For regular stable recovery, use the same command with `tag=vYYYY.M.PATCH` and
`npm_dist_tag=latest`. Only regular stable tags (patches 1–32, including correction
suffixes) are accepted for `latest`; extended-stable recovery retains its own
selector. Recovery builds the canonical versioned images without republishing
npm packages or plugins, dispatching native releases, or finalizing the GitHub
release. Existing approval and provenance checks still apply.

Stable publish to the default beta dist-tag:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=beta
```

Both Windows inputs are optional. To schedule detached promotion after GitHub publication, add `windows_node_tag` and `windows_node_installer_digests` together; the candidate helper records the digest map when given `--windows-node-tag`.

To attach Windows assets later or retry a failed promotion, use the exact OpenClaw tag, exact published Windows source tag, and approved installer digests:

```bash
gh workflow run windows-node-release.yml \
  --repo openclaw/openclaw \
  --ref main \
  -f tag=vYYYY.M.PATCH \
  -f windows_node_tag=vX.Y.Z \
  -f expected_installer_digests='{"OpenClawCompanion-Setup-x64.exe":"sha256:<approved-x64-sha256>","OpenClawCompanion-Setup-arm64.exe":"sha256:<approved-arm64-sha256>"}'
```

Never substitute `latest` for either tag. Monitor the Windows run and its verification evidence separately; an unsuccessful promotion leaves the npm package and GitHub release published. macOS recovery uses `openclaw/releases/.github/workflows/openclaw-macos-validate.yml` and `openclaw-macos-publish.yml`, preserving the successful macOS preflight and validation run IDs when promoting prepared assets.

Stable promotion directly to `latest` is explicit:

```bash
gh workflow run openclaw-release-publish.yml \
  --ref "$PUBLISH_REF" \
  -f tag=vYYYY.M.PATCH \
  -f preflight_run_id=<successful-openclaw-npm-preflight-run-id> \
  -f full_release_validation_run_id=<successful-full-release-validation-run-id> \
  -f full_release_validation_run_attempt=<successful-full-release-validation-run-attempt> \
  -f plugin_sdk_api_acknowledgement=<reviewed-8-character-digest> \
  -f npm_dist_tag=latest
```

For a selected plugin repair, use `OpenClaw Release Publish` with `publish_openclaw_npm=false`, `plugin_publish_scope=selected`, and `plugins=@openclaw/name`. The parent rejects selected scope when `publish_openclaw_npm=true` so the core package cannot ship without every publishable official plugin, including `@openclaw/diffs-language-pack`. `Plugin NPM Release` also supports direct focused repair dispatch.

Plugin npm artifact preflight checks out only the trusted scripts and workflows
it needs. Preflight and publication fetch the selected source manifest on demand
at the exact release SHA. Each verifier still independently checks that manifest
against the artifact's recorded source hash, together with the tarball hashes
and producer identity.

ClawHub OIDC publication requires the executing release parent to authorize the exact child run, attempt, and package inventories. A direct `Plugin ClawHub Release` dry run can prepare packages without publication authority, but a standalone publish cannot replace the parent. Bot-dispatched children stay on the automated route and are terminal once their exact parent attempt completes without success.

A direct human `Plugin ClawHub Release` dispatch with `release_publish_run_id` always takes ClawHub's explicit-recovery route. The `approve_plugins_clawhub_release` environment job uploads the version 2 `openclaw-clawhub-recovery-approval-<run-id>-<run-attempt>` receipt, which names the original child attempt (`authorizedChildRunId`/`authorizedChildRunAttempt`) whose parent receipt `openclaw-clawhub-parent-authorization-v2-<parent-run-id>-<parent-run-attempt>-<child-run-id>-<child-run-attempt>` the completed parent already uploaded; a completed parent cannot mint a new one. ClawHub resolves that parent receipt through the authorized child and requires the recovery child to run the same workflow ref and SHA, candidate SHA, tooling, parent attempt, and exact package inventory, so dispatch recovery from the parent's tooling ref with the parent's inputs. Pass `recovered_clawhub_run_id` and `recovered_clawhub_run_attempt` to name the original child explicitly; when omitted, the approval job discovers it from the parent run's single matching receipt and fails with the candidate list when zero or several exist. Version 1 recovery receipts are rejected. Do not retry publication with copied receipts or treat staging as completed publication.

```bash
gh workflow run plugin-clawhub-release.yml \
  --ref <parent-tooling-ref> \
  -f publish_scope=all-publishable \
  -f ref=<full-40-character-release-sha> \
  -f release_tag=vYYYY.M.PATCH \
  -f release_publish_run_id=<parent-run-id> \
  -f release_publish_run_attempt=<parent-run-attempt> \
  -f release_publish_branch=<parent-tooling-ref> \
  -f release_publish_full_ref=<parent-tooling-full-ref> \
  -f release_publish_workflow_sha=<parent-tooling-sha> \
  -f recovered_clawhub_run_id=<original-child-run-id> \
  -f recovered_clawhub_run_attempt=<original-child-run-attempt>
```

Before dispatching a ClawHub publisher, the parent refuses dispatch if a run for
the same tooling ref is waiting, pending, queued, or in progress. Follow the
reported run URL: wait for active publication, or reject a stale run's pending
deployment through GitHub's [pending-deployments API](https://docs.github.com/en/rest/actions/workflow-runs#review-pending-deployments-for-a-workflow-run)
with `state=rejected` before retrying.
The parent does not automatically reject or cancel detached children.

For pre-tag ClawHub bootstrap validation, dispatch `Plugin ClawHub New` from
trusted `main` and pass the full target release SHA through `ref`. Tagged
bootstrap is dispatched by the approved parent from its protected tooling tag;
Tideclaw alpha uses separately approved `main` tooling. Never dispatch bootstrap
from the product release tag or a release branch:

```bash
gh workflow run plugin-clawhub-new.yml \
  --ref main \
  -f plugins=@openclaw/name \
  -f ref=<full-40-character-release-sha> \
  -f pretag_validation=true \
  -f dry_run=true
```

Pre-tag validation requires `dry_run=true`, rejects release-tag and parent-run
inputs, and accepts only an exact target reachable from `main` or `release/*`.
It does not load ClawHub credentials, publish package bytes, or change trusted
publisher configuration. The workflow still resolves the live registry plan,
checks out and packs the target only in a secretless job, materializes the
locked ClawHub toolchain, and validates the immutable artifact and package
slug/identity before the release tag exists. Approve the
`clawhub-plugin-bootstrap` environment only after the secretless pack jobs
finish; this protected validation job has no credentials or mutation commands.

An approved dry run or real bootstrap after tagging must include the exact
release tag plus the parent `OpenClaw Release Publish` run id, attempt, and
ref. The parent attests the bootstrap workflow ref and exact SHA, using its
protected tooling tag for regular publication or separately approved `main`
tooling for Tideclaw alpha; the child run and every protected environment
approval must match that approved child SHA. The release tag is
rechecked before every publish attempt and trusted-publisher mutation.

The pack job
uploads one immutable artifact whose name, Actions artifact ID/digest,
producer run/attempt, target SHA, and per-package tarball SHA-256/size are
carried into the validation and protected jobs. The protected job checks out the parent-approved trusted
tooling, validates the artifact tuple through the GitHub API, downloads
by exact artifact ID, rehashes every tarball, and validates local TAR paths and
package identity with the pinned CLI's USTAR canonicalization rules. Every
candidate then passes the pinned CLI publish dry-run, which returns before
registry lookup or auth. The credential-job prefilter caps compressed ClawPacks
at 120 MiB, total file payload at 50 MiB, expanded TAR data at 64 MiB, and
TAR entry count at 10,000. Existing-package trusted-publisher repair remains
configure-only, but it still packs the target and requires the requested tag
plus exact registry byte and metadata equality before changing trusted-publisher
configuration. Post-publish verification downloads the ClawHub artifact and
requires the same SHA-256 and size. A rerun-failed recovery may reuse an earlier
attempt's package artifact only when the exact producer job completed
successfully. Final evidence also binds the locked ClawHub version, lock
SHA-256, and npm integrity. A mismatch requires a new package version.

## Related

- [Release policy](/reference/RELEASING)
- [Release channels](/install/development-channels)
- [Full release validation](/reference/full-release-validation)
