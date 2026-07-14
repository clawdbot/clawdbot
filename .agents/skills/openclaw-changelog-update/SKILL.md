---
name: openclaw-changelog-update
description: Regenerate OpenClaw release changelog sections from git history before beta or stable releases.
---

# OpenClaw Changelog Update

Use this for release changelog rewrites and GitHub release-note source text.
Run it once after the final Code SHA has green Full Release Validation. Do not
rerun it for same-candidate tooling retries, resumed publication, or promotion.
Use it with `release-openclaw-maintainer`; this skill owns changelog content,
ordering, grouping, and attribution discipline.

## Goal

Rebuild the target `CHANGELOG.md` version section from a complete, generated
history manifest, not stale draft notes. Produce grouped user-facing release
notes sorted by user interest while preserving every relevant issue/PR ref and
every human `Thanks @...` attribution.

## Inputs

- Target base version: `YYYY.M.PATCH`, without beta suffix.
- Base tag: last reachable shipped release tag, usually the previous stable or
  the previous beta train requested by the operator. It must be an ancestor of
  the target; a newer but divergent tag is not a valid history boundary. Use
  an explicit shipped/main-closeout SHA only when it is also reachable from the
  target.
- Target ref: the exact green Code SHA. The changelog commit created from this
  input becomes the Release SHA.
- Canonical main ref: current `origin/main`, fetched before verification. Release
  notes cite the original merged main PR when the same work is carried by a
  backport. A release-branch PR is used only while no forward-port exists on
  current main.

## Workflow

1. Confirm the release branch is at the fully validated Code SHA:
   - `git fetch --tags origin`
   - confirm clean `git status -sb`
   - record `git rev-parse HEAD` as the Code SHA
   - record the successful Full Release Validation run id and attempt
   - stop if any product/version/backport change is still pending
2. Audit history, including direct commits:
   - `git log --first-parent --date=iso-strict --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - `git log --first-parent --grep='(#' --date=short --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - also inspect `--since='24 hours ago'` when main moved during the release.
3. Generate the complete contribution record and editorial manifest before
   writing grouped prose:

   ```bash
   node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
     --base <base-tag> \
     --target <target-ref> \
     --main-ref origin/main \
     --version <YYYY.M.PATCH> \
     --manifest /tmp/openclaw-release-<YYYY.M.PATCH>.json \
     --write-ledger
   ```

   The verifier automatically reuses public GitHub GraphQL responses from an
   exact base/target SHA snapshot under the worktree's git metadata. Iterative
   rewrites at the same target avoid repeated network discovery. Use
   `--refresh-github-snapshot` after suspect API data, `--github-snapshot
<path>` for an explicit artifact, or `--no-github-snapshot` for a live-only
   audit. GitHub release bodies are always read live.
   - the manifest is the required input to the rewrite, not an after-the-fact
     audit; it contains every referenced PR, eligible contributor credit,
     inline issue context, every direct commit, and an editorial-eligibility
     classification for PRs and direct commits
   - for a historical backfill, add `--seed-ref <pre-backfill-ref>` once so
     contribution records from the prior changelog are retained even when an
     older merged commit omitted its PR number; the verifier excludes records
     for work reverted after the base tag, including beta work reverted before
     the stable release
   - add repeatable `--shipped-ref <prior-shipped-tag>` when the reachable main
     closeout differs from the shipped tag or later forward-port commits
     re-associate PRs that were already released. Each tag is a cumulative
     shipped boundary: the verifier unions explicit PR rows from complete
     contribution records in numbered release sections, excludes only overlapping PRs,
     and ignores `Unreleased`. Never infer this boundary from the base SHA,
     target prose, or target record. The manifest and generated provenance retain
     each tag plus the exact excluded PR inventory and count for deterministic
     candidate validation
   - source PR discovery combines merged GitHub commit associations with merged
     PR references explicitly present in active commit subjects/bodies so
     cherry-picks and squash commits remain accounted for. Resolve every
     association page and exclude PRs merged after the target release commit
   - canonicalize backports to the original merged PR on `main`: explicit
     cherry-pick origins win, then a unique normalized-subject match requires
     the same author and an overlapping changed path. Suppress release/backport
     PRs whenever the corresponding main PR exists on current `origin/main`.
     Keep a release-branch PR only when that change landed there first and has
     not yet been forward-ported to `main`
   - read the manifest before editing `### Highlights`, `### Changes`, or
     `### Fixes`; do not carry old grouped prose forward without re-auditing it
   - inspect linked PRs/issues or diffs for ambiguous commits. Direct commits
     are editorial input, not public ledger rows; infer material user outcomes
     from subject, body, touched files, tests, and nearby commits

