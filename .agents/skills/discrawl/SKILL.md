---
name: discrawl
description: "Discord archive: search, sync freshness, DMs, channel slices, SQL counts, and Discrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/discrawl
    requires:
      bins:
        - discrawl
    install:
      - kind: go
        module: github.com/openclaw/discrawl/cmd/discrawl@latest
        bins:
          - discrawl
---

# Discrawl

Use local Discord archive data before live Discord APIs. Check freshness for recent/current questions:

```bash
discrawl status --json
discrawl doctor
```

Refresh only when stale or asked:

```bash
discrawl sync --source wiretap
discrawl sync
```

Query with bounded slices:

```bash
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "query"
discrawl messages --channel '#maintainers' --days 7 --all
discrawl dms --last 20
DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json sql "select count(*) from messages;"
```

Report absolute date spans, channel/DM names, counts, and known gaps. Use read-only SQL for exact counts/rankings. Never use `--unsafe --confirm` unless the user explicitly requests a reviewed DB mutation.

Boundaries: bot sync needs configured Discord bot credentials. Wiretap reads local Discord Desktop artifacts only; do not extract user tokens, call Discord as the user, or write to Discord storage. Git-share snapshots must not include secrets or `@me` DM rows.
