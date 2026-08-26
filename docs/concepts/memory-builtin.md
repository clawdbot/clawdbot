---
doc-schema-version: 1
summary: "The default SQLite-based memory backend with keyword, vector, and hybrid search"
title: "Builtin memory engine"
read_when:
  - You want to understand the default memory backend
  - You want to configure embedding providers or hybrid search
  - You are migrating from the removed QMD memory backend
---

The builtin engine is the default memory backend. It stores your memory index
in a per-agent SQLite database and needs no extra dependencies to get
started.

## What it provides

- **Keyword search** via FTS5 full-text indexing (BM25 scoring).
- **Vector search** via embeddings from any supported provider.
- **Hybrid search** that combines both for best results.
- **Deterministic ranking** by relevance, recency, and write-time importance.
- **Diversity-aware ordering** with MMR enabled on hybrid results by default.
- **Trusted trigger recall** for bounded pre-reply context without a recall model.
- **CJK support** via trigram tokenization for Chinese, Japanese, and Korean.
- **sqlite-vec acceleration** for in-database vector queries (optional).

## Getting started

By default, the builtin engine uses OpenAI embeddings. If `OPENAI_API_KEY` or
`models.providers.openai.apiKey` is already configured, vector search works
with no extra memory config.

To set a provider explicitly:

```json5
{
  memory: {
    search: {
      provider: "openai",
    },
  },
}
```

Without an embedding provider, only keyword search is available.

To force local GGUF embeddings, install and configure the official llama.cpp
provider, then point `local.modelPath` at a GGUF file:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

```json5
{
  memory: {
    search: {
      provider: "local",
      fallback: "none",
      local: {
        modelPath: "~/.openclaw/models/llama.cpp/hf_ggml-org_embeddinggemma-300m-qat-Q8_0.gguf",
      },
    },
  },
}
```

## Supported embedding providers

| Provider          | ID                  | Notes                               |
| ----------------- | ------------------- | ----------------------------------- |
| Bedrock           | `bedrock`           | Uses the AWS credential chain       |
| DeepInfra         | `deepinfra`         | Default: `BAAI/bge-m3`              |
| Gemini            | `gemini`            | Supports multimodal (image + audio) |
| GitHub Copilot    | `github-copilot`    | Uses your Copilot subscription      |
| LM Studio         | `lmstudio`          | Local/self-hosted                   |
| Local             | `local`             | OpenClaw-managed llama.cpp server   |
| Mistral           | `mistral`           |                                     |
| Ollama            | `ollama`            | Local/self-hosted                   |
| OpenAI            | `openai`            | Default: `text-embedding-3-small`   |
| OpenAI-compatible | `openai-compatible` | Generic `/v1/embeddings` endpoint   |
| Voyage            | `voyage`            |                                     |

Set `memory.search.provider` to switch away from OpenAI.

## How indexing works

OpenClaw indexes `MEMORY.md`, an existing root `USER.md`, and `memory/*.md` into
chunks (400 tokens with 80-token overlap by default) and stores them in a
per-agent SQLite database. OpenClaw does not create `USER.md` automatically.

Each chunk can carry nullable importance and trigger metadata. Null values are
neutral, so older indexes remain usable. Search combines hybrid relevance,
recency decay, and importance before applying MMR diversity; trigger recall
only injects curated or promoted-trusted entries.

Each indexed chunk also has SQLite-owned provenance: origin class (`owner`,
`agent`, `untrusted`, or `system`), session kind, observation time, and an
optional supersession key. This metadata is stored separately from Markdown
so recalled prose cannot rewrite its own trust classification. Durable
entries additionally record their source sessions, which powers admission
policy and selective deletion — see
[Memory provenance and deletion](/concepts/memory-provenance).

