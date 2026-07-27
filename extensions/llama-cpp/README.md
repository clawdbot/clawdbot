# @openclaw/llama-cpp-provider

Official llama.cpp text-inference and embedding provider for OpenClaw.

This plugin runs local GGUF chat and embedding models in-process through
`node-llama-cpp`.

## Install

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

Restart the Gateway after installing or updating the plugin. Use Node 24 for
native installs and updates.

## Configure text inference

Choose **Local model (llama.cpp)** during onboarding. After explicit consent,
OpenClaw downloads Gemma 4 E4B IT Q4_K_M (approximately 5.0 GB) as the default.
The bundled download is offered only on machines with at least 16 GiB of RAM.
Discovery never downloads a model.

On smaller machines, use Ollama or LM Studio with a smaller model, use a cloud
provider, or configure any custom GGUF through `params.modelPath`. The 16 GiB
gate applies only to OpenClaw's bundled default download; custom GGUF models
remain available on any machine.

See the [llama.cpp provider guide](https://docs.openclaw.ai/plugins/llama-cpp)
for custom GGUF model configuration and hardware guidance.

## Configure embeddings

Set `memory.search.provider` to `local`. By default, the plugin
downloads and uses the EmbeddingGemma GGUF model. Configure
`memory.search.local.modelPath` to use another local path, Hugging
Face model URI, or HTTPS model URL.

## Package

- Plugin id: `llama-cpp`
- Package: `@openclaw/llama-cpp-provider`
- Minimum OpenClaw host: `2026.6.2`
