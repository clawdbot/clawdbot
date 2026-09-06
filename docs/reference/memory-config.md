---
summary: "Built-in memory search, admission exclusions, and dreaming configuration"
title: "Memory configuration reference"
sidebarTitle: "Memory config"
doc-schema-version: 1
read_when:
  - You want to configure memory search providers or embedding models
  - You want to understand hybrid search, MMR, or temporal-decay defaults
  - You want to enable multimodal memory indexing
  - You need to exclude specific session sources from automatic dreaming ingestion
  - You see a memory file-watching pressure warning
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

For custom OpenAI-compatible providers, `models.providers.<id>.apiKey` can name
an API-key or bearer-token profile saved with [`openclaw models auth`](/cli/models#auth-profiles),
such as `my-embeddings:default`. Literal keys keep their configured value even
when other profiles are saved for the provider. Empty keys do not select a saved profile.

<Note>
Codex OAuth covers chat/completions only and does not satisfy embedding requests.
</Note>

---

## Remote endpoint config

Use `provider: "openai-compatible"` for a generic OpenAI-compatible
`/v1/embeddings` server that should not inherit global OpenAI chat credentials.

<ParamField path="remote.baseUrl" type="string">
  Custom API base URL. Provider credentials and headers are inherited only when this resolves to the provider's configured destination.
</ParamField>
<ParamField path="remote.apiKey" type="string">
  API key owned by the remote destination. Set this when `remote.baseUrl` points somewhere other than the provider's configured destination.
</ParamField>
<ParamField path="remote.headers" type="object">
  Extra HTTP headers owned by the remote destination. Provider defaults are merged only for the provider's configured destination.
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
    | `model`                | `string` | `gemini-embedding-001` | Also supports `gemini-embedding-2`         |
    | `outputDimensionality` | `number` | `3072`                 | 128-3072; recommended: 768, 1536, or 3072  |

    The legacy `gemini-embedding-2-preview` identifier remains accepted during
    migration to the stable model.

    <Warning>
    Changing model or `outputDimensionality` changes the index identity. OpenClaw
    pauses vector search until you explicitly rebuild the memory index.

    Upgrading any existing configuration that already uses
    `gemini-embedding-2` can trigger the same pause even when you do not edit the
    configuration. Before this release, the stable model's dimension was
    omitted from index identity whether `outputDimensionality` was absent or
    explicitly set. After upgrade, an absent setting resolves to 3072, while an
    explicit setting between 128 and 3072 becomes part of the identity. The
    default `gemini-embedding-001` keeps its existing identity when this setting
    is absent; an explicitly configured value that was previously ignored now
    also changes the identity. For either path, check the affected agent with
    `openclaw memory status --deep --agent <id>`, then rebuild when ready with
    `openclaw memory index --force --agent <id>`.
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
  <Accordion title="Local (managed llama.cpp server)">
    | Key               | Type     | Default         | Description             |
    | ----------------- | -------- | --------------- | ----------------------- |
    | `local.modelPath` | `string` | auto-downloaded | Path to GGUF model file |

    Install the official llama.cpp provider, then choose llama.cpp once in
    interactive setup. OpenClaw installs a pinned, verified `llama-server` and
    writes its loopback `localService` configuration. Default model:
    `embeddinggemma-300m-qat-Q8_0.gguf` (~0.3 GB, auto-downloaded).

    Use the standalone CLI to verify the same provider path the Gateway uses:

    ```bash
    openclaw memory status --deep --agent main
    openclaw memory index --force --agent main
    ```

    Cache placement is provider-owned. `openclaw memory status --deep` reports
    server build, model path, capability, and endpoint facts observed from the
    managed server after it has handled an embedding request.

    Set `provider: "local"` explicitly for local GGUF embeddings. Full `hf:`
    file references and integrity-bearing HTTPS GGUF URLs are supported for
    explicit local configs, but they do not change the default provider.

  </Accordion>
</AccordionGroup>

## Indexing behavior

Memory engines own synchronization, batching, watch, and post-compaction
indexing heuristics. OpenClaw keeps these behaviors enabled with maintained
defaults rather than exposing per-install timing switches.

### File-watcher pressure

The "Memory file watching is tracking ..." warning reports an advisory count of
watched paths or directories, not a measured host limit or confirmed exhaustion.
Remove unnecessary `memory.search.extraPaths` entries or narrow their directory
roots. Global entries and `agents.entries.<id>.memory.search.extraPaths` entries
are combined: an empty per-agent list does not remove global roots. Changing only
an entry's `pattern` filters indexed files, not the directory tree being watched.

Removing extra-path entries does not exclude files that still belong to the
default `MEMORY.md`, `USER.md`, or `memory/` roots. If reducing extra paths is
insufficient, review file-watch and open-file limits on the Gateway host. There is no supported
`memory.search.sync.watch` setting.

After changes, restart the Gateway. To refresh the affected index, run
`openclaw memory index --force --agent <id>` on the Gateway host using its profile
and environment, including any `OPENCLAW_STATE_DIR` or `OPENCLAW_CONFIG_PATH`
overrides. Use the affected agent's ID; the command printed in the warning includes
it and the active profile or container hint. See [memory index](/cli/memory#memory-index).

## Hybrid search config

All under `memory.search.query`:

| Key          | Type     | Default | Description                               |
| ------------ | -------- | ------- | ----------------------------------------- |
| `maxResults` | `number` | `6`     | Max memory hits returned before injection |
| `minScore`   | `number` | `0.35`  | Minimum relevance score to include a hit  |

Without a per-call `maxResults`, primary-only `memory_search` calls use this
configured limit, including `corpus=memory` and `corpus=sessions`. Wiki and
combined searches (`corpus=wiki` or `corpus=all`) keep their separate default
of 10 results. An explicit tool `maxResults` overrides the applicable default.

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

For shared notes, keep each workspace's `memory/` directory local and add the shared directory's
canonical path to `extraPaths`. This setting indexes notes; it does not authorize legacy host-event
migration through a symlink.

If `openclaw doctor --fix` reports an unsafe Memory Core host-event source, check the named path and
permissions. Back up the legacy journal before replacing any symlink. To import it, preserve its
contents at `memory/.dreams/events.jsonl` as a regular file under regular directories inside the intended
workspace, then rerun `openclaw doctor --fix`. Doctor leaves rejected sources untouched. A symlink to
the workspace root itself is supported; symlinks below that root are refused by this migration.

---

## Multimodal memory (Gemini)

Index images and audio alongside Markdown using Gemini Embedding 2:

| Key                       | Type       | Default    | Description                            |
| ------------------------- | ---------- | ---------- | -------------------------------------- |
| `multimodal.enabled`      | `boolean`  | `false`    | Enable multimodal indexing             |
| `multimodal.modalities`   | `string[]` | --         | `["image"]`, `["audio"]`, or `["all"]` |
| `multimodal.maxFileBytes` | `number`   | `10485760` | Max file size for indexing (10 MiB)    |

<Note>
Only applies to files in `extraPaths`. Default memory roots stay Markdown-only. Requires `gemini-embedding-2` (the legacy preview identifier is also accepted). `fallback` must be `"none"`.
</Note>

Supported formats: `.jpg`, `.jpeg`, `.png` (images); `.mp3`, `.wav` (audio).

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
Session indexing is opt-in and runs asynchronously. Results can be slightly stale. Active transcripts live in the agent's SQLite database, while retained transcript artifacts can live on disk. Treat access to both as part of the same trust boundary.
</Warning>

Internal dreaming-narrative, cron, and heartbeat session transcripts are not
indexed, including retained compressed narrative archives whose live session
metadata is gone. They may quote fragments from user conversations but are not
searchable memory sources. Sessions purged with
[`openclaw memory forget`](/cli/memory#memory-forget) are also durably excluded,
even though their source transcripts remain in the session store. A forced
reindex removes stale transcript records without readmitting either group.
Ordinary user-session transcripts, including retained, reset, and
deleted-session archives, remain eligible until explicitly targeted.

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
[`tools.sessions.visibility`](/gateway/config-tools#tools-sessions). The default
`all` visibility permits cross-agent session access for unsandboxed callers,
including other users' transcripts. `memory_search` remains scoped to the selected
agent's indexed corpus; use [`sessions_search`](/concepts/session-search) for
Gateway-wide transcript search. Cross-agent access is on by default and governed
by `tools.agentToAgent`; set `enabled: false` to block ordinary cross-agent access
or use `allow` to restrict agent pairs; requester-owned native subagent and ACP child sessions stay reachable under `tree` or `all`. Set `agent` for same-agent recall or
`tree` for current plus spawned scope (main still sees all
same-agent sessions), or `self` for strict current-session access. A per-peer
DM scope alone does not restrict session-tool recall. Sandbox clamps and
incognito exclusions still apply.

`rememberAcrossConversations` does not widen that setting. It supplies a
separate runtime-only authorization limited to same-agent private
transcripts during the bounded Active Memory pass.

An explicit `memory_search` request for the `sessions` corpus requires session
search to be enabled for that agent. If it is unavailable, OpenClaw explains
how to enable session indexing instead of silently searching memory files.

The examples below place these settings under top-level `memory.search`. You can also
apply equivalent settings in a per-agent `memory.search` override when only one
agent should index and search session transcripts.

To keep transcript recall same-agent only, narrow session visibility from the
default `all`:

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

With `trigram`, query terms shorter than three characters use substring matching,
so short terms such as `AI` and `UK` remain searchable. Longer terms keep
full-text matching, including in queries that also contain short terms.

---

## Citations

`memory.citations` controls citation visibility for built-in memory results:

| Value            | Behavior                                               |
| ---------------- | ------------------------------------------------------ |
| `auto` (default) | Include `Source: <path#line>` when useful              |
| `on`             | Always include the source footer                       |
| `off`            | Omit the footer; the path remains available internally |

---

## Memory admission policy

Configure session exclusions for **dreaming ingestion and session backfill** under
`plugins.entries.memory-core.config.memoryPolicy.excludeSessions`. These
settings do not disable transcript search, restrict workspace writes, or
erase existing memories. See
[Memory provenance and deletion](/concepts/memory-provenance) for coverage and
deletion workflows.

| Key                          | Type       | Default | Matches                                                    |
| ---------------------------- | ---------- | ------- | ---------------------------------------------------------- |
| `hookExternalContentSources` | `string[]` | `[]`    | Recorded external-content hook sources, such as `"gmail"`. |
| `channels`                   | `string[]` | `[]`    | Recorded channel/plugin identifiers, not room IDs.         |
| `chatTypes`                  | `string[]` | `[]`    | Recorded chat type: `"direct"`, `"group"`, or `"channel"`. |

Every setting is optional. Omitted or empty arrays add no exclusions;
the normal provenance and session-kind gates still apply. Configured strings
are trimmed, with empty values dropped, then matched exactly and case-sensitively.
There are no glob patterns, substring matches, or message-content searches.

Hook sources are exact identifiers: IMAP uses `email`, Gmail hooks use `gmail`,
and generic webhooks use `webhook`. To exclude both IMAP and Gmail ingestion,
set `hookExternalContentSources: ["email", "gmail"]`.

Lists combine with **OR**. For example, configuring a hook source and
`chatTypes: ["group"]` excludes that hook source **and every group session**,
not just group sessions from that source. Matching uses retained live session
metadata through the configured `session.store`, including custom and shared
stores, scoped to the source agent. Missing metadata does not match a rule.
Older retained records may contain only a coarse `webhook` classification;
when the original exact source is gone, neither `email` nor `webhook` is
inferred for matching. Explicitly forget those sessions by full ID when needed.
Automatic dreaming separately skips retained archives; these lists do not
establish whether another memory path can read an archived transcript.

```json5
{
  plugins: {
    entries: {
      "memory-core": {
        config: {
          memoryPolicy: {
            excludeSessions: {
              hookExternalContentSources: ["gmail"],
            },
          },
        },
      },
    },
  },
}
```

Automatic ingestion checks these rules before reading the transcript. A
matched session's ingestion checkpoint records `excludedReason` as
`hookExternalContentSource:<source>`,
`channel:<channel>`, or `chatType:<type>`, in that precedence order.
Removing the rule makes the session eligible for a later sweep, subject to
the other ingestion gates.

Sessions selected by [`memory forget`](/cli/memory#memory-forget) are checked
first and receive the reason `forgotten`. Their durable per-agent exclusion
also applies to session backfill and transcript indexing, and removing a
configured rule does not undo it. It excludes the selected IDs, not every
future session from the same source.

<Warning>
Configured admission rules apply to automatic dreaming ingestion and manual
`memory session-backfill` previews, REM output, and apply runs. Raw transcript
indexing does not apply these lists. Direct agent writes and session-memory hooks are also
outside this policy. Use tool permissions and hook configuration when a
session must not write memory files at all.
</Warning>

Adding a rule does not remove an existing corpus, short-term candidate, or
promoted memory. Preview existing attributable artifacts with
`memory forget --dry-run`, then review its
[deletion boundaries](/concepts/memory-provenance#what-deletion-does-not-cover)
before applying it. Source session transcripts remain in the session store.

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
