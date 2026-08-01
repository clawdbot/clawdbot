# Extended-Stable Backport Preparation

Prepare the next Gateway patch for the active `extended-stable` line: the
`openclaw` npm package, official npm plugins, and matching Docker Gateway
images. Discover the complete candidate set, obtain approval, and prepare one
coordinated PR. Commits are canonical; PRs, issues, ClawSweeper reports, and
advisories provide context.

Read `backport-discovery.md` first. Its evidence-driven inventory, detached
baseline applicability probes, advisory reconciliation, and durable unreleased
ledger are mandatory for this maintenance line; this reference adds the
extended-stable package and publication constraints.

## Boundaries

- Read `docs/reference/RELEASING.md`,
  `scripts/openclaw-npm-extended-stable-release.mjs`, and the relevant release
  workflows from a pinned current `origin/main` before resolving the line.
- Target npm and Docker `extended-stable` on
  `extended-stable/YYYY.M.33`; user-facing `stable` remains npm `latest`.
- Cover the core `openclaw` package and every npm-publishable official plugin
  included by the canonical `all-publishable` release inventory at the same
  exact version.
- Carry the complete current-main Docker release-channel unit in the tagged
  tree: workflow, promoter, policy, shared release-version classifier, tests,
  and workflow validation. GitHub evaluates tag-push workflows from that tree.
- Exclude ClawHub publication, GitHub Releases, the macOS app, Windows Hub,
  mobile apps, website downloads, and private-repository dist-tags.
- Review the complete mainline delta using the shared evidence-driven audit.
  Do not stop after the first obvious fixes or consider public PRs, titles, or
  dependency bumps the complete source set.
- Present the full proposed release set before changing release refs.
- Never push directly to the canonical branch, create a release tag, publish a
  package, or mutate an npm dist-tag during discovery or staging.
- Never use `bypass_extended_stable_guard=true` for production.
- Reject features, broad refactors, speculative hardening, and changes that
  require new config, migrations, APIs, protocols, dependencies, runtime
  requirements, or operator action.
- Read `SECURITY.md` and use `$security-triage` for security candidates. Route
  unpublished advisory work through `$openclaw-ghsa-maintainer`; never expose
  private details before the security owner authorizes disclosure.
- Use `$openclaw-testing` for proof selection, `$autoreview` before handoff,
  and `$openclaw-pr-maintainer` for GitHub operations.

## Resolve the Active Line

1. Run `git status -sb`. Do not overwrite unrelated work.
2. Fetch current `origin/main`, tags, and `extended-stable/*` branches.
3. Pin the fetched `origin/main` SHA. Read the release contract from that exact
   commit before resolving versions, package scope, or branches.
4. Query npm dist-tags and choose exactly one mode:
   - **Existing line:** `extended-stable` exists. Treat its exact final
     `YYYY.M.PATCH` value as the published baseline; require `PATCH >= 33` and
     no prerelease or correction suffix.
   - **Bootstrap:** the selector is absent. Obtain explicit maintainer approval
     for the completed `YYYY.M` month and exact final base tag. Do not infer the
     base solely from `latest`, which may already have advanced.
5. Derive the only valid branch as `extended-stable/YYYY.M.33`.
   - Existing line: require the branch to exist, its `package.json` version to
     equal the selector, and `vYYYY.M.PATCH` to resolve to the branch tip.
   - Bootstrap: use the approved base tag for discovery. If the canonical
     branch exists, require its tip to equal the approved base commit and reject
     unexplained unpublished changes. Do not create the remote branch during
     discovery.
6. Confirm the published baseline or approved bootstrap base resolves from npm
   and its Git tag resolves to the expected commit.
7. Confirm `origin/main` has an exact final version in a strictly later
   calendar month with a patch below `33`, matching the production guard.
8. Choose the intended version:
   - bootstrap: exact final `YYYY.M.33`;
   - existing line: the next unused final patch on the same `YYYY.M` line,
     normally `PATCH + 1` and always `>= 34`.
9. Verify the intended core and official-plugin versions are absent from npm.

Use an isolated npm config for unauthenticated registry reads:

```bash
npm_userconfig=$(mktemp)
trap 'rm -f "$npm_userconfig"' EXIT
dist_tags=$(npm view openclaw dist-tags --json --userconfig "$npm_userconfig")
published_version=$(printf '%s' "$dist_tags" | jq -r '."extended-stable" // empty')
if [[ -n "$published_version" ]]; then
  npm view "openclaw@${published_version}" version \
    --userconfig "$npm_userconfig"
fi
```

