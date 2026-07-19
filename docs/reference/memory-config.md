---
summary: "All configuration knobs for memory search, embedding providers, QMD, hybrid search, and multimodal indexing"
title: "Memory configuration reference"
sidebarTitle: "Memory config"
read_when:
  - You want to configure memory search providers or embedding models
  - You want to set up the QMD backend
  - You want to tune hybrid search, MMR, or temporal decay
  - You want to enable multimodal memory indexing
---

This page lists every configuration knob for OpenClaw memory search. For conceptual overviews, see:

<CardGroup cols={2}>
  <Card title="Memory overview" href="/concepts/memory">
    How memory works.
  </Card>
  <Card title="Builtin engine" href="/concepts/memory-builtin">
    Default SQLite backend.
  </Card>
  <Card title="QMD engine" href="/concepts/memory-qmd">
    Local-first sidecar.
  </Card>
  <Card title="Memory search" href="/concepts/memory-search">
    Search pipeline and tuning.
  </Card>
  <Card title="Active memory" href="/concepts/active-memory">
    Memory sub-agent for interactive sessions.
  </Card>
</CardGroup>

All memory search settings live under `agents.defaults.memorySearch` in `openclaw.json` (or a per-agent `agents.list[].memorySearch` override) unless noted otherwise.

<Note>
For the recommended personal-agent workflow, use
`memorySearch.rememberAcrossConversations`. Advanced Active Memory targeting,
model, prompt, and latency controls live under `plugins.entries.active-memory`.

See [Active Memory](/concepts/active-memory) for both activation paths,
transcript persistence, and safe rollout guidance.
</Note>

---

## Remember across conversations

| Key                           | Type      | Default                                                    | Description                                                                    |
| ----------------------------- | --------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `rememberAcrossConversations` | `boolean` | On for personal installs; off with configured DM isolation | Use relevant context from this agent's other recognized private conversations. |

Configure it per agent when only a trusted personal agent should use
cross-conversation transcript recall:

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        memorySearch: {
          rememberAcrossConversations: true,
        },
      },
    ],
  },
}
```

The value follows normal `agents.defaults.memorySearch` inheritance with a
per-agent override. When unset, it defaults on only if global
`session.dmScope` is unset or `"main"` and no binding has a `session.dmScope`
override. Any configured DM isolation defaults it off. An explicit `true` or
`false` always wins. Enabling it implies session transcript indexing and
adds `sessions` to the agent's resolved memory sources. With QMD, it also
enables that agent's session export; no separate
`memory.qmd.sessions.enabled` setting is required for this mode.

OpenClaw's built-in memory provider supports this protected path with both the
builtin and QMD backends. Alternate memory providers can keep using their own
recall hooks and advanced Active Memory tools, but this setting is skipped
unless the current provider supports protected private transcript recall.
`openclaw doctor` reports an unsupported provider or an explicit Active Memory
`toolsAllow` list that omits `memory_search`.

The retrieval boundary is narrower than general session search:

- only the same agent's recognized private conversations are eligible
- the conversation being answered is excluded
- groups and channels are excluded as sources and destinations
- unknown conversation kinds fail closed
- sandboxed recall cannot use the special cross-conversation authorization

The setting does not change `tools.sessions.visibility`, session keys,
transcript storage, delivery routing, or the permissions of `sessions_list`,
`sessions_history`, and `sessions_send`. Active Memory performs a bounded
read-only retrieval pass; unavailable or timed-out retrieval does not block the
reply.

---

## Provider selection

| Key        | Type      | Default          | Description                                                                                                                                                                                                                                                                                 |
| ---------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`  | `boolean` | `true`           | Enable or disable memory search                                                                                                                                                                                                                                                             |
| `provider` | `string`  | `"openai"`       | Embedding adapter ID such as `bedrock`, `deepinfra`, `gemini`, `github-copilot`, `local`, `mistral`, `ollama`, `openai`, `openai-compatible`, or `voyage`; may also be a configured `models.providers.<id>` whose `api` points at a memory embedding adapter or OpenAI-compatible model API |
| `model`    | `string`  | provider default | Embedding model name                                                                                                                                                                                                                                                                        |
| `fallback` | `string`  | `"none"`         | Fallback adapter ID when the primary fails                                                                                                                                                                                                                                                  |

