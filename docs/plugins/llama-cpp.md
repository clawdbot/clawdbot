---
summary: "Run GGUF chat with managed or existing llama.cpp servers and managed local embeddings"
read_when:
  - You want OpenClaw to install and manage a local llama.cpp server
  - You want a local model recommendation for your Gateway hardware
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
the server. Setup reads the **Gateway host's** hardware and recommends a model
from its available memory, GPU capability, and free disk space. A browser
connected to a remote Gateway installs and runs the model on that Gateway,
not on the browser's computer.

Review the named host, execution backend, model, and download size, then confirm
the download. Setup verifies pinned model files and the llama.cpp build,
prepares a loopback endpoint, and checks inference before saving the new
default. Guided activation also asks the model to read a temporary file through
an OpenClaw tool and return its contents. A plain text reply alone does not pass
that check.

### Model recommendations

Setup prefers these text-only recipes as memory permits. Each uses a 65,536-token
context and supports tools:

| Model                   | Chat download | Minimum host memory         |
| ----------------------- | ------------- | --------------------------- |
| Qwen3.5 4B Q4_K_M       | About 2.7 GB  | 8 GiB                       |
| Qwen3.5 9B Q4_K_M       | About 5.7 GB  | 16 GiB                      |
| Gemma 4 12B IT Q4_K_M   | About 7.1 GB  | 24 GiB and GPU acceleration |
| Muse Glimmer 30B Q4_K_M | About 16.8 GB | 32 GiB and GPU acceleration |
| Qwen3.8 27B UD-Q4_K_M   | About 16.5 GB | 32 GiB and GPU acceleration |

Qwen3.8 is the first recommendation when its memory budget fits. Muse has a
smaller context-cache budget and can fit a 24 GiB NVIDIA card where Qwen3.8
does not. CPU recommendations stop at Qwen3.5 9B. Gemma 4 E2B, E4B, and 26B A4B
remain in the catalog for existing routes and cached downloads. The recommendation
order is a product default, not a claim that one model wins every task.

These are selection floors, not guaranteed fit or speed. Setup reserves memory
for the operating system, context cache, runtime, and default embedding model. It accounts
for current memory pressure and container memory limits, and may recommend a
smaller model when RAM, GPU memory, or disk space is limited. Separate NVIDIA
cards are not added together to assume a model will fit. Existing Gemma 4 E4B
configurations and cached custom models remain supported.

The chat download also includes your configured local embedding model, or
EmbeddingGemma by default (about 0.3 GB). Leave additional disk space for the
runtime and download staging; setup checks this before offering a new model.
When the cache and runtime use independent volumes, setup checks each volume's
free space separately. Shared storage pools and volumes whose independence cannot
be established use a combined reserve.
Custom embedding models may need more memory and disk space than these budgets.

### Execution backends

| Gateway host                                         | Managed backend           |
| ---------------------------------------------------- | ------------------------- |
| macOS on Apple silicon                               | Metal with unified memory |
| macOS on Intel                                       | CPU                       |
| Linux x64 or arm64                                   | CPU                       |
| Windows x64 with a supported NVIDIA GPU              | CUDA 12.4                 |
| Windows x64 without supported CUDA, or Windows arm64 | CPU                       |

The verified Windows CUDA build requires NVIDIA driver 551.78 or newer and
compute capability 5.0 or newer. Setup checks the driver and installed runtime's
device discovery. When an NVIDIA GPU has no compatible managed CUDA build,
setup explains the limitation and names CPU execution in the confirmation.
For other acceleration backends, run a compatible server yourself and choose
**Existing llama-server**.

If no recommendation fits, setup explains whether to free memory, free disk
space, or fix cache-directory permissions. Cancelling or failing guided
verification leaves the previous default model selected. A setup candidate has
its own server preset, so verification does not rewrite an existing managed
server's preset. Downloaded files may remain cached for a retry. Setup verifies and reuses cached
recommendations, and charges disk space only for missing model and runtime files.

### Set up only local embeddings

When `memory.search.provider` is `local` and chat setup cannot proceed or is
declined, OpenClaw offers a separate embedding-only setup. It installs only the
managed server and the configured embedding model after explicit consent. It
does not add a llama.cpp chat model or change the current chat model. Setup discovery remains
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
- A model that replies to a simple prompt but fails the setup tool check is
  not selected as the default. Retry after reviewing its tool support or choose
  another model.
- Platforms without a verified managed build should use an existing server.

OpenClaw does not auto-select ROCm, SYCL, OpenVINO, or Vulkan archives.

## Related

- [Local model services](/gateway/local-model-services)
- [Model providers](/concepts/model-providers)
- [LM Studio](/providers/lmstudio)
