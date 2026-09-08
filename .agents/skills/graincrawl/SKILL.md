---
name: graincrawl
description: "Granola archive: search, sync freshness, notes, transcripts, panels, SQL counts, and Graincrawl repo work."
metadata:
  openclaw:
    homepage: https://github.com/openclaw/graincrawl
    requires:
      bins:
        - graincrawl
    install:
      - kind: go
        module: github.com/openclaw/graincrawl/cmd/graincrawl@latest
        bins:
          - graincrawl
---

# Graincrawl

Use local Granola archive data first. Check freshness for recent/current questions:

```bash
graincrawl doctor --json
graincrawl status --json
```

Refresh only when stale or asked:

```bash
graincrawl sync --source private-api
graincrawl sync --source desktop-cache
```

Query with bounded reads:

```bash
graincrawl search "query"
graincrawl notes --json
graincrawl note get <id>
graincrawl transcripts get <id>
graincrawl panels get <id>
graincrawl --json sql "select count(*) as notes from notes;"
```

Report absolute date spans, note titles, source gaps, and transcript/panel availability. Use read-only SQL for exact counts/rankings. Ordinary reads must not surprise-prompt Keychain. Before encrypted source debugging, inspect `graincrawl secrets --json`; use `graincrawl unlock --json` before enabling encrypted sources. Resolve the database from status/config rather than assuming a machine-specific path.
