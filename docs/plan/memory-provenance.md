---
summary: Memory provenance and selective deletion — pipeline-promoted entries record source sessions, admission policy excludes configured sources, and `memory forget` durably blocks reingestion while purging attributable artifacts and reporting agent-curated writes.
title: Memory provenance plan
read_when:
  - Changing dreaming ingestion, consolidation, promotion, or memory deletion
  - Adding session-derived data to durable memory files or the memory index
  - Reviewing enterprise memory-policy, GDPR-deletion, or taint requirements
---

## Status

Accepted (operator decision, 2026-08-25). Single-PR implementation: admission
policy, entry origins, durable forgotten-session records, `memory forget`.

## Problem

Enterprise operators need two guarantees the built-in memory system cannot give
today:

1. **Admission**: content from named sources (email connectors, specific
   channels, specific counterparties) must be excludable from the durable
   memory pipeline by policy, deterministically — not by prompting. This does
   not restrict an agent's direct file edits during the excluded session.
2. **Deletion**: "purge every memory derived from X" — where X is a session, a
   person, or a source class (e.g. all Gmail-derived sessions) — must be
   executable and auditable after the fact. Employee-exit and GDPR erasure are
   the driving cases.

Today the session id is available at every memory write site but is never
recorded as a queryable fact: it is encoded in chunk paths
(`sessions/<agentId>/<sessionId>`), in session-corpus line prefixes
(`[<agentId>/sessions/<agentId>/<sessionId>#L<n>]`), and in daily-note prose
headers — never as a column. Consolidation (dreaming) merges entries across
sessions, so lineage is a DAG; after one dream cycle no deterministic join from
memory text back to source sessions exists.

## Design

### Invariants

- Entry lineage is recorded at the producer, at write time, in the per-agent
  SQLite DB (`agents/<agentId>/agent/openclaw-agent.sqlite`). Direct-write file
  provenance remains in its existing bounded core-owned SQLite plugin state.
  No prose parsing on the read path.
- Lineage survives consolidation: a merged entry's origin set is the union of
  its parents' origin sets, maintained deterministically in code around the
  consolidation LLM call — the model never carries provenance.
- Deletion is whole-entry: an entry with any origin in the purge set is
  removed entirely. No LLM-mediated "subtract one source" rewriting.
- A purge sweeps every derived artifact: memory files, index chunks (FTS +
  vec + recall metadata + provenance via cascade), session-corpus lines,
  short-term recall state, and dreaming memory backups. Verbatim copies of
  purged corpus snippets are removed whole-line from derived memory files and
  backups. A deletion that survives in a backup namespace is not a deletion.
- Forgetting a session records a durable per-agent tombstone. Later dreaming
  ingestion, explicit session backfill, and transcript indexing honor that
  recorded fact, so clearing seen-hash scopes cannot turn purged sessions
  back into new work.
- Internal dreaming-narrative, cron, and heartbeat session transcripts never
  enter the memory transcript index, including retained compressed narrative
  archives without live session-window rows. Structured session or run
  identity remains authoritative; quoted memory content is never used as a
  classifier. Forced reindex and purge remove stale index records from
  earlier runs without readmitting forgotten sessions.
- Direct agent edits carry file-level source-session evidence from native
  write-observer records or the selected sessions' live and archived harness
  transcripts, not invented entry lineage. Matching files are reported as
  `curatedWrites`, never edited automatically when affected lines cannot be
  identified.
- Missing provenance never blocks recall or changes retrieval behavior; it
  only limits what `memory forget` can target (reported, not silent).

### 1. Admission policy (no schema change)

Config under the `memory-core` plugin entry:

```jsonc
"memoryPolicy": {
  "excludeSessions": {
    "hookExternalContentSources": ["gmail"],   // matches session_windows.hook_external_content_source
    "channels": ["email"],                     // matches session_windows.channel
    "chatTypes": []                            // direct | group | channel
  }
}
```

Enforcement point: session corpus building / `scanSessionIngestionSource`
(`extensions/memory-core/src/session-ingestion.ts` already exposes
`acceptProvenance`; extend the corpus entry with the session-window facts so
the predicate can act on them). An excluded session is recorded as excluded in
ingestion state (visible non-outcome), never scanned into the corpus, and
therefore can never reach candidates, consolidation, or promotion.

Forgotten sessions are also excluded regardless of policy configuration. Their
recorded ingestion non-outcome carries `excludedReason: "forgotten"`; explicit
session backfill and the transcript index consult the same durable fact
before processing live sessions or retained archives.

This policy governs pipeline ingestion only. An agent running in an excluded
session can still write `MEMORY.md`, `USER.md`, or another memory file during
its turn; native write-observer records and harness tool calls in that
session's transcript supply evidence for report-only deletion review.

### 2. Entry origins and forgotten sessions (additive schema, same version)

New tables in the per-agent DB, following the retired
`skill_workshop_proposal_origin_runs` child-table pattern:

```sql
CREATE TABLE IF NOT EXISTS memory_entry_origins (
  entry_key TEXT NOT NULL,      -- stable claim key (claimHash / candidateKey)
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,     -- logical session id
  session_key TEXT,             -- when known
  origin_class TEXT NOT NULL CHECK (origin_class IN ('owner','agent','untrusted','system')),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (entry_key, agent_id, session_id)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_session_tombstones (
  session_id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
```

