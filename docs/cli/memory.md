---
summary: "CLI reference for `openclaw memory` (status/index/search/promote/promote-explain/rem-harness)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Memory wiki: [Memory Wiki](/plugins/memory-wiki)
- Wiki CLI: [wiki](/cli/wiki)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --fix
openclaw memory index --force
openclaw memory search "meeting notes"
openclaw memory search --query "deployment" --max-results 20
openclaw memory promote --limit 10 --min-score 0.75
openclaw memory promote --apply
openclaw memory promote --json --min-recall-count 0 --min-unique-queries 0
openclaw memory promote-explain "router vlan"
openclaw memory promote-explain "router vlan" --json
openclaw memory rem-harness
openclaw memory rem-harness --json
openclaw memory status --json
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory status --agent main
openclaw memory index --agent main --verbose
```

## Options

`memory status` and `memory index`:

- `--agent <id>`: scope to a single agent. Without it, these commands run for each configured agent; if no agent list is configured, they fall back to the default agent.
- `--verbose`: emit detailed logs during probes and indexing.

`memory status`:

- `--deep`: probe vector + embedding availability.
- `--index`: run a reindex if the store is dirty (implies `--deep`).
- `--fix`: repair stale recall locks and normalize promotion metadata.
- `--json`: print JSON output.

`memory index`:

- `--force`: force a full reindex.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--max-results <n>`: limit the number of results returned.
- `--min-score <n>`: filter out low-score matches.
- `--json`: print JSON results.

`memory promote`:

Preview and apply short-term memory promotions.

```bash
openclaw memory promote [--apply] [--limit <n>] [--include-promoted]
```

- `--apply` -- write promotions to `MEMORY.md` (default: preview only).
- `--limit <n>` -- cap the number of candidates shown.
- `--include-promoted` -- include entries already promoted in previous cycles.

Full options:

- Ranks short-term candidates from `memory/YYYY-MM-DD.md` using weighted promotion signals (`frequency`, `relevance`, `query diversity`, `recency`, `consolidation`, `conceptual richness`).
- Uses short-term signals from both memory recalls and daily-ingestion passes, plus light/REM phase reinforcement signals.
- When dreaming is enabled, `memory-core` auto-manages one cron job that runs a full sweep (`light -> REM -> deep`) in the background (no manual `openclaw cron add` required).
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--limit <n>`: max candidates to return/apply.
- `--min-score <n>`: minimum weighted promotion score.
- `--min-recall-count <n>`: minimum recall count required for a candidate.
- `--min-unique-queries <n>`: minimum distinct query count required for a candidate.
- `--apply`: append selected candidates into `MEMORY.md` and mark them promoted.
- `--include-promoted`: include already promoted candidates in output.
- `--json`: print JSON output.

`memory promote-explain`:

Explain a specific promotion candidate and its score breakdown.

```bash
openclaw memory promote-explain <selector> [--agent <id>] [--include-promoted] [--json]
```

- `<selector>`: candidate key, path fragment, or snippet fragment to look up.
- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted candidates.
- `--json`: print JSON output.

`memory rem-harness`:

Preview REM reflections, candidate truths, and deep promotion output without writing anything.

```bash
openclaw memory rem-harness [--agent <id>] [--include-promoted] [--json]
```

- `--agent <id>`: scope to a single agent (default: the default agent).
- `--include-promoted`: include already promoted deep candidates.
- `--json`: print JSON output.

## Dreaming

Dreaming is the background memory consolidation system with three cooperative
phases: **light** (sort/stage short-term material), **deep** (promote durable
facts into `MEMORY.md`), and **REM** (reflect and surface themes).

- Enable with `plugins.entries.memory-core.config.dreaming.enabled: true`.
- Toggle from chat with `/dreaming on|off` (or inspect with `/dreaming status`).
- Dreaming runs on one managed sweep schedule (`dreaming.frequency`) and executes phases in order: light, REM, deep.
- Only the deep phase writes durable memory to `MEMORY.md`.
- Human-readable phase output and diary entries are written to `DREAMS.md` (or existing `dreams.md`), with optional per-phase reports in `memory/dreaming/<phase>/YYYY-MM-DD.md`.
- Ranking uses weighted signals: recall frequency, retrieval relevance, query diversity, temporal recency, cross-day consolidation, and derived concept richness.
- Promotion re-reads the live daily note before writing to `MEMORY.md`, so edited or deleted short-term snippets do not get promoted from stale recall-store snapshots.
- Scheduled and manual `memory promote` runs share the same deep phase defaults unless you pass CLI threshold overrides.
- Automatic runs fan out across configured memory workspaces.

Default scheduling:

- **Sweep cadence**: `dreaming.frequency = 0 3 * * *`
- **Deep thresholds**: `minScore=0.8`, `minRecallCount=3`, `minUniqueQueries=3`, `recencyHalfLifeDays=14`, `maxAgeDays=30`

Example:

```json
{
  "plugins": {
    "entries": {
      "memory-core": {
        "config": {
          "dreaming": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

Notes:

- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- If effectively active memory remote API key fields are configured as SecretRefs, the command resolves those values from the active gateway snapshot. If gateway is unavailable, the command fails fast.
- Gateway version skew note: this command path requires a gateway that supports `secrets.resolve`; older gateways return an unknown-method error.
- Tune scheduled sweep cadence with `dreaming.frequency`. Deep promotion policy is otherwise internal; use CLI flags on `memory promote` when you need one-off manual overrides.
- `memory rem-harness --path <file-or-dir> --grounded` previews grounded `What Happened`, `Reflections`, and `Possible Lasting Updates` from historical daily notes without writing anything.
- `memory rem-backfill --path <file-or-dir>` writes reversible grounded diary entries into `DREAMS.md` for UI review.
- `memory rem-backfill --path <file-or-dir> --stage-short-term` also seeds grounded durable candidates into the live short-term promotion store so the normal deep phase can rank them.
- `memory rem-backfill --rollback` removes previously written grounded diary entries, and `memory rem-backfill --rollback-short-term` removes previously staged grounded short-term candidates.
- See [Dreaming](/concepts/dreaming) for full phase descriptions and configuration reference.
