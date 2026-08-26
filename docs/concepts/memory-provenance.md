---
summary: "Session-level memory provenance: how OpenClaw records where every durable memory came from, keeps configured sources out of memory by policy, and deletes everything derived from a session on request"
title: "Memory provenance and deletion"
sidebarTitle: "Provenance & deletion"
read_when:
  - You need to keep email, a channel, or another content source out of durable memory
  - You need to purge every memory derived from a session, a person, or a source, e.g. for GDPR erasure or an employee exit
  - You are reviewing OpenClaw memory for a security, privacy, or compliance assessment
---

Every durable memory OpenClaw creates through its pipeline records which
sessions it came from, as queryable SQLite facts — not as prose the model
could rewrite. That lineage supports two operator guarantees this page
explains end to end: **admission** (configured sources never enter durable
memory, deterministically) and **deletion** (`openclaw memory forget` purges
everything the pipeline derived from a chosen set of sessions and permanently
prevents its re-admission).

This page owns the policy story: what is recorded, what the guarantees cover,
and where their boundaries are. The command contract lives in
[`memory forget`](/cli/memory#memory-forget), the configuration keys in
[Memory config](/reference/memory-config#memory-admission-policy), and the
surrounding trust model in
[Memory architecture](/concepts/memory-architecture).

## What lineage is recorded

Three kinds of provenance exist, at different granularities:

| Record                | Granularity   | Written by                                       | Used for                                              |
| --------------------- | ------------- | ------------------------------------------------ | ----------------------------------------------------- |
| Chunk provenance      | Index chunk   | Classification code at index time                | Trust gating: promotion eligibility, recall framing   |
| Entry origins         | Durable entry | Ingestion and promotion, per source session      | Selective deletion; auditing where an entry came from |
| Curated-write records | Memory file   | The memory write observer, per authoring session | Reporting agent-authored edits during a purge         |

Chunk provenance (origin class, session kind) is the trust model described in
[Memory architecture](/concepts/memory-architecture#provenance-every-memory-knows-where-it-came-from).
Entry origins are what make deletion possible: when the dreaming pipeline
turns session content into a durable candidate, it records
`(entry, agent, source session)` rows in the agent's SQLite database, and
every pipeline-promoted `MEMORY.md` entry carries a stable marker that ties
the file text back to those rows.

Lineage survives [dreaming](/concepts/dreaming) consolidation. When
consolidation merges two entries, the result's origin set is the union of its
parents'; when a newer observation supersedes an older one, the origins move
to the surviving entry. This bookkeeping is deterministic code wrapped around
the consolidation model call — the model never carries or rewrites
provenance. In a workspace shared by several agents, the same reconciliation
runs against every participating agent's origins, so any agent's later
deletion request still finds the live entry.

Not every entry has origin rows. Operator-curated content and direct agent
edits never receive entry lineage (their file-level authoring sessions are
tracked separately — see
[the admission boundary](#the-admission-boundary) below), and entries
promoted before lineage recording existed have none either. All such entries
remain searchable, are never deleted by an unrelated selector, and are
listed as untargetable in a purge report rather than silently skipped.

## Admission: keeping sources out of memory

If a source must never reach durable memory — email content is the classic
case — exclude it by policy instead of prompting the model to be careful:

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail"],
              channels: ["email"],
              chatTypes: ["group"],
            },
          },
        },
      },
    },
  },
}
```

A session matching any configured exclusion never enters the dreaming
corpus, so it cannot produce candidates, survive consolidation, or promote
into `MEMORY.md`. The exclusion is enforced before the transcript is read,
and it is **recorded**, not silent: the ingestion checkpoint stores the
exclusion reason, visible to a later audit. Removing the policy re-admits
the session on the next sweep. Key semantics and matching rules are in
[Memory config](/reference/memory-config#memory-admission-policy).

### The admission boundary

The policy governs the **memory pipeline**. An agent running inside an
excluded session can still edit `MEMORY.md` or another memory file directly
during its turn — "remember this" resolved by the agent writing the file is
a workspace edit, governed by tool policy and the workspace trust boundary,
not by memory admission. OpenClaw records those writes with their authoring
session (the curated-write records above), so they are auditable and are
surfaced by a later purge, but preventing them is a tool-policy decision,
not a memory-policy one. If the requirement is "this session must not be
able to write memory files at all," restrict the agent's file tools for that
context rather than relying on admission policy.

## Deletion: purging what a session produced

`openclaw memory forget` deletes everything the memory pipeline derived from
a chosen session set. Sessions are selected by explicit ID or key, by their
recorded external-content hook source, or by a participant's actor ID —
"everything derived from Gmail" and "everything derived from sessions this
person took part in" are both one command. Selection resolves against live
session records **and** retained archived sessions, and an explicitly named
session that matches neither is still purged and excluded as an exact ID: an
operator-named session never produces a silent no-op. The report labels each
selected session `live`, `archived`, or `unresolved`.

A purge is **whole-entry and deterministic**. An entry with any origin in the
selected set is removed entirely — there is no model-mediated attempt to
subtract one source's contribution from merged prose, because a deletion
guarantee an LLM adjudicates is not one you can defend in an audit. Entries
that also had unselected origins are reported as mixed-lineage removals;
dreaming can regenerate what the surviving sessions still support.

The sweep covers every derived artifact, not just the visible entry: memory
files, verbatim quoted lines in dream diaries, session-corpus lines, index
chunks with their full-text and vector records, embedding-cache entries,
short-term recall state, ingestion dedup state, and dreaming's own pre-rewrite
backups. A deletion that survives in a backup or an index is not a deletion.
Always start with `--dry-run`, which computes the identical report without
writing; the full artifact list and report shape are in the
[command reference](/cli/memory#memory-forget).

### Purged sessions stay purged

Deleting derived data is not enough on its own: the memory pipeline
continuously re-reads session history, so a purge that only removed artifacts
would be silently undone by the next dreaming sweep or index rebuild. A real
purge therefore records each selected session as **forgotten** in the agent's
SQLite database. Dreaming ingestion, historical backfill, and transcript
indexing — including `memory index --force` — all treat forgotten sessions
exactly like policy-excluded ones, with the recorded reason `forgotten`.
Re-running the purge is safe and changes nothing.

### What deletion does not cover

The boundaries are deliberate, and each one is reported rather than silent:

- **Source transcripts.** The session transcript itself belongs to session
  management, not memory. A purge removes its copies from the memory index
  and permanently fences it out of the pipeline, then names the session in
  the report so you can remove the transcript through its owning workflow.
- **Agent-authored edits.** Freeform file edits cannot be attributed to
  individual lines safely enough for automatic deletion. The purge reports
  them as `curatedWrites` — file and timestamp, recovered from write-observer
  records and from the selected sessions' transcripts across all agent
  harnesses — and leaves the files for review.
- **Paraphrased prose.** Dream-diary lines quoting a purged session verbatim
  are removed; model-paraphrased prose that no longer contains the source
  text cannot be reliably attributed and stays. Keeping the affected sessions
  out of memory in the first place, via admission policy, is the stronger
  tool when a source is sensitive.

## Purging a person or a source end to end

The employee-exit / GDPR-erasure workflow, using a departed teammate as the
example:

```bash
# 1. Preview everything derived from sessions they took part in.
openclaw memory forget --participant <actor-id> --dry-run --json

# 2. Review the report: entries, artifacts, mixed-lineage removals,
#    curatedWrites, and each session's resolution source.

# 3. Purge. Selected sessions are durably excluded from re-ingestion.
openclaw memory forget --participant <actor-id>

# 4. Review curatedWrites files by hand, and remove the source transcripts
#    through session management if required.
```

For archived sessions that no longer carry participant metadata, select them
explicitly with `--session <id-or-key>`. For a source-wide purge, use the
recorded hook source instead: `openclaw memory forget --hook-source gmail`.

## Related

- [`memory forget` command reference](/cli/memory#memory-forget)
- [Memory admission policy configuration](/reference/memory-config#memory-admission-policy)
- [Memory architecture](/concepts/memory-architecture)
- [Dreaming](/concepts/dreaming)
- [Built-in memory](/concepts/memory-builtin)