Additive: new tables only, declared in the canonical schema plus a one-time
idempotent lazy ensure on first feature use, folded into the migration path at
the next natural bump (per `docs/reference/database-schemas.md`). Tombstones
are written only by a real purge, use reason `forgotten`, and are idempotent;
`--dry-run` does not initialize tombstone storage or write a deletion record.

Writers:

- **Ingestion → corpus**: each session-corpus line already carries its session
  ref; when a promotion candidate is formed from session-derived lines, record
  `(claimHash, agentId, sessionId)`.
- **Consolidation**: the LLM returns
  `{candidateKey, action: added|merged|superseded, resultEntry, priorEntries}`.
  Code unions the parents' origin rows onto the result entry's key on `merged`,
  re-keys on `superseded`, inserts fresh rows on `added`. Origin rows for keys
  no longer referenced by any live entry are pruned by the same pass. Shared
  workspaces reconcile every participating agent's existing origin rows.

Operator-curated `MEMORY.md`/`USER.md` edits have no origin rows. Direct agent
edits also lack deterministic entry lineage, but their existing bounded
memory-artifact provenance record carries `sessionId` and, when known,
`sessionKey`; `memory forget` reports matching files without rewriting them.

### 3. `memory forget` (purge command)

CLI surface (memory-core owns it): resolve a session set, then purge.

```
openclaw memory forget --session <id-or-key> [...]
openclaw memory forget --hook-source gmail [--since <date>]
openclaw memory forget --participant <actor-id>
  [--dry-run] [--json]
```

Explicit session IDs and keys resolve against live `session_windows` and
retained `session_transcript_archives`; an unmatched explicit value remains an
exact-ID purge target rather than silently disappearing. The report identifies
each target as `live`, `archived`, or `unresolved`. Hook-source and participant
selectors only match facts recorded in `session_windows` /
`session_participants`; archived sessions no longer retain that metadata and
must be selected explicitly. `--since` compares live-session creation times or
archive creation times; unresolved explicit IDs remain eligible.

Purge steps, in order, reported per step:

1. Session-corpus files: identify lines whose rendered prefix matches the
   purged sessions and retain their exact text for deterministic cleanup;
   rewrite corpus files without those lines.
2. Origin join → entry keys → remove matching entries from memory files
   (promotion-written blocks are hash-addressable; daily-note session sections
   carry session ids in headers). Remove any other whole memory-file line that
   contains an exact purged corpus snippet, including dream diaries and
   `DREAMS.md`; report those lines as `artifacts.memoryLines`.
3. Index: delete chunks for removed content and the selected sessions' own
   transcripts (cascades take recall metadata, provenance, FTS, vec); clear
   stale internal narrative/cron/heartbeat transcript debris, including
   metadata-less retained narrative archives; drop `memory_index_sources`
   rows for fully removed files; bump revision.
4. Plugin state: purge `short-term-recall` snippets and seen-hash scopes for
   the sessions; purge matching entries and exact snippets inside
   `dreaming-memory-backups`.
5. Origins and tombstones: delete origin rows for the purged sessions; report
   entries whose origin set became empty vs. mixed-lineage entries that were
   removed whole. Record each selected session with reason `forgotten` so
   later ingestion, session backfill, indexing, and forced reindex cannot
   resurrect its content.
6. Curated writes: report `{ relativePath, observedAt }` for agent-written
   memory files recorded by the write observer or matching mutation tool calls
   in the selected sessions' live and archived transcripts. Deduplicate files
   across both sources and leave their contents unchanged because file-level
   provenance cannot identify affected entries.

`--dry-run` prints the full report without writing. Mixed-lineage entries are
deleted whole and listed, so the operator can re-run dreaming to regenerate
what clean sessions still support; forgotten sessions remain excluded from
that sweep. Repeating a purge is idempotent. A future legal-hold flag can
refuse purges with a named reason; out of scope for this PR beyond leaving the
report shaped to carry refusals.

## Non-goals

- Purging session transcripts themselves (session store owns that; `forget`
  removes their memory-index copies and reports the source sessions so the
  operator can act on retained transcripts separately).
- Automatically redacting direct agent-written memory files without
  deterministic entry-level lineage (`curatedWrites` is report-only).
- Removing LLM-paraphrased diary prose that no longer contains an exact
  purged corpus snippet.
- Sub-entry source subtraction or model-mediated rewriting; attributable
  promoted entries are removed whole and exact corpus quotes whole-line.
- Legal-hold enforcement (report shape only).
- Cross-agent purge orchestration (per-agent DB; callers iterate agents).

## Proof

Live test with a real OpenAI-backed agent in an isolated `OPENCLAW_STATE_DIR`:
seed synthetic sessions (some flagged as email-derived), run dreaming, verify
origin rows exist and admission excluded the tainted session; run
`memory forget --dry-run` then real purge; verify memory files, FTS, vec,
embedding cache, session-corpus, short-term state, and backups no longer
contain the purged facts; verify internal narrative transcripts remain
unindexed even when only retained compressed archives remain, exact diary
quotes are removed, matching direct agent writes are reported without
modification, and recall still works for surviving entries. Run another
dreaming sweep and forced reindex to verify tombstoned sessions remain
excluded and their transcript chunks are not recreated; verify explicit session
backfill also refuses to regenerate their candidates.
