---
summary: "How OpenClaw remembers things across sessions"
title: "Memory overview"
read_when:
  - You want to understand how memory works
  - You want to know what memory files to write
---

OpenClaw remembers things by writing **plain Markdown files** in your agent's
workspace. The model only "remembers" what gets saved to disk — there is no
hidden state.

## How it works

Your agent has three memory-related files:

- **`MEMORY.md`** — long-term memory. Durable facts, preferences, and
  decisions. Loaded at the start of every DM session.
- **`memory/YYYY-MM-DD.md`** — daily notes. Running context and observations.
  Today and yesterday's notes are loaded automatically.
- **`DREAMS.md`** (optional) — Dream Diary and dreaming sweep
  summaries for human review, including grounded historical backfill entries.

These files live in the agent workspace (default `~/.openclaw/workspace`).

<Tip>
If you want your agent to remember something, just ask it: "Remember that I
prefer TypeScript." It will write it to the appropriate file.
</Tip>

## Memory tools

The agent has two tools for working with memory:

- **`memory_search`** — finds relevant notes using semantic search, even when
  the wording differs from the original.
- **`memory_get`** — reads a specific memory file or line range.

Both tools are provided by the active memory plugin (default: `memory-core`).

## Memory Wiki companion plugin

If you want durable memory to behave more like a maintained knowledge base than
just raw notes, use the bundled `memory-wiki` plugin.

`memory-wiki` compiles durable knowledge into a wiki vault with:

- deterministic page structure
- structured claims and evidence
- contradiction and freshness tracking
- generated dashboards
- compiled digests for agent/runtime consumers
- wiki-native tools like `wiki_search`, `wiki_get`, `wiki_apply`, and `wiki_lint`

It does not replace the active memory plugin. The active memory plugin still
owns recall, promotion, and dreaming. `memory-wiki` adds a provenance-rich
knowledge layer beside it.

See [Memory Wiki](/plugins/memory-wiki).

## Memory search

When an embedding provider is configured, `memory_search` uses **hybrid
search** — combining vector similarity (semantic meaning) with keyword matching
(exact terms like IDs and code symbols). This works out of the box once you have
an API key for any supported provider.

<Info>
OpenClaw auto-detects your embedding provider from available API keys. If you
have an OpenAI, Gemini, Voyage, or Mistral key configured, memory search is
enabled automatically.
</Info>

For details on how search works, tuning options, and provider setup, see
[Memory Search](/concepts/memory-search).

## Memory backends

<CardGroup cols={3}>
<Card title="Builtin (default)" icon="database" href="/concepts/memory-builtin">
SQLite-based. Works out of the box with keyword search, vector similarity, and
hybrid search. No extra dependencies.
</Card>
<Card title="QMD" icon="search" href="/concepts/memory-qmd">
Local-first sidecar with reranking, query expansion, and the ability to index
directories outside the workspace.
</Card>
<Card title="Honcho" icon="brain" href="/concepts/memory-honcho">
AI-native cross-session memory with user modeling, semantic search, and
multi-agent awareness. Plugin install.
</Card>
<Card title="LanceDB" icon="layers" href="/plugins/memory-lancedb">
Bundled LanceDB-backed memory with OpenAI-compatible embeddings, auto-recall,
auto-capture, and local Ollama embedding support.
</Card>
</CardGroup>

## Knowledge wiki layer

<CardGroup cols={1}>
<Card title="Memory Wiki" icon="book" href="/plugins/memory-wiki">
Compiles durable memory into a provenance-rich wiki vault with claims,
dashboards, bridge mode, and Obsidian-friendly workflows.
</Card>
</CardGroup>

## Automatic memory flush

Before [compaction](/concepts/compaction) summarizes your conversation, OpenClaw
runs a silent turn that reminds the agent to save important context to memory
files. This is on by default — you do not need to configure anything.

To keep that housekeeping turn on a local model, set an exact memory-flush model
override:

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "memoryFlush": {
          "model": "ollama/qwen3:8b"
        }
      }
    }
  }
}
```

The override applies only to the memory-flush turn and does not inherit the
active session fallback chain.

<Tip>
The memory flush prevents context loss during compaction. If your agent has
important facts in the conversation that are not yet written to a file, they
will be saved automatically before the summary happens.
</Tip>

## Dreaming

Dreaming is an optional background consolidation pass for memory. It collects
short-term signals, scores candidates, and promotes only qualified items into
long-term memory (`MEMORY.md`).

It is designed to keep long-term memory high signal:

- **Opt-in**: disabled by default.
- **Scheduled**: when enabled, `memory-core` auto-manages one recurring cron job
  for a full dreaming sweep.
- **Thresholded**: promotions must pass score, recall frequency, and query
  diversity gates.
- **Reviewable**: phase summaries and diary entries are written to `DREAMS.md`
  for human review.

For phase behavior, scoring signals, and Dream Diary details, see
[Dreaming](/concepts/dreaming).

## Grounded backfill and live promotion

The dreaming system now has two closely related review lanes:

- **Live dreaming** works from the short-term dreaming store under
  `memory/.dreams/` and is what the normal deep phase uses when deciding what
  can graduate into `MEMORY.md`.
- **Grounded backfill** reads historical `memory/YYYY-MM-DD.md` notes as
  standalone day files and writes structured review output into `DREAMS.md`.

Grounded backfill is useful when you want to replay older notes and inspect what
the system thinks is durable without manually editing `MEMORY.md`.

When you use:

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

the grounded durable candidates are not promoted directly. They are staged into
the same short-term dreaming store the normal deep phase already uses. That
means:

- `DREAMS.md` stays the human review surface.
- the short-term store stays the machine-facing ranking surface.
- `MEMORY.md` is still only written by deep promotion.

If you decide the replay was not useful, you can remove the staged artifacts
without touching ordinary diary entries or normal recall state:

```bash
openclaw memory rem-backfill --rollback
openclaw memory rem-backfill --rollback-short-term
```

## CLI

```bash
openclaw memory status          # Check index status and provider
openclaw memory search "query"  # Search from the command line
openclaw memory index --force   # Rebuild the index
```

## Further reading

- [Builtin memory engine](/concepts/memory-builtin): default SQLite backend.
- [QMD memory engine](/concepts/memory-qmd): advanced local-first sidecar.
- [Honcho memory](/concepts/memory-honcho): AI-native cross-session memory.
- [Memory LanceDB](/plugins/memory-lancedb): LanceDB-backed plugin with OpenAI-compatible embeddings.
- [Memory Wiki](/plugins/memory-wiki): compiled knowledge vault and wiki-native tools.
- [Memory search](/concepts/memory-search): search pipeline, providers, and tuning.
- [Dreaming](/concepts/dreaming): background promotion from short-term recall to long-term memory.
- [Memory configuration reference](/reference/memory-config): all config knobs.
- [Compaction](/concepts/compaction): how compaction interacts with memory.

## Related

- [Active memory](/concepts/active-memory)
- [Memory search](/concepts/memory-search)
- [Builtin memory engine](/concepts/memory-builtin)
- [Honcho memory](/concepts/memory-honcho)
- [Memory LanceDB](/plugins/memory-lancedb)
