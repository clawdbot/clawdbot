# Extended-stable publication

When asked to create the initial `.33` extended-stable line or a later
maintenance patch, read
`backport-discovery.md` and
`extended-stable-backports.md` and follow both before version, tag,
or publication work. Treat backport discovery and preparation as an ability of
this release skill, not as a separate release workflow.

The backport flow covers mainline inventory, private-security reconciliation,
approval, the staging PR, and proof handoff. After it lands, use the sequence
below. Never route `.33+` through regular beta/stable release steps.

Extended-stable requires a visible **SDK/config backport warning** whenever a
candidate changes the public plugin SDK or a config/default/schema/migration
surface. Prefer an adaptation that uses the SDK and configuration already
shipped on that line. If a contract change remains necessary, record its
published impact and the maintainer decision in the ledger and staging PR.
Read `extended-stable-backports.md`; a clean cherry-pick, green
release checks, or a regenerated baseline does not by itself explain the
maintenance risk.

Use this path only for the trailing completed month's `.33+` Gateway
distribution: the `openclaw` npm package, official npm plugins, and matching
Docker Gateway images. Treat
`docs/reference/RELEASING.md`,
`scripts/openclaw-npm-extended-stable-release.mjs`, and the release workflows
on pinned current `main` as the exact command and validation contract.

1. On `extended-stable/YYYY.M.33`, verify the root and every publishable official
   plugin have the intended version. Generate and commit the complete
   `## YYYY.M.P` changelog section with `### Highlights`, `### Changes`, and
   `### Fixes`. Carry the full current-main Docker
   release-channel unit: workflow, promoter, policy, shared classifier, tests,
   and workflow validation. Run focused checks and freeze the untagged tip SHA.
2. Keep the frozen SHA and canonical branch as the validation target; Full
   Release Validation derives `npm_dist_tag=extended-stable` from the version.
3. Run complete Full Release Validation against the canonical branch with
   `release_profile=stable`; save its run ID and successful `run_attempt`.
   Prefer the trusted main-pinned harness, which attests the immutable target
   SHA in its manifest. Current manifests include qualified npm and prepared
   Docker artifacts; use that same run ID for npm preflight evidence. Historical
   manifests without them still need a separate npm preflight. Any candidate
   branch change invalidates both gates.
4. Require the tip still equals the frozen SHA, then create signed `vYYYY.M.P`.
   Never move or delete a final tag; later source changes need a new patch.
5. Require the saved validation run to be complete and successful, bind its
   manifest target SHA and attempt to the tag, and accept a direct run from the
   canonical branch, a direct current-`main` run whose workflow SHA is still
   reachable from main, or a trusted main-pinned `release-ci/*` harness. Reject
   narrow reruns.
6. Dispatch `plugin-npm-release.yml` from the same branch with
   `publish_scope=all-publishable`, the full release SHA as `ref`, and
   `npm_dist_tag=extended-stable`. Require complete exact-version and selector
   readback, then save the successful plugin run ID.
7. Publish core with the tag, `npm_dist_tag=extended-stable`, all three run IDs,
   and `full_release_validation_run_attempt=<saved-attempt>`. Normally dispatch
   from the canonical branch. For a workflow-only recovery after the candidate
   is immutable, dispatch trusted current `main` with
   `release_candidate_branch=extended-stable/YYYY.M.33`; it still publishes the
   tag checkout and accepts canonical-branch, current-main, or trusted-pinned
   validation evidence; the prepared tarball and every evidence identity must
   still match the candidate SHA.
8. From a clean current-`main` checkout, run
   `node --import tsx scripts/openclaw-npm-postpublish-verify.ts YYYY.M.P`.
   Verify signatures, provenance, inventories, exact versions, and selectors.
   Use the generated repair only for the root selector; repair other selectors
   with approved credential-isolated tooling. Never republish a version.
9. Require `Docker Release` to verify default, slim, browser, and architecture
   images in GHCR and Docker Hub, including attestations and platform versions.
   It must advance only
   `extended-stable`, `extended-stable-slim`, and `extended-stable-browser` by
   digest and refuse automatic rollback. For alias repair, dispatch the
   approval-gated `docker-channel-promote.yml` from current `main` with the exact
   tag; never rebuild or move the release tag.
10. Do not create a GitHub Release or publish macOS, Windows, mobile, website,
    ClawHub, or private dist-tag artifacts from this path.
