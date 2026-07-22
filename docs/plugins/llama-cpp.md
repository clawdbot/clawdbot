---
summary: "Run local GGUF text inference and memory embeddings in OpenClaw with llama.cpp"
read_when:
  - You want local text inference without an API key or model server
  - You want memory search embeddings from a local GGUF model
  - You are configuring memory.search.provider = "local"
  - You need the OpenClaw plugin that owns the node-llama-cpp runtime
title: "llama.cpp Provider"
sidebarTitle: "llama.cpp Provider"
---

`llama-cpp` is the official external provider plugin for in-process local GGUF
text inference and embeddings. It registers text provider `llama-cpp`,
embedding provider `local`, and owns the `node-llama-cpp` native runtime.

Install it before using either local inference or local memory embeddings:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

The main `openclaw` npm package does not include `node-llama-cpp`. Keeping the
native dependency in this plugin prevents normal OpenClaw npm updates from
deleting a manually installed runtime inside the OpenClaw package directory.

## Local text inference

Choose **Local model (llama.cpp)** during interactive onboarding. OpenClaw asks
before downloading the default model:

`hf:bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf`

The Qwen3 4B Instruct 2507 Q4_K_M file is about 2.5 GB. Budget roughly 3 GB of
RAM for model weights, plus context and OpenClaw runtime overhead. The default
context is automatically sized with an 8,192-token cap so it remains practical
on 8 GB machines. Configure a larger context only when the machine has enough
memory.

The onboarding discovery check is read-only. It offers llama.cpp automatically
only when the default or configured GGUF file is already in the model cache; it
never downloads during discovery. Ollama and LM Studio remain separate local
service choices and keep their own discovery flows. Manually choosing llama.cpp
is the path that prompts for the default model download.

The provider uses the GGUF model's embedded chat template and native
node-llama-cpp function calling. Text streams token by token. Tool calls return
to OpenClaw for execution rather than running inside node-llama-cpp.

### Use another GGUF model

Add a model to `models.providers.llama-cpp`. Put a local path or full `hf:` file
URI in `params.modelPath`:

```json5
{
  models: {
    mode: "merge",
    providers: {
      "llama-cpp": {
        baseUrl: "local://llama-cpp",
        api: "openai-completions",
        params: {
          modelCacheDir: "~/.node-llama-cpp/models",
        },
        models: [
          {
            id: "my-local-model",
            name: "My local GGUF",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 2048,
            params: {
              modelPath: "~/Models/my-model.Q4_K_M.gguf",
              contextSize: 8192,
            },
            compat: { supportsTools: true },
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "llama-cpp/my-local-model" },
    },
  },
}
```

Inference never downloads a missing model implicitly. For a custom `hf:` URI,
download the GGUF into `modelCacheDir` first. Discovery uses node-llama-cpp's
own read-only cache resolver, including repository, branch, and split-file naming.

## Memory embedding configuration

Set `memory.search.provider` to `local`:

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

`local.modelPath` defaults to the `hf:` URI shown above (`embeddinggemma-300m-qat-Q8_0.gguf`).
Point it at a different `hf:` URI or a local `.gguf` file to use another
model. `local.modelCacheDir` overrides where downloaded models are cached
(default: `~/.node-llama-cpp/models`), and `local.contextSize` accepts an
integer or `"auto"`.

When `local.contextSize` is numeric, the provider also gives that requirement
to node-llama-cpp's automatic GPU-layer placement. This lets node-llama-cpp fit
the model and embedding context together while retaining its memory-safety
checks. With `"auto"`, node-llama-cpp keeps its normal automatic placement.

## Native runtime

Use Node 24 for the smoothest native install path. Source checkouts using
pnpm may need to approve and rebuild the native dependency:

```bash
pnpm approve-builds
pnpm rebuild node-llama-cpp
```

## Memory runtime diagnostics

Run `openclaw memory status --deep` after the provider has loaded to inspect
the selected backend and build, device names, GPU offloaded layers, requested
context size, and the last observed VRAM or unified-memory snapshot. The VRAM
values include an observation timestamp because passive status reads do not
reload the model or poll the device.

The same last-known facts can appear in `openclaw doctor` when the running
Gateway has already used the local provider. A normal status or doctor command
does not load a model just to collect diagnostics.

## Troubleshooting

If `node-llama-cpp` is missing or fails to load, OpenClaw reports the failure
with:

1. Install the plugin: `openclaw plugins install @openclaw/llama-cpp-provider`.
2. Use Node 24 for native installs/updates.
3. From a pnpm source checkout: `pnpm approve-builds`, then `pnpm rebuild node-llama-cpp`.

For local inference without an in-process native dependency, use the Ollama or
LM Studio provider instead. For lower-friction local embeddings, set
`memory.search.provider` to a remote embedding provider such as `lmstudio`,
`ollama`, `openai`, or `voyage` instead.
