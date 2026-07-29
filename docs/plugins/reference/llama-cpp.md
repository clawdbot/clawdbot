---
summary: "Local GGUF text inference and embeddings through node-llama-cpp."
read_when:
  - You are installing, configuring, or auditing the llama-cpp plugin
title: "Llama Cpp plugin"
---

# Llama Cpp plugin

Local GGUF text inference and embeddings through node-llama-cpp.

## Distribution

- Package: `@openclaw/llama-cpp-provider`
- Install route: npm; ClawHub

## Surface

providers: `llama-cpp`; contracts: `embeddingProviders`

<!-- openclaw-plugin-reference:manual-start -->

## Default text model

During interactive setup, OpenClaw offers Gemma 4 E4B IT Q4_K_M as an
approximately 5.0 GB bundled download. The offer requires at least 16 GiB of
total RAM. Existing cached models are still detected on smaller machines.

To use another model, set `params.modelPath` to any custom GGUF. Custom models
are not subject to the bundled-download RAM requirement. On machines below the
requirement, you can also run a smaller model through Ollama or LM Studio, or
choose a cloud provider.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [llama-cpp](/plugins/llama-cpp)