When `provider` is not set, OpenClaw uses OpenAI embeddings. Set `provider`
explicitly to use Bedrock, DeepInfra, Gemini, GitHub Copilot, Mistral, Ollama,
Voyage, a local GGUF model, or an OpenAI-compatible `/v1/embeddings` endpoint.
Legacy configs that still say `provider: "auto"` resolve to `openai`.

<Warning>
Changing the embedding provider, model, provider settings, sources, scope,
chunking, or tokenizer can make the existing SQLite vector index incompatible.
OpenClaw pauses vector search and reports an index identity warning instead of
automatically re-embedding everything. Rebuild when you are ready with
`openclaw memory status --index --agent <id>` or
`openclaw memory index --force --agent <id>`.
</Warning>

When `provider` is unset, legacy `provider: "auto"` is present, or
`provider: "none"` intentionally selects FTS-only mode, memory recall can still
use lexical FTS ranking when embeddings are unavailable.

Explicit non-local providers fail closed. If you set `memorySearch.provider` to
a concrete remote-backed provider such as Bedrock, DeepInfra, Gemini, GitHub
Copilot, LM Studio, Mistral, Ollama, OpenAI, Voyage, or an OpenAI-compatible
custom provider, and that provider is unavailable at runtime, `memory_search`
returns an unavailable result instead of silently using FTS-only recall. Fix the
provider/auth configuration, switch to a reachable provider, or set
`provider: "none"` if you want deliberate FTS-only recall.

### Custom provider ids

`memorySearch.provider` can point at a custom `models.providers.<id>` entry for memory-specific provider adapters such as `ollama`, or for OpenAI-compatible model APIs such as `openai-responses` / `openai-completions`. OpenClaw resolves that provider's `api` owner for the embedding adapter while preserving the custom provider id for endpoint, auth, and model-prefix handling. This lets multi-GPU or multi-host setups dedicate memory embeddings to a specific local endpoint:

```json5
{
  models: {
    providers: {
      "ollama-5080": {
        api: "ollama",
        baseUrl: "http://gpu-box.local:11435",
        apiKey: "ollama-local",
        models: [{ id: "qwen3-embedding:0.6b", name: "Qwen3 Embedding 0.6B" }],
      },
    },
  },
  agents: {
    defaults: {
      memorySearch: {
        provider: "ollama-5080",
        model: "qwen3-embedding:0.6b",
      },
    },
  },
}
```

### API key resolution

Remote embeddings require an API key. Bedrock uses the AWS SDK default credential chain instead (instance roles, SSO, access keys, or a Bedrock API key).

| Provider       | Env var                                             | Config key                          |
| -------------- | --------------------------------------------------- | ----------------------------------- |
| Bedrock        | AWS credential chain, or `AWS_BEARER_TOKEN_BEDROCK` | No API key needed                   |
| DeepInfra      | `DEEPINFRA_API_KEY`                                 | `models.providers.deepinfra.apiKey` |
| Gemini         | `GEMINI_API_KEY`                                    | `models.providers.google.apiKey`    |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`  | Auth profile via device login       |
| Mistral        | `MISTRAL_API_KEY`                                   | `models.providers.mistral.apiKey`   |
| Ollama         | `OLLAMA_API_KEY` (placeholder)                      | --                                  |
| OpenAI         | `OPENAI_API_KEY`                                    | `models.providers.openai.apiKey`    |
| Voyage         | `VOYAGE_API_KEY`                                    | `models.providers.voyage.apiKey`    |

<Note>
Codex OAuth covers chat/completions only and does not satisfy embedding requests.
</Note>

---

## Remote endpoint config

Use `provider: "openai-compatible"` for a generic OpenAI-compatible
`/v1/embeddings` server that should not inherit global OpenAI chat credentials.

<ParamField path="remote.baseUrl" type="string">
  Custom API base URL.
</ParamField>
<ParamField path="remote.apiKey" type="string">
  Override API key.
</ParamField>
<ParamField path="remote.headers" type="object">
  Extra HTTP headers (merged with provider defaults).
</ParamField>

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai-compatible",
        model: "text-embedding-3-small",
        remote: {
          baseUrl: "https://api.example.com/v1/",
          apiKey: "YOUR_KEY",
        },
      },
    },
  },
}
```

---

## Provider-specific config

