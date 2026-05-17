---
summary: "Configure the official external LanceDB memory plugin, including local Ollama-compatible embeddings"
read_when:
  - You are configuring the memory-lancedb plugin
  - You want LanceDB-backed long-term memory with auto-recall or auto-capture
  - You are using local OpenAI-compatible embeddings such as Ollama
title: "Memory LanceDB"
sidebarTitle: "Memory LanceDB"
---

`memory-lancedb` is an official external memory plugin that stores long-term memory in
LanceDB and uses embeddings for recall. It can automatically recall relevant
memories before a model turn and capture important facts after a response.

Use it when you want a local vector database for memory, need an
OpenAI-compatible embedding endpoint, or want to keep a memory database outside
the default built-in memory store.

## Installation

Install `memory-lancedb` before setting `plugins.slots.memory = "memory-lancedb"`:

```bash
openclaw plugins install @openclaw/memory-lancedb
```

The plugin is published to npm and is not bundled into the OpenClaw runtime image.
The installer writes the plugin entry and switches the memory slot when no other
plugin owns it.

<Note>
`memory-lancedb` is an active memory plugin. Enable it by selecting the memory
slot with `plugins.slots.memory = "memory-lancedb"`. Companion plugins such as
`memory-wiki` can run beside it, but only one plugin owns the active memory slot.
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

Restart the Gateway after changing plugin config:

```bash
openclaw gateway restart
```

Then verify the plugin is loaded:

```bash
openclaw plugins list
```

## Provider-backed embeddings

`memory-lancedb` can use the same memory embedding provider adapters as
`memory-core`. Set `embedding.provider` and omit `embedding.apiKey` to use the
provider's configured auth profile, environment variable, or
`models.providers.<provider>.apiKey`.

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
        },
      },
    },
  },
}
```

This path works with provider auth profiles that expose embedding credentials.
For example, GitHub Copilot can be used when the Copilot profile/plan supports
embeddings:

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
            provider: "github-copilot",
            model: "text-embedding-3-small",
          },
        },
      },
    },
  },
}
```

OpenAI Codex / ChatGPT OAuth (`openai-codex`) is not an OpenAI Platform
embeddings credential. For OpenAI embeddings, use an OpenAI API key auth profile,
`OPENAI_API_KEY`, or `models.providers.openai.apiKey`. OAuth-only users can use
another embedding-capable provider such as GitHub Copilot or Ollama.

## Ollama embeddings

For Ollama embeddings, prefer the bundled Ollama embedding provider. It uses the
native Ollama `/api/embed` endpoint and follows the same auth/base URL rules as
the Ollama provider documented in [Ollama](/providers/ollama).

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

Set `dimensions` for non-standard embedding models. OpenClaw knows the
dimensions for `text-embedding-3-small` and `text-embedding-3-large`; custom
models need the value in config so LanceDB can create the vector column.

For small local embedding models, lower `recallMaxChars` if you see context
length errors from the local server.

## OpenAI-compatible providers

Some OpenAI-compatible embedding providers reject the `encoding_format`
parameter, while others ignore it and always return `number[]` vectors.
`memory-lancedb` therefore omits `encoding_format` on embedding requests and
accepts either float-array responses or base64-encoded float32 responses.

If you have a raw OpenAI-compatible embeddings endpoint that does not have a
bundled provider adapter, omit `embedding.provider` (or leave it as `openai`) and
set `embedding.apiKey` plus `embedding.baseUrl`. This preserves the direct
OpenAI-compatible client path.

Set `embedding.dimensions` for providers whose model dimensions are not built
in. For example, ZhiPu `embedding-3` uses `2048` dimensions:

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

## Recall and capture limits

`memory-lancedb` has two separate text limits:

| Setting           | Default | Range     | Applies to                                                |
| ----------------- | ------- | --------- | --------------------------------------------------------- |
| `recallMaxChars`  | `1000`  | 100-10000 | text sent to the embedding API for recall                 |
| `captureMaxChars` | `500`   | 100-10000 | message length eligible for auto-capture                  |
| `customTriggers`  | `[]`    | 0-50      | literal phrases that make auto-capture consider a message |

