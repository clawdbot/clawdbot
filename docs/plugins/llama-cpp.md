---
summary: "Run local GGUF chat and memory embeddings with an OpenClaw-managed llama.cpp server"
read_when:
  - You want local text inference without an API key or separately managed model server
  - You want memory search embeddings from a local GGUF model
  - You are configuring memory.search.provider = "local"
  - You need to inspect or repair OpenClaw's managed llama.cpp server
title: "llama.cpp Provider"
sidebarTitle: "llama.cpp Provider"
---

The `llama-cpp` plugin manages a loopback-only `llama-server` for local GGUF
chat and embeddings. OpenClaw installs a pinned, integrity-verified llama.cpp
release, starts it only when a request needs it, reuses it across concurrent
chat and embedding requests, and stops it after an idle period.

Install the official plugin before using either local inference or local memory
embeddings:

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

## Guided setup

Choose **llama.cpp** once during interactive onboarding or configuration.
OpenClaw then:

1. Selects the verified llama-server build for the Gateway platform.
2. Verifies the archive SHA-256 and the extracted server version.
3. Downloads and verifies the required models after consent. Chat plus embedding
   models are installed for chat configurations; memory-only configurations
   install only the configured embedding model.
4. Writes a durable OpenAI-compatible provider with a loopback `baseUrl` and
   `localService` process definition.
5. Live-tests the candidate before saving it.

The default chat model remains:

`hf:unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf`

Gemma 4 E4B IT Q4_K_M is about 5.0 GB. OpenClaw offers that download only on
machines with at least 16 GiB of RAM. The default context cap is 65,536 tokens,
which the full agent system prompt requires. The bundled EmbeddingGemma model is
about 0.3 GB.

When `memory.search.provider` is `"local"` and no llama.cpp chat model is
configured, guided setup creates an embedding-only provider: it does not
download the roughly 5 GB Gemma chat model and does not write a chat default.
The managed server still starts from the same verified llama-server release and
serves `/v1/embeddings`. If an existing llama.cpp chat model is configured but
its GGUF is unavailable, setup keeps that configuration and does not silently
replace it with the default Gemma download.

Discovery is read-only. It reports a prepared choice only when the managed
binary, server preset, and selected model already exist; it never installs or
downloads during discovery.

## How requests run

The provider uses OpenClaw's normal OpenAI-compatible chat, image, streaming,
and tool transport. `llama-server` applies the GGUF chat template; OpenClaw
executes tool calls and returns their results to the model. The existing
`llamacpp-gbnf` tool-schema compatibility profile remains enabled.

One managed router owns separate presets for chat and embeddings. This lets
`memory.search.provider: "local"` use a dedicated embedding GGUF through
`/v1/embeddings` without creating a second OpenClaw process supervisor.

## Use another GGUF model

Add the model to `models.providers.llama-cpp.models`, set `params.modelPath`,
make it the selected `llama-cpp/<model-id>`, then run interactive llama.cpp
setup again. `modelPath` accepts:

- an absolute or `~/` local GGUF path;
- a cache-relative GGUF filename;
- a full `hf:` file URI, including `#branch` when needed;
- an HTTPS GGUF URL that publishes a SHA-256 response digest.

Example model entry:

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

The default managed cache is `~/.openclaw/models/llama.cpp`. Existing
`modelCacheDir` settings still win, and setup recognizes the former
`~/.node-llama-cpp/models` default cache so upgrades do not redownload a model
that is already present.

## Local memory embeddings

Set the memory provider to `local`:

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

The plugin preserves the historical `local` provider/model cache identity, so
the transport migration does not require a SQLite schema change or automatic
memory reindex. A custom embedding `modelPath` remains its literal index
identity. Run `openclaw memory status --index` if you intentionally change it.

## Diagnostics

Run:

```bash
openclaw memory status --deep
openclaw doctor
```

After the managed embedding server has handled a request, deep status reports
facts observed from `/health`, `/models`, `/props`, and `/metrics`: server build,
model id and path, endpoint state, and configured capabilities. Vision is
reported only when `/props` confirms it. Draft and multimodal projector support
are not currently configured by this plugin and are never inferred from a model
name.

Local-service startup and exit logs include bounded, redacted stderr tails. See
[Logging](/logging) and [Local model services](/gateway/local-model-services).

## Platform requirements

- macOS arm64 uses the official Metal build. macOS x64 uses the CPU build.
- Linux x64 needs glibc 2.34 or newer; Linux arm64 needs glibc 2.38 or newer.
  Install the OpenMP runtime (`libgomp1` on Debian/Ubuntu or `libgomp` on
  Fedora) if the version probe reports `libgomp.so.1` missing.
- Windows x64 and arm64 use the CPU build and require the Microsoft Visual C++
  2015-2022 Redistributable.
- Alpine/musl and platforms without a pinned official build fail with an
  actionable manual-server path rather than silently skipping setup.

OpenClaw intentionally does not auto-select CUDA, ROCm, SYCL, OpenVINO, or
Vulkan archives. Those builds add driver and companion-runtime contracts that
cannot be verified safely from onboarding alone.

## Troubleshooting

**Binary missing or wrong version:** run interactive llama.cpp setup again. It
reinstalls the pinned build and rewrites the absolute `localService.command`.

**Model missing:** configure a local GGUF path or rerun setup and approve the
verified default download.

**Server starts but the model fails to load:** inspect `openclaw logs --follow`
and `openclaw memory status --deep`. The managed service error includes the
bounded server stderr tail.

**Only keyword memory matches:** run `openclaw memory status --deep`, repair the
reported endpoint/model issue, then run `openclaw memory index --force` only if
status reports an index identity mismatch.
