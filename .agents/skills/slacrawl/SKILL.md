---
name: slacrawl
description: "Slack archive: search, sync freshness, threads/DMs, SQL counts, and Slacrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/slacrawl
    requires:
      bins:
        - slacrawl
    install:
      - kind: go
        module: github.com/vincentkoc/slacrawl/cmd/slacrawl@latest
        bins:
          - slacrawl
---

# Slacrawl

Use local Slack archive data first. Check freshness for recent/current questions:

```bash
slacrawl doctor
slacrawl status --json
```

Refresh only when stale or asked:

```bash
slacrawl sync --source desktop
slacrawl sync --source api --latest-only
```

Query with bounded slices:

```bash
slacrawl search --limit 20 "query"
slacrawl messages --since 7d --limit 50
slacrawl sql "select count(*) from messages;"
```

Report workspace/channel names, absolute date spans, counts, and token/source limits. Use read-only SQL for exact counts/rankings. API sync and full thread/DM hydration require Slack tokens; do not assume they exist.