`recallMaxChars` controls auto-recall, the `memory_recall` tool, the
`memory_forget` query path, and `openclaw ltm search`. Auto-recall prefers the
latest user message from the turn and falls back to the full prompt only when no
user message is available. This keeps channel metadata and large prompt blocks
out of the embedding request.

`captureMaxChars` controls whether a response is short enough to be considered
for automatic capture. It does not cap recall query embeddings.

`customTriggers` lets you add literal auto-capture phrases without writing
regular expressions. The built-in triggers include common English, Czech,
Chinese, Japanese, and Korean memory phrases.

## Commands

When `memory-lancedb` is the active memory plugin, it registers the `ltm` CLI
namespace:

```bash
openclaw ltm list
openclaw ltm search "project preferences"
openclaw ltm stats
```

The plugin also extends `openclaw memory` with a non-vector `query` subcommand
that runs against the LanceDB table directly:

```bash
openclaw memory query --cols id,text,createdAt --limit 20
openclaw memory query --filter "category = 'preference'" --order-by createdAt:desc
```

- `--cols <columns>`: comma-separated column allowlist (defaults to `id`, `text`, `importance`, `category`, `createdAt`).
- `--filter <condition>`: SQL-style WHERE clause; capped at 200 characters and restricted to alphanumerics, comparison operators, quotes, parentheses, and a small set of safe punctuation.
- `--limit <n>`: positive integer; default `10`.
- `--order-by <column>:<asc|desc>`: in-memory sort applied after the filter; the sort column is auto-included in the projection.

Agents also get LanceDB memory tools from the active memory plugin:

- `memory_recall` for LanceDB-backed recall
- `memory_store` for saving important facts, preferences, decisions, and entities
- `memory_forget` for removing matching memories

## Storage

By default, LanceDB data lives under `~/.openclaw/memory/lancedb`. Override the
path with `dbPath`:

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

`storageOptions` accepts string key/value pairs for LanceDB storage backends and
supports `${ENV_VAR}` expansion:

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

## Runtime dependencies

`memory-lancedb` depends on the native `@lancedb/lancedb` package. Packaged
OpenClaw treats that package as part of the plugin package. Gateway startup
does not repair plugin dependencies; if the dependency is missing, reinstall or
update the plugin package and restart the Gateway.

If an older install logs a missing `dist/package.json` or missing
`@lancedb/lancedb` error during plugin load, upgrade OpenClaw and restart the
Gateway.

If the plugin logs that LanceDB is unavailable on `darwin-x64`, use the default
memory backend on that machine, move the Gateway to a supported platform, or
disable `memory-lancedb`.

## Troubleshooting

### Input length exceeds the context length

This usually means the embedding model rejected the recall query:

```text
memory-lancedb: recall failed: Error: 400 the input length exceeds the context length
```

Set a lower `recallMaxChars`, then restart the Gateway:

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

For Ollama, also verify the embedding server is reachable from the Gateway host:

```bash
curl http://127.0.0.1:11434/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"mxbai-embed-large","input":"hello"}'
```

### Unsupported embedding model

Without `dimensions`, only the built-in OpenAI embedding dimensions are known.
For local or custom embedding models, set `embedding.dimensions` to the vector
size reported by that model.

### Plugin loads but no memories appear

Check that `plugins.slots.memory` points at `memory-lancedb`, then run:

```bash
openclaw ltm stats
openclaw ltm search "recent preference"
```

If `autoCapture` is disabled, the plugin will recall existing memories but will
not automatically store new ones. Use the `memory_store` tool or enable
`autoCapture` if you want automatic capture.

## Related

- [Memory overview](/concepts/memory)
- [Active memory](/concepts/active-memory)
- [Memory search](/concepts/memory-search)
- [Memory Wiki](/plugins/memory-wiki)
- [Ollama](/providers/ollama)
