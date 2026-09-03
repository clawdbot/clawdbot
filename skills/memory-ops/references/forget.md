# Deletion and admission

Both controls belong to the bundled `memory-core` plugin. Other memory plugins
expose different commands.

## Preview, apply, re-preview

```bash
openclaw sessions --agent <agent-id> --limit all --json
openclaw memory forget --agent <agent-id> --session <id-or-key> --dry-run --json
openclaw memory forget --agent <agent-id> --session <id-or-key> --json
openclaw memory forget --agent <agent-id> --session <id-or-key> --dry-run --json
```

- `--agent` defaults to the default agent, not all agents. Name it.
- At least one selector is required. `--session`, `--hook-source`, and
  `--participant` are repeatable and combine with OR. `--since <ISO date>`
  narrows by session creation time.
- Selectors match recorded identifiers. `--participant` matches a raw actor
  ID and selects the whole session, including other people's messages.
  `--hook-source` is exact: `email` for IMAP, `gmail` for Gmail hooks,
  `webhook` for generic webhooks.
- The preview is computed from current state, not saved as a plan. Pause
  direct agent edits and external writers during a sensitive cleanup; they do
  not share the plugin's mutation lock.

## Read the report

| Field                   | Check                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `sessionResolutions`    | Each value resolved `live` or `archived`. `unresolved` means the ID was recorded for exclusion, not that it was found. |
| `participantMatches`    | Typed identities matched by a raw participant ID; ambiguous matches need review.                                       |
| `entryKeys`             | Tracked entries with an origin in the selected sessions.                                                               |
| `mixedLineageEntryKeys` | Entries that also have unselected origins. They are removed whole.                                                     |
| `untargetableEntryKeys` | Promotion markers with no origin rows. Not selectable by lineage.                                                      |
| `curatedWrites`         | Files to review by hand. The record does not delete anything.                                                          |
| `artifacts`             | Counts of files, entries, lines, index chunks, and store rows.                                                         |
| `refusals`              | Historical highlights needing manual review.                                                                           |

An empty preview means those selectors found nothing more. It is not proof
that no related information remains.

## What stays after a purge

- Original transcripts and archives. Session deletion is a separate command
  and ordinarily keeps a deleted-transcript archive.
- Older entries without origin rows.
- Freeform edits and arbitrary shell writes. `curatedWrites` points at files
  to inspect.
- Paraphrases, exports, external backups, and other plugins' stores.
- Other agents' stores. Repeat the preview per agent, including agents that
  share a workspace.

Report these boundaries when the user asks for erasure.

## Purged sessions stay purged

A real purge records each selected session as forgotten in that agent's
SQLite store before removing artifacts. Dreaming ingestion, session backfill,
and `memory index --force` all check those records. Repeating the purge does
not lift the exclusion, and removing an admission rule does not undo it. It
applies to those session IDs only, not to future conversations with the same
person or source.

## If a purge fails

Cleanup is not one transaction. Resolve the reported storage or filesystem
error, rerun the same command with the same selectors, then run `--dry-run`
again. Do not delete corpus or origin records by hand; the retry needs them to
find remaining artifacts. If an index run reports that its source changed,
rerun `openclaw memory index --agent <agent-id>`.

## Admission policy

Admission excludes future sessions from dreaming ingestion and
`session-backfill`. It does not touch raw transcript indexing, direct writes,
session hooks, or existing memory.

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail", "email"],
            },
          },
        },
      },
    },
  },
}
```

Values match recorded session metadata, not words in a conversation. A
session missing that metadata does not match; select it by full ID. An
excluded session can still edit `MEMORY.md` or `USER.md` if its tools allow
it; admission is not a filesystem permission.

Pair the two controls: `forget` for what already exists, an admission rule
for what should stay out from now on.