- **Index location:** the owning agent database at
  `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
- **Storage maintenance:** SQLite WAL sidecars are bounded with periodic and
  shutdown checkpoints.
- **File watching:** changes to memory files trigger a debounced reindex
  (1.5s default).
- **Auto-reindex:** the index rebuilds automatically when the embedding
  provider, model, chunking config, configured sources, or scope change.
- **Reindex on demand:** `openclaw memory index --force`

<Info>
You can also index Markdown files outside the workspace with
`memory.search.extraPaths`. See the
[configuration reference](/reference/memory-config#additional-memory-paths).
</Info>

## Migrating from QMD

QMD has been removed; builtin is the only memory engine. After upgrading, run:

```bash
openclaw doctor --fix
```

Doctor removes the retired `memory.backend`, `memory.qmd`, and
`memory.search.qmd` settings, including agent-scoped `memory.search.qmd`
forms. It preserves QMD paths and extra collections as the corresponding
`memory.search.extraPaths` entries, including `{ path, pattern }` globs. When
QMD session indexing was enabled, Doctor also enables builtin session indexing
and adds `sessions` to `memory.search.sources` without enabling broader
cross-conversation recall. Retained session-reset transcripts remain in the
agent's sessions directory and are indexed from those original artifacts.

When Memory Core finds a retired per-agent QMD workspace under
`~/.openclaw/agents/<agentId>/qmd/`, Doctor also offers to remove its derived
indexes, model downloads, collection metadata, and session exports.

Canonical memory remains in `MEMORY.md`, `USER.md`, `memory/*.md`, and the
migrated extra paths. Builtin indexes those same Markdown sources on its next
sync. The cutover is lossless by construction: no canonical memory content is
copied or deleted; only derived state is rebuilt.

Builtin now covers most QMD use cases with:

- hybrid BM25 and vector retrieval by default, followed by temporal decay,
  importance, and project affinity before MMR diversity,
- bounded lexical query expansion for conversational searches,
- string or `{ path, pattern }` entries in `memory.search.extraPaths`, and
- optional image and audio indexing under `extraPaths` only.

QMD query mode's learned cross-encoder reranking and HyDE generation are not
part of builtin memory. MMR reduces duplicate results but is not a learned
relevance reranker. To replace QMD's in-process, zero-key GGUF embeddings,
install the [llama.cpp provider](/plugins/llama-cpp) and set
`memory.search.provider: "local"`; without an embedding provider, builtin uses
BM25 keyword search only.

## When to use

The builtin engine is the right choice for most users:

- Works out of the box with no extra dependencies.
- Handles keyword and vector search well.
- Supports all embedding providers.
- Hybrid search combines the best of both retrieval approaches.

The builtin engine can index directories outside the workspace with
`memory.search.extraPaths`. It uses bounded lexical query expansion to improve
conversational recall, but it does not provide a learned or model-based relevance
reranking stage. Its MMR pass is deterministic and local.

Consider [Honcho](/concepts/memory-honcho) if you want cross-session memory
with automatic user modeling.

## Troubleshooting

**Memory search disabled?** Check `openclaw memory status`. If no provider is
detected, set one explicitly or add an API key.

**Local provider not detected?** Run interactive llama.cpp setup once, confirm
the local path exists, and run:

```bash
openclaw memory status --deep --agent main
openclaw memory index --force --agent main
```

Both standalone CLI commands and the Gateway use the same `local` provider id.
Set `memory.search.provider: "local"` when you want local embeddings.

**Stale results?** Run `openclaw memory index --force` to rebuild. The watcher
may miss changes in rare edge cases.

**sqlite-vec not loading?** OpenClaw falls back to in-process cosine
similarity automatically. `openclaw memory status --deep` reports the local
vector store separately from the embedding provider, so `Vector store:
unavailable` points at sqlite-vec loading while `Embeddings: unavailable`
points at provider/auth or model readiness. Check logs for the specific load
error.

## Configuration

For embedding provider setup, search result limits and thresholds, batch
indexing, multimodal memory, sqlite-vec, extra paths, and all other config
knobs, see the
[Memory configuration reference](/reference/memory-config).

## Related

- [Memory overview](/concepts/memory)
- [Memory search](/concepts/memory-search)
- [Active memory](/concepts/active-memory)
