---
summary: "Run GGUF chat with managed or existing llama.cpp servers and managed local embeddings"
read_when:
  - You want OpenClaw to install and manage a local llama.cpp server
  - You want OpenClaw to connect to an existing llama-server
  - You want memory search embeddings from a local GGUF model
  - You are configuring memory.search.provider = "local"
title: "llama.cpp Provider"
sidebarTitle: "llama.cpp Provider"
---

The `llama-cpp` plugin provides one `llama-cpp` model provider. OpenClaw can
manage a local `llama-server` or connect to one that you operate. Both choices
use `llama-cpp/<model>` references and the OpenAI-compatible transport.

```bash
openclaw plugins install @openclaw/llama-cpp-provider
openclaw onboard
```

## Choose server ownership

| Setup choice          | Process owner                 | Local embeddings |
| --------------------- | ----------------------------- | ---------------- |
| Managed local server  | OpenClaw                      | Yes              |
| Existing llama-server | You or an external supervisor | No               |

`models.providers.llama-cpp.localService` is the ownership discriminator. If
it exists, OpenClaw manages the process. Without it, `baseUrl` identifies an
existing endpoint. Switching choices rewrites ownership-specific state on the
same provider; it never creates another provider namespace.

## Managed local server

Choose **Managed local server** when OpenClaw should install, start, and stop
the server. After consent, setup verifies a pinned llama.cpp build, writes the
loopback endpoint and `localService` definition, and probes the result before
saving it.

The default chat model is Gemma 4 E4B IT Q4_K_M (about 5.0 GB) with a 65,536
token context cap. OpenClaw offers it only on machines with at least 16 GiB of
RAM. This setup downloads the chat model and the managed EmbeddingGemma model
(about 0.3 GB).

When `memory.search.provider` is `local` and chat setup cannot proceed or is
declined, OpenClaw offers a separate embedding-only setup. It installs only the
managed server and EmbeddingGemma after explicit consent. It does not add a
llama.cpp chat model or change the current chat model. Setup discovery remains
read-only and never installs or downloads anything.

If the llama.cpp provider has any configured chat models, embedding-only setup
leaves it unchanged. Move any chat routes to another provider and remove those
model entries before retrying. An existing external llama.cpp server config
must also be removed before OpenClaw can manage embeddings.

### Use another managed GGUF

Add a model under `models.providers.llama-cpp.models`, select its
`llama-cpp/<id>` reference, and run managed setup again:

```json5
{
  id: "my-local-model",
  name: "My local GGUF",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 2048,
  params: {
    modelPath: "~/Models/my-model.Q4_K_M.gguf",
    contextSize: 65536,
  },
  compat: { supportsTools: true },
}
```

`modelPath` accepts local paths, cache-relative filenames, full `hf:` file
URIs, and HTTPS GGUF URLs that publish a SHA-256 response digest. The default
cache is `~/.openclaw/models/llama.cpp`; a configured `modelCacheDir` remains
authoritative for managed setup.

## Existing llama-server

Choose **Existing llama-server** when another terminal, container, service
manager, or machine owns the process.

<Steps>
  <Step title="Start llama-server">
    Give the model a stable alias:

    ```bash
    llama-server \
      --model /path/to/model.gguf \
      --alias my-model \
      --host 127.0.0.1 \
      --port 8080
    ```

  </Step>
  <Step title="Configure OpenClaw">
    Run `openclaw onboard`, choose **Existing llama-server**, and enter the
    endpoint. Enable API-key authentication only when the server or proxy
    requires it.

  </Step>
  <Step title="Select the model">
    ```bash
    openclaw models list --provider llama-cpp
    openclaw models set llama-cpp/my-model
    ```
  </Step>
</Steps>

OpenClaw reads `/health`, `/models` (falling back to `/v1/models`), and
`/props`. Router property probes use `autoload=false`; discovery never loads,
wakes, unloads, downloads, or reloads models. Explicit configured model rows
remain authoritative over discovered rows with the same ID.

### Authentication and endpoint replacement

Existing endpoints support no auth, API keys, SecretRefs, auth profiles, and
explicit authorization headers. An explicit `Authorization` header wins over
ambient API-key discovery unless setup receives a new key. Choosing no API key
removes the default llama.cpp auth profile and stale inline key fields while
preserving an explicit `Authorization` header and unrelated headers. Endpoint
URLs containing a username or password are rejected.

```bash
export LLAMA_SERVER_API_KEY="<API_KEY>"
openclaw onboard
```

When the endpoint changes, setup does not send the old endpoint's environment,
profile, configured key, or header credentials to the replacement. Switching
from managed mode also removes `localService`, managed model/cache parameters,
and the managed request timeout before discovery.

For non-interactive setup:

```bash
openclaw onboard \
  --non-interactive \
  --accept-risk \
  --auth-choice llama-cpp-existing-server \
  --custom-base-url http://127.0.0.1:8080/v1 \
  --custom-model-id my-model
```

Use `--llama-server-api-key <API_KEY>` when a replacement endpoint requires a
new credential. `LLAMA_SERVER_API_KEY` remains available for initial setup and
unchanged endpoints.

### Manual configuration

Guided setup is recommended because it verifies discovery. The minimal manual
shape is:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "llama-cpp": {
        baseUrl: "http://127.0.0.1:8080/v1",
        api: "openai-completions",
        request: { allowPrivateNetwork: true },
        models: [],
      },
    },
  },
}
```

Custom provider IDs may also point at llama-server through the generic
OpenAI-compatible path. They remain custom providers and should declare the
`llamacpp` tool-schema profile explicitly; see [custom provider capability
declarations](/gateway/config-tools#custom-provider-capability-declarations).

## Requests and local embeddings

Both ownership choices use OpenClaw's normal chat, image, streaming, and tool
transport. The llama.cpp compatibility family cleans unsupported tool-schema
constraints, maps thinking-off requests to the Qwen chat-template flag, and
adapts JSON Schema requests for older llama-server builds.

Local memory embeddings require managed mode:

```json5
{
  memory: {
    search: {
      provider: "local",
      local: {
        modelPath: "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
      },
    },
  },
}
```

The plugin preserves the historical `local` embedding provider and index
identity. Run `openclaw memory status --index` after intentionally changing the
embedding model.

## Troubleshooting

- Managed setup: run `openclaw doctor` and `openclaw memory status --deep`.
- Existing server: inspect `/health`, `/models`, and `/props`; HTTP 503 means
  the model is still loading.
- Missing tools: verify both tool capability flags in `/props` and use a
  tool-capable Jinja chat template.
- Managed Linux builds require glibc 2.34 on x64 or 2.38 on arm64. Windows
  builds require the Microsoft Visual C++ 2015-2022 Redistributable.
- Platforms without a verified managed build should use an existing server.

OpenClaw does not auto-select CUDA, ROCm, SYCL, OpenVINO, or Vulkan archives.

## Related

- [Local model services](/gateway/local-model-services)
- [Model providers](/concepts/model-providers)
- [LM Studio](/providers/lmstudio)