<AccordionGroup>
  <Accordion title="Gemini">
    | Key                    | Type     | Default                | Description                                |
    | ---------------------- | -------- | ---------------------- | ------------------------------------------- |
    | `model`                | `string` | `gemini-embedding-001` | Also supports `gemini-embedding-2-preview` |
    | `outputDimensionality` | `number` | `3072`                 | For Embedding 2: 768, 1536, or 3072        |

    <Warning>
    Changing model or `outputDimensionality` changes the index identity. OpenClaw
    pauses vector search until you explicitly rebuild the memory index.
    </Warning>

  </Accordion>
  <Accordion title="OpenAI-compatible input types">
    OpenAI-compatible embedding endpoints can opt into provider-specific `input_type` request fields. This is useful for asymmetric embedding models that require different labels for query and document embeddings.

    | Key                 | Type     | Default | Description                                             |
    | ------------------- | -------- | ------- | -------------------------------------------------------- |
    | `inputType`         | `string` | unset   | Shared `input_type` for query and document embeddings   |
    | `queryInputType`    | `string` | unset   | Query-time `input_type`; overrides `inputType`          |
    | `documentInputType` | `string` | unset   | Index/document `input_type`; overrides `inputType`      |

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai-compatible",
            remote: {
              baseUrl: "https://embeddings.example/v1",
              apiKey: "${EMBEDDINGS_API_KEY}",
            },
            model: "asymmetric-embedder",
            queryInputType: "query",
            documentInputType: "passage",
          },
        },
      },
    }
    ```

    Changing these values affects embedding cache identity for provider batch indexing and should be followed by a memory reindex when the upstream model treats the labels differently.

  </Accordion>
  <Accordion title="Bedrock">
    ### Bedrock embedding config

    Bedrock uses the AWS SDK default credential chain plus an OpenClaw-checked bearer token, so no API keys are stored in config. If OpenClaw runs on EC2 with a Bedrock-enabled instance role, just set the provider and model:

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "bedrock",
            model: "amazon.titan-embed-text-v2:0",
          },
        },
      },
    }
    ```

    | Key                    | Type     | Default                        | Description                     |
    | ---------------------- | -------- | ------------------------------- | -------------------------------- |
    | `model`                | `string` | `amazon.titan-embed-text-v2:0` | Any Bedrock embedding model ID  |
    | `outputDimensionality` | `number` | model default                  | For Titan V2: 256, 512, or 1024 |

    **Supported models** (with family detection and dimension defaults):

    | Model ID                                   | Provider   | Default Dims | Configurable Dims          |
    | ------------------------------------------- | ---------- | ------------- | -------------------------- |
    | `amazon.titan-embed-text-v2:0`             | Amazon     | 1024         | 256, 512, 1024             |
    | `amazon.titan-embed-text-v1`               | Amazon     | 1536         | --                          |
    | `amazon.titan-embed-g1-text-02`            | Amazon     | 1536         | --                          |
    | `amazon.titan-embed-image-v1`              | Amazon     | 1024         | --                          |
    | `amazon.nova-2-multimodal-embeddings-v1:0` | Amazon     | 1024         | 256, 384, 1024, 3072       |
    | `cohere.embed-english-v3`                  | Cohere     | 1024         | --                          |
    | `cohere.embed-multilingual-v3`             | Cohere     | 1024         | --                          |
    | `cohere.embed-v4:0`                        | Cohere     | 1536         | 256, 384, 512, 768, 1024, 1536 |
    | `twelvelabs.marengo-embed-3-0-v1:0`        | TwelveLabs | 512          | --                          |
    | `twelvelabs.marengo-embed-2-7-v1:0`        | TwelveLabs | 1024         | --                          |

    Throughput-suffixed variants (e.g., `amazon.titan-embed-text-v1:2:8k`) and region-prefixed inference profile IDs (e.g., `us.amazon.titan-embed-text-v2:0`) inherit the base model's configuration.

    **Region:** resolved in this order: the `memorySearch.remote.baseUrl` override, the `models.providers.amazon-bedrock.baseUrl` config, `AWS_REGION`, `AWS_DEFAULT_REGION`, then a default of `us-east-1`.

    **Authentication:** OpenClaw checks for `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` or `AWS_BEARER_TOKEN_BEDROCK` first, then falls through to the standard AWS SDK default credential provider chain:

    1. Environment variables (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`), unless `AWS_PROFILE` is also set
    2. SSO (only when SSO fields are configured)
    3. Shared credentials and config files (`fromIni`, includes `AWS_PROFILE`)
    4. Credential process (`credential_process` in the AWS config file)
    5. Web identity token credentials
    6. ECS or EC2 instance metadata credentials

    **IAM permissions:** the IAM role or user needs:

    ```json
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "*"
    }
    ```

    For least-privilege, scope `InvokeModel` to the specific model:

    ```text
    arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0
    ```

  </Accordion>
  <Accordion title="Local (GGUF + llama.cpp)">
    | Key                   | Type               | Default                | Description                                                                                                                                                                                                                                                                                                          |
    | --------------------- | ------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `local.modelPath`     | `string`           | auto-downloaded        | Path to GGUF model file                                                                                                                                                                                                                                                                                              |
    | `local.modelCacheDir` | `string`           | node-llama-cpp default | Cache dir for downloaded models                                                                                                                                                                                                                                                                                      |
    | `local.contextSize`   | `number \| "auto"` | `4096`                 | Context window size for the embedding context. 4096 covers typical chunks (128-512 tokens) while bounding non-weight VRAM. Lower to 1024-2048 on constrained hosts. `"auto"` uses the model's trained maximum -- not recommended for 8B+ models (Qwen3-Embedding-8B: up to 40 960 tokens can push VRAM to ~32 GB). |

    Install the official llama.cpp provider first: `openclaw plugins install @openclaw/llama-cpp-provider`.
    Default model: `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB, auto-downloaded). Source checkouts still require native build approval: `pnpm approve-builds` then `pnpm rebuild node-llama-cpp`.

    Use the standalone CLI to verify the same provider path the Gateway uses:

    ```bash
    openclaw memory status --deep --agent main
    openclaw memory index --force --agent main
    ```

    Numeric `local.contextSize` values also inform node-llama-cpp's automatic GPU-layer placement so model weights and the requested embedding context are fitted together. `openclaw memory status --deep` reports last-known llama.cpp backend, device, offload, requested-context, and timestamped memory facts after the runtime has loaded; passive status does not load a model.

    Set `provider: "local"` explicitly for local GGUF embeddings. `hf:` and HTTP(S) model references are supported for explicit local configs (via node-llama-cpp's model resolution), but they do not change the default provider.

  </Accordion>
</AccordionGroup>

### Inline embedding timeout

<ParamField path="sync.embeddingBatchTimeoutSeconds" type="number">
  Override the timeout for inline embedding batches during memory indexing.

Unset uses the provider default: 600 seconds for local/self-hosted providers such as `local`, `ollama`, and `lmstudio`, and 120 seconds for hosted providers. Increase this when local CPU-bound embedding batches are healthy but slow.
</ParamField>

---

## Indexing behavior

All under `memorySearch.sync` unless noted:

| Key                            | Type      | Default | Description                                                           |
| ------------------------------ | --------- | ------- | --------------------------------------------------------------------- |
| `onSessionStart`               | `boolean` | `true`  | Sync the memory index when a session starts                           |
| `onSearch`                     | `boolean` | `true`  | Sync lazily on search after detecting content changes                 |
| `watch`                        | `boolean` | `true`  | Watch memory files (chokidar) and schedule reindex on changes         |
| `watchDebounceMs`              | `number`  | `1500`  | Debounce window for coalescing rapid file-watch events                |
| `intervalMinutes`              | `number`  | `0`     | Periodic reindex interval in minutes (`0` disables)                   |
| `sessions.postCompactionForce` | `boolean` | `true`  | Force a session reindex after compaction-triggered transcript updates |

<ParamField path="chunking.tokens" type="number">
  Chunk size in tokens used when splitting memory sources before embedding (default: 400).
</ParamField>
<ParamField path="chunking.overlap" type="number">
  Token overlap between adjacent chunks to preserve context near split boundaries (default: 80).
</ParamField>

<Note>
Changing `chunking.tokens` or `chunking.overlap` changes chunk boundaries and invalidates the existing index identity (see the Warning under Provider selection).
</Note>

---

## Hybrid search config

All under `memorySearch.query`:

| Key          | Type     | Default | Description                               |
| ------------ | -------- | ------- | ----------------------------------------- |
| `maxResults` | `number` | `6`     | Max memory hits returned before injection |
| `minScore`   | `number` | `0.35`  | Minimum relevance score to include a hit  |

And under `memorySearch.query.hybrid`:

| Key                   | Type      | Default | Description                        |
| --------------------- | --------- | ------- | ---------------------------------- |
| `enabled`             | `boolean` | `true`  | Enable hybrid BM25 + vector search |
| `vectorWeight`        | `number`  | `0.7`   | Weight for vector scores (0-1)     |
| `textWeight`          | `number`  | `0.3`   | Weight for BM25 scores (0-1)       |
| `candidateMultiplier` | `number`  | `4`     | Candidate pool size multiplier     |

<Tabs>
  <Tab title="MMR (diversity)">
    | Key           | Type      | Default | Description                          |
    | ------------- | --------- | ------- | ------------------------------------- |
    | `mmr.enabled` | `boolean` | `false` | Enable MMR re-ranking                |
    | `mmr.lambda`  | `number`  | `0.7`   | 0 = max diversity, 1 = max relevance |
  </Tab>
  <Tab title="Temporal decay (recency)">
    | Key                          | Type      | Default | Description               |
    | ---------------------------- | --------- | ------- | -------------------------- |
    | `temporalDecay.enabled`      | `boolean` | `false` | Enable recency boost      |
    | `temporalDecay.halfLifeDays` | `number`  | `30`    | Score halves every N days |

    Evergreen files (`MEMORY.md`, non-dated files in `memory/`) are never decayed.

  </Tab>
</Tabs>

### Full example

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          maxResults: 6,
          minScore: 0.35,
          hybrid: {
            vectorWeight: 0.7,
            textWeight: 0.3,
            mmr: { enabled: true, lambda: 0.7 },
            temporalDecay: { enabled: true, halfLifeDays: 30 },
          },
        },
      },
    },
  },
}
```

---

## Additional memory paths

| Key          | Type       | Description                              |
| ------------ | ---------- | ---------------------------------------- |
| `extraPaths` | `string[]` | Additional directories or files to index |

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        extraPaths: ["../team-docs", "/srv/shared-notes"],
      },
    },
  },
}
```

