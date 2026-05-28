---
summary: "The default SQLite-based memory backend with keyword, vector, and hybrid search"
title: "Builtin memory engine"
read_when:
  - You want to understand the default memory backend
  - You want to configure embedding providers or hybrid search
---

The builtin engine is the default memory backend. It stores your memory index in
a per-agent SQLite database and needs no extra dependencies to get started.

## What it provides

- **Keyword search** via FTS5 full-text indexing (BM25 scoring).
- **Vector search** via embeddings from any supported provider.
- **Hybrid search** that combines both for best results.
- **CJK support** via trigram tokenization for Chinese, Japanese, and Korean.
- **sqlite-vec acceleration** for in-database vector queries (optional).

## Getting started

By default, the builtin engine uses OpenAI embeddings. If you already have
`OPENAI_API_KEY` or `models.providers.openai.apiKey` configured, vector search
works with no extra memory config.

To set a provider explicitly:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
      },
    },
  },
}
```

Without an embedding provider, only keyword search is available.

To force the built-in local embedding provider, install the optional
`node-llama-cpp` runtime package next to OpenClaw, then point `local.modelPath`
at a GGUF file:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "local",
        fallback: "none",
        local: {
          modelPath: "~/.node-llama-cpp/models/embeddinggemma-300m-qat-Q8_0.gguf",
        },
      },
    },
  },
}
```

## Supported embedding providers

| Provider          | ID                  | Notes                               |
| ----------------- | ------------------- | ----------------------------------- |
| Bedrock           | `bedrock`           | Uses AWS credential chain           |
| DeepInfra         | `deepinfra`         | Default: `BAAI/bge-m3`              |
| Gemini            | `gemini`            | Supports multimodal (image + audio) |
| GitHub Copilot    | `github-copilot`    | Uses Copilot subscription           |
| Local             | `local`             | Optional `node-llama-cpp` runtime   |
| Mistral           | `mistral`           |                                     |
| Ollama            | `ollama`            | Local/self-hosted                   |
| OpenAI            | `openai`            | Default: `text-embedding-3-small`   |
| OpenAI-compatible | `openai-compatible` | Generic `/v1/embeddings` endpoint   |
| Voyage            | `voyage`            |                                     |

Set `memorySearch.provider` to switch away from OpenAI.

## How indexing works

OpenClaw indexes `MEMORY.md` and `memory/*.md` into chunks (~400 tokens with
80-token overlap) and stores them in a per-agent SQLite database.

- **Index location:** `~/.openclaw/memory/<agentId>.sqlite`
- **Storage maintenance:** SQLite WAL sidecars are bounded with periodic and
  shutdown checkpoints.
- **File watching:** changes to memory files trigger a debounced reindex (1.5s).
- **Auto-reindex:** when the embedding provider, model, or chunking config
  changes, the entire index is rebuilt automatically.
- **Reindex on demand:** `openclaw memory index --force`

<Info>
You can also index Markdown files outside the workspace with
`memorySearch.extraPaths`. See the
[configuration reference](/reference/memory-config#additional-memory-paths).
</Info>

## When to use

The builtin engine is the right choice for most users:

- Works out of the box with no extra dependencies.
- Handles keyword and vector search well.
- Supports all embedding providers.
- Hybrid search combines the best of both retrieval approaches.

Consider switching to [QMD](/concepts/memory-qmd) if you need reranking, query
expansion, or want to index directories outside the workspace.

Consider [Honcho](/concepts/memory-honcho) if you want cross-session memory with
automatic user modeling.

## Troubleshooting

**Memory search disabled?** Check `openclaw memory status`. If no provider is
detected, set one explicitly or add an API key.

**Local provider not detected?** Confirm the local path exists and run:

```bash
openclaw memory status --deep --agent main
openclaw memory index --force --agent main
```

Both standalone CLI commands and the Gateway use the same `local` provider id.
Set `memorySearch.provider: "local"` when you want local embeddings.

**Stale results?** Run `openclaw memory index --force` to rebuild. The watcher
may miss changes in rare edge cases.

**sqlite-vec not loading?** OpenClaw falls back to in-process cosine similarity
automatically. `openclaw memory status --deep` reports the local vector store
separately from the embedding provider, so `Vector store: unavailable` points
at sqlite-vec loading while `Embeddings: unavailable` points at provider/auth
or model readiness. Check logs for the specific load error.

## Configuration

For embedding provider setup, hybrid search tuning (weights, MMR, temporal
decay), batch indexing, multimodal memory, sqlite-vec, extra paths, and all
other config knobs, see the
[Memory configuration reference](/reference/memory-config).

## Related

- [Memory overview](/concepts/memory)
- [Memory search](/concepts/memory-search)
- [Active memory](/concepts/active-memory)
