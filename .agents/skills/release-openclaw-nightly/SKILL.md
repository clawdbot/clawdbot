---
name: release-openclaw-nightly
description: "OpenClaw Tideclaw alpha/nightly release automation: isolated branches, local fixes, release CI, branch retention, and forward-port to main."
---

# Nightly Release

Use for Tideclaw/OpenClaw alpha/nightly release automation, manual alpha triggers, beta prep, release-branch repair, and post-release forward-port. Load `$release-private` if it exists before using Tideclaw host paths, cron ids, or Discord routing ids.

## Policy

- Alpha/nightly runs every 12h or by manual trigger.
- Beta is human-triggered from Discord from a proven alpha/release branch.
- Stable/latest always needs explicit human confirmation.
- Never publish from a dirty checkout or directly from `main`.
- Main can be busy or broken; alpha work must be isolated so transient main failures do not block a usable nightly.
- Publish only after release-branch proof is green.
- After a successful alpha, forward-port release-branch commits back to `main` and prove main CI green.
- Forward-port PRs contain only reusable fixes needed to make nightly/release checks pass. They must not contain alpha version bumps, release notes, changelog release entries, tags, generated artifacts, or state-file updates.
- Keep only alpha/nightly branches from the last 3 days, plus any branch with an active run, open PR, or release tag.
- Never run broad env/token dumps. For GitHub writes on the Tideclaw host, use the Tideclaw `gh` write wrapper below.

## Identity

Tideclaw should commit under its own machine identity on release branches and forward-port branches:

```bash
git config user.name "Tideclaw"
git config user.email "tideclaw@openclaw.ai"
```

This is good for auditability if commits are clearly machine-authored and gated by CI. Avoid direct pushes to protected `main`; forward-port via PR/automerge unless the repo policy explicitly allows the bot to push after green checks. Include human `Co-authored-by` only when a human supplied the patch or explicit commit text.

## Branch Shape

- Branch prefix: `tideclaw/alpha/`
- Branch name: `tideclaw/alpha/YYYY-MM-DD-HHMMZ`
- Base: current `origin/main` SHA at trigger time.
- State file: resolve from `$release-private` on the Tideclaw host.
- Release tag: `vYYYY.M.PATCH-alpha.N`
- npm dist-tag: `alpha`

`PATCH` is a sequential monthly release-train number, never the calendar day. Determine the alpha train from stable and beta releases; ignore alpha-only patch numbers when choosing the next train. Use one greater than the highest stable/beta patch for the month, then increment only `alpha.N` for repeated nightlies on that train. If a beta exists on that next patch, move alpha to the following train. Legacy alpha-only tags with inflated patch numbers do not advance beta/stable numbering.

Do not reuse old alpha branches for a new run. If rerunning the same base SHA, create a new timestamped branch and record why.

## Start

1. Work in the Tideclaw host checkout from `$release-private`.
2. Fetch first:

```bash
git fetch origin main --tags --prune
git switch main
git merge --ff-only origin/main
BASE_SHA="$(git rev-parse origin/main)"
BRANCH="tideclaw/alpha/$(date -u +%Y-%m-%d-%H%MZ)"
git switch -c "$BRANCH" "$BASE_SHA"
```

3. Read repo release docs/scripts before changing anything:
   - `AGENTS.md`
   - release docs under `docs/`
   - release scripts under `scripts/`
   - `.github/workflows/*release*`
4. Compare `$BASE_SHA` with the last successful alpha state and current git/npm/GitHub alpha tags. If already released, report skip and do not publish.

Manual trigger:

```bash
CRON_ID="<from release-private>"
OPENCLAW_ALLOW_ROOT=1 openclaw cron run "$CRON_ID" --expect-final --timeout 21600000
```

## Discord Alpha Trigger

Tideclaw may run alpha immediately from Discord when a maintainer mentions Tideclaw in `#releases` or `#maintainers`.

