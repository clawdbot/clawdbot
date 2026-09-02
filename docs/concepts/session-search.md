---
summary: "Search past session transcripts and reopen the matching context"
title: "Session search"
read_when:
  - You need to find something discussed in an earlier session
  - You want to understand session search privacy or indexing
---

# Session search

`sessions_search` searches the user and assistant text in visible past sessions. Each result
includes a `sessionKey`, timestamp, role, and a short matching excerpt. Pass the returned
`sessionKey`, `messageId`, and `sessionId` together to `sessions_history` to reopen the matched
context, including retained history from before a session reset. Without `messageId`, history
returns the newest bounded tail instead.

Anchored reads use `limit` to bound the surrounding messages and cannot be combined with `offset`.
For SQLite transcript history, a missing message returns an empty history; a `sessionId` that does
not belong to the selected session key is rejected. These rules also apply in local embedded mode,
without a running Gateway.

## Visibility and output

Search uses the same configured session visibility rules as `sessions_history`. The default
`tools.sessions.visibility: "agent"` permits unsandboxed callers to search all sessions belonging to
their agent, including other users' conversations in shared-agent deployments. Set explicit `tree`
or `self`, or use separate agents, when callers need a narrower trust boundary. Per-peer DM routing
separates conversation context but does not restrict session-tool visibility.

Results outside the caller's effective visibility scope are removed before result limits are
applied. Sandboxed agents remain limited to sessions they spawned when spawned-session visibility
is enabled. Incognito sessions remain excluded; ordinary cross-agent access requires `all` plus
agent-to-agent policy.

Excerpts are redacted before they return to the model. Results are also bounded by count, excerpt
length, and total response size.

## Index lifecycle

OpenClaw stores a full-text index next to the transcript rows in each agent's SQLite database.
New user and assistant messages are indexed in the same transaction that persists them, so the
index never lags live conversations; tool results, reasoning blocks, and images are excluded.
Only the transcript's active branch is searchable.

Transcripts that predate the index (for example, sessions imported by `openclaw doctor`) and
sessions whose active branch was rewound are reindexed by a background reconciliation that starts
with the next search. A response with `indexing: true` can therefore be incomplete; retry after
indexing finishes. Deleting a session removes its index entries in the same transaction.

Search currently uses SQLite's Unicode word tokenizer with diacritic removal. Trigram tokenization
for CJK substring matching is a future improvement.

## Session search vs. memory search

Use `sessions_search` for exact words or phrases from raw session transcripts. Use
[`memory_search`](/concepts/memory-search) for durable memory files and semantic recall. The
experimental session-memory corpus is the semantic complement to this exact transcript search.
