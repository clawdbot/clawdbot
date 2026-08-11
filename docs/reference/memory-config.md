---
summary: "Built-in memory search providers, retrieval modes, and multimodal indexing"
title: "Memory configuration reference"
sidebarTitle: "Memory config"
read_when:
  - You want to configure memory search providers or embedding models
  - You want to understand hybrid search, MMR, or temporal-decay defaults
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
  <Card title="Memory search" href="/concepts/memory-search">
    Search pipeline and tuning.
  </Card>
  <Card title="Active memory" href="/concepts/active-memory">
    Memory sub-agent for interactive sessions.
  </Card>
</CardGroup>

All shared memory settings live under top-level `memory` in `openclaw.json`. Search defaults use `memory.search`; per-agent search overrides use `agents.entries.*.memory.search`.

<Note>
For the recommended personal-agent workflow, use
`memory.search.rememberAcrossConversations`. Advanced Active Memory targeting,
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
    entries: {
      personal: {
        memory: {
          search: {
            rememberAcrossConversations: true,
          },
        },
      },
    },
  },
}
```

The value follows normal `memory.search` inheritance with a
per-agent override. When unset, it defaults on only if global
`session.dmScope` is unset or `"main"` and no binding has a `session.dmScope`
override. Any configured DM isolation defaults it off. An explicit `true` or
`false` always wins. Enabling it implies session transcript indexing and adds
`sessions` to the agent's resolved memory sources.

OpenClaw's built-in memory provider supports this protected path. Alternate memory providers can keep using their own
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

Explicit non-local providers fail closed. If you set `memory.search.provider` to
a concrete remote-backed provider such as Bedrock, DeepInfra, Gemini, GitHub
Copilot, LM Studio, Mistral, Ollama, OpenAI, Voyage, or an OpenAI-compatible
custom provider, and that provider is unavailable at runtime, `memory_search`
returns an unavailable result instead of silently using FTS-only recall. Fix the
provider/auth configuration, switch to a reachable provider, or set
`provider: "none"` if you want deliberate FTS-only recall.

### Custom provider ids

`memory.search.provider` can point at a custom `models.providers.<id>` entry for memory-specific provider adapters such as `ollama`, or for OpenAI-compatible model APIs such as `openai-responses` / `openai-completions`. OpenClaw resolves that provider's `api` owner for the embedding adapter while preserving the custom provider id for endpoint, auth, and model-prefix handling. This lets multi-GPU or multi-host setups dedicate memory embeddings to a specific local endpoint:

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
  memory: {
    search: {
      provider: "ollama-5080",
      model: "qwen3-embedding:0.6b",
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
  memory: {
    search: {
      provider: "openai-compatible",
      model: "text-embedding-3-small",
      remote: {
        baseUrl: "https://api.example.com/v1/",
        apiKey: "YOUR_KEY",
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
      memory: {
        search: {
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
    }
    ```

    Changing these values affects embedding cache identity for provider batch indexing and should be followed by a memory reindex when the upstream model treats the labels differently.

  </Accordion>
  <Accordion title="Bedrock">
    ### Bedrock embedding config

    Bedrock uses the AWS SDK default credential chain plus an OpenClaw-checked bearer token, so no API keys are stored in config. If OpenClaw runs on EC2 with a Bedrock-enabled instance role, just set the provider and model:

    ```json5
    {
      memory: {
        search: {
          provider: "bedrock",
          model: "amazon.titan-embed-text-v2:0",
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

    **Region:** resolved in this order: the `memory.search.remote.baseUrl` override, the `models.providers.amazon-bedrock.baseUrl` config, `AWS_REGION`, `AWS_DEFAULT_REGION`, then a default of `us-east-1`.

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
    | Key               | Type     | Default         | Description             |
    | ----------------- | -------- | --------------- | ----------------------- |
    | `local.modelPath` | `string` | auto-downloaded | Path to GGUF model file |

    Install the official llama.cpp provider first: `openclaw plugins install @openclaw/llama-cpp-provider`.
    Default model: `embeddinggemma-300m-qat-Q8_0.gguf` (~0.6 GB, auto-downloaded). Source checkouts still require native build approval: `pnpm approve-builds` then `pnpm rebuild node-llama-cpp`.

    Use the standalone CLI to verify the same provider path the Gateway uses:

    ```bash
    openclaw memory status --deep --agent main
    openclaw memory index --force --agent main
    ```

    Cache placement and embedding context sizing are provider-owned. `openclaw memory status --deep` reports last-known llama.cpp backend, device, offload, requested-context, and timestamped memory facts after the runtime has loaded; passive status does not load a model.

    Set `provider: "local"` explicitly for local GGUF embeddings. `hf:` and HTTP(S) model references are supported for explicit local configs (via node-llama-cpp's model resolution), but they do not change the default provider.

  </Accordion>
</AccordionGroup>

## Indexing behavior

Memory engines own synchronization, batching, watch, and post-compaction
indexing heuristics. OpenClaw keeps these behaviors enabled with maintained
defaults rather than exposing per-install timing switches.

## Hybrid search config

All under `memory.search.query`:

| Key          | Type     | Default | Description                               |
| ------------ | -------- | ------- | ----------------------------------------- |
| `maxResults` | `number` | `6`     | Max memory hits returned before injection |
| `minScore`   | `number` | `0.35`  | Minimum relevance score to include a hit  |

Hybrid retrieval remains enabled. The builtin engine always applies a fixed
30-day recency half-life to dated daily notes and a fixed importance
multiplier after hybrid relevance, then applies MMR diversity ordering with a
fixed lambda of `0.7`. `MEMORY.md`, `USER.md`, and other evergreen memory files
do not decay. Nullable importance is neutral, so no migration or new tuning
key is required for existing indexes.

Strong trigger matches on promoted, trusted entries can inject up to three
compact memories on eligible interactive turns. Today, root `MEMORY.md` and
`USER.md` are the curated eligible tier. Daily notes and transcripts are never
auto-injected.

### Full example

```json5
{
  memory: {
    search: {
      query: {
        maxResults: 6,
        minScore: 0.35,
      },
    },
  },
}
```

---

## Additional memory paths

| Key          | Type                                                  | Description                              |
| ------------ | ----------------------------------------------------- | ---------------------------------------- |
| `extraPaths` | `Array<string \| { path: string; pattern?: string }>` | Additional directories or files to index |

```json5
{
  memory: {
    search: {
      extraPaths: ["../team-docs", { path: "/srv/shared-notes", pattern: "runbooks/**/*.md" }],
    },
  },
}
```

Paths can be absolute or workspace-relative. Directories are scanned recursively for supported
files. Object entries narrow a directory with a root-relative glob using `/` separators; direct
file entries are indexed exactly. The builtin engine skips symlinks.

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

| Key             | Type      | Default | Description                      |
| --------------- | --------- | ------- | -------------------------------- |
| `cache.enabled` | `boolean` | `true`  | Cache chunk embeddings in SQLite |

Prevents re-embedding unchanged text during reindex or transcript updates.

---

## Batch indexing

| Key                    | Type      | Default | Description                |
| ---------------------- | --------- | ------- | -------------------------- |
| `remote.batch.enabled` | `boolean` | `false` | Enable batch embedding API |

Available for `gemini`, `openai`, and `voyage`. OpenAI batch is typically fastest and cheapest for large backfills.

Batch enablement is the only remote batching setting. Concurrency, polling, and timeout behavior are provider-owned.

---

## Session memory search

Index session transcripts and surface them via `memory_search`:

| Key                           | Type       | Default                                                    | Description                              |
| ----------------------------- | ---------- | ---------------------------------------------------------- | ---------------------------------------- |
| `rememberAcrossConversations` | `boolean`  | On for personal installs; off with configured DM isolation | Permit private cross-conversation recall |
| `sources`                     | `string[]` | `["memory"]`                                               | Add `"sessions"` to include transcripts  |

<Warning>
Session indexing is opt-in and runs asynchronously. Results can be slightly stale. Session logs live on disk, so treat filesystem access as the trust boundary.
</Warning>

<Note>
The [session-memory hook](/automation/hooks#session-memory) saves conversation
excerpts to `<workspace>/memory/`, which the `memory` source already indexes.
If transcript indexing is also enabled, the same conversation can appear from
both `memory` and `sessions`, resulting in overlapping search results and
additional embedding work. For hook-only recall, set `sources: ["memory"]` and
`rememberAcrossConversations: false`; `sources` alone is insufficient because
cross-conversation recall automatically adds `sessions`. For full-transcript
recall instead, run `openclaw hooks disable session-memory`. Enable both only
when you intentionally want both representations.
</Note>

Ordinary model-invoked session transcript search obeys
[`tools.sessions.visibility`](/gateway/config-tools#toolssessions). The default
`tree` visibility exposes the current session, sessions it spawned, and
same-agent group sessions watched through ambient group awareness. Other
unrelated sessions require `agent` visibility (or `all` only when cross-agent
recall is also required and agent-to-agent policy allows it).

`rememberAcrossConversations` does not widen that setting. It supplies a
separate runtime-only authorization limited to same-agent private
transcripts during the bounded Active Memory pass.

The examples below place these settings under top-level `memory.search`. You can also
apply equivalent settings in a per-agent `memory.search` override when only one
agent should index and search session transcripts.

For same-agent gateway-to-DM recall:

```json5
{
  memory: {
    search: {
      experimental: { sessionMemory: true },
      sources: ["memory", "sessions"],
    },
  },
  tools: {
    sessions: { visibility: "agent" },
  },
}
```

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

## Citations

`memory.citations` controls citation visibility for built-in memory results:

| Value            | Behavior                                               |
| ---------------- | ------------------------------------------------------ |
| `auto` (default) | Include `Source: <path#line>` when useful              |
| `on`             | Always include the source footer                       |
| `off`            | Omit the footer; the path remains available internally |

