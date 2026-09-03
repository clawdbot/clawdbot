# Recall operations

## Tool parameters

`memory_search`

| Field        | Type    | Notes                                                        |
| ------------ | ------- | ------------------------------------------------------------ |
| `query`      | string  | Required. Natural language plus exact identifiers.           |
| `maxResults` | integer | Optional cap; keep it small and call again with a new query. |
| `minScore`   | number  | Optional floor; raise it when results are noisy.             |
| `corpus`     | string  | `memory` (default), `wiki`, `all`, or `sessions`.            |

`memory_get`

| Field    | Type    | Notes                                                   |
| -------- | ------- | ------------------------------------------------------- |
| `path`   | string  | Required. Workspace-relative path from a search result. |
| `from`   | integer | First line, 1-based.                                    |
| `lines`  | integer | Line count. Omitted means a bounded excerpt.            |
| `corpus` | string  | `memory` (default), `wiki`, or `all`.                   |

`memory_get` returns `status: "ok"` when the excerpt was read and
`status: "not_found"` when every requested available corpus missed. It reports
truncation and continuation when more content exists, so page with `from`
instead of raising `lines`.

## How ranking behaves

- Vector similarity and BM25 keyword search run in parallel and merge. If only
  one path is available, the other runs alone.
- Score = hybrid relevance × recency decay × importance. Dated daily notes
  decay with a 30-day half-life. `MEMORY.md`, `USER.md`, and undated files
  under `memory/` do not decay.
- Filenames are indexed separately. An exact path or stem outranks a partial
  match, so searching a known filename is reliable.
- MMR reorders results to reduce near-duplicate snippets. It does not change
  scores.

A result that looks stale but relevant is usually recency decay. Search again
with the identifier the note contains, or read the file with `memory_get`.

## Corpus scoping

- `memory`: workspace memory files, imports, and configured extra paths.
- `wiki`: pages registered by the `memory-wiki` plugin.
- `all`: one pass across memory and wiki. Use it when the wiki plugin is on.
- `sessions`: indexed transcripts. Requires `experimental.sessionMemory: true`
  and `"sessions"` in `memory.search.sources`; hits obey
  `tools.sessions.visibility` and can include other users' conversations.

A corpus warning in the result means that corpus was unavailable or partial.
Tell the user instead of treating the answer as complete.

## What an empty result means

1. Nothing indexed: `openclaw memory status --agent <id>` shows the index
   size. Run `openclaw memory index --force --agent <id>` if it is empty or
   dirty. An empty corpus indexes as a successful no-op.
2. Keyword-only mode: `openclaw memory status --deep --agent <id>` probes the
   embedding provider. With `provider` unset, `auto`, or `local`, a failed
   embedding setup falls back to keyword search silently. Search for the
   exact words the note used.
3. Explicit provider down: when `memory.search.provider` names a provider and
   it fails, `memory_search` reports memory unavailable instead of degrading.
   Fix the provider or key. Set `provider: "none"` only for deliberate
   keyword-only recall.
4. The note was never written. Ask the user, then write it to the correct
   file so the next session finds it.

## Active Memory

In the default `escalate` mode a blocking recall sub-agent runs only when the
message asks about the past and the deterministic lane found no strong hit.
It can call only the configured memory recall tools. If it fails, the turn
continues without memory context. Do not depend on it; an explicit
`memory_search` is the reliable path.

## Promotion

Dreaming promotes daily-note material into `MEMORY.md` through score,
recall-frequency, and query-diversity gates. To inspect or run it by hand:

```bash
openclaw memory promote --agent <id>                 # preview candidates
openclaw memory promote-explain <selector> --agent <id>
openclaw memory promote --agent <id> --apply         # append selected entries
```

Promotion re-reads the live daily note before writing, so edit or delete a
short-term snippet first when a candidate should not graduate.
