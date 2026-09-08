---
summary: "Managed and external llama.cpp servers for GGUF chat and embeddings."
read_when:
  - You are installing, configuring, or auditing the llama-cpp plugin
title: "Llama Cpp plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Managed and external llama.cpp servers for GGUF chat and embeddings.

## Distribution

- Package: `@openclaw/llama-cpp-provider`
- Install route: npm or ClawHub

## Surface

- Providers: `llama-cpp`
- Contracts: `embeddingProviders`

<!-- openclaw-plugin-reference:manual-start -->

## Default text model

During interactive setup, OpenClaw installs a pinned, verified `llama-server`
and offers Gemma 4 E4B IT Q4_K_M as an approximately 5.0 GB download. The model
offer requires at least 16 GiB of total RAM. Existing cached models are still
detected on smaller machines.

To use another model, set `params.modelPath` to any custom GGUF. Custom models
are not subject to the bundled-download RAM requirement. On machines below the
requirement, you can also run a smaller model through Ollama or LM Studio, or
choose a cloud provider.

<!-- openclaw-plugin-reference:manual-end -->

## Related docs

- [llama-cpp](/plugins/llama-cpp)
