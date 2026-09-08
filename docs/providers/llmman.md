---
summary: "Run OpenClaw with llmman (local models, hosted providers, and hybrid local + hosted routing)"
read_when:
  - You want to run OpenClaw against local GGUF or safetensors models through llmman
  - You want hybrid inference that keeps small requests local and overflows large ones to a hosted model
  - You need llmman setup, configuration, vision, or troubleshooting guidance
title: "llmman"
---

[llmman](https://github.com/llmmanorg/llmman) pulls models as OCI artifacts from
any registry or Hugging Face and serves them through unmodified upstream
engines: `llama-server` for GGUF, `vllm` or `mlx-lm` for safetensors. One
daemon exposes Ollama-, OpenAI-, and Anthropic-compatible APIs and can also
forward requests to hosted providers. OpenClaw talks to it through the generic
`openai-completions` adapter on `/v1`.

Three modes are supported:

| Mode              | What it uses                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| Local only        | `llmman serve` on the Gateway host or LAN, serving pulled models such as `qwen3.8`                               |
| Hybrid            | One `llmman.hybrid/<local>,<provider>/<model>` ref; llmman picks the local or hosted side per request            |
| Hosted via llmman | `llmman.provider/<provider>/<model>` refs; llmman forwards to a hosted provider while keeping one local endpoint |

| Property         | Value                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Provider id      | `llmman` (custom; configure under `models.providers.llmman`)                             |
| Plugin           | none; not a bundled OpenClaw provider plugin, so models are listed explicitly            |
| API              | OpenAI-compatible (`api: "openai-completions"`)                                          |
| Default base URL | `http://127.0.0.1:17434/v1`                                                              |
| Auth             | llmman has no authentication; OpenClaw sends whatever `apiKey` you configure as a bearer |
| Reference model  | `qwen3.8` (Qwen3.8 27B, vision-capable, 262,144-token native context)                    |

<Warning>
`llmman serve` has no authentication and no TLS. Keep the default loopback bind unless a trusted network boundary restricts access, and never expose it on a public interface.
</Warning>

<Info>
Version scope: this page is verified against [llmman v0.1.334](https://github.com/llmmanorg/llmman/releases/tag/v0.1.334), commit [`22b6d73`](https://github.com/llmmanorg/llmman/commit/22b6d7330e1b0882401e83e35fe592817eb7c816). Model names, hybrid routing, vision, and tool calling on this page were exercised against that build with `qwen3.8`.
</Info>

## Auth rules

<AccordionGroup>
  <Accordion title="Local llmman has no auth">
    `llmman serve` never checks credentials. OpenClaw still needs a non-empty `apiKey` on the provider entry so the provider counts as configured. This page uses `LLMMAN_API_KEY=llmman-local` with `apiKey: "${LLMMAN_API_KEY}"`, mirroring the `OLLAMA_API_KEY=ollama-local` convention. A literal `apiKey: "llmman-local"` works too.
  </Accordion>
  <Accordion title="The bearer matters for hybrid and hosted refs">
    For `llmman.hybrid/...` and `llmman.provider/...` refs, llmman forwards the bearer OpenClaw presents to the hosted provider as that provider's API key. The one exception is the literal placeholder `llmman`, which tells the daemon to use its own key. See [Hybrid inference](#hybrid-inference) for both patterns. A marker such as `llmman-local` would be sent to the hosted provider and rejected there.
  </Accordion>
  <Accordion title="Remote llmman hosts">
    A daemon started with `LLMMAN_HOST=0.0.0.0` in its environment binds every interface with no auth. Point OpenClaw at a LAN host only inside a network you trust; there is no credential OpenClaw can send that llmman would enforce. A daemon reachable off loopback also refuses to spend its own hosted-provider key for callers that presented none.
  </Accordion>
  <Accordion title="Env var substitution">
    `${LLMMAN_API_KEY}` resolves from the Gateway process environment or `~/.openclaw/.env`. If the variable is missing, OpenClaw logs a config warning and treats the provider as unavailable, so put the export where the Gateway can read it. See [Environment](/help/environment).
  </Accordion>
</AccordionGroup>

## Getting started

<Steps>
  <Step title="Install llmman">
    ```bash
    curl -fsSL https://llmmanorg.github.io/install.sh | sh   # Linux, macOS
    brew install llmmanorg/tap/llmman                         # Homebrew
    ```

    Windows: `irm https://llmmanorg.github.io/install.ps1 | iex` or `winget install llmmanorg.llmman`. Other options: `cargo binstall llmman`.

  </Step>
  <Step title="Pull a model and start the server">
    ```bash
    llmman pull qwen3.8
    llmman serve
    ```

    Bare names such as `qwen3.8` resolve to Docker Hub's curated `docker.io/ai/<name>:latest`. `owner/repo` names resolve to `hf.co/owner/repo`; a full reference (`ghcr.io/...`, `hf.co/...`) is used as-is.

    `llmman serve` takes no arguments: it listens on `127.0.0.1:17434` and loads any pulled model on the first request that names it, then unloads it after five idle minutes. GPU acceleration (CUDA, ROCm, Vulkan, Metal) is auto-detected and the matching `llama-server` is downloaded if none is on `PATH`. Everything else is tuned through the daemon's environment: `LLMMAN_HOST` for the bind address, `LLMMAN_CONTEXT_LENGTH` for the server context, `LLMMAN_KEEP_ALIVE` for the idle unload timer (see [Advanced configuration](#advanced-configuration)).

    By default llmman uses the model's trained context (262,144 for `qwen3.8`) and, on out-of-memory, retries with the context halved down to a 16,384 floor. `llmman ps` shows the context a loaded model actually got; keep the OpenClaw model's `contextWindow` at or below that value.

  </Step>
  <Step title="Verify the server">
    ```bash
    curl http://127.0.0.1:17434/api/version
    curl http://127.0.0.1:17434/v1/models
    llmman ps
    ```

    There is no `/health` route; use `/api/version` or `/v1/models` as the readiness probe. `/v1/models` lists fully qualified ids such as `docker.io/ai/qwen3.8:latest`; requests may use either that form or the short name.

  </Step>
  <Step title="Set the marker credential">
    Add to `~/.openclaw/.env` (or export in the Gateway's shell):

    ```bash
    LLMMAN_API_KEY=llmman-local
    ```

  </Step>
  <Step title="Add the provider and select the model">
    Add the config below, then:

    ```bash
    openclaw models list --provider llmman
    openclaw models set llmman/qwen3.8
    ```

  </Step>
</Steps>

<Note>
`llmman launch openclaw --model qwen3.8` can bootstrap a first-run OpenClaw install by running non-interactive onboarding against the llmman endpoint. It only applies when no `openclaw.json` exists yet; for an existing install use the explicit config on this page.
</Note>

## Full config example

Qwen3.8 on a local llmman server:

```json5
{
  agents: {
    defaults: {
      model: { primary: "llmman/qwen3.8" },
      models: {
        "llmman/qwen3.8": { alias: "Qwen3.8 (llmman)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "qwen3.8",
            name: "Qwen3.8 (llmman)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

`models.mode: "merge"` keeps hosted providers available as fallbacks. `timeoutSeconds` gives cold model loads and long generations room before the model request timeout fires.

## Model discovery

llmman is not a bundled OpenClaw plugin, so there is no implicit discovery. List every model you want under `models.providers.llmman.models` with a provider-local `id` (no `llmman/` prefix).

| Behavior     | Detail                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model ids    | Short (`qwen3.8`, `qwen3.5:9b`), Hugging Face (`unsloth/Qwen3.5-0.8B-GGUF`), or fully qualified (`docker.io/ai/qwen3.8:latest`) all work                                 |
| Default tag  | `:latest` when omitted                                                                                                                                                   |
| Capabilities | `llmman show <model>` and `POST /api/show` report `completion` plus `vision` when a companion `mmproj` projector is present; mark such models `input: ["text", "image"]` |
| Reasoning    | Set `reasoning: true` for thinking models such as Qwen3.8; llmman returns thinking as `reasoning_content`                                                                |
| Context      | `llmman show <model>` prints the trained context length; `llmman ps` prints the context the running server was started with                                              |
| Costs        | All `0`; the hosted half of a hybrid ref is billed by that provider, not tracked by OpenClaw                                                                             |

```bash
llmman list
llmman show qwen3.8
openclaw models list --provider llmman
```

To add a model, pull it and add a matching entry:

```bash
llmman pull qwen3.5:9b
```

### Smoke tests

A narrow text probe that skips the full agent tool surface:

```bash
LLMMAN_API_KEY=llmman-local \
  openclaw infer model run \
    --local \
    --model llmman/qwen3.8 \
    --prompt "Reply with exactly: pong" \
    --json
```

Add `--file` with an image for a lean vision-model probe (PNG/JPEG/WebP;
non-image files are rejected before llmman is called; use
`openclaw infer audio transcribe` for audio):

```bash
LLMMAN_API_KEY=llmman-local \
  openclaw infer model run \
    --local \
    --model llmman/gemma4:e4b \
    --prompt "Describe this image in one sentence." \
    --file ./photo.jpg \
    --json
```

Neither path loads chat tools, memory, or session context. If a probe succeeds
while normal agent replies fail, the issue is usually tool-schema handling or
context pressure in the backend, not the endpoint; see
[Troubleshooting](#troubleshooting).

A full agent turn with tool calling is the real test:

```bash
openclaw agent --local --session-id llmman-smoke \
  --message "Read the file ./README.md with a tool and summarize it in one sentence."
```

## Hybrid inference

llmman can pair a local model with a hosted one under a single model name and
choose a side per request. OpenClaw configures the pair once as an ordinary
model id and gets local-first inference with hosted overflow, without an
agent-level fallback switch.

The reference is `llmman.hybrid/<local>,<provider>/<model>`. With `qwen3.8`
as the local half and OpenAI's `gpt-5.6-luna` as the hosted half:

```text
llmman.hybrid/qwen3.8,openai/gpt-5.6-luna
```

Which side serves a request:

1. **`x-llmman-route: local` or `cloud`** request header wins. Any other value is a `400`.
2. **Otherwise, size.** A request body larger than the local context can hold goes to the hosted model. The budget is 4 bytes per token of `LLMMAN_CONTEXT_LENGTH`; `LLMMAN_HYBRID_LOCAL_BYTES` sets it directly and `0` disables the size rule.
3. **Otherwise, local.**

If a request llmman kept local is then refused by the local backend as larger
than its context, llmman resends it to the hosted half before anything reaches
OpenClaw. A `local` pin is never overridden this way. Every routed request is
logged with the side and the reason; the response's `model` field still shows
the pair name.

### Hosted-provider key

The hosted half authenticates like any llmman `--provider` request. Pick one:

<Tabs>
  <Tab title="OpenClaw presents the key (recommended)">
    Set the llmman provider's `apiKey` to the hosted provider's key. llmman forwards it per request and never persists it. Local-only models on the same provider entry ignore the value.

    ```bash
    # ~/.openclaw/.env
    LLMMAN_API_KEY=sk-...   # your OpenAI API key
    ```

    Keep `apiKey: "${LLMMAN_API_KEY}"` in the config below.

  </Tab>
  <Tab title="llmman holds the key">
    Give the daemon its own key and have OpenClaw send the literal placeholder `llmman`:

    ```bash
    llmman config set providers.openai.api_key sk-...
    llmman serve
    ```

    `OPENAI_API_KEY` in the daemon's environment works too and overrides the config file.

    ```bash
    # ~/.openclaw/.env
    LLMMAN_API_KEY=llmman
    ```

    The placeholder must be exactly `llmman`; any other bearer is treated as a real key and forwarded to the hosted provider. llmman only spends its own key for loopback callers, so this pattern requires the daemon and the Gateway on the same host.

  </Tab>
</Tabs>

### Hybrid config

```json5
{
  agents: {
    defaults: {
      model: { primary: "llmman/llmman.hybrid/qwen3.8,openai/gpt-5.6-luna" },
      models: {
        "llmman/llmman.hybrid/qwen3.8,openai/gpt-5.6-luna": { alias: "Qwen3.8 + Luna" },
        "llmman/qwen3.8": { alias: "Qwen3.8 local" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        timeoutSeconds: 300,
        models: [
          {
            id: "llmman.hybrid/qwen3.8,openai/gpt-5.6-luna",
            name: "Qwen3.8 + GPT-5.6 Luna (hybrid)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 8192,
          },
          {
            id: "qwen3.8",
            name: "Qwen3.8 (llmman)",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 65536,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

The daemon's context length is the pair's local budget: 4 bytes per token of
`LLMMAN_CONTEXT_LENGTH` (or the model's trained context when unset). Set
`LLMMAN_CONTEXT_LENGTH=65536` in the daemon's environment to match the example,
or set `LLMMAN_HYBRID_LOCAL_BYTES` to pick the byte budget directly.

Set `contextWindow` on the pair to the local budget. OpenClaw then compacts
around the local model's limit, so most turns stay local; llmman still
overflows to `gpt-5.6-luna` when a request exceeds it. Set it to the hosted
model's window instead if you prefer fewer compactions and more hosted
traffic.

### Pinning a side

OpenClaw sends provider-level `headers` on every request, so a second provider
entry on the same base URL can force one side of the pair:

```json5
{
  models: {
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llmman.hybrid/qwen3.8,openai/gpt-5.6-luna",
            name: "Hybrid",
            input: ["text", "image"],
          },
        ],
      },
      "llmman-cloud": {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        headers: { "x-llmman-route": "cloud" },
        models: [
          {
            id: "llmman.hybrid/qwen3.8,openai/gpt-5.6-luna",
            name: "Hybrid (hosted)",
            input: ["text", "image"],
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: {
        primary: "llmman/llmman.hybrid/qwen3.8,openai/gpt-5.6-luna",
        fallbacks: ["llmman-cloud/llmman.hybrid/qwen3.8,openai/gpt-5.6-luna"],
      },
    },
  },
}
```

Switch with `/model llmman-cloud/...` for a turn that should go hosted, or use
`headers: { "x-llmman-route": "local" }` for an entry that must never leave
the machine.

### Hybrid versus OpenClaw fallbacks

| Mechanism                         | Decides                    | Switches on                                                    |
| --------------------------------- | -------------------------- | -------------------------------------------------------------- |
| llmman hybrid pair                | Per request, inside llmman | Request size versus local context, or an explicit route header |
| `agents.defaults.model.fallbacks` | Per turn, inside OpenClaw  | Provider errors, timeouts, rate limits, auth failures          |

They compose. A common shape is a hybrid pair as `primary` with a direct hosted
model as a fallback for when llmman itself is down:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "llmman/llmman.hybrid/qwen3.8,openai/gpt-5.6-luna",
        fallbacks: ["openai/gpt-5.6-luna"],
      },
    },
  },
}
```

### Hosted models through llmman

`llmman.provider/<provider>/<model>` forwards to a hosted provider with no
local half. Use it when you want every model, local or hosted, behind one
endpoint and one key-handling story:

```json5
{
  models: {
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "qwen3.8", name: "Qwen3.8 (llmman)", reasoning: true, input: ["text", "image"] },
          {
            id: "llmman.provider/openai/gpt-5.6-luna",
            name: "GPT-5.6 Luna via llmman",
            reasoning: true,
            input: ["text", "image"],
          },
        ],
      },
    },
  },
}
```

The provider catalog comes from [models.dev](https://models.dev) and is cached
by the daemon. `llmman providers` shows which providers have a key;
`llmman list --provider openai` lists that provider's models and prices. For
direct hosted access without llmman in the path, configure the
[OpenAI](/providers/openai) provider instead.

## Vision and image description

Models that ship a companion `mmproj` projector are vision-capable; `qwen3.8`
and `gemma4:e4b` are. `llmman show <model>` logs `found companion mmproj file`
and `/api/show` reports a `vision` capability. Mark those models
`input: ["text", "image"]` so image attachments are injected into agent turns.

```bash
llmman pull gemma4:e4b
openclaw infer image describe --file ./photo.jpg --model llmman/gemma4:e4b --json
```

`--model` must be a full `<provider/model>` ref. Use `infer image describe`
for OpenClaw's image-understanding flow and configured `imageModel`; use
`infer model run --file` for a raw multimodal probe with a custom prompt.

To make a llmman model the default image-understanding provider for inbound
media:

```json5
{
  agents: {
    defaults: {
      imageModel: {
        primary: "llmman/gemma4:e4b",
      },
    },
  },
  models: {
    providers: {
      llmman: {
        baseUrl: "http://127.0.0.1:17434/v1",
        apiKey: "${LLMMAN_API_KEY}",
        api: "openai-completions",
        models: [{ id: "gemma4:e4b", name: "Gemma 4 E4B (llmman)", input: ["text", "image"] }],
      },
    },
  },
  tools: {
    media: {
      image: {
        timeoutSeconds: 180,
      },
    },
  },
}
```

OpenClaw rejects image-description requests for models not marked
image-capable. Slow local vision models can need a longer image-understanding
timeout than hosted models; `models.providers.llmman.timeoutSeconds` still
governs the underlying HTTP request for normal model calls.

## Configuration

<Tabs>
  <Tab title="Local only">
    ```json5
    {
      models: {
        providers: {
          llmman: {
            baseUrl: "http://127.0.0.1:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            models: [
              {
                id: "qwen3.8",
                name: "Qwen3.8 (llmman)",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 65536,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    }
    ```

  </Tab>

  <Tab title="LAN llmman host">
    Start the server on the GPU box with `LLMMAN_HOST=0.0.0.0` (and optionally `LLMMAN_CONTEXT_LENGTH=65536`) in its environment, then point OpenClaw at it:

    ```bash
    llmman serve
    ```

    ```json5
    {
      models: {
        providers: {
          llmman: {
            baseUrl: "http://gpu-box.local:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 420,
            models: [
              {
                id: "qwen3.8",
                name: "Qwen3.8 (gpu-box)",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 65536,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    }
    ```

    <Warning>
    The remote daemon has no authentication. Only do this inside a trusted network, and do not use hybrid refs with "llmman holds the key" against a non-loopback daemon; it refuses to spend its own key for remote callers.
    </Warning>

  </Tab>

  <Tab title="On-demand startup">
    OpenClaw starts llmman itself when a `llmman/...` model is selected and stops it when idle:

    ```json5
    {
      models: {
        providers: {
          llmman: {
            baseUrl: "http://127.0.0.1:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 300,
            localService: {
              command: "/opt/homebrew/bin/llmman",
              args: ["serve"],
              env: { LLMMAN_CONTEXT_LENGTH: "65536" },
              healthUrl: "http://127.0.0.1:17434/v1/models",
              readyTimeoutMs: 180000,
              idleStopMs: 0,
            },
            models: [
              {
                id: "qwen3.8",
                name: "Qwen3.8 (llmman)",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 65536,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    }
    ```

    `command` must be an absolute path; use the output of `which llmman` on the Gateway host. `env` is how the daemon's settings such as `LLMMAN_CONTEXT_LENGTH` are supplied here. `healthUrl` must be `/v1/models` or `/api/version`, since llmman has no `/health`. The first request after startup also loads the model, so keep `timeoutSeconds` generous. Full field reference: [Local model services](/gateway/local-model-services).

  </Tab>
</Tabs>

## Common recipes

Replace model ids with names from `llmman list` or
`openclaw models list --provider llmman`.

<AccordionGroup>
  <Accordion title="Local Qwen3.8 as the default agent model">
    ```bash
    llmman pull qwen3.8
    llmman serve
    echo 'LLMMAN_API_KEY=llmman-local' >> ~/.openclaw/.env
    openclaw models set llmman/qwen3.8
    ```

    Use the [Full config example](#full-config-example) for the provider entry, and set `LLMMAN_CONTEXT_LENGTH=65536` in the daemon's environment if you want the server context to match it exactly.

  </Accordion>

  <Accordion title="Local first, hosted overflow">
    The [Hybrid config](#hybrid-config) above: `llmman.hybrid/qwen3.8,openai/gpt-5.6-luna` as `primary`, `LLMMAN_API_KEY` set to the OpenAI key, `LLMMAN_CONTEXT_LENGTH` matching the pair's `contextWindow`. Add `openai/gpt-5.6-luna` to `fallbacks` so a stopped daemon does not block replies.
  </Accordion>

  <Accordion title="Small local profile">
    Local models served through a custom `openai-completions` provider do not enable [Tool Search](/tools/tool-search) automatically. Turn it on to keep optional capabilities available while loading their schemas only when needed, and cap the context to what the host can run with `LLMMAN_CONTEXT_LENGTH=32768` in the daemon's environment:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "llmman/qwen3.8" },
        },
      },
      tools: {
        toolSearch: { mode: "tools" },
      },
      models: {
        providers: {
          llmman: {
            baseUrl: "http://127.0.0.1:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.8",
                name: "Qwen3.8 (llmman)",
                reasoning: true,
                input: ["text", "image"],
                contextWindow: 32768,
                contextTokens: 32768,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
    }
    ```

    Use `compat.supportsTools: false` only when the model or server reliably fails on tool schemas; it disables tool use entirely. For a deliberately narrower agent, prefer `tools.profile` or a per-agent tool policy.

  </Accordion>

  <Accordion title="Multiple llmman hosts">
    Custom provider ids when running more than one daemon; each gets its own host, models, and timeout:

    ```json5
    {
      models: {
        providers: {
          "llmman-fast": {
            baseUrl: "http://mini.local:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            models: [{ id: "qwen3.5:9b", name: "qwen3.5:9b", input: ["text"], contextWindow: 32768 }],
          },
          "llmman-large": {
            baseUrl: "http://gpu-box.local:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            timeoutSeconds: 420,
            models: [{ id: "qwen3.8", name: "qwen3.8", reasoning: true, input: ["text", "image"], contextWindow: 131072 }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "llmman-fast/qwen3.5:9b",
            fallbacks: ["llmman-large/qwen3.8"],
          },
        },
      },
    }
    ```

    llmman can also pool several daemons itself: `llmman config set aggregation.peers <host>,<host>` (or `LLMMAN_PEERS`) makes one daemon forward to peers, so OpenClaw sees a single endpoint whose model list spans the group.

  </Accordion>

  <Accordion title="Hugging Face or private-registry models">
    Model ids are whatever llmman resolves. Pull with the full reference and use the same string as the OpenClaw model id:

    ```bash
    llmman pull hf.co/unsloth/Qwen3.5-0.8B-GGUF
    llmman pull ghcr.io/myorg/private-model:v1
    ```

    ```json5
    {
      models: {
        providers: {
          llmman: {
            baseUrl: "http://127.0.0.1:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
            api: "openai-completions",
            models: [
              { id: "hf.co/unsloth/Qwen3.5-0.8B-GGUF", name: "Qwen3.5 0.8B", input: ["text"] },
              { id: "ghcr.io/myorg/private-model:v1", name: "Private model", input: ["text"] },
            ],
          },
        },
      },
    }
    ```

    The agent ref is then `llmman/hf.co/unsloth/Qwen3.5-0.8B-GGUF`. Run `llmman login <registry>` first for private registries.

  </Accordion>
</AccordionGroup>

### Model selection

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "llmman/qwen3.8",
        fallbacks: ["llmman/qwen3.5:9b", "openai/gpt-5.6-luna"],
      },
    },
  },
}
```

For slow local models, prefer provider-scoped tuning before raising the whole
agent runtime timeout: `models.providers.llmman.timeoutSeconds` covers
connection setup, headers, body streaming, and the total guarded-fetch abort
for that provider's model requests only.

### Quick verification

```bash
# llmman daemon visible to this machine
curl http://127.0.0.1:17434/api/version
llmman ps

# OpenClaw catalog and selected model
openclaw models list --provider llmman
openclaw models status

# Direct model smoke
LLMMAN_API_KEY=llmman-local openclaw infer model run \
  --local --model llmman/qwen3.8 --prompt "Reply with exactly: ok" --json
```

For remote hosts, replace `127.0.0.1` with the `baseUrl` host. If `curl` works
but OpenClaw does not, check whether the Gateway runs on a different machine,
container, or service account.

## Advanced configuration

<AccordionGroup>
  <Accordion title="Context windows">
    `LLMMAN_CONTEXT_LENGTH` is the server-side context (there is no flag). Semantics by backend:

    - **llama-server (GGUF):** set, it is passed as `--ctx-size` for generation models; `0` means the trained context. Unset, llmman uses `262144` or the model's trained context if smaller, and on out-of-memory retries with the context halved down to a 16,384 floor.
    - **vLLM (safetensors):** a positive value becomes `--max-model-len`; unset uses the vLLM default.
    - **mlx_lm.server:** not forwarded.

    `LLMMAN_NUM_PARALLEL` scales `--ctx-size` up by that factor so each slot keeps the full context.

    On the OpenClaw side, `contextWindow` declares the model's window and `contextTokens` caps active input. Keep `contextWindow` at or below the server value; OpenClaw derives compaction and preflight thresholds from it. For hybrid pairs the same value also sets the byte budget that decides when llmman overflows to the hosted half.

    ```json5
    {
      models: {
        providers: {
          llmman: {
            models: [
              {
                id: "qwen3.8",
                name: "qwen3.8",
                contextWindow: 65536,
                contextTokens: 49152,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Thinking control">
    Qwen3.8 thinks by default; llmman returns the reasoning as `reasoning_content`, which OpenClaw's `openai-completions` adapter separates from the final text. Requests are proxied to `llama-server`, so `chat_template_kwargs` passes through. To turn thinking off for a model:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "llmman/qwen3.8": {
              params: {
                chat_template_kwargs: { enable_thinking: false },
              },
            },
          },
        },
      },
    }
    ```

    `openclaw agent --model llmman/qwen3.8 --thinking off` and `/think off` work for one-shot control. `reasoning_effort` is forwarded unchanged; whether a level changes anything depends on the model's chat template.

  </Accordion>

  <Accordion title="Model lifecycle and keep-alive">
    Models load on their first request, each in its own backend subprocess, and unload after five idle minutes. Tune with:

    | Variable                   | Meaning                                                                                  |
    | -------------------------- | ---------------------------------------------------------------------------------------- |
    | `LLMMAN_KEEP_ALIVE`        | Idle unload timer (default `5m`); `0` unloads right after each request                    |
    | `LLMMAN_MAX_LOADED_MODELS` | Cap on concurrently loaded models; idle ones are evicted LRU, busy ones return `503`      |
    | `LLMMAN_MAX_QUEUE`         | Pending-request cap before `503` (default `512`)                                          |
    | `LLMMAN_LOAD_TIMEOUT`      | Load stall timeout (default `10m`)                                                       |

    `llmman ps` shows loaded models with their context and expiry; `llmman stop <model>` unloads one now. A first request after startup or an idle unload pays the load cost, so set `timeoutSeconds` on the provider and raise `LLMMAN_KEEP_ALIVE` to keep the daemon warm for chat surfaces.

  </Accordion>

  <Accordion title="GPU and backend selection">
    llmman probes CUDA, ROCm, Vulkan (Linux/Windows) or Metal (macOS) and downloads a matching `llama-server` release if none is on `PATH`. Override with `LLMMAN_LLM_LIBRARY`: `cpu`, `cuda`, `cuda13`, `rocm`, `vulkan`, or `metal`. Other knobs: `LLMMAN_FLASH_ATTENTION` (`on`/`off`/`auto`), `LLMMAN_KV_CACHE_TYPE` (`f16`, `q8_0`, `q4_0`), `LLMMAN_SCHED_SPREAD` for multi-GPU layer splitting, `LLMMAN_IGPU_ENABLE` to count integrated GPUs. On Linux, `llmman serve --ociman docker|podman` runs `llama-server` from the `ghcr.io/ggml-org/llama.cpp` images instead of a local binary. `LLMMAN_DEBUG=1` prints the probe result.
  </Accordion>

  <Accordion title="Memory embeddings">
    llmman serves `/v1/embeddings` for GGUF embedding models, so [memory search](/concepts/memory) can use it through the generic `openai-compatible` embedding provider:

    ```bash
    llmman pull embeddinggemma
    ```

    ```json5
    {
      memory: {
        search: {
          provider: "openai-compatible",
          model: "embeddinggemma",
          remote: {
            baseUrl: "http://127.0.0.1:17434/v1",
            apiKey: "${LLMMAN_API_KEY}",
          },
        },
      },
    }
    ```

    Embedding models are capped to their trained context regardless of `LLMMAN_CONTEXT_LENGTH`. See [Memory config](/reference/memory-config#remote-endpoint-config) for the remaining fields.

  </Accordion>

  <Accordion title="Ollama-compatible API">
    llmman also implements Ollama's native `/api/chat`, `/api/tags`, `/api/show`, and `/api/ps`, and `OLLAMA_HOST=127.0.0.1:17434 ollama run <model>` works against it. Prefer `api: "openai-completions"` from OpenClaw anyway: llmman's `/api/show` reports only `completion` and `vision` capabilities, so the bundled Ollama plugin's discovery would mark every llmman model `compat.supportsTools: false`. If you do point the Ollama plugin at `http://127.0.0.1:17434` (no `/v1`), list models explicitly instead of relying on discovery.
  </Accordion>

  <Accordion title="Compat flags">
    llmman forwards message content and tool schemas to the backend without normalizing them, so compatibility depends on the selected engine and model. Structured content parts (text + image) and OpenClaw's full tool schema work with `qwen3.8` on `llama-server`. If a different backend or model rejects them:

    - `messages[].content: invalid type: sequence, expected a string` → set `compat.requiresStringContent: true` on the model entry. OpenClaw then flattens pure text content parts into plain strings.
    - `400 JSON schema conversion failed` → `llama-server` could not compile a tool schema into its grammar subset. Update OpenClaw first; if a third-party tool or MCP server contributes the offending schema, disable it for that agent, and use `compat.supportsTools: false` only as a last resort.

    ```json5
    {
      models: {
        providers: {
          llmman: {
            models: [
              {
                id: "qwen3.8",
                name: "qwen3.8",
                compat: {
                  requiresStringContent: true,
                },
              },
            ],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Proxy-style behavior">
    Because llmman is a non-native `openai-completions` endpoint, OpenClaw treats it as a proxy route: no `service_tier`, no Responses `store`, no prompt-cache hints, no OpenAI reasoning-compat payload shaping, no hidden OpenClaw attribution headers, and `compat.supportsDeveloperRole` is forced to `false`. Vendor-specific fields can be merged into the request body with `agents.defaults.models["llmman/<model>"].params.extra_body`.
  </Accordion>

  <Accordion title="Model costs">
    Local llmman models are free, so set all costs to `0`. The hosted half of a hybrid or `llmman.provider/...` ref is billed by that provider; `llmman list --provider openai` shows its per-million-token prices.
  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="curl /v1/models fails">
    `llmman serve` is not running or is not reachable at the configured address. The default is `127.0.0.1:17434`; if you set `LLMMAN_HOST`, update the OpenClaw `baseUrl` and `healthUrl` to match.

    ```bash
    llmman serve
    curl http://127.0.0.1:17434/api/version
    ```

  </Accordion>

  <Accordion title="Provider unavailable or secrets could not be resolved">
    `models.providers.llmman.apiKey: *** env var "LLMMAN_API_KEY"` in the config warnings means the substitution found no value. Add `LLMMAN_API_KEY=llmman-local` to `~/.openclaw/.env`, or replace `"${LLMMAN_API_KEY}"` with the literal `"llmman-local"`.
  </Accordion>

  <Accordion title="Unknown model">
    The model is not pulled, or the id in config does not match what llmman resolves. Compare against `llmman list`; a short name maps to `docker.io/ai/<name>:latest`, and an `owner/repo` name maps to `hf.co/owner/repo`.

    ```bash
    llmman pull qwen3.8
    llmman list
    ```

  </Accordion>

  <Accordion title="Cold model times out">
    Large models can take minutes to load, especially on the first request after an idle unload. Raise `models.providers.llmman.timeoutSeconds`, warm the model with a first `openclaw infer model run`, and consider a longer `LLMMAN_KEEP_ALIVE` on the daemon.
  </Accordion>

  <Accordion title="Hybrid request fails with no API key for provider">
    llmman routed the request to the hosted half and found no usable key. Either the bearer OpenClaw sent was a marker (`llmman-local`) rather than a real key, or you used the `llmman` placeholder without giving the daemon its own `OPENAI_API_KEY`, or the daemon is bound off loopback and refuses to spend its own key. See [Hosted-provider key](#hosted-provider-key).
  </Accordion>

  <Accordion title="Hybrid requests never go hosted (or always do)">
    Check the daemon log; every routed request records the side and the reason. Routing is by request body size against `LLMMAN_CONTEXT_LENGTH` (4 bytes per token) unless `x-llmman-route` is set. Lower `LLMMAN_HYBRID_LOCAL_BYTES` to overflow sooner, raise it to stay local longer, or pin a side with a provider `headers` entry as in [Pinning a side](#pinning-a-side).
  </Accordion>

  <Accordion title="Direct /v1/chat/completions calls pass but openclaw infer model run fails">
    Both probes are tool-free, so `compat.supportsTools` cannot change this failure. Check the configured base URL, model id, and `LLMMAN_API_KEY`, inspect the daemon and backend logs, and compare the two request payloads.
  </Accordion>

  <Accordion title="Model run passes but a normal agent turn fails">
    The agent turn adds a larger prompt and tool schemas. A `400 JSON schema conversion failed` is `llama-server` rejecting a tool schema; update OpenClaw and check third-party tools or MCP servers. Otherwise enable [Tool Search](/tools/tool-search) to defer schemas, confirm the server's actual context allocation, and use `compat.supportsTools: false` only as a last resort. See [Smaller or stricter backends](/gateway/local-models#smaller-or-stricter-backends).
  </Accordion>

  <Accordion title="llama-server crashes on larger agent turns">
    If schema errors are gone but the spawned `llama-server` still crashes on larger turns, treat it as an upstream `llama.cpp` or model limitation. Lower `LLMMAN_CONTEXT_LENGTH`, set `LLMMAN_KV_CACHE_TYPE=q8_0` to reduce memory, or switch the backend or model.
  </Accordion>

  <Accordion title="Model outputs tool JSON as text">
    Confirm the model's chat template supports tool calling and that the request reached `/v1/chat/completions` (not the Ollama or Anthropic surfaces via a proxy). If the model only calls tools when forced, set `params.extra_body.tool_choice: "required"` on that model ref as described in [Local models](/gateway/local-models#other-openai-compatible-local-proxies).
  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Local models" href="/gateway/local-models" icon="server">
    Running OpenClaw against local model servers.
  </Card>
  <Card title="Local model services" href="/gateway/local-model-services" icon="play">
    Starting local model servers on demand for configured providers.
  </Card>
  <Card title="OpenAI" href="/providers/openai" icon="cloud">
    Direct hosted access to the models used as the hybrid overflow half.
  </Card>
  <Card title="Inference CLI" href="/cli/infer" icon="terminal">
    `openclaw infer model run` and the other one-shot probes used on this page.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Gateway troubleshooting" href="/gateway/troubleshooting#local-openai-compatible-backend-passes-direct-probes-but-agent-runs-fail" icon="wrench">
    Debugging local OpenAI-compatible backends that pass probes but fail agent runs.
  </Card>
</CardGroup>