---

## Dreaming

Dreaming is configured under `plugins.entries.memory-core.config.dreaming`, not under `memory.search`.

Dreaming runs as one scheduled sweep and uses internal light/deep/REM phases as an implementation detail.

For conceptual behavior and slash commands, see [Dreaming](/concepts/dreaming).

### User settings

| Key                                     | Type      | Default       | Description                                                                                                                      |
| --------------------------------------- | --------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                               | `boolean` | `true`        | Enable or disable dreaming entirely                                                                                              |
| `frequency`                             | `string`  | `0 3 * * *`   | Optional cron cadence for the full dreaming sweep                                                                                |
| `model`                                 | `string`  | default model | Optional Dream Diary subagent model override                                                                                     |
| `phases.deep.maxPromotedSnippetTokens`  | `number`  | `160`         | Maximum estimated tokens kept from each short-term recall snippet promoted into `MEMORY.md`; provenance metadata remains visible |
| `phases.deep.maxPriorEntryLossFraction` | `number`  | `0.25`        | Reject a consolidation rewrite that removes more than this fraction of prior entries                                             |

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
- Deep consolidation stores the prior `MEMORY.md` in SQLite-backed plugin state and records rewrite counts and highlights in `DREAMS.md`.
- Untrusted and system-derived candidates are structurally excluded before consolidation and durable promotion.
- `dreaming.model` uses the existing plugin subagent trust gate; set `plugins.entries.memory-core.subagent.allowModelOverride: true` before enabling it.
- Dream Diary retries once with the session default model when the configured model is unavailable. Trust or allowlist failures are logged and are not silently retried.
- The light/deep/REM phase policy and thresholds are internal behavior, not user-facing config.

</Note>

## Related

- [Configuration reference](/gateway/configuration-reference)
- [Memory overview](/concepts/memory)
- [Memory search](/concepts/memory-search)
