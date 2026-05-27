---
name: openclaw-changelog-update
description: Regenerate OpenClaw release changelog sections from git history before beta or stable releases.
---

# OpenClaw Changelog Update

Use this for release changelog rewrites and GitHub release-note source text.
Use it with `release-openclaw-maintainer`; this skill owns changelog content,
ordering, and audit discipline.

## Goal

Rewrite the target `CHANGELOG.md` version section from history, not from stale
draft notes. Produce user-facing release notes sorted by user interest while
preserving issue/PR refs and thanks.

## Inputs

- Target base version: `YYYY.M.D`, without beta suffix.
- Base tag: last reachable shipped release tag, usually the previous stable or
  the previous beta train requested by the operator.
- Target ref: exact branch/SHA being released.

## Workflow

1. Start on `main` before branching when possible:
   - `git fetch --tags origin`
   - `git pull --ff-only`
   - confirm clean `git status -sb`
2. Audit history, including direct commits:
   - `git log --first-parent --date=iso-strict --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - `git log --first-parent --grep='(#' --date=short --pretty=format:'%h%x09%ad%x09%s' <base-tag>..<target-ref>`
   - also inspect `--since='24 hours ago'` when main moved during the release.
3. Read linked PRs/issues or diffs for ambiguous commits. Direct commits matter;
   infer notes from subject, body, touched files, tests, and nearby commits.
4. Rewrite one stable-base section only:
   - use `## YYYY.M.D`
   - do not create beta-specific headings
   - do not leave a stale `## Unreleased` section above the target release
   - if `Unreleased` contains release-bound notes, fold them into the target
     section instead of deleting them
5. Section shape:
   - `### Highlights`: 5-8 bullets, broad user wins first
   - `### Changes`: new capabilities and behavior changes
   - `### Fixes`: user-facing fixes first, grouped by impact and surface
6. Preserve attribution:
   - keep `#issue`, `(#PR)`, `Fixes #...`, and `Thanks @...`
   - do not add GHSA references, advisory IDs, or security advisory slugs to
     changelog entries or GitHub release-note text unless explicitly requested
   - never thank bots, `@openclaw`, `@clawsweeper`, or `@steipete`
   - if grouping multiple entries, carry all relevant refs and thanks into the
     grouped bullet
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
   - `git diff --check`
   - for docs/changelog-only changes, no broad tests are required
   - commit with `scripts/committer "docs(changelog): refresh YYYY.M.D notes" CHANGELOG.md`
   - push, pull/rebase if needed, then branch/rebase release from latest `main`

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