Paths can be absolute or workspace-relative. Directories are scanned recursively for `.md` files. Symlink handling depends on the active backend: the builtin engine skips symlinks, while QMD follows the underlying QMD scanner behavior.

For agent-scoped cross-agent transcript search, use `agents.list[].memorySearch.qmd.extraCollections` instead of `memory.qmd.paths`. Those extra collections follow the same `{ path, name, pattern? }` shape, but they are merged per agent and can preserve explicit shared names when the path points outside the current workspace. If the same resolved path appears in both `memory.qmd.paths` and `memorySearch.qmd.extraCollections`, QMD keeps the first entry and skips the duplicate.

---

## Multimodal memory (Gemini)

Index images and audio alongside Markdown using Gemini Embedding 2:

| Key                       | Type       | Default    | Description                            |
| ------------------------- | ---------- | ---------- | -------------------------------------- |
| `multimodal.enabled`      | `boolean`  | `false`    | Enable multimodal indexing             |
| `multimodal.modalities`   | `string[]` | --         | `["image"]`, `["audio"]`, or `["all"]` |
| `multimodal.maxFileBytes` | `number`   | `10485760` | Max file size for indexing (10 MiB)    |

<Note>
Only applies to files in `extraPaths`. Default memory roots stay Markdown-only. Requires `gemini-embedding-2-preview`. `fallback` must be `"none"`.
</Note>

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif` (images); `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac` (audio).

---

## Embedding cache

| Key                | Type      | Default | Description                                  |
| ------------------ | --------- | ------- | -------------------------------------------- |
| `cache.enabled`    | `boolean` | `true`  | Cache chunk embeddings in SQLite             |
| `cache.maxEntries` | `number`  | unset   | Best-effort upper bound on cached embeddings |

Prevents re-embedding unchanged text during reindex or transcript updates. Leave `maxEntries` unset for an unbounded cache; set it when disk growth matters more than peak reindex speed. When set, the oldest entries (by last-updated time) are pruned first once the cache exceeds the limit.

---

## Batch indexing

| Key                           | Type      | Default | Description                |
| ----------------------------- | --------- | ------- | -------------------------- |
| `remote.nonBatchConcurrency`  | `number`  | `4`     | Parallel inline embeddings |
| `remote.batch.enabled`        | `boolean` | `false` | Enable batch embedding API |
| `remote.batch.concurrency`    | `number`  | `2`     | Parallel batch jobs        |
| `remote.batch.wait`           | `boolean` | `true`  | Wait for batch completion  |
| `remote.batch.pollIntervalMs` | `number`  | `2000`  | Poll interval              |
| `remote.batch.timeoutMinutes` | `number`  | `60`    | Batch timeout              |

Available for `gemini`, `openai`, and `voyage`. OpenAI batch is typically fastest and cheapest for large backfills.

`remote.nonBatchConcurrency` controls inline embedding calls used by local/self-hosted providers and hosted providers when provider batch APIs are not active. Ollama defaults to `1` for non-batch indexing to avoid overwhelming smaller local hosts; set a higher value on larger machines.

This is separate from `sync.embeddingBatchTimeoutSeconds`, which controls the timeout for inline embedding calls.

---

## Session memory search (experimental)

Index session transcripts and surface them via `memory_search`:

| Key                           | Type       | Default      | Description                             |
| ----------------------------- | ---------- | ------------ | --------------------------------------- |
| `experimental.sessionMemory`  | `boolean`  | `false`      | Enable session indexing                 |
| `sources`                     | `string[]` | `["memory"]` | Add `"sessions"` to include transcripts |
| `sync.sessions.deltaBytes`    | `number`   | `100000`     | Byte threshold for reindex              |
| `sync.sessions.deltaMessages` | `number`   | `50`         | Message threshold for reindex           |

<Warning>
Session indexing is opt-in and runs asynchronously. Results can be slightly stale. Session logs live on disk, so treat filesystem access as the trust boundary.
</Warning>

Ordinary model-invoked session transcript search obeys
[`tools.sessions.visibility`](/gateway/config-tools#toolssessions). The default
`tree` visibility exposes the current session, sessions it spawned, and
same-agent group sessions watched through ambient group awareness. Other
unrelated sessions require `agent` visibility (or `all` only when cross-agent
recall is also required and agent-to-agent policy allows it).

`rememberAcrossConversations` does not widen that setting. It supplies a
separate runtime-only authorization limited to same-agent private
transcripts during the bounded Active Memory pass.

The examples below place these settings under `agents.defaults`. You can also
apply equivalent `memorySearch` settings in a per-agent override when only one
agent should index and search session transcripts.

For same-agent gateway-to-DM recall:

<Tabs>
  <Tab title="Builtin backend">
    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            experimental: { sessionMemory: true },
            sources: ["memory", "sessions"],
          },
        },
      },
      tools: {
        sessions: { visibility: "agent" },
      },
    }
    ```
  </Tab>
  <Tab title="QMD backend">
    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            experimental: { sessionMemory: true },
            sources: ["memory", "sessions"],
          },
        },
      },
      memory: {
        backend: "qmd",
        qmd: {
          sessions: { enabled: true },
        },
      },
      tools: {
        sessions: { visibility: "agent" },
      },
    }
    ```
  </Tab>
</Tabs>

When using QMD, `agents.defaults.memorySearch.experimental.sessionMemory` and
`sources: ["sessions"]` do not by themselves export transcripts into QMD. Set
`memory.qmd.sessions.enabled: true` as well. The higher-level
`rememberAcrossConversations: true` setting is the exception: it implies the
required QMD session export for that agent. Implied exports stay private:
they always use the default internal export location (a configured
`sessions.exportDir` applies only to explicit exports), they are searched only
during that agent's cross-conversation recall, and ordinary `memory_get`
cannot read them. Explicit
`memory.qmd.sessions.enabled: true` keeps its existing behavior and makes
exported transcripts part of the ordinary memory corpus.

---

## SQLite vector acceleration (sqlite-vec)

| Key                          | Type      | Default | Description                       |
| ---------------------------- | --------- | ------- | --------------------------------- |
| `store.vector.enabled`       | `boolean` | `true`  | Use sqlite-vec for vector queries |
| `store.vector.extensionPath` | `string`  | bundled | Override sqlite-vec path          |

When sqlite-vec is unavailable, OpenClaw falls back to in-process cosine similarity automatically.

---

## Index storage

Built-in memory indexes live in each agent's OpenClaw SQLite database at
`agents/<agentId>/agent/openclaw-agent.sqlite`.

| Key                   | Type     | Default     | Description                               |
| --------------------- | -------- | ----------- | ----------------------------------------- |
| `store.fts.tokenizer` | `string` | `unicode61` | FTS5 tokenizer (`unicode61` or `trigram`) |

---

## QMD backend config

Set `memory.backend = "qmd"` to enable. All QMD settings live under `memory.qmd`:

| Key                      | Type      | Default  | Description                                                                           |
| ------------------------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| `command`                | `string`  | `qmd`    | QMD executable path; set an absolute path when service `PATH` differs from your shell |
| `searchMode`             | `string`  | `search` | Search command: `search`, `vsearch`, `query`                                          |
| `rerank`                 | `boolean` | --       | Set to `false` with `searchMode: "query"` and QMD 2.1+ to skip QMD reranking          |
| `includeDefaultMemory`   | `boolean` | `true`   | Auto-index `MEMORY.md` + `memory/**/*.md`                                             |
| `paths[]`                | `array`   | --       | Extra paths: `{ name, path, pattern? }`                                               |
| `sessions.enabled`       | `boolean` | `false`  | Export session transcripts into QMD                                                   |
| `sessions.retentionDays` | `number`  | --       | Transcript retention                                                                  |
| `sessions.exportDir`     | `string`  | --       | Export directory                                                                      |

`searchMode: "search"` is lexical/BM25-only. OpenClaw does not run semantic vector readiness probes or QMD embedding maintenance for that mode, including during `memory status --deep`; `vsearch` and `query` continue to require QMD vector readiness and embeddings.

`rerank: false` only changes QMD `query` mode and requires QMD 2.1 or newer. In direct CLI mode OpenClaw passes `--no-rerank`; in mcporter-backed MCP mode it passes `rerank: false` to QMD's unified query tool. Leave it unset to use QMD's default query reranking behavior.

OpenClaw prefers current QMD collection and MCP query shapes, but keeps older QMD releases working by trying compatible collection pattern flags and older MCP tool names when needed. When QMD advertises support for multiple collection filters, same-source collections are searched with one QMD process; older QMD builds keep the per-collection compatibility path. Same-source means durable memory collections (default memory files plus custom paths) are grouped together, while session transcript collections remain a separate group so source diversification still has both inputs.

<Note>
QMD model overrides stay on the QMD side, not OpenClaw config. If you need to override QMD's models globally, set environment variables such as `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, and `QMD_GENERATE_MODEL` in the gateway runtime environment.
</Note>

