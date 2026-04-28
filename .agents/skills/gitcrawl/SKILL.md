---
name: gitcrawl
description: Use gitcrawl for OpenClaw issue and PR archive search, duplicate discovery, related-thread clustering, and local GitHub mirror freshness checks.
metadata:
  openclaw:
    requires:
      bins:
        - gitcrawl
---

# Gitcrawl

Use this skill before live GitHub search when triaging OpenClaw issues or PRs.

`gitcrawl` is the local candidate-discovery layer. It is fast, includes open and closed threads, and can surface duplicate attempts, related issues, and already-landed fixes. It is not the final source of truth for comments, labels, merges, closes, or current CI.

## Default Flow

1. Check local state:

```bash
gitcrawl doctor --json
```

2. Read the target from the local archive:

```bash
gitcrawl threads openclaw/openclaw --numbers <issue-or-pr-number> --include-closed --json
```

3. Find related candidates:

```bash
gitcrawl neighbors openclaw/openclaw --number <issue-or-pr-number> --limit 12 --json
gitcrawl search openclaw/openclaw --query "<scope or title keywords>" --mode hybrid --limit 20 --json
```

4. Inspect relevant clusters:

```bash
gitcrawl cluster-detail openclaw/openclaw --id <cluster-id> --member-limit 20 --body-chars 280 --json
```

5. Verify anything actionable with live GitHub and the checkout:

```bash
gh pr view <number> --json number,title,state,mergedAt,body,files,comments,reviews,statusCheckRollup
gh issue view <number> --json number,title,state,body,comments,closedAt
```

## Freshness Rules

- Treat `gitcrawl` as stale if `doctor` shows no target thread, an old `last_sync_at`, missing embeddings for neighbor/search commands, or a clearly wrong open/closed state.
- If stale data blocks the decision, refresh the portable store first:

```bash
gitcrawl init --portable-store git@github.com:openclaw/gitcrawl-store.git --json
```

- Run expensive update commands such as `gitcrawl sync --include-comments` only when the user asked to update the local store or stale data is blocking the decision.
- The sync default is all GitHub thread states; pass `--state open`, `--state closed`, or `--state all` only when a task requires a narrower or explicit scope.

## Boundaries

- Use `gitcrawl` for candidates, clusters, and historical context.
- Use `gh`, `gh api`, and the current checkout for live state before commenting, labeling, closing, reopening, merging, or filing a PR review.
- Do not close or label based only on `gitcrawl` similarity. Require matching problem intent plus live verification.
- If `gitcrawl` is unavailable, say so and fall back to targeted `gh search` rather than blocking normal maintainer work.
