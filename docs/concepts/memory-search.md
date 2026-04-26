---
summary: "How memory search finds relevant notes using embeddings and hybrid retrieval"
title: "Memory search"
read_when:
  - You want to understand how memory_search works
  - You want to choose an embedding provider
  - You want to tune search quality
---

`memory_search` finds relevant notes from your memory files, even when the
wording differs from the original text. It works by indexing memory into small
chunks and searching them using embeddings, keywords, or both.

## Quick start

If you have a GitHub Copilot subscription, OpenAI, Gemini, Voyage, or Mistral
API key configured, memory search works automatically. To set a provider
explicitly:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai", // or "gemini", "local", "ollama", etc.
      },
    },
  },
}
```

For local embeddings with no API key, install the optional `node-llama-cpp`
runtime package next to OpenClaw and use `provider: "local"`.

## Supported providers

| Provider       | ID               | Needs API key | Notes                                                |
| -------------- | ---------------- | ------------- | ---------------------------------------------------- |
| Bedrock        | `bedrock`        | No            | Auto-detected when the AWS credential chain resolves |
| Gemini         | `gemini`         | Yes           | Supports image/audio indexing                        |
| GitHub Copilot | `github-copilot` | No            | Auto-detected, uses Copilot subscription             |
| Local          | `local`          | No            | GGUF model, ~0.6 GB download                         |
| Mistral        | `mistral`        | Yes           | Auto-detected                                        |
| Ollama         | `ollama`         | No            | Local, must set explicitly                           |
| OpenAI         | `openai`         | Yes           | Auto-detected, fast                                  |
| Voyage         | `voyage`         | Yes           | Auto-detected                                        |

## How search works

OpenClaw runs two retrieval paths in parallel and merges the results:

```mermaid
flowchart LR
    Q["Query"] --> E["Embedding"]
    Q --> T["Tokenize"]
    E --> VS["Vector Search"]
    T --> BM["BM25 Search"]
    VS --> M["Weighted Merge"]
    BM --> M
    M --> R["Top Results"]
```

- **Vector search** finds notes with similar meaning ("gateway host" matches
  "the machine running OpenClaw").
- **BM25 keyword search** finds exact matches (IDs, error strings, config
  keys).

If only one path is available (no embeddings or no FTS), the other runs alone.

When embeddings are unavailable, OpenClaw still uses lexical ranking over FTS results instead of falling back to raw exact-match ordering only. That degraded mode boosts chunks with stronger query-term coverage and relevant file paths, which keeps recall useful even without `sqlite-vec` or an embedding provider.

## Improving search quality

Two optional features help when you have a large note history:

### Temporal decay

Old notes gradually lose ranking weight so recent information surfaces first.
With the default half-life of 30 days, a note from last month scores at 50% of
its original weight. Evergreen files like `MEMORY.md` are never decayed.

<Tip>
Enable temporal decay if your agent has months of daily notes and stale
information keeps outranking recent context.
</Tip>

### MMR (diversity)

Reduces redundant results. If five notes all mention the same router config, MMR
ensures the top results cover different topics instead of repeating.

<Tip>
Enable MMR if `memory_search` keeps returning near-duplicate snippets from
different daily notes.
</Tip>

### Enable both

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            mmr: { enabled: true },
            temporalDecay: { enabled: true },
          },
        },
      },
    },
  },
}
```

## Multimodal memory

With Gemini Embedding 2, you can index images and audio files alongside
Markdown. Search queries remain text, but they match against visual and audio
content. See the [Memory configuration reference](/reference/memory-config) for
setup.

## Session memory search

You can optionally index session transcripts so `memory_search` can recall
earlier conversations. This is opt-in via
`memorySearch.experimental.sessionMemory`. See the
[configuration reference](/reference/memory-config) for details.

## Troubleshooting

**No results?** Run `openclaw memory status` to check the index. If empty, run
`openclaw memory index --force`.

**Only keyword matches?** Your embedding provider may not be configured. Check
`openclaw memory status --deep`.

**Local embeddings time out?** `ollama`, `lmstudio`, and `local` use a longer
inline batch timeout by default. If the host is simply slow, set
`agents.defaults.memorySearch.sync.embeddingBatchTimeoutSeconds` and rerun
`openclaw memory index --force`.

**CJK text not found?** Rebuild the FTS index with
`openclaw memory index --force`.

## Further reading

- [Active Memory](/concepts/active-memory) -- sub-agent memory for interactive chat sessions
- [Memory](/concepts/memory) -- file layout, backends, tools
- [Memory configuration reference](/reference/memory-config) -- all config knobs

## Related

- [Memory overview](/concepts/memory)
- [Active memory](/concepts/active-memory)
- [Builtin memory engine](/concepts/memory-builtin)
