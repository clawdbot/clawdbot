---
summary: "CLI reference for `openclaw memory` (status/index/search/forget/promote/promote-explain/rem-harness/rem-backfill/session-backfill)"
read_when:
  - You want to index or search semantic memory
  - You're debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
  - You need to delete provenance-tracked memories derived from specific sessions or participants
title: "Memory"
---

# `openclaw memory`

Manage semantic memory indexing, search, promotion into `MEMORY.md`, and
provenance-based deletion.
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

| Flag        | Effect                                                                                                                                                                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--deep`    | Probe vector-store, embedding-provider, and semantic-search readiness (implies extra provider calls). Plain `memory status` stays fast and skips this; a complete persisted index is shown as `indexed (unprobed)`, while unknown vector/semantic state means it was not probed. |
| `--index`   | Reindex if the store is dirty. Implies `--deep`.                                                                                                                                                                                                                                 |
| `--fix`     | Repair stale recall locks and normalize promotion metadata.                                                                                                                                                                                                                      |
| `--json`    | Print JSON.                                                                                                                                                                                                                                                                      |
| `--verbose` | Emit detailed per-phase logs.                                                                                                                                                                                                                                                    |

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
extra-path details before showing indexing progress. The completion message
reports the indexed file count. An empty corpus is a successful no-op: the
command reports the resolved workspace path and that nothing was indexed, and
leaves the missing `memory/` directory for the first memory write to create.
Internal dreaming-narrative, cron, and heartbeat session transcripts are
excluded from indexing, including retained compressed narrative archives whose
original sessions are no longer active. Sessions previously selected by
`memory forget` also remain excluded. `--force` removes stale index records for
both groups without reindexing their retained transcripts. Ordinary retained,
reset, and deleted user-session archives remain eligible until explicitly
targeted.

## `memory search`

```bash
openclaw memory search [query] [--query <text>] [--agent <id>] [--max-results <n>] [--min-score <n>] [--json]
```

- Query: positional `[query]` or `--query <text>`. If both are set, `--query`
  wins. If neither is set, the command errors.
- `--agent <id>`: defaults to the default agent (not the full agent list).
- `--max-results <n>`: cap result count (positive integer).
- `--min-score <n>`: filter out matches below this score.

If the index remains dirty after the bounded search-time refresh, human output
warns that matches may be incomplete. With `--json`, the response adds
`stale: true`, plus `warning` and `action` fields describing how to rebuild the
index. Treat an empty `results` array as authoritative only when `stale` is
absent.

## `memory forget`

Delete provenance-tracked durable memory entries derived from selected
sessions, together with their indexed and short-term copies. The concepts
behind this command — recorded lineage, admission policy, and the deletion
guarantees and boundaries — are explained in
[Memory provenance and deletion](/concepts/memory-provenance). Select sessions
by ID or session key, their external-content hook source, or a participant's
actor ID:

```bash
openclaw memory forget --session <id-or-key> [--session <id-or-key> ...]
openclaw memory forget --hook-source gmail [--since 2026-01-01]
openclaw memory forget --participant <actor-id> [--agent <id>] [--dry-run] [--json]
```

`--session`, `--hook-source`, and `--participant` are repeatable. At least one
selector is required. `--agent` selects one agent and otherwise defaults to the
default agent. Explicit session IDs and keys match both live sessions and
retained archived sessions. An unknown explicit value is still treated as an
exact session ID, purged where matching artifacts exist, and durably excluded
from future memory ingestion. The report identifies each selected session as
`live`, `archived`, or `unresolved`. Hook-source and participant selectors only
match sessions whose corresponding metadata still exists; archived sessions do
not retain those facts, so select them by ID or key instead. `--since <date>`
filters live sessions by their creation time and archived sessions by their
archive creation time; unresolved explicit IDs have no timestamp and remain
selected.

Run with `--dry-run` before deleting. It computes the same complete report as
the real purge without changing memory files, SQLite indexes, plugin state, or
durable deletion records. `--json` prints that report as machine-readable JSON.

A purge removes matching pipeline-promoted entries, session-corpus lines,
selected-session transcript index chunks, full-text and vector index records,
embedding-cache entries, short-term recall, seen-hash scopes, dreaming rewrite
backups, and recorded origins. It also clears stale index records for internal
dreaming-narrative, cron, or heartbeat sessions. An entry derived from both
selected and unselected sessions is deleted whole and reported as a
mixed-lineage entry; dreaming can regenerate supported facts from surviving
sessions later. Entries without recorded origins remain searchable and are not
deleted by an unrelated selector; the report lists them as untargetable.

A real purge records each selected session as forgotten in the agent's SQLite
database. Future dreaming sweeps record that session as excluded with reason
`forgotten`; `memory session-backfill` and transcript indexing, including
`memory index --force`, also reject it. Repeating the purge is safe and does
not undo this exclusion.

Dream diaries and other workspace memory files can quote source-session corpus
lines without retaining a session reference. The purge removes any whole line
containing an exact purged corpus-line snippet from files such as
`memory/dreaming/**/*.md` and `DREAMS.md`, as well as matching dreaming
backups. `artifacts.memoryLines` reports the number of these additional removed
memory-file lines. Model-paraphrased prose that does not contain the exact
source text cannot be attributed reliably and is not removed automatically.

Direct agent edits to memory files are tracked at the file level, not per
entry. When such a write happened during a selected session, `curatedWrites`
lists its `relativePath` and `observedAt` without modifying the file. Evidence
comes from native write-observer records and the selected sessions' live or
archived transcripts, including writes performed by external agent harnesses.
Review those files separately: a freeform edit cannot be attributed to
individual lines safely enough for automatic deletion.

<Warning>
`memory forget` removes selected-session transcript chunks from the memory
index and permanently prevents their memory-pipeline readmission, but does not
delete the original source session transcripts. The report identifies the
selected sessions so you can remove transcript data separately through its
owning session-management workflow when required.
</Warning>

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
| `--min-unique-queries <n>` | `3`          | Minimum distinct query count required.                            |
| `--apply`                  | preview only | Append selected candidates to `MEMORY.md` and mark them promoted. |
| `--include-promoted`       |              | Include candidates already promoted in previous cycles.           |
| `--json`                   |              | Print JSON.                                                       |

The CLI and scheduled dreaming sweep share the deep-phase defaults below.
Explicit CLI flags override them for a one-off manual run.

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

## `memory session-backfill`

Distill retained session history through the same provenance and short-term
staging pipeline used by dreaming. The default is a read-only preview, ordered
from the oldest unprocessed day to the newest.

```bash
openclaw memory session-backfill --agent <id> [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
  [--limit-days <n>] [--archive-files <path...>] [--rem | --apply] [--json]
openclaw memory session-backfill --agent <id> --rollback [--json]
```

| Flag                        | Default      | Effect                                                                                                        |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| `--from YYYY-MM-DD`         |              | Include messages on or after this day in the dreaming timezone.                                               |
| `--to YYYY-MM-DD`           |              | Include messages on or before this day in the dreaming timezone.                                              |
| `--limit-days <n>`          | `92`         | Process at most this many hash-untracked days, oldest first.                                                  |
| `--archive-files <path...>` |              | Also inspect foreign transcript files as untrusted input; embedded owner metadata is not accepted.            |
| `--rem`                     |              | Write deterministic grounded per-day previews to `DREAMS.md` only.                                            |
| `--apply`                   | preview only | Drain all bounded batches, stage trusted candidates, and write reversible `DREAMS.md` diary blocks.           |
| `--rollback`                |              | Remove all grounded backfill candidates and shared backfill diary blocks, including `rem-backfill` artifacts. |
| `--json`                    |              | Print machine-readable per-day counts and top candidates.                                                     |

The command reads the selected agent's canonical session store, including
retained SQLite transcript identities from session rotation. It uses the same
tracked message hashes and per-run caps as live session ingestion, so repeated
`--apply` runs skip already ingested messages. Owner and agent lines from the
canonical store are eligible; tool output, web or non-owner input, and turns
without trustworthy owner provenance are excluded. Foreign archive files have
no authenticated owner-provenance contract, so their embedded ownership fields
remain untrusted and cannot be staged. Sessions previously purged with
[`memory forget`](/cli/memory#memory-forget) remain durably excluded, including
when their original transcripts still exist or their tracked hashes were
cleared.

`--apply` drains the selected history to completion in one invocation while
keeping each bounded batch in its own transaction. Human and JSON output report
per-batch progress plus total batches, candidates, and staged entries. A
successful apply followed immediately by preview therefore reports zero new
candidates. It writes only the session corpus under `memory/.dreams/`, short-term
staging state, and reversible diary entries in `DREAMS.md`. It never writes
`MEMORY.md` or `USER.md`; durable promotion remains a separate `memory promote`
or dreaming decision. `--rem` and `--apply` are mutually exclusive.

Backfill rollback is intentionally shared with `memory rem-backfill`: both
commands use the same grounded-only staging class and diary markers. Run
`session-backfill --rollback` only when you intend to clear both commands'
grounded backfill artifacts from that workspace. Rollback also removes the
tracked hashes added by session backfill and rewinds the affected transcript
cursors, so surviving eligible candidates can be previewed and applied again.
Rollback does not remove forgotten-session records or readmit purged sessions.

## Dreaming

Dreaming is the background memory consolidation system with three cooperative
phases, run in order on one schedule: **light** (sort/stage short-term
material), **REM** (reflect and surface themes), **deep** (promote durable
facts into `MEMORY.md`). Only deep writes to `MEMORY.md`.

- Enable with `plugins.entries.memory-core.config.dreaming.enabled: true`
  (default `true`); `memory-core` auto-manages the sweep cron job, no manual
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
- Scheduled and manual `memory promote` runs share the same deep-phase ranking
  signals and default thresholds; explicit CLI flags remain one-run overrides.
- Scheduled runs fan out across every configured agent's memory workspace.

Scheduled defaults (`plugins.entries.memory-core.config.dreaming`):

| Key                                    | Default     |
| -------------------------------------- | ----------- |
| `frequency`                            | `0 3 * * *` |
| `phases.deep.minScore`                 | `0.75`      |
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
