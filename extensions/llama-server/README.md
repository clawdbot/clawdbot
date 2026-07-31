# llama-server provider

Bundled provider plugin for connecting OpenClaw to an existing llama.cpp `llama-server` process.

The plugin uses OpenClaw's shared OpenAI completions transport. It owns endpoint normalization, read-only model discovery, runtime context and chat-template capability mapping, optional API-key setup, router status, and llama.cpp-safe tool schemas.

See [the provider guide](../../docs/providers/llama-server.md).
