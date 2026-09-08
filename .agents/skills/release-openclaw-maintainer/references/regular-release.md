# Regular beta and stable release

## Freeze and validate code

Read [preparation](preparation.md) before branch or version changes. Record the
approved version, cut SHA, release branch and product-complete Code SHA,
including final notes when ready. Code SHA may also be the Release SHA. Use
[validation](validation.md) to select phase-specific gates and
`$release-openclaw-ci` for dispatch/recovery.

Run deterministic source preflight, then validate the exact Code SHA:

```bash
node scripts/full-release-validation-at-sha.mjs --sha <code-sha> --target-ref release/YYYY.M.PATCH --workflow-sha <tooling-sha>
```

Record and reuse the full trusted Tooling SHA. Beta-publish uses
`release_profile=beta`, `run_release_soak=false`; require `npm-beta-v1` for a
qualifying canonical beta target, otherwise retain historical full behavior.
A confirmed code defect creates a new Code SHA. Tooling, credentials,
infrastructure or wrapper failure keeps the candidate and recovers the failed
surface. Use [publication recovery](publication-recovery.md) for classification.

An early `OpenClaw Performance` run is optional beta confidence:
`target_ref=<code-sha>`, `profile=release`, `repeat=3`, deep profiling/live OpenAI
off, `fail_on_regression=false`. It may overlap validation; stable/full keeps
its blocking performance child. Compare available agent-turn/resource,
Gateway startup ready/listen/RSS/CPU and CLI startup metrics against earlier
releases. Record minor regressions; major regressions block unless waived or
proven infrastructure noise.

## Qualify publication bytes

If Code SHA already contains fully final notes, use the same successful fresh
Full Release Validation parent and attempt for Code and Release qualification.
Its exact npm/OCI descriptors must belong to that SHA and satisfy the selected
release profile's required gates. No second commit or validation run is needed
solely to name a Release SHA.

If notes change after Code qualification, use `$openclaw-changelog-update`
with current main for canonical PR provenance and commit only `CHANGELOG.md`.
The complete Code-to-Release delta must be exactly that file to optionally use
`changelog-only-release-v1`. That path requires green Code product evidence
and fresh Release SHA npm qualification/Docker preparation; it does not reuse
the earlier package bytes. Any other source change requires fresh product
qualification.

For either path, final SDK reports cover both
beta and latest; publication selects the appropriate one. Run release-note,
package/install/update acceptance against these exact prepared bytes.

Review the Plugin SDK API diff. If it reports changes, record its reviewed
8-character acknowledgement digest; otherwise omit the acknowledgement.
Confirm the npm version is unpublished. A prepare-only request does not
authorize pushing publication tags: use an existing matching protected tooling
ref where available, otherwise report that qualification still needs one.
With publication/tag-push authority, create and push the protected lightweight `release-publish/<tooling-sha12>-<epoch>` tooling tag at the recorded
Tooling SHA (see `docs/reference/RELEASING.md`), then consume existing validation
against the untagged Release SHA:

```bash
pnpm release:candidate -- \
  --tag <tag> \
  --target-sha <release-sha> \
  --full-release-run <release-sha-validation-run-id> \
  --publish-workflow-ref release-publish/<tooling-sha12>-<epoch> \
  --plugin-sdk-api-acknowledgement <reviewed-8-character-digest> \
  --skip-dispatch
```

Omit `--plugin-sdk-api-acknowledgement` when no API change exists. The helper
completes package/install proof and prints the publish command; do not dispatch
another equivalent validation. Its `npm-beta-v1` Telegram package result is
`deferred-postpublish`, never passed. Other policies retain their check. Beta
and alpha defer Parallels to `pnpm release:beta-smoke`; stable/full run it before
publication. Override with `--run-parallels`/`--skip-parallels` only on explicit
operator direction. Optional `--windows-node-tag <exact-source-tag>` records
its approved installer digest map; stable candidates do not require Windows.

For a prepare-only request, stop with the candidate, evidence, limitations, and
printed next command. Do not create/push the final tag or publish/announce.
With publication authority and candidate success, create and push the signed
final tag at Release SHA. Leave GitHub Release creation/finalization to the
publish workflow. At this point start the selected macOS handoff, release-ops
validation, and notarization preflight through [platform publication](platform-publication.md)
while npm/plugin publication proceeds. These preparation lanes do not need a
published GitHub page; asset promotion waits for its required release state.
Keep their exact run/attempt identities in the handoff's publication rows.

## Publish and verify

Read [publication authentication and recovery](publication-recovery.md).
Dispatch `.github/workflows/openclaw-release-publish.yml` using the candidate
helper's protected `release-publish/<tooling-sha12>-<epoch>` ref. Pass matching
`npm_dist_tag`, `preflight_run_id`, `full_release_validation_run_id` and its
exact successful `full_release_validation_run_attempt`. Include the reviewed
SDK acknowledgement only when required. Optional Windows source tag and
candidate-approved digests are supplied together or both omitted.

Wait for `npm-release` environment approval, plugin npm then core npm, parallel
ClawHub, npm postpublish verification, Docker publication, dependency/release
evidence, and GitHub finalization. Reuse successful immutable child artifacts
on recovery; never rebuild or republish successful versions.

Native applications use [platform publication](platform-publication.md) as
independent tasks; beta runs them only if requested. Their approval, build,
signing or promotion does not delay npm/GitHub finalization. Recover an app
failure without republishing npm.

## Confidence and promotion

Run [postpublish confidence](validation.md#postpublish-confidence) against the
exact published beta package. Deferred lanes must pass at least once before
stable/latest promotion, including published-package Telegram. Run safe
independent rosters concurrently while controlling local Docker/VM load.
Classify failures before admitting a fix to the next beta; do not scan moving
main or automatically rerun all groups. An operator's beta-attempt cap counts
approved product attempts, not infrastructure failures.

Campaign generation belongs to `$openclaw-release-validation` and is not a
publish blocker. Requested Discord announcements use
`$release-openclaw-announcement`; requested X posts use `$release-tweets`.
Existing explicit posting authorization is required. Beta-only requests end
after verification and any requested announcement.

For an authorized stable promotion, reuse the matching beta's full confidence
when still applicable. Run published npm verification, Docker install/update,
macOS-only Parallels smoke and required QA signal; broaden only for stale
proof, material stable/beta differences, or explicit retesting. Promote beta to
latest through the restricted dist-tag workflow in
[publication recovery](publication-recovery.md). For direct latest publication,
point beta to that stable only if requested. Verify each selector readback.

Complete [stable main closeout](stable-main-closeout.md) once version,
changelog, npm and Docker evidence are ready. Record pending apps and monitor
them independently; verify each platform's assets/updater before announcing it
complete.
