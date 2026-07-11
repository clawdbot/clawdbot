---
summary: "Install the official llama.cpp provider for local GGUF memory embeddings"
read_when:
  - You want memory search embeddings from a local GGUF model
  - You are configuring memorySearch.provider = "local"
  - You need the OpenClaw plugin that owns the node-llama-cpp runtime
title: "llama.cpp Provider"
sidebarTitle: "llama.cpp Provider"
---

`llama-cpp` is the official external provider plugin for local GGUF
embeddings. It registers embedding provider id `local` and owns the
`node-llama-cpp` runtime dependency used by `memorySearch.provider: "local"`.

Install it before using local memory embeddings:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

The main `openclaw` npm package does not include `node-llama-cpp`. Keeping the
native dependency in this plugin prevents normal OpenClaw npm updates from
deleting a manually installed runtime inside the OpenClaw package directory.

## Configuration

Set `memorySearch.provider` to `local`:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "local",
        local: {
          modelPath: "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
        },
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

## Native Runtime

Use Node 24 for the smoothest native install path. Source checkouts using
pnpm may need to approve and rebuild the native dependency:

```bash
pnpm approve-builds
pnpm rebuild node-llama-cpp
```

## Runtime diagnostics

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

For lower-friction local embeddings without the native build step, set
`memorySearch.provider` to a remote embedding provider such as `lmstudio`,
`ollama`, `openai`, or `voyage` instead.
