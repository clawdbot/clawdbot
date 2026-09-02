---
summary: "CLI reference for `openclaw memory` (status/index/reset/search/forget/promote/promote-explain/rem-harness/rem-backfill/session-backfill)"
read_when:
  - You want to index or search semantic memory
  - You're debugging memory availability or indexing
  - You want to promote recalled short-term memory into `MEMORY.md`
  - You need to delete provenance-tracked memories derived from specific sessions or participants
title: "Memory"
doc-schema-version: 1
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
For providers that discover their default model at initialization, plain status
defers model identity checks until that model is known. Use `--deep` to initialize
the provider and verify the model and provider settings against the existing index.

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

If status reports an index identity warning after changing embedding settings,
check the affected agent's provider, model, sources, and extra paths, then rebuild:

```bash
openclaw memory status --deep --agent <id>
openclaw memory index --force --agent <id>
openclaw memory status --agent <id>
```

`openclaw memory status --index --agent <id>` also rebuilds an incompatible index.
Both repair commands replace the derived memory index while preserving other agent
state. Use `--agent` to limit the repair to the affected agent.

<Warning>
The default `openclaw-agent.sqlite` database also contains canonical sessions,
transcripts, and other durable agent state. Never delete it or its `-wal`,
`-shm`, or `-journal` sidecars to reset a memory index. Use `memory index --force`
to rebuild, or [`memory reset`](/cli/memory#memory-reset) to clear the derived index and
embedding cache; see
[Safe index recovery](/concepts/memory-builtin#safe-index-recovery).
</Warning>

## `memory reset`

Clear the builtin memory index and embedding cache without deleting sessions,
transcripts, or memory files.

```bash
openclaw memory reset [--agent <id>] [--yes]
```

Same per-agent scoping as `status` and `index`: without `--agent`, reset runs for
every configured agent, falling back to the default agent when no list is
configured. The command asks for confirmation. `--yes` skips the prompt and is
required in a non-interactive terminal.

Reset atomically drops and recreates only memory-owned derived tables in
`agents/<agentId>/agent/openclaw-agent.sqlite`, clearing indexed content and
cached embeddings while retaining required revision bookkeeping. Non-memory
database tables and memory source files remain untouched. An agent with no index
is a successful no-op. Reset coordinates with existing memory maintenance and
does not restart the Gateway; a running Gateway can reindex retained sources
afterward. If indexing is busy, let it finish and retry reset.

Rebuild from retained sources afterward:

```bash
openclaw memory reset --agent main --yes
openclaw memory index --agent main
```

Reset does not shrink the database file or restore data already lost by deleting
it. It is not a privacy purge: use [`memory forget`](/cli/memory#memory-forget) to remove
tracked memory derived from selected sessions and prevent re-ingestion.

## `memory search`

```bash
openclaw memory search [query] [--query <text>] [--agent <id>] [--max-results <n>] [--min-score <n>] [--json]
```

- Query: positional `[query]` or `--query <text>`. If both are set, `--query`
  wins. If neither is set, the command errors.
- `--agent <id>`: defaults to the default agent (not the full agent list).
- `--max-results <n>`: cap result count (positive integer).
- `--min-score <n>`: filter out matches below this score.

Routine indexing can continue after search returns and does not add a warning.
If automatic indexing failed, or the index identity is incompatible, human
output warns that matches may be incomplete. With `--json`, the response adds
`stale: true`, plus `warning` and `action` fields. Treat an empty `results`
array as authoritative only when `stale` is absent.

## `memory forget`

Remove identifiable memory artifacts derived from selected sessions and record
those sessions as forgotten in one agent's store. See
[Memory provenance and deletion](/concepts/memory-provenance) for the
relationship between lineage, admission policy, and deletion coverage.

<Warning>
This command deletes immediately unless `--dry-run` is set. There is no
confirmation prompt or `--apply` flag. Source session transcripts are retained.
</Warning>

Start with a preview:

```bash
openclaw memory forget --agent <agent-id> --session <id-or-key> --dry-run --json
openclaw memory forget --agent <agent-id> --hook-source gmail --dry-run --json
openclaw memory forget --agent <agent-id> --participant <actor-id> --dry-run --json
```

After checking the report, repeat the intended command without `--dry-run`.

| Flag                       | Effect                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`             | Select one agent. Defaults to the default agent, not all agents.                                               |
| `--session <id-or-key>`    | Select by session ID or key; repeatable.                                                                       |
| `--hook-source <source>`   | Select live sessions with this recorded external-content hook source; repeatable.                              |
| `--participant <actor-id>` | Select live sessions with this recorded participant actor ID; repeatable.                                      |
| `--since <date>`           | Include sessions created on or after the date. Use an ISO timestamp with a timezone for an unambiguous cutoff. |
| `--dry-run`                | Compute a report without changing memory files, indexes, plugin state, or forgotten-session records.           |
| `--json`                   | Print the full report as JSON.                                                                                 |

### Session selection

At least one selector is required. Repeated values and different selector
types combine with **OR**: a session matching any selector is selected, subject
to `--since`. Selectors match recorded identifiers, not names or text in
messages. A participant selector selects the whole session, including other
participants' contributions.

`--participant` intentionally matches raw actor IDs across identity namespaces;
it is not a profile-only selector. The report's `participantMatches` shows the
typed identities matching each requested ID, including ambiguous matches.
Review these identities and the selected whole sessions in `--dry-run --json`
before deleting. Profile merges do not silently reinterpret a raw selector.

Explicit IDs and keys resolve against live sessions and retained archives in
the configured `session.store`, including custom and shared stores. Matching
remains scoped to the selected agent.
The report labels each result `live`, `archived`, or `unresolved`. An
unresolved explicit value is recorded literally as a session ID for future
exclusion; it does not prove that the requested session was found. IDs match
exactly and case-sensitively, including when matching retained archive names.
An abbreviation does not select a longer session ID.

Hook-source and participant selectors require live metadata; archived-only
records do not retain those facts. Select those archives by full ID or key.
Hook-source matching is exact: IMAP uses `email`, Gmail hooks use `gmail`, and
generic webhooks use `webhook`. Older retained records containing only a coarse
`webhook` classification cannot distinguish IMAP from a generic webhook when
the original exact source is gone; select those sessions by full ID instead.
`--since` uses the live session's creation time or the archive's creation time,
not individual message timestamps. Unresolved explicit IDs have no timestamp
and remain selected.

### Read the report

| Field                              | Meaning                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentId`, `dryRun`                | Store selected and whether this was a preview.                                                                                                       |
| `sessionIds`, `sessionResolutions` | Selected IDs and how each resolved; a resolution may also include `sessionKey`.                                                                      |
| `entryKeys`                        | Entry keys with at least one origin in the selected sessions.                                                                                        |
| `mixedLineageEntryKeys`            | Selected entries that also have unselected origins; they are removed whole.                                                                          |
| `untargetableEntryKeys`            | Promotion markers found without origin rows in this agent's store. This does not enumerate unmarked prose.                                           |
| `curatedWrites`                    | Files to review, with `relativePath` and `observedAt` (Unix milliseconds). Includes supported recorded write attempts, which may not have succeeded. |
| `artifacts`                        | Counts of matching files, entries, lines, and store rows described below.                                                                            |
| `refusals`                         | Historical consolidation highlights needing manual review. An empty list does not establish complete deletion coverage.                              |

Preview and apply use the same matching logic, but each reads current state;
a preview is not an immutable plan or a lock on subsequent writes. Apply
coordinates with the memory plugin's staging and file mutations. Indexing
discards stale results instead of restoring purged chunks or cached embeddings;
rerun an index command that reports a source change. Direct agent edits and
external writers do not share that lock, so pause them during a sensitive
cleanup. Rerun the preview afterward. An empty selection or zero counts do not
prove that no related data remains.

### If deletion fails

Deletion is not one transaction across files and stores. Index and plugin-state
cleanup, including rewrite backups, runs before memory-file edits; corpus and
origin evidence is removed last so a retry can identify remaining artifacts.
If a purge fails, resolve the reported storage or filesystem error and rerun
the same command with the same selectors. Do not remove its corpus or origin
records manually. After it succeeds, repeat the command with `--dry-run` to
review what remains.

### Artifacts removed

The purge removes matching promotion-marker entries and session-reference
sections from scanned memory files, selected session-corpus lines, and
selected-session transcript index chunks. It clears associated full-text and
vector rows, cached embeddings, matching short-term state, ingestion seen-hash
scopes, and origin rows. Matching content is scrubbed from dreaming rewrite
backups, rather than deleting every backup.

Consolidation preserves origins for replaced promotion markers while retained
rewrite preimages reference them. Those origins are pruned only after live
entries, retained preimages, diary excerpts, and indexed snapshots stop referencing the keys.
New consolidation-history excerpts carry the replacement entry's lineage and
are removed with it. Their origins remain while the excerpts remain, even
after backup rotation; diary history has no automatic expiry.
In a shared workspace, a later purge for another agent also checks its indexed
snapshots, even when the first purge already removed the shared file content.

It also clears stale index records for internal dreaming-narrative, cron, or
heartbeat sessions when the selection is nonempty. Index cleanup can therefore
include more than the selected sessions, and all chunks from a changed memory
file may be invalidated for later reindexing.

The `artifacts` counters are:

- `memoryFiles`, `memoryEntries`, `memoryLines`: changed memory files,
  removed marked entries or session-reference sections, and extra whole lines
  containing exact selected corpus snippets.
- `sessionCorpusFiles`, `sessionCorpusLines`: changed corpus files and
  removed corpus lines.
- `indexChunks`, `indexSources`, `ftsRows`, `vectorRows`,
  `embeddingCacheRows`: removed index and cache records.
- `shortTermEntries`, `seenHashScopes`, `backups`, `originRows`: removed
  short-term entries and deduplication scopes, rewritten backup records, and
  deleted source-origin rows.

Entries with mixed lineage are deleted whole; the command does not rewrite
them to preserve only unselected contributions. Surviving sources may support
new entries later, but regeneration is not guaranteed.

### Readmission and retained data

A real purge records the selected session IDs as forgotten in the agent's
SQLite database before removing artifacts. Automatic dreaming ingestion,
`memory session-backfill`, and transcript indexing, including
`memory index --force`, check those records. Automatic ingestion records the
reason `forgotten`. Repeating the purge does not remove the exclusion, and
removing an admission-policy rule does not undo it. Future sessions with new
IDs are not excluded by a previous purge.

New session-backfill diary facts and reflections carry entry markers and
source origins, including REM previews and diary blocks left by a failed apply.
Forgetting removes each matching line, including transformed or combined claims;
unrelated lines remain. Historical unmarked backfill text has no reconstructed lineage.
Exact corpus quotations in dream diaries such as `DREAMS.md` and
`memory/dreaming/**/*.md` can be removed as whole lines. Untracked paraphrases
cannot be reliably attributed and remain.

A `curatedWrites` record alone does not delete a file or its freeform edits.
The latest file-level write-observer record and supported `write`, `edit`,
and `apply_patch` calls in retained transcripts identify files to review.
This is not a complete audit of shell writes or external editors. A reported
file may still be changed by the separate marker, session-reference, or
exact-quotation cleanup.

<Warning>
Entries staged before source-session tracking may lack origin rows and remain
after a purge; review them separately. Current session backfill preserves
origins, but does not reconstruct missing historical lineage.
Rewrite backups whose origin rows were already lost also require separate
review; this does not automatically repair earlier incomplete purges.
`untargetableEntryKeys` does not enumerate every untracked candidate or memory.

Source transcripts, retained archives, other agents' indexes, exports, and
external backups also require separate review. In particular,
[session deletion](/cli/sessions#delete-sessions) ordinarily retains a
deleted-transcript archive; it is not an erasure of every conversation copy.
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

Distill retained session history into grounded short-term candidates. It shares
transcript trust classification, admission policy, and corpus storage with
dreaming. Staged candidates retain every contributing session's origin so
`memory forget` can select them later. Configured exclusions apply in preview,
REM, and apply modes; forgotten sessions remain excluded in every mode.
The default is a read-only preview, ordered
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
| `--rem`                     |              | Write deterministic grounded per-day previews to `DREAMS.md` and retain their source-origin records.          |
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

Both writing modes record diary origins before publishing text, so a later
apply failure does not leave untraceable diary quotations. REM keeps only the
diary and its origin bookkeeping: it does not retain a session corpus, stage
candidates, advance ingestion cursors, or call a model.

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
