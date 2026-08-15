---
name: notcrawl
description: "Notion archive: search, sync freshness, pages/databases, Markdown exports, SQL counts, and Notcrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/notcrawl
    requires:
      bins:
        - notcrawl
    install:
      - kind: go
        module: github.com/vincentkoc/notcrawl/cmd/notcrawl@latest
        bins:
          - notcrawl
---

# Notcrawl

Use local Notion archive data before browsing or live Notion API calls. Check freshness for recent/current questions:

```bash
notcrawl doctor
notcrawl status --json
```

Refresh only when stale or asked:

```bash
notcrawl sync --source desktop
notcrawl sync --source api
```

Query with bounded reads:

```bash
notcrawl search "query"
notcrawl databases
notcrawl report
notcrawl sql "select count(*) from pages;"
```

Report workspace/teamspace, page/database titles, absolute date spans, counts, and known gaps. Use read-only SQL only; never mutate the archive. API mode requires `NOTION_TOKEN`; do not assume token availability.
