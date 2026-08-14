# @openclaw/llama-cpp-provider

Official managed llama.cpp provider for OpenClaw GGUF chat and embeddings.

The plugin installs a pinned, integrity-verified `llama-server` and configures
OpenClaw's existing `localService` supervisor. Model traffic uses the normal
OpenAI-compatible chat and embedding transports.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin, then choose
**llama.cpp** once during interactive onboarding or configuration.

## Configure text inference

After explicit consent, OpenClaw installs the matching server build and
downloads Gemma 4 E4B IT Q4_K_M (approximately 5.0 GB) plus EmbeddingGemma
(approximately 0.3 GB). The default chat download is offered only on machines
with at least 16 GiB of RAM.

Custom GGUF models remain supported through `params.modelPath`. Rerun llama.cpp
setup after changing the model so OpenClaw can verify the file and regenerate
the managed router preset.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for platform requirements, custom GGUF configuration, diagnostics, and repair.

## Configure embeddings

Set `memory.search.provider` to `local`. The plugin preserves the historical
`local` embedding provider and index identity while serving requests through
the managed server's `/v1/embeddings` endpoint.

## Package

- Plugin id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
