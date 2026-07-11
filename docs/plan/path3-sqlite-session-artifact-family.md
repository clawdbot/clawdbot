---
summary: "Path 3 plan for archiving all SQLite transcript artifacts that belong to a session"
read_when:
  - You are implementing clawdbot-d63.2 / clawdbot-04b
  - You are touching SQLite session retention, reset, delete, or agent-deletion archival
  - You need to distinguish SQLite-era artifact families from legacy JSONL sidecars
title: "Path 3 SQLite session artifact family"
---

# Path 3 SQLite Session Artifact Family

This note scopes `clawdbot-d63.2` while `clawdbot-d63.1` owns the overlapping
reset/delete archive helper in `src/config/sessions/session-accessor.sqlite.ts`.
The implementation file was dirty during this pass, so this artifact records
the exact contract and patch points without racing the sibling worker.

## Authoritative family

After the SQLite flip, active session transcripts are SQLite rows. A session's
archive family is:

- The `transcript_events`, `transcript_event_identities`, and `sessions` rows
  for the entry's current `sessionId`.
- The same SQLite transcript row set for every `sessionId` referenced by
  `entry.compactionCheckpoints[*].preCompaction.sessionId`.
- The same SQLite transcript row set for every `sessionId` referenced by
  `entry.compactionCheckpoints[*].postCompaction.sessionId`.
- The same SQLite transcript row set for every `sessionId` in
  `entry.usageFamilySessionIds`.

Archive only rows that are no longer referenced by any remaining
`session_entries` row or by any remaining entry's compaction or usage-family
metadata. This preserves checkpoint branch/restore and usage rollup state until
the final live reference is gone.

## Non-family artifacts after the flip

Generated topic transcript file variants and trajectory sidecars are not active
SQLite runtime state. They are legacy file artifacts:

- Topic variants such as `<sessionId>-topic-<thread>.jsonl` only exist for the
  file-backed transcript format. SQLite uses the canonical session id plus
  `session_routes`/entry delivery metadata instead of per-topic JSONL files.
- Trajectory sidecars such as `.trajectory.jsonl` and `.trajectory-path.json`
  are named from real JSONL `sessionFile` paths. SQLite `sessionFile` values are
  `sqlite:<agentId>:<sessionId>:<storePath>` markers and do not name sidecar
  files.
- Archive-tier readers must keep reading legacy archived JSONL files, but
  runtime retention must not scan active sessions directories or reopen JSONL
  transcript files for SQLite sessions.

Doctor import remains the migration owner for legacy primary JSONL files and
their adjacent trajectory sidecars. Runtime SQLite retention should not add a
second importer or file fallback.

## Patch points

Extend the SQLite archive helper introduced by `clawdbot-d63.1` rather than
adding a parallel path.

1. Add a local collector near `deleteSqliteSessionStateIfUnreferenced`:
   - `collectSqliteSessionArtifactFamily(entry: SessionEntry): Set<string>`
   - Include `entry.sessionId`, checkpoint pre/post session ids, and
     `usageFamilySessionIds`.
   - Filter empty strings and dedupe deterministically.

2. Add a reference collector for the post-removal store:
   - `readReferencedSqliteSessionArtifactFamilyIds(database): Set<string>`
   - Iterate current `session_entries`, parse each `entry_json`, and collect
     the same family ids from every surviving entry.

3. Change the reset/delete/maintenance callers that currently archive one
   removed `sessionId` to pass the removed entry's full family.

4. For each family id, archive the SQLite transcript rows with the caller's
   reason (`reset` or `deleted`), then delete the `sessions` row only when the
   family id is absent from the post-removal reference set.

5. Keep transcript event deletion centralized through the existing SQLite
   session-row cleanup path. Do not add active JSONL reads.

## Focused tests

Add SQLite-only tests to `src/config/sessions/session-accessor.conformance.test.ts`
or the sibling lifecycle test after `clawdbot-d63.1` commits:

- Deleting an entry with a pre-compaction transcript archives both the current
  session and the pre-compaction session, then removes both SQLite row sets.
- Deleting one of two entries that share a compaction pre-session archives
  nothing for the shared pre-session until the final referencing entry is
  removed.
- Deleting an entry with `usageFamilySessionIds` archives predecessor SQLite
  transcript rows when no other entry references that usage family.
- A topic-shaped session key with a SQLite marker does not cause any generated
  topic JSONL read or sidecar lookup.

The focused proof should use:

```bash
node scripts/run-vitest.mjs src/config/sessions/session-accessor.conformance.test.ts
```

If the final tests live in `store.session-lifecycle-mutation.test.ts`, run that
file explicitly with the same wrapper. Broad `pnpm` gates should stay on
Crabbox/Testbox for this Codex worktree.
