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

All memory search settings live under `agents.defaults.memorySearch` in `openclaw.json` unless noted otherwise.

<Note>
If you are looking for the **active memory** feature toggle and sub-agent config, that lives under `plugins.entries.active-memory` instead of `memorySearch`.

Active memory uses a two-gate model:

1. the plugin must be enabled and target the current agent id
2. the request must be an eligible interactive persistent chat session

See [Active Memory](/concepts/active-memory) for the activation model, plugin-owned config, transcript persistence, and safe rollout pattern.
</Note>

---

## Provider selection

| Key        | Type      | Default          | Description                                                                                                                                                                                                                        |
| ---------- | --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider` | `string`  | auto-detected    | Embedding adapter ID such as `bedrock`, `deepinfra`, `gemini`, `github-copilot`, `local`, `mistral`, `ollama`, `openai`, or `voyage`; may also be a configured `models.providers.<id>` whose `api` points at one of those adapters |
| `model`    | `string`  | provider default | Embedding model name                                                                                                                                                                                                               |
| `fallback` | `string`  | `"none"`         | Fallback adapter ID when the primary fails                                                                                                                                                                                         |
| `enabled`  | `boolean` | `true`           | Enable or disable memory search                                                                                                                                                                                                    |

### Auto-detection order

When `provider` is not set, OpenClaw selects the first available:

<Steps>
  <Step title="local">
    Selected if `memorySearch.local.modelPath` is configured and the file exists.
  </Step>
  <Step title="github-copilot">
    Selected if a GitHub Copilot token can be resolved (env var or auth profile).
  </Step>
  <Step title="openai">
    Selected if an OpenAI key can be resolved.
  </Step>
  <Step title="gemini">
    Selected if a Gemini key can be resolved.
  </Step>
  <Step title="voyage">
    Selected if a Voyage key can be resolved.
  </Step>
  <Step title="mistral">
    Selected if a Mistral key can be resolved.
  </Step>
  <Step title="deepinfra">
    Selected if a DeepInfra key can be resolved.
  </Step>
  <Step title="bedrock">
    Selected if the AWS SDK credential chain resolves (instance role, access keys, profile, SSO, web identity, or shared config).
  </Step>
</Steps>

`ollama` is supported but not auto-detected (set it explicitly).

### Custom provider ids

`memorySearch.provider` can point at a custom `models.providers.<id>` entry. OpenClaw resolves that provider's `api` owner for the embedding adapter while preserving the custom provider id for endpoint, auth, and model-prefix handling. This lets multi-GPU or multi-host setups dedicate memory embeddings to a specific local endpoint:

```json5
{
  models: {
    providers: {
      "ollama-5080": {
        api: "ollama",
        baseUrl: "http://gpu-box.local:11435",
        apiKey: "ollama-local",
        models: [{ id: "qwen3-embedding:0.6b" }],
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

Remote embeddings require an API key. Bedrock uses the AWS SDK default credential chain instead (instance roles, SSO, access keys).

| Provider       | Env var                                            | Config key                          |
| -------------- | -------------------------------------------------- | ----------------------------------- |
| Bedrock        | AWS credential chain                               | No API key needed                   |
| DeepInfra      | `DEEPINFRA_API_KEY`                                | `models.providers.deepinfra.apiKey` |
| Gemini         | `GEMINI_API_KEY`                                   | `models.providers.google.apiKey`    |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | Auth profile via device login       |
| Mistral        | `MISTRAL_API_KEY`                                  | `models.providers.mistral.apiKey`   |
| Ollama         | `OLLAMA_API_KEY` (placeholder)                     | --                                  |
| OpenAI         | `OPENAI_API_KEY`                                   | `models.providers.openai.apiKey`    |
| Voyage         | `VOYAGE_API_KEY`                                   | `models.providers.voyage.apiKey`    |

<Note>
Codex OAuth covers chat/completions only and does not satisfy embedding requests.
</Note>

---

## Remote endpoint config

For custom OpenAI-compatible endpoints or overriding provider defaults:

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
        provider: "openai",
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
    | ---------------------- | -------- | ---------------------- | ------------------------------------------ |
    | `model`                | `string` | `gemini-embedding-001` | Also supports `gemini-embedding-2-preview` |
    | `outputDimensionality` | `number` | `3072`                 | For Embedding 2: 768, 1536, or 3072        |

    <Warning>
    Changing model or `outputDimensionality` triggers an automatic full reindex.
    </Warning>

  </Accordion>
  <Accordion title="OpenAI-compatible input types">
    OpenAI-compatible embedding endpoints can opt into provider-specific `input_type` request fields. This is useful for asymmetric embedding models that require different labels for query and document embeddings.

    | Key                 | Type     | Default | Description                                             |
    | ------------------- | -------- | ------- | ------------------------------------------------------- |
    | `inputType`         | `string` | unset   | Shared `input_type` for query and document embeddings   |
    | `queryInputType`    | `string` | unset   | Query-time `input_type`; overrides `inputType`          |
    | `documentInputType` | `string` | unset   | Index/document `input_type`; overrides `inputType`      |

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "openai",
            remote: {
              baseUrl: "https://embeddings.example/v1",
              apiKey: "env:EMBEDDINGS_API_KEY",
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
    Bedrock uses the AWS SDK default credential chain — no API keys needed. If OpenClaw runs on EC2 with a Bedrock-enabled instance role, just set the provider and model:

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
    | ---------------------- | -------- | ------------------------------ | ------------------------------- |
    | `model`                | `string` | `amazon.titan-embed-text-v2:0` | Any Bedrock embedding model ID  |
    | `outputDimensionality` | `number` | model default                  | For Titan V2: 256, 512, or 1024 |

    **Supported models** (with family detection and dimension defaults):

    | Model ID                                   | Provider   | Default Dims | Configurable Dims    |
    | ------------------------------------------ | ---------- | ------------ | -------------------- |
    | `amazon.titan-embed-text-v2:0`             | Amazon     | 1024         | 256, 512, 1024       |
    | `amazon.titan-embed-text-v1`               | Amazon     | 1536         | --                   |
    | `amazon.titan-embed-g1-text-02`            | Amazon     | 1536         | --                   |
    | `amazon.titan-embed-image-v1`              | Amazon     | 1024         | --                   |
    | `amazon.nova-2-multimodal-embeddings-v1:0` | Amazon     | 1024         | 256, 384, 1024, 3072 |
    | `cohere.embed-english-v3`                  | Cohere     | 1024         | --                   |
    | `cohere.embed-multilingual-v3`             | Cohere     | 1024         | --                   |
    | `cohere.embed-v4:0`                        | Cohere     | 1536         | 256-1536             |
    | `twelvelabs.marengo-embed-3-0-v1:0`        | TwelveLabs | 512          | --                   |
    | `twelvelabs.marengo-embed-2-7-v1:0`        | TwelveLabs | 1024         | --                   |

    Throughput-suffixed variants (e.g., `amazon.titan-embed-text-v1:2:8k`) inherit the base model's configuration.

    **Authentication:** Bedrock auth uses the standard AWS SDK credential resolution order:

    1. Environment variables (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`)
    2. SSO token cache
    3. Web identity token credentials
    4. Shared credentials and config files
    5. ECS or EC2 metadata credentials

    Region is resolved from `AWS_REGION`, `AWS_DEFAULT_REGION`, the `amazon-bedrock` provider `baseUrl`, or defaults to `us-east-1`.

    **IAM permissions:** the IAM role or user needs:

    ```json
    {
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": "*"
    }
    ```

    For least-privilege, scope `InvokeModel` to the specific model:

    ```
    arn:aws:bedrock:*::foundation-model/amazon.titan-embed-text-v2:0
    ```

  </Accordion>
  <Accordion title="Local (GGUF + node-llama-cpp)">
    | Key                   | Type               | Default                | Description                                                                                                                                                                                                                                                                                                          |
    | --------------------- | ------------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `local.modelPath`     | `string`           | auto-downloaded        | Path to GGUF model file                                                                                                                                                                                                                                                                                              |
    | `local.modelCacheDir` | `string`           | node-llama-cpp default | Cache dir for downloaded models                                                                                                                                                                                                                                                                                      |
    | `local.contextSize`   | `number \| "auto"` | `4096`                 | Context window size for the embedding context. 4096 covers typical chunks (128–512 tokens) while bounding non-weight VRAM. Lower to 1024–2048 on constrained hosts. `"auto"` uses the model's trained maximum — not recommended for 8B+ models (Qwen3-Embedding-8B: 40 960 tokens → ~32 GB VRAM vs ~8.8 GB at 4096). |

    Default model: `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB, auto-downloaded). Packaged installs repair the native `node-llama-cpp` runtime through managed plugin runtime deps when `provider: "local"` is configured. Source checkouts still require native build approval: `pnpm approve-builds` then `pnpm rebuild node-llama-cpp`.

    Use the standalone CLI to verify the same provider path the Gateway uses:

    ```bash
    openclaw memory status --deep --agent main
    openclaw memory index --force --agent main
    ```

    If `provider` is `auto`, `local` is selected only when `local.modelPath` points to an existing local file. `hf:` and HTTP(S) model references can still be used explicitly with `provider: "local"`, but they do not make `auto` select local before the model is available on disk.

  </Accordion>
</AccordionGroup>

### Inline embedding timeout

<ParamField path="sync.embeddingBatchTimeoutSeconds" type="number">
  Override the timeout for inline embedding batches during memory indexing.

Unset uses the provider default: 600 seconds for local/self-hosted providers such as `local`, `ollama`, and `lmstudio`, and 120 seconds for hosted providers. Increase this when local CPU-bound embedding batches are healthy but slow.
</ParamField>

---

## Hybrid search config

All under `memorySearch.query.hybrid`:

| Key                   | Type      | Default | Description                        |
| --------------------- | --------- | ------- | ---------------------------------- |
| `enabled`             | `boolean` | `true`  | Enable hybrid BM25 + vector search |
| `vectorWeight`        | `number`  | `0.7`   | Weight for vector scores (0-1)     |
| `textWeight`          | `number`  | `0.3`   | Weight for BM25 scores (0-1)       |
| `candidateMultiplier` | `number`  | `4`     | Candidate pool size multiplier     |

<Tabs>
  <Tab title="MMR (diversity)">
    | Key           | Type      | Default | Description                          |
    | ------------- | --------- | ------- | ------------------------------------ |
    | `mmr.enabled` | `boolean` | `false` | Enable MMR re-ranking                |
    | `mmr.lambda`  | `number`  | `0.7`   | 0 = max diversity, 1 = max relevance |
  </Tab>
  <Tab title="Temporal decay (recency)">
    | Key                          | Type      | Default | Description               |
    | ---------------------------- | --------- | ------- | ------------------------- |
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

Paths can be absolute or workspace-relative. Directories are scanned recursively for `.md` files. Symlink handling depends on the active backend: the builtin engine ignores symlinks, while QMD follows the underlying QMD scanner behavior.

For agent-scoped cross-agent transcript search, use `agents.list[].memorySearch.qmd.extraCollections` instead of `memory.qmd.paths`. Those extra collections follow the same `{ path, name, pattern? }` shape, but they are merged per agent and can preserve explicit shared names when the path points outside the current workspace. If the same resolved path appears in both `memory.qmd.paths` and `memorySearch.qmd.extraCollections`, QMD keeps the first entry and skips the duplicate.

---

## Multimodal memory (Gemini)

Index images and audio alongside Markdown using Gemini Embedding 2:

| Key                       | Type       | Default    | Description                            |
| ------------------------- | ---------- | ---------- | -------------------------------------- |
| `multimodal.enabled`      | `boolean`  | `false`    | Enable multimodal indexing             |
| `multimodal.modalities`   | `string[]` | --         | `["image"]`, `["audio"]`, or `["all"]` |
| `multimodal.maxFileBytes` | `number`   | `10000000` | Max file size for indexing             |

<Note>
Only applies to files in `extraPaths`. Default memory roots stay Markdown-only. Requires `gemini-embedding-2-preview`. `fallback` must be `"none"`.
</Note>

Supported formats: `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif` (images); `.mp3`, `.wav`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.flac` (audio).

---

## Embedding cache

| Key                | Type      | Default | Description                      |
| ------------------ | --------- | ------- | -------------------------------- |
| `cache.enabled`    | `boolean` | `false` | Cache chunk embeddings in SQLite |
| `cache.maxEntries` | `number`  | `50000` | Max cached embeddings            |

Prevents re-embedding unchanged text during reindex or transcript updates.

---

## Batch indexing

| Key                           | Type      | Default | Description                |
| ----------------------------- | --------- | ------- | -------------------------- |
| `remote.nonBatchConcurrency`  | `number`  | `4`     | Parallel inline embeddings |
| `remote.batch.enabled`        | `boolean` | `false` | Enable batch embedding API |
| `remote.batch.concurrency`    | `number`  | `2`     | Parallel batch jobs        |
| `remote.batch.wait`           | `boolean` | `true`  | Wait for batch completion  |
| `remote.batch.pollIntervalMs` | `number`  | --      | Poll interval              |
| `remote.batch.timeoutMinutes` | `number`  | --      | Batch timeout              |

Available for `openai`, `gemini`, and `voyage`. OpenAI batch is typically fastest and cheapest for large backfills.

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

---

## SQLite vector acceleration (sqlite-vec)

| Key                          | Type      | Default | Description                       |
| ---------------------------- | --------- | ------- | --------------------------------- |
| `store.vector.enabled`       | `boolean` | `true`  | Use sqlite-vec for vector queries |
| `store.vector.extensionPath` | `string`  | bundled | Override sqlite-vec path          |

When sqlite-vec is unavailable, OpenClaw falls back to in-process cosine similarity automatically.

---

## Index storage

| Key                   | Type     | Default                               | Description                                 |
| --------------------- | -------- | ------------------------------------- | ------------------------------------------- |
| `store.path`          | `string` | `~/.openclaw/memory/{agentId}.sqlite` | Index location (supports `{agentId}` token) |
| `store.fts.tokenizer` | `string` | `unicode61`                           | FTS5 tokenizer (`unicode61` or `trigram`)   |

---

## QMD backend config

Set `memory.backend = "qmd"` to enable. All QMD settings live under `memory.qmd`:

| Key                      | Type      | Default  | Description                                                                           |
| ------------------------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| `command`                | `string`  | `qmd`    | QMD executable path; set an absolute path when service `PATH` differs from your shell |
| `searchMode`             | `string`  | `search` | Search command: `search`, `vsearch`, `query`                                          |
| `includeDefaultMemory`   | `boolean` | `true`   | Auto-index `MEMORY.md` + `memory/**/*.md`                                             |
| `paths[]`                | `array`   | --       | Extra paths: `{ name, path, pattern? }`                                               |
| `sessions.enabled`       | `boolean` | `false`  | Index session transcripts                                                             |
| `sessions.retentionDays` | `number`  | --       | Transcript retention                                                                  |
| `sessions.exportDir`     | `string`  | --       | Export directory                                                                      |

`searchMode: "search"` is lexical/BM25-only. OpenClaw does not run semantic vector readiness probes or QMD embedding maintenance for that mode, including during `memory status --deep`; `vsearch` and `query` continue to require QMD vector readiness and embeddings.

OpenClaw prefers current QMD collection and MCP query shapes, but keeps older QMD releases working by trying compatible collection pattern flags and older MCP tool names when needed. When QMD advertises support for multiple collection filters, same-source collections are searched with one QMD process; older QMD builds keep the per-collection compatibility path. Same-source means durable memory collections are grouped together, while session transcript collections remain a separate group so source diversification still has both inputs.

<Note>
QMD model overrides stay on the QMD side, not OpenClaw config. If you need to override QMD's models globally, set environment variables such as `QMD_EMBED_MODEL`, `QMD_RERANK_MODEL`, and `QMD_GENERATE_MODEL` in the gateway runtime environment.
</Note>

<AccordionGroup>
  <Accordion title="Update schedule">
    | Key                       | Type      | Default | Description                           |
    | ------------------------- | --------- | ------- | ------------------------------------- |
    | `update.interval`         | `string`  | `5m`    | Refresh interval                      |
    | `update.debounceMs`       | `number`  | `15000` | Debounce file changes                 |
    | `update.onBoot`           | `boolean` | `true`  | Refresh when the long-lived QMD manager opens; also gates opt-in startup refresh |
    | `update.startup`          | `string`  | `off`   | Optional gateway-start refresh: `off`, `idle`, or `immediate` |
    | `update.startupDelayMs`   | `number`  | `120000` | Delay before `startup: "idle"` refresh runs |
    | `update.waitForBootSync`  | `boolean` | `false` | Block manager opening until its initial refresh completes |
    | `update.embedInterval`    | `string`  | --      | Separate embed cadence                |
    | `update.commandTimeoutMs` | `number`  | --      | Timeout for QMD commands              |
    | `update.updateTimeoutMs`  | `number`  | --      | Timeout for QMD update operations     |
    | `update.embedTimeoutMs`   | `number`  | --      | Timeout for QMD embed operations      |
  </Accordion>
  <Accordion title="Limits">
    | Key                       | Type     | Default | Description                |
    | ------------------------- | -------- | ------- | -------------------------- |
    | `limits.maxResults`       | `number` | `6`     | Max search results         |
    | `limits.maxSnippetChars`  | `number` | --      | Clamp snippet length       |
    | `limits.maxInjectedChars` | `number` | --      | Clamp total injected chars |
    | `limits.timeoutMs`        | `number` | `4000`  | Search timeout             |
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

    The shipped default allows direct and channel sessions, while still denying groups.

    Default is DM-only. `match.keyPrefix` matches the normalized session key; `match.rawKeyPrefix` matches the raw key including `agent:<id>:`.

  </Accordion>
  <Accordion title="Citations">
    `memory.citations` applies to all backends:

    | Value            | Behavior                                            |
    | ---------------- | --------------------------------------------------- |
    | `auto` (default) | Include `Source: <path#line>` footer in snippets    |
    | `on`             | Always include footer                               |
    | `off`            | Omit footer (path still passed to agent internally) |

  </Accordion>
</AccordionGroup>

QMD boot refreshes use a one-shot subprocess path during gateway startup. The long-lived QMD manager still owns the regular file watcher and interval timers when memory search is opened for interactive use.

### Full QMD example

```json5
{
  memory: {
    backend: "qmd",
    citations: "auto",
    qmd: {
      includeDefaultMemory: true,
      update: { interval: "5m", debounceMs: 15000 },
      limits: { maxResults: 6, timeoutMs: 4000 },
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

| Key         | Type      | Default       | Description                                       |
| ----------- | --------- | ------------- | ------------------------------------------------- |
| `enabled`   | `boolean` | `false`       | Enable or disable dreaming entirely               |
| `frequency` | `string`  | `0 3 * * *`   | Optional cron cadence for the full dreaming sweep |
| `model`     | `string`  | default model | Optional Dream Diary subagent model override      |

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
