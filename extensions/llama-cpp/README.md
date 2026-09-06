# @openclaw/llama-cpp-provider

Official llama.cpp provider for managed and external OpenClaw model servers.

The `llama-cpp` provider either installs a pinned, integrity-verified
`llama-server` under OpenClaw's `localService` supervisor or connects to a
server that you already operate. Both choices use `llama-cpp/<model>` references
and OpenClaw's normal OpenAI-compatible chat transport. Local embeddings require
the managed choice.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Interactive setup
shows **Managed local server** and **Existing llama-server** under one
**Local llama.cpp** group.

## Configure managed text inference

After explicit consent, OpenClaw installs the matching server build and a
recommended chat model that fits the Gateway's memory, GPU, and free disk space.
The download also includes the configured local embedding model, or EmbeddingGemma
by default (approximately 0.3 GB). See the provider guide for current recommendations.

When local memory search is configured and chat setup is unavailable or
declined, OpenClaw offers a separate embedding-only setup. After explicit
consent, it installs only the server and EmbeddingGemma. It leaves the current
chat model unchanged. Move any llama.cpp chat routes and remove its configured
chat model entries first. Remove an existing external server config before
retrying embedding-only setup.

Custom GGUF models remain supported through `params.modelPath`. Rerun llama.cpp
setup after changing the model so OpenClaw can verify the file and regenerate
the managed router preset.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for platform requirements, custom GGUF configuration, diagnostics, and repair.

## Connect to an existing server

Choose **Existing llama-server** during setup and enter the endpoint and
optional API key. OpenClaw passively discovers single-model and router catalogs.
It never installs, starts, stops, or reconfigures the external process.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for authentication, router behavior, manual configuration, and troubleshooting.

## Configure embeddings

Set `memory.search.provider` to `local`. The plugin preserves the historical
`local` embedding provider and index identity while serving requests through
the managed server's `/v1/embeddings` endpoint.

## Package

- Plugin id: `llama-cpp`
- Provider id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
