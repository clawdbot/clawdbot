---
summary: "Configure the official external LanceDB memory plugin, including local Ollama-compatible embeddings"
read_when:
  - You are configuring the memory-lancedb plugin
  - You want LanceDB-backed long-term memory with auto-recall or auto-capture
  - You are using local OpenAI-compatible embeddings such as Ollama
title: "Memory LanceDB"
sidebarTitle: "Memory LanceDB"
---

`memory-lancedb` is an official external plugin that stores long-term memory in
LanceDB with vector search. It can auto-recall relevant memories before a model
turn and auto-capture important facts after a response.

Use it for a local vector database, an OpenAI-compatible embedding endpoint, or
a memory store outside the default built-in memory backend.

## Installation

```bash
openclaw plugins install @openclaw/memory-lancedb
```

The plugin is published to npm; it is not bundled into the OpenClaw runtime
image. Installing it writes the plugin entry, enables it, and switches
`plugins.slots.memory` to `memory-lancedb`. If another plugin currently owns
the memory slot, that plugin is disabled with a warning.

<Note>
Companion plugins such as `memory-wiki` can run alongside `memory-lancedb`,
but only one plugin owns the active memory slot at a time.
</Note>

<Note>
LanceDB's `memory_recall` does not receive the protected private transcript
authorization used by `memory.search.rememberAcrossConversations`. Use LanceDB's
`autoRecall` or its `memory_recall` tool through
[advanced Active Memory](/concepts/active-memory#lancedb-memory).
`openclaw doctor` reports when Remember across conversations is unavailable
with the current memory provider.
</Note>

## Quick start

```json5
{
  plugins: {
    slots: {
      memory: "memory-lancedb",
    },
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          embedding: {
            provider: "openai",
            model: "text-embedding-3-small",
          },
          autoRecall: true,
          autoCapture: false,
        },
      },
    },
  },
}
```

After saving the configuration, enable the plugin and inspect its registrations:

```bash
openclaw plugins enable memory-lancedb
openclaw plugins inspect memory-lancedb --runtime
```

## Embedding config

`embedding` is required and must include at least one field. `provider`
defaults to `openai`; `model` defaults to `text-embedding-3-small`.

| Field                  | Type          | Notes                                                                    |
| ---------------------- | ------------- | ------------------------------------------------------------------------ |
| `embedding.provider`   | string        | Adapter id, e.g. `openai`, `github-copilot`, `ollama`. Default `openai`. |
| `embedding.model`      | string        | Default `text-embedding-3-small`.                                        |
| `embedding.apiKey`     | string        | Optional; supports `${ENV_VAR}` expansion and live credential rotation.  |
| `embedding.baseUrl`    | string        | Optional; supports `${ENV_VAR}` expansion and live endpoint rotation.    |
| `embedding.dimensions` | integer (>=1) | Required for models not in the built-in table (see below).               |

Two request paths exist:

- **Provider adapter path** (default): set `embedding.provider` and omit
  `embedding.apiKey`/`embedding.baseUrl`. The plugin resolves the provider's
  configured auth profile, environment variable, or
  `models.providers.<provider>.apiKey` through the same memory embedding
  adapters `memory-core` uses. This is the path for `github-copilot`, `ollama`,
  and any other bundled provider with embedding support.
- **Direct OpenAI-compatible client path**: leave `embedding.provider` unset
  (or `"openai"`) and set `embedding.apiKey` plus `embedding.baseUrl`. Use this
  for a raw OpenAI-compatible embeddings endpoint that has no bundled provider
  adapter.

`embedding.apiKey` and `embedding.baseUrl` are re-read from live plugin config
for the next memory operation, as long as `provider`, `model`, and `dimensions`
remain unchanged.

<Warning>
`embedding.provider`, `embedding.model`, and `embedding.dimensions` define the
persisted LanceDB index identity and stay fixed within a running plugin instance.
Before reloading the plugin with a new identity, plan a LanceDB re-embedding or
rebuild so every stored row uses the new vector space and dimensions. The plugin
does not re-embed existing rows automatically.
</Warning>

OpenAI Codex / ChatGPT OAuth is not an OpenAI Platform embeddings credential.
For OpenAI embeddings use an OpenAI API key auth profile, `OPENAI_API_KEY`, or
`models.providers.openai.apiKey`. OAuth-only users should pick another
embedding-capable provider such as `github-copilot` or `ollama`.

```json5
{
  plugins: {
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          embedding: {
            provider: "github-copilot",
            model: "text-embedding-3-small",
          },
        },
      },
    },
  },
}
```

Some OpenAI-compatible embedding endpoints reject the `encoding_format`
parameter; others ignore it and always return `number[]`. `memory-lancedb`
omits `encoding_format` on requests and accepts either float-array or
base64-encoded float32 responses, so both response shapes work without config.

### Dimensions

OpenClaw has a built-in dimension for `text-embedding-3-small` (1536) and
`text-embedding-3-large` (3072) only. Any other model needs an explicit
`embedding.dimensions` so LanceDB can create the vector column, for example
ZhiPu `embedding-3` at 2048 dimensions:

```json5
{
  plugins: {
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          embedding: {
            apiKey: "${ZHIPU_API_KEY}",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4",
            model: "embedding-3",
            dimensions: 2048,
          },
        },
      },
    },
  },
}
```

## Ollama embeddings

Use the bundled Ollama provider adapter path (`embedding.provider: "ollama"`).
It calls Ollama's native `/api/embed` endpoint and follows the same auth/base
URL rules as the [Ollama](/providers/ollama) provider.

```json5
{
  plugins: {
    slots: {
      memory: "memory-lancedb",
    },
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          embedding: {
            provider: "ollama",
            baseUrl: "http://127.0.0.1:11434",
            model: "mxbai-embed-large",
            dimensions: 1024,
          },
          recallMaxChars: 400,
          autoRecall: true,
          autoCapture: false,
        },
      },
    },
  },
}
```

`mxbai-embed-large` is not in the built-in dimension table, so `dimensions` is
required. For small local embedding models, lower `recallMaxChars` if the
local server returns context-length errors.

## Recall and capture limits

| Setting           | Default | Range                       | Applies to                                                        |
| ----------------- | ------- | --------------------------- | ----------------------------------------------------------------- |
| `recallMaxChars`  | `1000`  | 100-10000                   | Recall query length and each escaped model-visible recalled item. |
| `captureMaxChars` | `500`   | 100-10000                   | `memory_store` input limit and auto-capture eligibility.          |
| `customTriggers`  | `[]`    | 0-50 items, each ≤100 chars | Literal phrases that make auto-capture consider a message.        |

`recallMaxChars` bounds the `before_prompt_build` auto-recall query, the
`memory_recall` tool, the `memory_forget` query path, and `openclaw ltm search`.
Auto-recall embeds the latest user message from the turn and falls back to the
full prompt only when no user message is present, keeping channel metadata and
large prompt blocks out of the embedding request. It also bounds each recalled
item after prompt escaping before that text reaches the model.

`captureMaxChars` gates whether a user message from the turn's `agent_end`
event is short enough to be considered for auto-capture. `memory_store` rejects
longer text before embedding or storage; the setting does not affect recall
queries.

`customTriggers` adds literal auto-capture phrases without regex. Built-in
triggers cover common English, Czech, Chinese, Japanese, and Korean memory
phrases (`remember`, `prefer`, `记住`, `覚えて`, `기억해`, and similar).

Auto-capture also rejects text that looks like envelope/transport metadata,
prompt-injection payloads, or already-injected `<relevant-memories>` context,
and caps at 3 captured memories per agent turn.

Completed message occurrences are not processed again while they remain in the
conversation transcript, including after compaction. The last 60 completed text
blocks also stay deduplicated after their messages leave the transcript. This
history includes text that matched an existing memory and successful blocks from
a partially failed message. A later message can still capture text that an
earlier occurrence skipped because of the per-turn limit. Identical replacements
without a distinct timestamp or retained context can be indistinguishable from
an unchanged replay. Resetting or ending
the conversation clears that progress. Overlapping completions in one conversation
share capture progress; other conversations can proceed independently. On shutdown,
the plugin stops new capture work and waits for pending captures before closing
its storage.

Every memory is owned by one agent. Recall, duplicate detection, capture,
listing, raw queries, and deletion all enforce that owner before returning or
mutating rows. An agent with `memory.search.enabled: false` in its `agents.entries.*`
entry, or one inheriting a disabled top-level search, also gets none of the `memory_recall`, `memory_store`,
or `memory_forget` tools and does not participate in automatic recall or
capture, even when the plugin-level `autoRecall`/`autoCapture` flags are on.

## Commands

`memory-lancedb` registers the `ltm` CLI namespace whenever it is installed
(not only when it owns the active memory slot):

```bash
openclaw ltm list [--agent <id>] [--limit <n>] [--order-by-created-at]
openclaw ltm search <query> [--agent <id>] [--limit <n>]
openclaw ltm stats [--agent <id>]
```

`ltm query` runs a non-vector query directly against the LanceDB table:

```bash
openclaw ltm query --agent research --cols id,text,createdAt --limit 20
openclaw ltm query --filter "category = 'preference'" --order-by createdAt:desc
```

| Flag                              | Default                                 | Notes                                                                                                                                     |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--agent <id>`                    | configured default agent                | Selects the private agent namespace. Available on `list`, `search`, `query`, and `stats`.                                                 |
| `--cols <columns>`                | `id,text,importance,category,createdAt` | Comma-separated column allowlist.                                                                                                         |
| `--filter <condition>`            | none                                    | One comparison over an output column, such as `category = 'preference'` or `importance >= 0.8`. String values must be quoted.             |
| `--limit <n>`                     | `10`                                    | Positive integer.                                                                                                                         |
| `--order-by <column>:<asc\|desc>` | none                                    | Sorted in memory after the filter runs; the sort column is auto-added to the projection and stripped from output if it was not requested. |

Agents get three tools from the active memory plugin:

- `memory_recall`: vector search over stored memories.
- `memory_store`: save a fact, preference, decision, or entity (rejects text
  that looks like a prompt-injection payload; skips exact duplicates after
  normalizing line endings, Unicode NFC, and surrounding whitespace, but stores
  semantically similar memories with different text).
- `memory_forget`: delete by `memoryId`, or by `query` (auto-deletes a single
  match above 90% score, otherwise lists candidate IDs to disambiguate).

## Storage

LanceDB data defaults to `~/.openclaw/memory/lancedb`. Override with `dbPath`:

```json5
{
  plugins: {
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          dbPath: "~/.openclaw/memory/lancedb",
          embedding: {
            apiKey: "${OPENAI_API_KEY}",
            model: "text-embedding-3-small",
          },
        },
      },
    },
  },
}
```

The plugin keeps one LanceDB table and stores a normalized agent owner on each
row. This is a storage boundary, not a post-search filter: agent ownership is
applied before vector ranking and is included in list, query, count, and delete
predicates. `ltm query --filter` accepts one validated comparison over the
public output columns. The store builds that comparison separately from the
mandatory owner predicate, so a filter cannot widen the query to another
agent.

Databases created before per-agent ownership have no reliable row provenance.
On upgrade, `openclaw doctor --fix` assigns those legacy rows once to the
configured default agent. Runtime access fails closed until that migration has
completed; other agents never inherit the old shared rows.

`storageOptions` accepts string key/value pairs for LanceDB storage backends
(e.g. S3-compatible object storage) and supports `${ENV_VAR}` expansion:

```json5
{
  plugins: {
    entries: {
      "memory-lancedb": {
        enabled: true,
        config: {
          dbPath: "s3://memory-bucket/openclaw",
          storageOptions: {
            access_key: "${AWS_ACCESS_KEY_ID}",
            secret_key: "${AWS_SECRET_ACCESS_KEY}",
            endpoint: "${AWS_ENDPOINT_URL}",
          },
          embedding: {
            apiKey: "${OPENAI_API_KEY}",
            model: "text-embedding-3-small",
          },
        },
      },
    },
  },
}
```

## Runtime dependencies and platform support

`memory-lancedb` bundles LanceDB's JavaScript. Its plugin package declares native
`@lancedb/lancedb-*` packages as optional dependencies, so installation selects
the matching binary for the host platform. Gateway startup does not repair
plugin dependencies; if the native dependency is missing or fails to load,
reinstall or update the plugin package. Managed installs and updates apply to
the running Gateway. After repairing package files directly, run
`openclaw plugins reload memory-lancedb`.

Changing Node.js or the host platform still requires a Gateway restart with
compatible native dependencies. Plugin reload does not change the running
process or its ABI.

`@lancedb/lancedb` does not publish a native build for `darwin-x64` (Intel
Mac). On that platform the plugin logs that LanceDB is unavailable at load
time; use the default memory backend, run the Gateway on a supported
platform/architecture, or disable `memory-lancedb`.

## Troubleshooting

### Input length exceeds the context length

The embedding model rejected the recall query:

```text
memory-lancedb: recall failed: Error: 400 the input length exceeds the context length
```

Lower `recallMaxChars`; the new limit applies to the next memory operation:

```json5
{
  plugins: {
    entries: {
      "memory-lancedb": {
        config: {
          recallMaxChars: 400,
        },
      },
    },
  },
}
```

For Ollama, also verify the embedding server is reachable from the Gateway
host using its native embed endpoint:

```bash
curl http://127.0.0.1:11434/api/embed \
  -H "Content-Type: application/json" \
  -d '{"model":"mxbai-embed-large","input":"hello"}'
```

### Unsupported embedding model

Without `embedding.dimensions`, only the built-in OpenAI embedding dimensions
are known (`text-embedding-3-small`, `text-embedding-3-large`). For any other
model, set `embedding.dimensions` to the vector size that model reports.

### Plugin loads but no memories appear

Confirm `plugins.slots.memory` points at `memory-lancedb`, then run:

```bash
openclaw ltm stats
openclaw ltm search "recent preference"
```

If `autoCapture` is disabled, the plugin still recalls existing memories but
does not store new ones automatically. Use the `memory_store` tool, or enable
`autoCapture`.

## Related

- [Memory overview](/concepts/memory)
- [Active memory](/concepts/active-memory)
- [Memory search](/concepts/memory-search)
- [Memory Wiki](/plugins/memory-wiki)
- [Ollama](/providers/ollama)