Do not use GitHub's latest nonprerelease Release as the source of truth. The
extended-stable lane intentionally creates no GitHub Release. In bootstrap
mode, record the approving maintainer and approved base commit. Stop before
discovery or mutation if npm, the canonical branch, tags, package versions,
approved base, or protected `main` disagree.

## Build the Complete Commit Inventory

Freeze `scan_end` to the pinned `origin/main` SHA. Resolve `scan_start` in this
order:

1. the prior accepted extended-stable backport evidence's recorded `scan_end`;
2. for the first run, the merge base between the canonical branch and `main`;
3. an explicitly audited maintainer-provided mainline cursor when histories are
   unrelated.

Never reuse a cursor from an open, abandoned, partially landed, or rejected PR.
Load unresolved `blocked` candidates from the accepted prior evidence before
classifying new commits. Advance the cursor only when those candidates remain
durably recorded for the next run.

```bash
scan_end=$(git rev-parse origin/main)
scan_start=${PRIOR_ACCEPTED_SCAN_END:-}
if [[ -z "$scan_start" ]]; then
  scan_start=$(git merge-base "<canonical-extended-stable-ref>" "$scan_end")
fi
git merge-base --is-ancestor "$scan_start" "$scan_end"
git log --reverse --format='%H%x09%ad%x09%an%x09%s' --date=short \
  "$scan_start..$scan_end"
git cherry "<canonical-extended-stable-ref>" "$scan_end" "$scan_start"
```

If no auditable start exists, stop rather than guessing from dates or titles.

Create the durable unreleased backport ledger required by
`backport-discovery.md`, with one row per non-equivalent commit. Process
deterministic batches of at most 100 commits. Record each SHA, subject, changed
paths, first-pass decision, applicability result, exclusions, and missing
evidence. Keep public security rows opaque and private advisory detail only in
the approved security record.

```bash
ledger_dir=$(mktemp -d)
git rev-list --reverse "$scan_start..$scan_end" >"$ledger_dir/all-commits.txt"
git cherry "<canonical-extended-stable-ref>" "$scan_end" "$scan_start" \
  >"$ledger_dir/patch-equivalence.txt"
split -l 100 "$ledger_dir/all-commits.txt" "$ledger_dir/batch-"
```

Review every ledger entry's subject and changed-file summary. Inspect the full
diff and surrounding code for every plausible security or reliability fix, and
mechanically probe each security- or reliability-signalled production diff in a
detached baseline worktree as required by `backport-discovery.md`. Separately
review conventional `fix`, `perf`, and `doctor` commits in the high-risk paths
named there. Account for merges, squash commits, direct commits, reordered
patches, branch-specific equivalents, and companion commits that `git cherry`
misses. Do not finish while any entry remains unclassified.

Also inspect direct maintainer/security commits, linked PRs and issues,
ClawSweeper findings, companion fixes, callers, siblings, tests, and dependency
contracts.

## Filter by Publication Surface

Include only fixes that affect the core package, an npm-publishable official
plugin in the exact release inventory, or the official Docker image/runtime
path. Prove package or image inclusion rather than inferring it from the source
path alone.

- Do not exclude `extensions/**` by path. Determine whether the package appears
  in the canonical `all-publishable` inventory.
- Include plugin fixes only when the canonical workflow publishes that package
  at the same intended version and can verify its exact package and selector.
- Treat ClawHub-only, external, private, or otherwise unlisted plugin changes as
  out of scope.
- Treat macOS-app-only, Windows-Hub-only, mobile-only, website-only, and GitHub
  Release-only fixes as `skip` for this Gateway extended-stable line.
- Treat cross-repository or package-topology uncertainty as `blocked` until the
  shipped npm surface and release owner are proven.

Prioritize crashes, hangs, restart loops, data/session/message loss,
auth/provider failures, serious mature-behavior regressions,
release/update/rollback failures, and bounded resource exhaustion. Do not
exclude a commit because its title lacks `fix:` or it has no PR.

## Reconcile Private Security Work

Before calling the release set complete, use `$security-triage` and
`$openclaw-ghsa-maintainer` to:

1. enumerate authorized open/draft advisories and private-fork fix state;
2. determine privately whether each item affects a published npm package in the
   extended-stable release inventory;
3. route applicable unpublished fixes through the approved private workflow;
4. expose only an opaque pending/cleared status publicly.

If advisory access is unavailable, require explicit security-owner
confirmation. Never copy advisory titles, exploit details, private SHAs, or
private refs into the public ledger, branch, PR, or chat output.

## Assess Every Plausible Fix

For each candidate, prove:

1. The faulty behavior exists in the published extended-stable package set or
   canonical branch.
