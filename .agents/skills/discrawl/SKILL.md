---
name: discrawl
description: "Discord archive: search, sync freshness, DMs, summaries, TUI, repo/release work."
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

Use local Discord archives first. For recent/current questions, check
`discrawl status --json`; use `discrawl doctor` for source/config readiness.
Refresh only when stale, missing the requested scope, or explicitly requested.

```bash
discrawl sync --source wiretap  # local Discord Desktop artifacts
discrawl sync                   # configured source; bot API requires credentials
```

Use `--full` only for deliberate historical backfills. Do not interrupt another
archive writer to resolve a busy/locked database. Resolve configured paths
instead of assuming default macOS, XDG, or legacy locations.

## Read Bounded Slices

```bash
DISCRAWL_NO_AUTO_UPDATE=1 discrawl search --limit 20 "query"
discrawl messages --channel '<channel>' --days 7 --all
discrawl dms --last 20
DISCRAWL_NO_AUTO_UPDATE=1 discrawl --json sql "select count(*) as messages from messages;"
```

`DISCRAWL_NO_AUTO_UPDATE=1` suppresses git-share updates during read smokes.
`discrawl sql` is read-only by default and accepts SQL arguments or stdin. Use
it for exact counts/joins when normal reads are too coarse; never use
`--unsafe --confirm` without an explicitly requested and reviewed database
mutation. Consult subcommand help for filters. Report absolute date spans,
channel/DM names, counts, freshness, and source gaps.

## Source Boundaries

Desktop wiretap reads local artifacts; it must not extract credentials, use
user tokens, call Discord as the user, or write Discord application storage.
Bot sync needs configured bot credentials; never infer availability. Desktop
DMs are local-only, not part of the published Git snapshot. Git-share snapshots
must exclude secrets and `@me` DM rows.

For implementation work or a genuinely missing CLI feature, verify the checkout
remote is `openclaw/discrawl` and follow its instructions. Do not assume a
machine-specific historical checkout path.

## ClawSweeper Sandbox

Use the sandbox reader only:

```bash
discrawl-sandbox search --limit 20 "query"
discrawl-sandbox messages --channel clawtributors --days 7 --all
discrawl-sandbox status --json
```

This reader imports `https://github.com/openclaw/discord-store.git` into
`/root/clawsweeper-sandbox-workspace/.discrawl/discrawl.db` with
`discord.token_source = "none"`. The published Git snapshot is public-channel
filtered; do not use `/root/.discrawl/config.toml` or the rich writer DB from
sandboxed public Discord sessions.
