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
        module: github.com/openclaw/slacrawl/cmd/slacrawl@latest
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
slacrawl sync --source wiretap
slacrawl sync --source bot --latest-only
```

`wiretap` reads Slack Desktop cache; `bot` uses API tokens. The `desktop`/`api`
aliases remain valid. A configured connector can use `--source mcp`; select the
workspace explicitly when needed. Use `--full` only for deliberate backfills.

Query with bounded slices:

```bash
slacrawl search --limit 20 "query"
slacrawl messages --since 7d --limit 50
slacrawl sql "select count(*) from messages;"
```

Report workspace/channel names, absolute date spans, counts, and token/source limits. Use read-only SQL for exact counts/rankings. API sync and full thread/DM hydration require Slack tokens; do not assume they exist.