### mcporter integration

All under `memory.qmd.mcporter`. Routes QMD searches through a long-lived `mcporter` MCP daemon instead of spawning `qmd` per query, cutting cold-start overhead for larger models.

| Key           | Type      | Default | Description                                                            |
| ------------- | --------- | ------- | ---------------------------------------------------------------------- |
| `enabled`     | `boolean` | `false` | Route QMD calls through mcporter instead of spawning `qmd` per request |
| `serverName`  | `string`  | `qmd`   | mcporter server name that runs `qmd mcp` with `lifecycle: keep-alive`  |
| `startDaemon` | `boolean` | `true`  | Automatically start the mcporter daemon when `enabled` is true         |

Requires `mcporter` installed and on PATH, plus a configured mcporter server that runs `qmd mcp`. Keep disabled for simpler local setups where per-query process spawn cost is acceptable.

<AccordionGroup>
  <Accordion title="Update schedule">
    | Key                       | Type      | Default | Description                           |
    | --------------------------- | --------- | -------- | ---------------------------------------- |
    | `update.interval`         | `string`  | `5m`    | Refresh interval                      |
    | `update.debounceMs`       | `number`  | `15000` | Debounce file changes                 |
    | `update.onBoot`           | `boolean` | `true`  | Refresh when the long-lived QMD manager opens; set false to skip the immediate boot update |
    | `update.startup`          | `string`  | `off`   | Optional gateway-start QMD initialization: `off`, `idle`, or `immediate` |
    | `update.startupDelayMs`   | `number`  | `120000` | Delay before `startup: "idle"` refresh runs |
    | `update.waitForBootSync`  | `boolean` | `false` | Block manager opening until its initial refresh completes |
    | `update.embedInterval`    | `string`  | `60m`   | Separate embed cadence                |
    | `update.commandTimeoutMs` | `number`  | `30000` | Timeout for QMD maintenance commands (collection list/add) |
    | `update.updateTimeoutMs`  | `number`  | `120000` | Timeout for each `qmd update` cycle   |
    | `update.embedTimeoutMs`   | `number`  | `120000` | Timeout for each `qmd embed` cycle    |
  </Accordion>
  <Accordion title="Limits">
    | Key                       | Type     | Default | Description                |
    | --------------------------- | -------- | ------- | ------------------------------ |
    | `limits.maxResults`       | `number` | `4`     | Max search results         |
    | `limits.maxSnippetChars`  | `number` | `450`   | Clamp snippet length       |
    | `limits.maxInjectedChars` | `number` | `2200`  | Clamp total injected chars |
    | `limits.timeoutMs`        | `number` | `4000`  | QMD command timeout during QMD-backed search, including `memory_search`; setup, sync, builtin fallback, and supplemental work keep the default tool deadline |
  </Accordion>
  <Accordion title="Scope">
    Controls which sessions can receive QMD search results. Same schema as [`session.sendPolicy`](/gateway/config-agents#session):

    ```json5
    {
      memory: {
        qmd: {
          scope: {
            default: "deny",
            rules: [{ action: "allow", match: { chatType: "direct" } }],
          },
        },
      },
    }
    ```

    The shipped default is DM/direct-only, denying groups and other channel types. `match.keyPrefix` matches the normalized session key; `match.rawKeyPrefix` matches the raw key including `agent:<id>:`.

  </Accordion>
  <Accordion title="Citations">
    `memory.citations` applies to all backends:

    | Value            | Behavior                                            |
    | ------------------ | ------------------------------------------------------ |
    | `auto` (default) | Include `Source: <path#line>` footer in snippets    |
    | `on`             | Always include footer                               |
    | `off`            | Omit footer (path still passed to agent internally) |

  </Accordion>
</AccordionGroup>

When gateway-start QMD initialization is enabled, OpenClaw starts QMD only for eligible agents. If `update.onBoot` is true and no interval/embed maintenance is configured, startup uses a one-shot manager for the boot refresh and closes it. If an update or embed interval is configured, startup opens the long-lived QMD manager so it can own the watcher and interval timers; `update.onBoot: false` skips only the immediate boot refresh.

### Full QMD example

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      includeDefaultMemory: true,
      update: { interval: "5m", debounceMs: 15000 },
      limits: { maxResults: 4, timeoutMs: 4000 },
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
      paths: [{ name: "docs", path: "~/notes", pattern: "**/*.md" }],
    },
  },
}
```

---

## Dreaming

Dreaming is configured under `plugins.entries.memory-core.config.dreaming`, not under `agents.defaults.memorySearch`.

Dreaming runs as one scheduled sweep and uses internal light/deep/REM phases as an implementation detail.

For conceptual behavior and slash commands, see [Dreaming](/concepts/dreaming).

### User settings

| Key                                    | Type      | Default       | Description                                                                                                                      |
| -------------------------------------- | --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | `boolean` | `false`       | Enable or disable dreaming entirely                                                                                              |
| `frequency`                            | `string`  | `0 3 * * *`   | Optional cron cadence for the full dreaming sweep                                                                                |
| `model`                                | `string`  | default model | Optional Dream Diary subagent model override                                                                                     |
| `phases.deep.maxPromotedSnippetTokens` | `number`  | `160`         | Maximum estimated tokens kept from each short-term recall snippet promoted into `MEMORY.md`; provenance metadata remains visible |

### Example

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        subagent: {
          allowModelOverride: true,
          allowedModels: ["anthropic/claude-sonnet-4-6"],
        },
        config: {
          dreaming: {
            enabled: true,
            frequency: "0 3 * * *",
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      },
    },
  },
}
```

<Note>
- Dreaming writes machine state to `memory/.dreams/`.
- Dreaming writes human-readable narrative output to `DREAMS.md` (or existing `dreams.md`).
- `dreaming.model` uses the existing plugin subagent trust gate; set `plugins.entries.memory-core.subagent.allowModelOverride: true` before enabling it.
- Dream Diary retries once with the session default model when the configured model is unavailable. Trust or allowlist failures are logged and are not silently retried.
- The light/deep/REM phase policy and thresholds are internal behavior, not user-facing config.

</Note>

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Memory overview](/concepts/memory)
- [Memory search](/concepts/memory-search)
