---
summary: "Trace session-derived memories, control ingestion, and preview or delete tracked memory artifacts"
title: "Memory provenance and deletion"
sidebarTitle: "Provenance & deletion"
doc-schema-version: 1
read_when:
  - You want to exclude a source from automatic memory ingestion
  - You need to remove memories derived from specific sessions or participants
  - You are reviewing memory provenance, deletion coverage, or retained data
---

OpenClaw records source-session lineage for memories staged by automatic
session ingestion and historical session backfill. `openclaw memory forget` uses that lineage to remove
tracked entries and related artifacts, and records the selected sessions as
forgotten so later ingestion does not restore them.

Two controls serve different purposes: **admission policy** excludes matching
sessions from future dreaming ingestion and session backfill; **forget** removes
identifiable artifacts from selected sessions. Neither is a general erasure
of everything the agent has seen or written.

These controls belong to the bundled `memory-core` plugin. Other memory
plugins may expose different commands and deletion behavior.

<Warning>
`memory forget` deletes immediately unless you pass `--dry-run`. It does not
delete original session transcripts, every freeform memory edit, or copies
outside the memory stores it scans. Review the report and the
[deletion boundaries](#what-deletion-does-not-cover) before applying it.
</Warning>

## Preview and forget a session

Use an explicit agent so you know which store you are changing. List its
sessions to find the full session key or ID. Session IDs are exact and
case-sensitive; an abbreviation does not select a longer ID:

```bash
openclaw sessions --agent <agent-id> --limit all --json
openclaw memory forget --agent <agent-id> --session <id-or-key> --dry-run --json
```

Check `sessionResolutions` for the intended sessions, `entryKeys` and
`mixedLineageEntryKeys` for whole-entry removals, and `artifacts` for the
affected stores. Review `curatedWrites` and `untargetableEntryKeys` separately;
neither is a complete inventory of data that will remain.

When the selection is correct, repeat the same command without `--dry-run`:

```bash
openclaw memory forget --agent <agent-id> --session <id-or-key> --json
```

There is no additional confirmation prompt or `--apply` flag. A preview is
computed from current state, not saved as a deletion plan. Pause direct agent
edits and external writers during a sensitive cleanup; they do not share the
memory plugin's mutation lock. Run the preview again afterward to check for
remaining attributable artifacts.

If deletion fails, resolve the reported storage or filesystem error, rerun the
same command, then repeat it with `--dry-run`. A failure can leave partial
cleanup. The purge keeps corpus and origin evidence until dependent artifacts
are cleaned; do not delete that evidence manually to clear an error.

The full flags, selector semantics, and report fields are in
[`memory forget`](/cli/memory#memory-forget).

## What lineage is recorded

Three records serve different purposes:

| Record                | Granularity   | Written by                                     | Used for                                        |
| --------------------- | ------------- | ---------------------------------------------- | ----------------------------------------------- |
| Chunk provenance      | Index chunk   | Classification code at index time              | Trust gating and recall framing                 |
| Entry origins         | Tracked entry | Session ingestion, backfill, and consolidation | Finding entries derived from a selected session |
| Curated-write records | Memory file   | The memory write observer                      | Identifying files to review during a purge      |

[Chunk provenance](/concepts/memory-architecture#provenance-every-memory-knows-where-it-came-from)
describes the origin class and session kind. Entry origins instead associate
an entry key with an agent and source session in SQLite. Promotion markers in
`MEMORY.md` connect the visible entry to those origin rows.

When [dreaming](/concepts/dreaming) merges or supersedes tracked entries,
reconciliation transfers the parents' origins to the surviving entry. It
runs in code around the model call, including for participating agents that
share a workspace; the model does not own the origin rows.

Origins for replaced entries remain while retained rewrite preimages still
reference their promotion markers. Backup rotation prunes those origins only
when live entries, retained preimages, diary excerpts, and indexed snapshots no longer reference them.

New consolidation-history excerpts retain the replacement entry's lineage,
including its merged or superseded parents. Their origin rows remain while
those excerpts remain, even after backup rotation. Diary history has no
automatic expiry; long revision histories can retain growing origin sets.

When backfill coalesces the same claim from several sessions, it retains every
source origin without counting the repeated claim as extra evidence.
Session-backfill diary lines also carry markers tied to source origins before
publication. This includes REM facts, reflections, and combined claims, even
when displayed citations are shortened or a later apply step fails. Forgetting
any contributing session removes the whole marked line, not unrelated diary
lines. Earlier unmarked backfill diaries do not gain lineage retroactively.

Coverage is not universal. Handwritten notes, direct agent edits, and entries
staged before lineage tracking may lack entry origins. The report's
`untargetableEntryKeys` lists **promotion markers with
no origins in the selected agent's store**, not all untracked prose. Such
entries cannot be selected by lineage alone, although explicit session
references or exact corpus quotations may still match the file scrub.

## Admission: keeping sources out of memory

To keep Gmail hook sessions out of **dreaming ingestion and session backfill**:

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail"],
            },
          },
        },
      },
    },
  },
}
```

IMAP uses the exact hook source `email`; Gmail hooks use `gmail`. Include both
values to exclude both sources. Generic webhooks use `webhook`.

You can also exclude channel/plugin identifiers (not room IDs) or chat types.
Empty or omitted lists add no policy exclusions. A match in any list excludes
the whole session; values
match recorded session metadata, not words in the conversation.

Both paths check the policy before reading the transcript. Automatic ingestion
also records the exclusion reason in its ingestion checkpoint. Removing a matching
rule makes a session eligible for a later sweep, subject to the other trust
and ingestion gates. A session recorded as forgotten remains excluded.

Policy is prospective: it does not erase an existing corpus, staged
candidate, or promoted entry. Use `memory forget` for existing attributable
data. See [Memory config](/reference/memory-config#memory-admission-policy)
for exact matching rules and exclusion reasons.

### The admission boundary

| Path                            | Configured admission exclusions          |
| ------------------------------- | ---------------------------------------- |
| Automatic dreaming ingestion    | Applied before transcript reads          |
| Manual `session-backfill`       | Applied in preview, REM, and apply modes |
| Raw transcript indexing         | Not applied                              |
| Direct writes and session hooks | Not applied                              |

Matching requires retained session metadata; missing fields do not match a
rule. Both controls honor the configured `session.store`, including custom
and shared stores, while keeping selection scoped to the chosen agent. Older
retained records may have only a coarse `webhook` classification; without the
original exact source, OpenClaw does not infer `email` or `webhook` for matching.
Select those sessions explicitly by full ID.

Automatic dreaming separately skips retained archives. To exclude an
archived session from backfill and transcript indexing too, explicitly forget
its full session ID. Those paths check forgotten-session records even when
the former channel, chat type, or hook-source metadata is no longer available.

An excluded session can still edit `MEMORY.md`, `USER.md`, or another
workspace file if its tools permit it. Restrict the relevant file, shell, and
external-harness capabilities when you need to prevent those writes, and
review enabled memory-writing hooks. Admission policy is not a filesystem
permission. Observed writes are reported for review, not given per-entry
lineage.

## Deletion: purging what a session produced

Selectors identify **sessions**, not individual facts about a person.
`--participant` selects sessions with that recorded actor ID; it does not
search memory text for a name. `--hook-source` selects sessions with that
recorded external-content source. Both require retained metadata. Explicit
IDs and keys can also resolve retained archives.

A tracked entry with any selected origin is removed whole, even when it also
has unselected origins. These removals appear in `mixedLineageEntryKeys`.
The purge does not ask a model to subtract one person's contribution from
merged prose. Surviving sources may support a new entry later, but automatic
reconstruction is not guaranteed.

The cleanup covers matching promoted entries, session-corpus lines, memory
index chunks and their full-text/vector rows, cached embeddings, short-term
state, ingestion deduplication state, and dreaming rewrite preimages. It also
removes whole lines containing exact selected corpus snippets from scanned
memory files and dream diaries. The
[command reference](/cli/memory#memory-forget) describes the counters and
selection limits.

### Purged sessions stay purged

A real purge records each selected session as forgotten in the selected
agent's SQLite database before removing its artifacts. Automatic ingestion,
historical session backfill, and transcript indexing, including
`memory index --force`, check these records. Automatic ingestion records the
reason `forgotten`.

The memory plugin coordinates purges with its staging and file mutations.
A pending dream narrative is skipped if its tracked source entries or prior
diary context were removed before publication. This does not retroactively
identify untracked paraphrases in older diary entries. Historical consolidation
highlights with quoted markers also lack reliable deletion boundaries. The
report warns in `refusals` when it recognizes remaining highlights in that
format; review them manually. The warning is not an inventory of all untracked
history, and missing historical lineage is not reconstructed.

Indexing checks again before publishing chunks or cached embeddings, so a
result prepared before the purge cannot restore forgotten session data or a
stale memory-file snapshot. An affected index run reports that its source
changed; rerun `openclaw memory index --agent <agent-id>` to index current data.

Repeating a purge does not lift that exclusion. It applies to those session
IDs in that agent's store, not to future conversations with the same person
or hook source. Keep an admission rule for future matching sessions, within
[the admission boundary](#the-admission-boundary).

## What deletion does not cover

- **Original transcripts and archives.** Memory cleanup leaves them in the
  session store. [Session deletion](/cli/sessions#delete-sessions) is a
  separate lifecycle operation and ordinarily retains a deleted-transcript
  archive. Do not treat either command as proof that all conversation copies
  have been erased.
- **Untracked older memories.** No origin row means no lineage-based deletion.
  New session backfill preserves origins, but it does not retroactively supply
  lineage for candidates or rewrite backups whose origins were lost in older
  versions. Inspect those separately; a prior purge is not automatically repaired.
- **Freeform edits.** `curatedWrites` reports recognized writes or write
  attempts with a `relativePath` and `observedAt`. That record alone does
  not delete a file or identify contributing lines. Supported write/edit/patch
  transcript records supplement the latest file-level observer record, but
  can include unsuccessful attempts. Arbitrary shell writes and external edits
  are not fully tracked.
- **Paraphrases and other copies.** Exact corpus quotations can be removed,
  but untracked paraphrases, exports, external backups, other plugins' stores,
  and independently copied files are outside this cleanup. A reported curated
  file can still lose lines that match a tracked entry or exact quotation.
- **Other agents.** Selection and forgotten-session records are per agent.
  Repeat the review for each relevant agent, including agents sharing a
  workspace; one agent's report does not establish that every index is clean.

An empty preview means no more artifacts were found by those selectors and
matching rules. It is not a certificate that no related information remains.

## Purging a person or a source end to end

For a participant, start with a preview in each relevant agent:

```bash
openclaw memory forget --agent <agent-id> --participant <actor-id> --dry-run --json
```

Verify the resolved session IDs before removing `--dry-run`. This removes
tracked entries derived from **any content in those sessions**, not only
messages authored by that participant. If participant metadata is missing
from an archive, add its explicit `--session <id-or-key>` selector.

For a source, use its recorded hook identifier:

```bash
openclaw memory forget --agent <agent-id> --hook-source gmail --dry-run --json
```

After applying the reviewed selection, inspect retained files and untracked
memories, handle transcript and archive retention separately, and rerun the
preview. Add an admission rule if future sessions from that source should
also stay out of dreaming ingestion and session backfill.

## Related

- [`memory forget` command reference](/cli/memory#memory-forget)
- [Memory admission policy configuration](/reference/memory-config#memory-admission-policy)
- [Memory architecture](/concepts/memory-architecture)
- [Dreaming](/concepts/dreaming)
- [Built-in memory](/concepts/memory-builtin)
