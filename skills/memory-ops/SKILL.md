---
name: memory-ops
description: "Operate OpenClaw memory on the default memory-core path: recall with memory_search and memory_get, write notes to the right file, diagnose an empty or keyword-only index, and preview before running memory forget."
---

# Memory operations

Use OpenClaw's memory tools for recall and the `openclaw memory` CLI for index
and deletion work. Read and preview before changing anything.

## Mental model

- Memory is files in the agent workspace plus an index over them. There is no
  hidden state; the agent remembers only what reaches disk.
- `MEMORY.md` and `USER.md` are the curated bootstrap layer. They load at
  session start and stay evergreen in ranking.
- `memory/YYYY-MM-DD.md` and `memory/YYYY-MM-DD-<slug>.md` are the working
  layer. They are indexed for search but not injected every turn, and they
  decay in ranking with a 30-day half-life.
- Imported notes under `memory/imports/*` are indexed, not merged into
  `MEMORY.md`.
- `memory_search` finds notes. `memory_get` reads an exact excerpt. Neither
  writes memory.
- The CLI owns index health (`status`, `index`), promotion (`promote`), and
  deletion (`forget`). `forget` is the only destructive command here.
- Dreaming promotes material from daily notes into `MEMORY.md` in the
  background. Direct edits to `MEMORY.md` are allowed but bypass its scoring.

If the `memory-wiki` plugin is active, its `wiki-maintainer` skill owns the
vault. Use `corpus: "all"` for one recall pass across memory and wiki, and
leave wiki page edits to that skill.

## Recall before you answer

Before answering about prior work, decisions, dates, people, preferences, or
todos:

1. Call `memory_search` with a natural-language `query`. Hybrid search matches
   meaning and exact terms, so include identifiers, error strings, and config
   keys verbatim.
2. Read only the lines you need with `memory_get` (`path`, optional `from` and
   `lines`). Do not re-read whole files into context.
3. Surface a corpus warning to the user. It means results are partial.
4. Cite `Source: <path#line>` when citations are enabled and it helps the user
   verify a snippet.

Trigger recall injects at most three trusted entries from `MEMORY.md` and
`USER.md` automatically. Daily notes, imports, and transcripts never inject; an
explicit `memory_search` is the only way to reach them.

For exact quotes from earlier conversations use `sessions_search`, then open
the hit with `sessions_history`. `memory_search` covers transcripts only when
`experimental.sessionMemory` is on and `"sessions"` is in the configured
sources.

Read [recall.md](references/recall.md) for parameters, corpus scoping, and
what an empty result means.

## Write to the right place

- A durable non-profile fact or standing decision goes in `MEMORY.md`, as a
  short entry, not a log line.
- A stable preference or profile fact goes in `USER.md` as an imperative
  directive. Supersede a changed preference in place instead of appending a
  contradiction.
- Running context, observations, and session summaries go in today's
  `memory/YYYY-MM-DD.md`.
- Do not create ad hoc note files elsewhere in the workspace. They are not
  indexed unless `memory.search.extraPaths` names them.
- When a note changes future behavior, record when it applies, when it expires,
  what to avoid, and who the source is. Memory preserves that context; it does
  not enforce it. Use approvals, sandboxing, or scheduled tasks for hard
  controls, and scheduled tasks for time-based reminders.

If `MEMORY.md` is reported truncated in context, move detail into
`memory/*.md` and keep a summary. Check with `/context list` or
`openclaw doctor`.

## Diagnose recall

| Symptom                       | Check                                 | Fix                                            |
| ----------------------------- | ------------------------------------- | ---------------------------------------------- |
| No results at all             | `openclaw memory status --agent <id>` | `openclaw memory index --force --agent <id>`   |
| Only keyword matches          | `openclaw memory status --deep`       | Configure `memory.search.provider` or its key  |
| Memory reported unavailable   | `status --deep` provider probe        | Fix the named provider; `none` for FTS-only    |
| Dreaming line stays `off`     | Default agent heartbeat               | See the dreaming doc; the cron rides heartbeat |
| Index says its source changed | A purge or edit ran during indexing   | Rerun `openclaw memory index --agent <id>`     |

Pass `--agent` explicitly. Without it, `status` and `index` run for every
configured agent.

## Delete safely

`openclaw memory forget` deletes immediately unless `--dry-run` is set. There
is no confirmation prompt and no `--apply` flag. Always:

1. Resolve the exact session ID or key with `openclaw sessions --agent <id>
--limit all --json`. IDs are exact and case-sensitive; an abbreviation
   selects nothing.
2. Run the same selectors with `--dry-run --json` and read
   `sessionResolutions`, `entryKeys`, `mixedLineageEntryKeys`, and `refusals`.
3. Repeat without `--dry-run` only after the user confirms the selection.
4. Run the preview again and report what remains.

Selectors pick sessions, never individual facts. An entry with mixed lineage
is removed whole. Transcripts, freeform edits, paraphrases, other agents'
stores, and untracked older entries are outside this cleanup. Do not claim
that information is erased; report the counters.

Admission policy is a different control. It keeps future sessions out of
dreaming ingestion and backfill and does not remove existing data.

Read [forget.md](references/forget.md) before any deletion or exclusion work.