Accepted shapes:

```text
@Tideclaw run alpha now
@Tideclaw alpha release from main now
@Tideclaw trigger alpha
```

Rules:

1. Treat this as a manual alpha trigger equivalent to the alpha cron job.
2. Start from current `origin/main` and create a fresh `tideclaw/alpha/YYYY-MM-DD-HHMMZ` branch.
3. Follow the normal alpha workflow: reuse prior fixes, run local checks, fix on the alpha branch, run release CI, publish alpha after green gates, then forward-port reusable fixes via fixes-only PR.
4. If another alpha/beta/stable release run is already active, report the active branch/run and stop.
5. `#maintainers` trigger requires an explicit Tideclaw mention; do not react to unmentioned release chatter there.
6. Resolve Discord role/user ids and live host hotfix notes from `$release-private`.

## Discord Beta Trigger

Tideclaw may run beta releases from `#releases` or mentioned `#maintainers` commands only when a maintainer sends an explicit beta trigger. Treat this as human approval for beta, not for stable/latest.

Accepted shapes:

```text
@Tideclaw beta release from vYYYY.M.PATCH-alpha.N
@Tideclaw beta release from tideclaw/alpha/YYYY-MM-DD-HHMMZ
@Tideclaw beta release from latest proven alpha
```

Rules:

1. Require the words `beta release` and a source alpha tag/branch, or `latest proven alpha`.
2. If the source is ambiguous, ask one clarifying question in `#releases` and stop.
3. Verify the source alpha first: GitHub release, npm `alpha` package, release CI, recorded state file, and branch/tag SHA.
4. Create a fresh beta branch `tideclaw/beta/YYYY-MM-DD-HHMMZ` from the proven alpha source, not directly from a moving `main`.
5. Reuse/squash only stabilization fixes already proven on alpha. Do not import unrelated alpha release mechanics unless the beta release docs require them.
6. Compute beta as `vYYYY.M.PATCH-beta.N`, matching npm `--tag beta`. Ignore alpha-only patch numbers when selecting the beta train.
7. Run beta release validation/preflight/full release CI and fix failures on the beta branch.
8. Publish beta only after green beta gates. Use GitHub Actions/OIDC, never direct npm publish from the host.
9. Final Discord summary must include source alpha, beta tag/version, branch, fix commits, workflow run IDs, npm/GitHub proof, and any skipped/blocked reason.
10. After beta publishes, forward-port reusable fixes to `main` using the same fixes-only PR rules below.

## Reuse Prior Fixes

Before running checks, mine recent Tideclaw alpha branches for fixes already made during previous release attempts:

1. Read the Tideclaw state file from `$release-private` for the last successful alpha branch and fix commit SHAs.
2. List recent remote branches:

```bash
git for-each-ref refs/remotes/origin/tideclaw/alpha --format='%(refname:short) %(committerdate:iso-strict)'
```

3. Consider only Tideclaw alpha branches from the last 3 days plus the last successful alpha branch.
4. For each candidate branch, inspect commits that are not in current `origin/main`:

```bash
git log --no-merges --reverse --format='%H%x09%s' origin/main..origin/tideclaw/alpha/YYYY-MM-DD-HHMMZ
```

5. Cherry-pick only real stabilization fixes that still apply to the new alpha branch. Prefer commits recorded as `fixCommitShas` in the state file.
6. Skip version bumps, changelog release entries, tag artifacts, generated release notes, state-file-only commits, and one-off debug instrumentation.
7. If a cherry-pick conflicts, inspect whether current main already contains an equivalent fix. If not, resolve minimally and keep the commit message clear.
8. Record reused commit SHAs separately from newly authored fix SHAs in the alpha state and final Discord summary.

Use `git cherry`, `git range-diff`, and targeted test reruns to avoid duplicating fixes already present on `main`.

## Repair Loop

Use the branch as a release-candidate repair surface:

1. Run narrow local checks first: changed tests, release preflight, type/lint/build gates required by release docs.
2. If local checks fail, fix on the alpha branch with minimal commits.
3. Commit each coherent fix as Tideclaw.
4. Re-run the failed local check after each fix.
5. Do not hide failures by editing baselines, expected-failure lists, ignore files, or release inventory unless the release docs explicitly require it and the diff is justified.
6. If a failure is flaky, rerun once; if still red, treat it as real.
7. If the fix is clearly useful for main, keep it small and forward-portable. Avoid broad refactors during alpha stabilization.

Commit examples:

```bash
git add <files>
git commit -m "fix: stabilize alpha release preflight"
git push -u origin "$BRANCH"
```

## Release CI

After local proof:

1. Compute the next `vYYYY.M.PATCH-alpha.N` from existing git tags, npm versions, and GitHub releases. Select `PATCH` from stable/beta trains, not the date or the highest alpha-only patch. Reuse the same alpha train and increment `alpha.N` until that patch has a beta; after a beta exists, use the following patch for new alpha builds.
2. Make the alpha branch package version and release metadata match that tag, commit it, and push the branch.
3. Run release validation from the alpha branch, using GitHub CLI, not browser/fetch tools. On the Tideclaw host, bare `gh` is a read-only Codex sandbox wrapper; use `/usr/local/bin/gh-tideclaw-write` for write-capable commands such as `workflow run`, `run cancel`, and publish dispatch:

```bash
GH="/usr/local/bin/gh-tideclaw-write"
SHA="$(git rev-parse HEAD)"
TAG="v$(node -p "require('./package.json').version")"
BRANCH="$(git branch --show-current)"

"$GH" workflow run full-release-validation.yml --repo openclaw/openclaw --ref "$BRANCH" \
  -f ref="$BRANCH" \
  -f release_profile=beta \
  -f rerun_group=all

"$GH" workflow run openclaw-npm-release.yml --repo openclaw/openclaw --ref "$BRANCH" \
  -f tag="$SHA" \
  -f preflight_only=true \
  -f npm_dist_tag=alpha
```

4. Watch the exact workflow run IDs and head SHA with `gh run list`, `gh run view`, and `gh api`. Read-only `gh` is fine for polling; use `$GH` only when a command mutates GitHub. Do not use Codex browser/fetch for GitHub API polling; prior Tideclaw runs failed there after successful preflight.
5. For alpha, blocking gates are the ones Tideclaw can repair directly or that prove package safety: normal CI, plugin prerelease, npm preflight, package preparation, install smoke, tag/reachability, and publish verification. Treat cross-OS, live channel, QA Lab, package acceptance, long Docker E2E, and Telegram package E2E failures as advisory; report them in Discord and continue if the blocking gates are green.
   - If `rerun_group=all` is stuck only on advisory lanes after CI, plugin prerelease, npm preflight, package preparation, and install smoke are green, dispatch a focused Full Release Validation on the same head with `-f rerun_group=install-smoke`. Use that successful focused Full Release Validation run as the publish proof, and include the separate CI/plugin/full advisory run IDs in the Discord summary.
6. If a blocking gate fails, fix on the alpha branch, push, and rerun only the failed or required release CI. If the commit changes, discard old preflight/full-validation run IDs and rerun them for the new head.
7. After full validation and npm preflight are green on the same branch head, create and push the release tag from that exact commit:

```bash
git tag -a "$TAG" "$SHA" -m "openclaw ${TAG#v}"
git push origin "$TAG"
```

8. Dispatch the publish wrapper from the same alpha branch. Use the successful npm preflight run ID and the full release validation run ID plus exact attempt from the same head SHA:

```bash
FULL_RELEASE_VALIDATION_RUN_ATTEMPT="$(gh api \
  "repos/openclaw/openclaw/actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}" \
  --jq .run_attempt)"
"$GH" workflow run openclaw-release-publish.yml --repo openclaw/openclaw --ref "$BRANCH" \
  -f tag="$TAG" \
  -f preflight_run_id="$NPM_PREFLIGHT_RUN_ID" \
  -f full_release_validation_run_id="$FULL_RELEASE_VALIDATION_RUN_ID" \
  -f full_release_validation_run_attempt="$FULL_RELEASE_VALIDATION_RUN_ATTEMPT" \
  -f npm_dist_tag=alpha \
  -f plugin_publish_scope=all-publishable \
  -f publish_openclaw_npm=true \
  -f release_profile=beta \
  -f wait_for_clawhub=false
```

9. Watch the publish wrapper plus child runs. If `openclaw-npm-release.yml` is waiting on the `npm-release` environment and Tideclaw cannot approve it, report that as the only blocker; do not call the release done.
10. Do not publish npm directly from the host; use GitHub Actions/OIDC.

Important: `openclaw-npm-release.yml` with `preflight_only=true` only prepares artifacts. It does not publish. A successful alpha requires the later `openclaw-release-publish.yml` wrapper, a pushed git tag, npm `alpha` dist-tag proof, and a GitHub prerelease.

## Verify Published Alpha

Release is not done until all are true:

- GitHub tag exists.
- GitHub Release exists and is marked prerelease.
- Release body links npm version page, registry tarball, integrity, and CI/proof.
- `npm view openclaw@<version>` shows the exact version, dist-tag `alpha`, tarball, integrity, and publish time.
- Installed/package smoke follows repo release docs.
- The Tideclaw state file from `$release-private` records version, tag, base SHA, branch, fix commit SHAs, workflow run IDs, npm integrity, and timestamp.

Final Discord summary in `#releases`:

- tag/version
- base SHA
- branch
- fix commits
- workflow run IDs
- npm/GitHub proof
- skipped/blocked reason if not released

Use Discord-safe Markdown links with angle-bracket targets. Never print secrets.

## Forward-Port

After a successful alpha, raise a fixes-only PR back to `main`:

1. Create/update a forward-port branch from current `origin/main`:

```bash
git fetch origin main --prune
git switch -c "tideclaw/forward-port/$(date -u +%Y-%m-%d-%H%MZ)" origin/main
```

2. Cherry-pick only release-branch commits that are real fixes required to make nightly/release checks pass.
3. Exclude alpha version bumps, changelog release entries, release notes, tag artifacts, generated release assets, state-file-only commits, and any commit whose only purpose was publishing the alpha.
4. If a commit mixes a real fix with release/version changes, split it: replay only the fix hunks into a new commit on the forward-port branch.
5. Resolve conflicts in favor of the minimal main-compatible fix.
6. Run the relevant changed/local gate.
7. Push and open a PR, or use the repo’s allowed bot merge path.
8. Wait for required main CI to go green. If CI fails, fix on the forward-port branch and rerun.
9. Report the PR/merge SHA and any commits intentionally not forward-ported.

If `origin/main` is independently red before the forward-port, document the unrelated failing check and still keep the forward-port PR green against its head when possible.

## Branch Retention

Before and after each run, prune old alpha branches:

1. List `origin/tideclaw/alpha/*`.
2. Keep branches whose timestamp is within the last 3 days UTC.
3. Keep branches referenced by a live workflow run, open PR, release tag, or state file.
4. Delete only Tideclaw-owned alpha branches:

```bash
git push origin --delete tideclaw/alpha/YYYY-MM-DD-HHMMZ
```

Never delete human branches, beta branches, stable branches, or unknown prefixes.

## Stop Conditions

Stop and report clearly if:

- release docs/scripts disagree on versioning or publish path
- required secrets/auth are unavailable
- GitHub Actions cannot be dispatched or observed
- a required release gate stays red after a real fix attempt
- npm/GitHub state disagrees after publish
- forward-port cannot be made green without a larger product decision