2. The public source commit is on `main` and is not already present or
   behaviorally equivalent on the branch.
3. The change restores existing behavior instead of adding functionality.
4. The fix includes all required companion commits.
5. Any branch-specific adaptation is narrow and preserves the invariant.
6. Focused validation can prove the fix on the maintenance branch.
7. The complete fix ships through the canonical npm publication inventory.

Classify each plausible fix as:

- `backport`: applicable, material, isolated, npm-shipped, and testable;
- `already-covered`: commit or equivalent behavior is present;
- `not-affected`: the published package set does not contain the defect;
- `blocked`: useful, but adaptation, package scope, or proof is incomplete;
- `skip`: feature, low-impact change, refactor, or out-of-scope surface.

Do not infer that a clean cherry-pick is safe. Treat config/default, persisted
state, plugin/API boundary, protocol, dependency, packaging, installer, and
cross-repository changes as high risk requiring maintainer judgment. Collapse
overlapping or dependent commits to the smallest final fix before proposing it.

## Present the Full Release Set

Before mutation, report:

| Source commit | Decision | Published impact | Dependencies | Adaptation | Proof |
| ------------- | -------- | ---------------- | ------------ | ---------- | ----- |

Include the published npm selector/version, canonical branch, intended patch,
protected `main` version, scan bounds, total commits, batch count, dependency
order, complete proposed set, blocked/high-risk decisions, carry-forward items,
affected core/plugin packages, out-of-scope publication surfaces, and
confidential security status.

Use PR links when they exist, but retain source commit identities in internal
evidence. Obtain explicit maintainer approval for the complete categorized
ledger and release set before changing branches.

## Prepare the Approved Patch Set

1. Resolve the exact target commit. In existing-line mode, use the canonical
   remote head. In bootstrap mode, use the approved base commit; after release
   set approval, create the canonical branch from that exact commit if it is
   still absent. Re-fetch and verify it before creating a separate staging
   branch.
2. Apply each approved public source commit in dependency order with
   `git cherry-pick -x`. Keep commits separate and avoid unrelated cleanup.
3. Compare every result with the source diff and maintenance branch. Return a
   candidate to `blocked` if adaptation becomes architectural.
4. Backport or add focused regression tests where practical. Run focused proof
   per fix, then combined changed-surface and release-relevant checks. Use
   Crabbox/Testbox for broad, package, cross-OS, release, or E2E proof.
5. Set the intended root version and run `pnpm release:prep` on the same staging
   branch. Verify every publishable official plugin package has that exact
   version. Do not create the tag or dispatch publication before the PR lands.
6. Run `$autoreview` until no accepted/actionable findings remain.
7. Open one coordinated PR targeting the canonical extended-stable branch.
   Never target `main` and never push the target branch directly.
8. Keep unpublished security work in the approved private advisory fork until
   disclosure is authorized.

The PR body must list the intended maintenance tag, exact npm publication
inventory, every source commit and optional PR, impact, adaptations, focused
and combined proof, security status, rollback considerations, and exact scan
bounds. Update the durable ledger with branch/tag/version/SHA provenance and
unresolved blocked candidates so the next run carries them forward. Dispatch
npm preflight only after the canonical branch or tag has that exact final
version and SHA.

## Stabilize the landed candidate

Keep product backports separate from release-tooling compatibility. After the
coordinated PR lands:

1. Verify the branch tip, root/plugin versions, and complete Docker
   release-channel unit identify one candidate.
2. Run focused proof, npm preflight, and complete branch-owned validation.
3. Use another approved PR for product defects; use the smallest
   behavior-preserving repair for frozen-target tooling; retry external failures
   without changing the candidate.
4. Record repairs and omitted unsupported scenarios. Any branch change requires
   new exact-head evidence. Tag only the final green tip.

## Handoff

Report:

- mode, published `openclaw@extended-stable` version or approved bootstrap
  base, and canonical branch;
- intended maintenance tag and final staging head;
- included, skipped, blocked, not-affected, and already-covered candidates;
- affected core/plugin packages, adaptations, and commit order;
- proof commands, run IDs, and autoreview result;
- candidate-stabilization failures, their classification, every workflow or
  harness compatibility repair, and superseded validation runs;
- remaining security, release, or maintainer approvals;
- the coordinated PR URL or why no PR was opened;
- exact intended Docker images and aliases, plus explicit confirmation that no
  other non-npm publication is planned.

Then follow the parent skill's publish and recovery sequence. Keep exact
branch/tag/package/run identity, never republish for selector repair, and move
only the `extended-stable*` Docker aliases.
