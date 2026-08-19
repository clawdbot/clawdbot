# @openclaw/llama-cpp-provider

Official llama.cpp provider for managed and external OpenClaw model servers.

The `llama-cpp` provider installs a pinned, integrity-verified `llama-server`
and configures OpenClaw's existing `localService` supervisor. The
`llama-server` provider connects to a server that you already run and discovers
its models and capabilities. Both use OpenClaw's normal OpenAI-compatible chat
transport; managed local embeddings stay on `llama-cpp`.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Interactive setup
shows **Managed local server** and **Existing llama-server** under one
**Local llama.cpp** group.

## Configure managed text inference

After explicit consent, OpenClaw installs the matching server build and
downloads Gemma 4 E4B IT Q4_K_M (approximately 5.0 GB) plus EmbeddingGemma
(approximately 0.3 GB). The default chat download is offered only on machines
with at least 16 GiB of RAM.

Custom GGUF models remain supported through `params.modelPath`. Rerun llama.cpp
setup after changing the model so OpenClaw can verify the file and regenerate
the managed router preset.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for platform requirements, custom GGUF configuration, diagnostics, and repair.

## Connect to an existing server

Choose **Existing llama-server** during setup and enter the endpoint and
optional API key. OpenClaw passively discovers single-model and router catalogs.
It never installs, starts, stops, or reconfigures the external process.

See the [llama-server provider guide](https://docs.openclaw.ai/providers/llama-server)
for authentication, router behavior, manual configuration, and troubleshooting.

## Configure embeddings

Set `memory.search.provider` to `local`. The plugin preserves the historical
`local` embedding provider and index identity while serving requests through
the managed server's `/v1/embeddings` endpoint.

## Package

- Plugin id: `llama-cpp`
- Provider ids: `llama-cpp`, `llama-server`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