4. Rewrite one stable-base section only:
   - use `## YYYY.M.PATCH`
   - do not create beta-specific headings
   - do not leave a stale `## Unreleased` section above the target release
   - if `Unreleased` contains release-bound notes, fold them into the target
     section instead of deleting them
5. Section shape:
   - `### Highlights`: 5-8 bullets, broad user wins first
     - include only a clear user-visible capability or workflow unlock, a
       material reliability/safety fix, a broad cross-surface improvement, or
       a release-defining integration/compatibility milestone
     - every highlight must say what changed for a user in one sentence; use
       one user story per bullet and group its supporting PRs
     - exclude tests, CI, refactors, docs, catalog churn, and implementation
       detail unless the outcome is a material install/update, data-safety, or
       widely visible user improvement
   - `### Changes`: new capabilities and behavior changes
   - `### Fixes`: user-facing fixes first, grouped by impact and surface
   - group related changes/fixes by surface and user impact; avoid one bullet
     per tiny commit when several commits tell one user-facing story
   - `### Complete contribution record`: generated PR-first record after the
     grouped prose; it is the exhaustive accounting surface, not a second
     release summary
6. Preserve attribution:
   - keep `#issue`, `(#PR)`, `Fixes #...`, and `Thanks @...`
   - every human-authored merged PR represented by a user-facing entry needs
     its PR ref and `Thanks @author`, even when the PR had no linked issue
   - every human issue reporter for a `Fixes #...` or referenced bug issue
     represented by a user-facing entry needs `Thanks @reporter` unless the
     same handle is already thanked in that bullet
   - every human `Co-authored-by` contributor on represented user-facing work
     needs `Thanks @handle` when a GitHub handle is known
   - when grouping multiple PRs/issues in one bullet, include every relevant
     PR/issue ref and every human contributor handle in that same bullet
   - multiple `Thanks @...` handles in one bullet are expected; do not drop or
     collapse contributor credit just because the note is grouped
   - if one grouped bullet covers both direct commits and PRs, keep all PR refs
     and thanks, plus any issue refs and human credit from the direct work
   - issues remain normal inline `#NNN` references. Do not add a separate
     linked-issues inventory. The generated PR record keeps source issues
     inline as `Related #NNN` on the PR that shipped them
   - when backfilling an older linked-issues inventory, preserve reporter
     credit inline for every GitHub-confirmed closing PR relationship. Do not
     infer a PR relationship from a generic cross-reference event, invent an
     unrelated PR link for a standalone report, or recreate the retired
     inventory
   - the complete contribution record lists every merged source PR exactly once
     as `**PR #NNN**`; source PRs include GitHub commit associations and merged
     PR references explicitly present in active commit subjects/bodies. It
     preserves author/co-author credit and any issue references in the original
     title
   - direct commits remain in the manifest with GitHub-resolved author,
     co-author, issue, and editorial-eligibility data. They inform grouped
     prose but are never rendered as a public `#### Direct commits` dump. Add
     direct-commit credit to a grouped bullet only when it shares an explicit
     closing issue reference or at least two distinctive subject terms
   - the verifier rejects `docs`, `test`, `refactor`, `ci`, `build`, `chore`,
     and `style` PRs in Highlights, Changes, or Fixes. Keep those internal
     contributions in the complete PR record, but do not give them editorial
     release-note space
   - classify internal-only work from conventional prefixes and clear title
     signals such as `QA`, `test`, `docs`, `refactor`, `lint`, or `CI`; an
     untyped title is not automatically editorial
   - do not add GHSA references, advisory IDs, or security advisory slugs to
     changelog entries or GitHub release-note text unless explicitly requested
   - never thank bots, `@claude`, `@openclaw`, `@clawsweeper`, or `@steipete`
   - do not use GitHub's release contributor count as the source of truth; the
     changelog must carry the complete human credit set itself
7. Sorting preference:
   - security/data-loss and content-boundary fixes
   - transcript/replay/reply delivery correctness
   - channels and mobile integrations
   - providers/Codex/local model reliability
   - install/update/release path reliability
   - performance and observability
   - docs and contributor-only/internal details last or omitted
