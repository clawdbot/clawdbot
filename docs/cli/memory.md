---
summary: "CLI reference for `openclaw memory` (status/index/search/promote/promote-explain/rem-harness/rem-backfill)"
read_when:
  - You want to index or search semantic memory
  - You're debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
title: "Memory"
---

# `openclaw memory`

Manage semantic memory indexing, search, and promotion into `MEMORY.md`.
Provided by the bundled `memory-core` plugin, available when
`plugins.slots.memory` selects `memory-core` (the default). Other memory
plugins expose their own CLI namespaces.

Related: [Memory](/concepts/memory) concept, [Dreaming](/concepts/dreaming),
[Memory config reference](/reference/memory-config), [Memory Wiki](/plugins/memory-wiki),
[wiki](/cli/wiki), [Plugins](/tools/plugin).

## `memory status`

```bash
openclaw memory status [--agent <id>] [--deep] [--index] [--fix] [--json] [--verbose]
```

Without `--agent`, runs for every agent in `agents.entries`; if no agent list is
configured, falls back to the default agent.

| Flag        | Effect                                                                                                                                                                                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deep`    | Probe vector-store, embedding-provider, and semantic-search readiness (implies extra provider calls). Plain `memory status` stays fast and skips this; unknown vector/semantic state means it was not probed. QMD lexical `searchMode: "search"` always skips semantic vector probes, even with `--deep`. |
| `--index`   | Reindex if the store is dirty. Implies `--deep`.                                                                                                                                                                                                                                                          |
| `--fix`     | Repair stale recall locks and normalize promotion metadata.                                                                                                                                                                                                                                               |
| `--json`    | Print JSON.                                                                                                                                                                                                                                                                                               |
| `--verbose` | Emit detailed per-phase logs.                                                                                                                                                                                                                                                                             |

If the `Dreaming` line stays `off` even with `dreaming.enabled: true`, or
scheduled sweeps never seem to run, the managed dreaming cron depends on the
default agent's heartbeat firing to trigger reconciliation. See
[Dreaming](/concepts/dreaming) for scheduling details.

Status also lists any extra search paths from `memory.search.extraPaths`.

## `memory index`

```bash
openclaw memory index [--agent <id>] [--force] [--verbose]
```

Same per-agent scoping as `status`. `--force` runs a full reindex instead of
an incremental one. `--verbose` prints per-agent provider, model, sources, and
extra-path details before showing indexing progress.

## `memory search`

```bash
openclaw memory search [query] [--query <text>] [--agent <id>] [--max-results <n>] [--min-score <n>] [--json]
```

- Query: positional `[query]` or `--query <text>`. If both are set, `--query`
  wins. If neither is set, the command errors.
- `--agent <id>`: defaults to the default agent (not the full agent list).
- `--max-results <n>`: cap result count (positive integer).
- `--min-score <n>`: filter out matches below this score.

## `memory promote`

Rank short-term candidates from `memory/YYYY-MM-DD.md` and optionally append
top entries to `MEMORY.md`.

```bash
openclaw memory promote [--agent <id>] [--limit <n>] [--min-score <n>] \
  [--min-recall-count <n>] [--min-unique-queries <n>] [--apply] [--include-promoted] [--json]
