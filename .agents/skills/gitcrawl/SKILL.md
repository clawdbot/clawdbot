---
name: gitcrawl
description: "GitHub archive: issue/PR search, sync freshness, duplicate clusters, current GitHub handoff, and Gitcrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/gitcrawl
    requires:
      bins:
        - gitcrawl
    install:
      - kind: go
        module: github.com/openclaw/gitcrawl/cmd/gitcrawl@latest
        bins:
          - gitcrawl
---

# Gitcrawl

Use local GitHub archives for discovery; verify current GitHub state before a
maintainer decision or public mutation. Check freshness and configured database
paths with `gitcrawl doctor --json`.

```bash
gitcrawl threads owner/repo --numbers <number> --include-closed --json
gitcrawl neighbors owner/repo --number <number> --limit 12 --json
gitcrawl search issues "query" -R owner/repo --state open --json number,title,url
gitcrawl clusters owner/repo --sort size --min-size 5
gitcrawl cluster-detail owner/repo --id <cluster-id>
```

For stale results, use a bounded `--sync-if-stale 5m` search or targeted
`gitcrawl sync owner/repo --numbers 123,456 --with pr-details`. The latter
hydrates local PR files, commits, checks, workflow runs, and review-thread
resolution; it does not populate the separate GitHub CLI cache.

## Current GitHub State

Use bare PATH `gh` and narrow native JSON fields:

```bash
gh pr view <number> -R owner/repo --json number,title,state,url,isDraft,headRefName,headRefOid
gh pr checks <number> -R owner/repo --json name,state,bucket,link
gh issue view <number> -R owner/repo --json number,title,state,closedAt,url
```

`gitcrawl gh` was removed. Its exit 2 is a migration notice, not an auth failure.
Do not pass its `--live`/`--cached` flags or old field names to `gh`, restore an
old Gitcrawl, bypass the existing Octopool shim, or change auth/PATH/config to
repair that removed command. Octopool owns the shared `gh` cache; Gitcrawl owns
the local archive. See the [upstream migration guide](https://github.com/openclaw/gitcrawl/blob/main/docs/gh-shim.md)
when setting up or diagnosing that handoff.

## Archive Boundaries

Archive state and similarity are candidate evidence, not proof of a duplicate
or resolved issue. Report repository, issue/PR numbers, absolute date spans,
cluster IDs, freshness, and known gaps. `close-thread`, `close-cluster`, and
canonical-member choices are local overrides; they do not mutate GitHub.
Public mutations use authorized `gh` workflows and checkout proof.

For exact archive counts, Gitcrawl has no `sql` subcommand. Resolve `.db_path`
from `doctor --json` and use `sqlite3 -readonly`; do not modify database rows
instead of using the maintainer commands. For Gitcrawl implementation work,
verify the checkout remote is `openclaw/gitcrawl` and use its own instructions.