8. Keep bullets single-line unless existing file style forces otherwise. Avoid
   internal release-process noise unless it changes user install/update safety.
9. Check release-note side conditions:
   - inspect `src/plugins/compat/registry.ts`
   - inspect `src/commands/doctor/shared/deprecation-compat.ts`
   - if any compatibility `removeAfter` is on/before release date, resolve it
     or explicitly record the blocker before shipping
10. Validate and ship:

- after the manifest-driven rewrite, regenerate and verify the complete
  contribution record before committing:
  ```bash
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
    --base <base-tag> \
    --target <target-ref> \
    --main-ref origin/main \
    --version <YYYY.M.PATCH> \
    --manifest /tmp/openclaw-release-<YYYY.M.PATCH>.json \
    --write-ledger
  ```
- the command fails when any `#NNN` reference in release history or the
  rendered release section cannot resolve, when reverted work is presented
  as shipped, when a source PR is absent from the contribution record, when
  direct commits are rendered as a public record dump, when non-editorial
  PRs appear in grouped prose, or when an eligible PR author or known
  co-author is missing from that PR's `Thanks @...` credit. It also fails
  before history collection when `--base` is not an ancestor of `--target`,
  when `### Highlights` has fewer than five or more than eight top-level
  bullets, or when the existing prose/record names a PR outside the source
  range. Only an explicit `--seed-ref` may add historical PR inventory; an
  explicit repeatable `--shipped-ref` may subtract PRs proven present in a
  prior shipped tag
- when grouped prose names a PR, that same bullet must retain every
  contributor and linked-reporter credit from its generated PR record
- unqualified `#NNN` references resolve against `openclaw/openclaw`;
  cross-repository references such as `openclaw/imsg#141` remain literal
  text and must not be rewritten as local issue links
- after the GitHub release or prerelease is published, verify every matching
  release page against the same source section:
  ```bash
  node .agents/skills/openclaw-changelog-update/scripts/verify-release-notes.mjs \
    --base <base-tag> \
    --target <target-ref> \
    --version <YYYY.M.PATCH> \
    --release-tag v<YYYY.M.PATCH> \
    --check-github
  ```
- add one `--release-tag` for every beta and stable page in the train; a
  `### Release verification` tail is permitted, but any other body drift
  fails the check
- `scripts/render-github-release-notes.mjs` is the canonical release-body
  renderer used by candidate validation, publish, and verification. When the
  complete `## YYYY.M.PATCH` section fits GitHub's 125,000-character limit and
  the renderer's matching 125,000-byte safety ceiling, the body must contain
  that exact section including its heading
- when the complete source section exceeds either limit, the renderer keeps the exact
  grouped editorial notes through the line before
  `### Complete contribution record`, then emits that heading with a stable
  link to the full contribution record in the tag-pinned `CHANGELOG.md`.
  Never truncate a bullet or partial record, and never hand-author a different
  compact form
- append `### Release verification` only when it fits after the canonical full
  or compact body is chosen. If it does not fit, omit the body tail and retain
  the immutable attached release evidence; never compact a fitting full
  contribution record just to preserve the optional tail
- `pnpm release:candidate` performs this deterministic render check from the
  exact tag before it dispatches Full Release Validation, including when local
  generated checks are explicitly skipped
- `git diff --check`
- for docs/changelog-only changes, no broad tests are required
- commit with `scripts/committer "docs(changelog): refresh YYYY.M.PATCH notes" CHANGELOG.md`
- record the new commit as the Release SHA and require
  `git diff --name-only <code-sha>..<release-sha>` to print only
  `CHANGELOG.md`
- push the release branch without rebasing it onto moving `main`
- dispatch SHA-pinned Full Release Validation for the Release SHA with evidence
  reuse enabled. It must select `changelog-only-release-v1`; any other changed
  path returns the release to the Code SHA validation loop

## Quota / API Outage Rule

If GitHub API quota is exhausted, do not idle. Continue work that does not need
GitHub API:

- local changelog rewrite and release-note extraction
- local pretag checks and package/build sanity
- git push/tag checks over git protocol
- npm registry `npm view` checks
- exact workflow-dispatch command preparation

Only GitHub Release creation, workflow dispatch, run polling, artifact download,
and issue/PR mutation need API quota.