```

| Flag                       | Default      | Effect                                                            |
| -------------------------- | ------------ | ----------------------------------------------------------------- |
| `--limit <n>`              |              | Max candidates to return/apply.                                   |
| `--min-score <n>`          | `0.75`       | Minimum weighted promotion score.                                 |
| `--min-recall-count <n>`   | `3`          | Minimum recall count required.                                    |
| `--min-unique-queries <n>` | `2`          | Minimum distinct query count required.                            |
| `--apply`                  | preview only | Append selected candidates to `MEMORY.md` and mark them promoted. |
| `--include-promoted`       |              | Include candidates already promoted in previous cycles.           |
| `--json`                   |              | Print JSON.                                                       |

These CLI defaults differ from the scheduled dreaming sweep's deep-phase
thresholds (see [Dreaming](#dreaming) below); pass explicit flags to match
sweep behavior for a one-off manual run.

Ranking signals: recall frequency, retrieval relevance, query diversity,
temporal recency, cross-day consolidation, and derived concept richness, drawn
from both memory recalls and daily-ingestion passes, plus a light/REM phase
reinforcement boost for repeated dreaming revisits. Before writing, promotion
re-reads the live daily note, so edits or deletions to short-term snippets
since ranking are respected instead of promoting from a stale snapshot.

## `memory promote-explain`

Explain one promotion candidate's score breakdown.

```bash
openclaw memory promote-explain <selector> [--agent <id>] [--include-promoted] [--json]
```

`<selector>` matches a candidate's key (exact or substring), path, or snippet
text.

## `memory rem-harness`

Preview REM reflections, candidate truths, and deep-phase promotion output
without writing anything.

```bash
openclaw memory rem-harness [--agent <id>] [--path <file-or-dir>] [--grounded] [--include-promoted] [--json]
```

- `--path <file-or-dir>`: seed the harness from historical `YYYY-MM-DD.md`
  daily files instead of the live workspace.
- `--grounded`: also render a grounded `What Happened` / `Reflections` /
  `Possible Lasting Updates` preview from the historical notes.

## `memory rem-backfill`

Write grounded historical REM summaries into `DREAMS.md` for UI review.
Reversible.

```bash
openclaw memory rem-backfill --path <file-or-dir> [--agent <id>] [--stage-short-term] [--json]
openclaw memory rem-backfill --rollback [--rollback-short-term] [--json]
```

- `--path <file-or-dir>`: required unless `--rollback`/`--rollback-short-term`
  is set. Historical daily memory file(s) or directory to backfill from.
- `--stage-short-term`: also seed grounded durable candidates into the live
  short-term promotion store so the normal deep phase can rank them.
- `--rollback`: remove previously written grounded diary entries from
  `DREAMS.md`.
- `--rollback-short-term`: remove previously staged grounded short-term
  candidates.

## Dreaming

Dreaming is the background memory consolidation system with three cooperative
phases, run in order on one schedule: **light** (sort/stage short-term
material), **REM** (reflect and surface themes), **deep** (promote durable
facts into `MEMORY.md`). Only deep writes to `MEMORY.md`.

- Enable with `plugins.entries.memory-core.config.dreaming.enabled: true`
  (default `false`); `memory-core` auto-manages the sweep cron job, no manual
  `openclaw cron add` required.
- Toggle from chat with `/dreaming on|off`; inspect with `/dreaming status`
  (or `/dreaming`/`/dreaming help`). `on`/`off` requires channel owner status
  or gateway `operator.admin`; `status` and help stay available to anyone who
  can invoke the command.
- Human-readable phase output goes to `DREAMS.md` (or an existing `dreams.md`).
  By default (`dreaming.storage.mode: "separate"`) each phase also writes a
  standalone report to `memory/dreaming/<phase>/YYYY-MM-DD.md`; set `mode:
"inline"` to fold reports into the daily memory file instead, or `"both"`
  for both.
- Scheduled and manual `memory promote` runs share the same deep-phase
  ranking signals; only the default thresholds differ (see table above vs.
  scheduled defaults below).
- Scheduled runs fan out across every configured agent's memory workspace.

Scheduled defaults (`plugins.entries.memory-core.config.dreaming`):

| Key                                    | Default     |
| -------------------------------------- | ----------- |
| `frequency`                            | `0 3 * * *` |
| `phases.deep.minScore`                 | `0.8`       |
| `phases.deep.minRecallCount`           | `3`         |
| `phases.deep.minUniqueQueries`         | `3`         |
| `phases.deep.recencyHalfLifeDays`      | `14`        |
| `phases.deep.maxAgeDays`               | `30`        |
| `phases.deep.maxPromotedSnippetTokens` | `160`       |

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

Full key list and phase details: [Dreaming](/concepts/dreaming),
[Memory config reference](/reference/memory-config#dreaming).

## SecretRef gateway dependency

If active memory remote API key fields are configured as SecretRefs, `memory`
commands resolve them from the active gateway snapshot; if the gateway is
unavailable, the command fails fast. This requires a gateway supporting the
`secrets.resolve` method; older gateways return an unknown-method error.

## Related

- [CLI reference](/cli)
- [Memory overview](/concepts/memory)
