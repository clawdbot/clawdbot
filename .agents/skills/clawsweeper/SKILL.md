---
name: clawsweeper
description: Inspect ClawSweeper commit-review and issue/PR-sweeper reports for OpenClaw, including recent per-commit reports, finding summaries, GitHub Checks, Actions monitoring, manual backfills, and report links.
---

# ClawSweeper

ClawSweeper lives at `~/Projects/clawsweeper`. Use this skill when Peter asks
about ClawSweeper reports, commit-review checks, recent findings, historic
backfills, or whether the sweeper/dispatch lane is healthy.

## Start

```bash
cd ~/Projects/clawsweeper
git status --short
git pull --ff-only
pnpm run build
```

Do not overwrite unrelated local edits. If the tree is dirty, inspect status
and keep report-reading commands read-only unless Peter asked to commit.

## Recent Commit Reports

Canonical reports are flat:

```text
records/<repo-slug>/commits/<40-char-sha>.md
```

Use the lister instead of browsing date folders:

```bash
pnpm commit-reports -- --since 6h
pnpm commit-reports -- --since "24 hours ago" --findings
pnpm commit-reports -- --since 7d --non-clean
pnpm commit-reports -- --repo openclaw/openclaw --author steipete --since 7d
pnpm commit-reports -- --since 24h --json
```

One report per commit. Reruns overwrite the same SHA-named file. Results:
`nothing_found`, `findings`, `inconclusive`, `failed`, `skipped_non_code`.

## Monitor Actions

Receiver lane in `openclaw/clawsweeper`:

```bash
gh run list --repo openclaw/clawsweeper --workflow "ClawSweeper Commit Review" \
  --limit 12 --json databaseId,displayTitle,event,status,conclusion,createdAt,updatedAt,url
gh run list --repo openclaw/clawsweeper --workflow "ClawSweeper Commit Review" \
  --status in_progress --limit 20 --json databaseId,displayTitle,event,status,createdAt,url
```

Target dispatcher in `openclaw/openclaw`:

```bash
gh run list --repo openclaw/openclaw --workflow "ClawSweeper Dispatch" \
  --event push --limit 8 --json databaseId,displayTitle,event,status,conclusion,headSha,url
git ls-remote https://github.com/openclaw/openclaw.git refs/heads/main
```

Check the target commit's published report check:

```bash
gh api "repos/openclaw/openclaw/commits/<sha>/check-runs?per_page=100" \
  --jq '.check_runs[] | select(.name=="ClawSweeper Commit Review") | [.status,.conclusion,.details_url] | @tsv'
```

## Manual Commit Rerun / Backfill

Use the receiver workflow when Peter asks to rerun a specific commit report,
review a specific commit, or backfill a historic range. Reruns overwrite the
same canonical report file:
`records/<repo-slug>/commits/<40-char-sha>.md`.

Single-commit rerun:

```bash
gh workflow run commit-review.yml --repo openclaw/clawsweeper \
  -f target_repo=openclaw/openclaw \
  -f commit_sha=<sha> \
  -f before_sha=<parent-sha> \
  -f create_checks=false \
  -f enabled=true
```

Historic range backfill:

```bash
gh workflow run commit-review.yml --repo openclaw/clawsweeper \
  -f target_repo=openclaw/openclaw \
  -f commit_sha=<end-sha> \
  -f before_sha=<start-sha> \
  -f create_checks=false \
  -f enabled=true
```

Use `create_checks=true` only when Peter explicitly wants target commit check
runs. Checks are opt-in; markdown reports are the primary surface.

For a targeted rerun with extra instructions, add `additional_prompt`:

```bash
-f additional_prompt="Review this commit with focus on <topic>."
```

After dispatch, monitor and then pull the regenerated report:

```bash
gh run list --repo openclaw/clawsweeper --workflow "ClawSweeper Commit Review" \
  --limit 5 --json databaseId,displayTitle,status,conclusion,url
gh run watch <run-id> --repo openclaw/clawsweeper --interval 30 --exit-status
git pull --ff-only
sed -n '1,180p' records/openclaw-openclaw/commits/<sha>.md
```

## Report Reading

Lead with counts and useful findings:

```bash
pnpm commit-reports -- --since 24h
pnpm commit-reports -- --since 24h --findings
```

If findings exist, open the markdown report and summarize:

- SHA and author/co-authors
- result, confidence, severity, check conclusion
- concrete finding and affected file
- whether the report includes tests/live checks
- GitHub report URL:
  `https://github.com/openclaw/clawsweeper/blob/main/<report-path>`

Do not post GitHub comments from this lane. Commit Sweeper's public surfaces are
markdown reports and the `ClawSweeper Commit Review` check.
