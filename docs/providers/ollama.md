---
summary: "Run OpenClaw with Ollama (cloud and local models)"
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
  - You want Ollama vision models for image understanding
title: "Ollama"
---

OpenClaw talks to Ollama's native API (`/api/chat`), not the OpenAI-compatible
`/v1` endpoint. Three modes are supported:

| Mode          | What it uses                                                                     |
| ------------- | -------------------------------------------------------------------------------- |
| Cloud + Local | A reachable Ollama host, serving local models and (if signed in) `:cloud` models |
| Cloud only    | `https://ollama.com` directly, no local daemon                                   |
| Local only    | A reachable Ollama host, local models only                                       |

For cloud-only setup with the dedicated `ollama-cloud` provider id, see
[Ollama Cloud](/providers/ollama-cloud). Use `ollama-cloud/<model>` refs when
you want cloud routing kept separate from a local `ollama` provider.

<Warning>
Do not use the `/v1` OpenAI-compatible URL (`http://host:11434/v1`). It breaks tool calling and models can emit raw tool-call JSON as plain text. Use the native URL: `baseUrl: "http://host:11434"` (no `/v1`).
</Warning>

The canonical config key is `baseUrl`. `baseURL` is also accepted for
OpenAI-SDK-style examples, but new config should use `baseUrl`.

## Auth rules

<AccordionGroup>
  <Accordion title="Local and LAN hosts">
    Loopback, private-network, `.local`, and bare-hostname Ollama URLs do not need a real bearer token. OpenClaw uses the `ollama-local` marker for these.
  </Accordion>
  <Accordion title="Remote and Ollama Cloud hosts">
    Public remote hosts and `https://ollama.com` require a real credential: `OLLAMA_API_KEY`, an auth profile, or the provider's `apiKey`. For direct hosted use, prefer the `ollama-cloud` provider.
  </Accordion>
  <Accordion title="Custom provider ids">
    A custom provider with `api: "ollama"` follows the same rules. For example, an `ollama-remote` provider pointed at a private LAN host can use `apiKey: "ollama-local"`; sub-agents resolve that marker through the Ollama provider hook instead of treating it as a missing credential. `agents.defaults.memorySearch.provider` can also point at a custom provider id so embeddings use that Ollama endpoint.
  </Accordion>
  <Accordion title="Auth profiles">
    `auth-profiles.json` stores the credential for a provider id; put endpoint settings (`baseUrl`, `api`, models, headers, timeouts) in `models.providers.<id>`. Older flat files such as `{ "ollama-windows": { "apiKey": "ollama-local" } }` are not a runtime format; `openclaw doctor --fix` rewrites them into a canonical `ollama-windows:default` API-key profile with a backup. A `baseUrl` value in that legacy file is noise and should move to provider config.
  </Accordion>
  <Accordion title="Memory embedding scope">
    Bearer auth for Ollama memory embeddings is scoped to the host it was declared for:

    - A provider-level key is sent only to that provider's host.
    - `agents.*.memorySearch.remote.apiKey` is sent only to its remote embedding host.
    - A pure `OLLAMA_API_KEY` env value is treated as the Ollama Cloud convention and is not sent to local/self-hosted hosts by default.

  </Accordion>
</AccordionGroup>

## Getting started

<Tabs>
  <Tab title="Onboarding (recommended)">
    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        ```

        Select **Ollama**, then pick a mode: **Cloud + Local**, **Cloud only**, or **Local only**.

        On a fresh guided setup, OpenClaw first checks the default or configured
        Ollama host. If an installed model advertises tool support, the shared
        CLI/macOS setup ladder offers it immediately and verifies it with a real
        completion. This automatic check never pulls a model; if no suitable
        installed model exists, onboarding continues to the normal Ollama picker.
      </Step>
      <Step title="Select a model">
        `Cloud only` prompts for `OLLAMA_API_KEY` and suggests hosted cloud defaults. `Cloud + Local` and `Local only` prompt for an Ollama base URL, discover available models, and auto-pull the selected local model if missing. An installed `:latest` tag such as `gemma4:latest` is shown once instead of duplicating `gemma4`. `Cloud + Local` also checks whether the host is signed in for cloud access.
      </Step>
      <Step title="Verify">
        ```bash
        openclaw models list --provider ollama
        ```
      </Step>
    </Steps>

    Non-interactive:

    ```bash
    openclaw onboard --non-interactive \
      --auth-choice ollama \
      --custom-base-url "http://ollama-host:11434" \
      --custom-model-id "qwen3.5:27b" \
      --accept-risk
    ```

    `--custom-base-url` and `--custom-model-id` are optional; omitting them uses the local default host and the `gemma4` suggested model.

  </Tab>

  <Tab title="Manual setup">
    <Steps>
      <Step title="Install and start Ollama">
        Get it from [ollama.com/download](https://ollama.com/download), then pull a model:

        ```bash
        ollama pull gemma4
        ```

        For hybrid cloud access, run `ollama signin` on the same host.
      </Step>
      <Step title="Set a credential">
        ```bash
        export OLLAMA_API_KEY="ollama-local"    # local/LAN host, any value works
        export OLLAMA_API_KEY="your-real-key"   # https://ollama.com only
        ```

        Or in config: `openclaw config set models.providers.ollama.apiKey "OLLAMA_API_KEY"`.
      </Step>
      <Step title="Select the model">
        ```bash
        openclaw models list
        openclaw models set ollama/gemma4
        ```

        Or in config:

        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "ollama/gemma4" },
            },
          },
        }
        ```
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Cloud models through a local host

`Cloud + Local` routes both local and `:cloud` models through one reachable
Ollama host — this is Ollama's hybrid flow and the mode to pick during setup
when you want both.

OpenClaw prompts for the base URL, discovers local models, and checks
`ollama signin` status. When signed in, it suggests hosted defaults
(`kimi-k2.5:cloud`, `minimax-m2.7:cloud`, `glm-5.1:cloud`, `glm-5.2:cloud`). If
not signed in, setup stays local-only until you run `ollama signin`.

For cloud-only access without a local daemon, use `openclaw onboard --auth-choice ollama-cloud` and see [Ollama Cloud](/providers/ollama-cloud) — that path does not need `ollama signin` or a running server:

```bash
openclaw onboard --auth-choice ollama-cloud
openclaw models set ollama-cloud/kimi-k2.5:cloud
```

The cloud model list shown during `openclaw onboard` is populated live from
`https://ollama.com/api/tags`, capped at 500 entries, so the picker reflects
the current hosted catalog. If `ollama.com` is unreachable or returns no
models at setup time, OpenClaw falls back to its hardcoded suggested list so
onboarding still completes.

## Model discovery (implicit provider)

When `OLLAMA_API_KEY` (or an auth profile) is set and neither
`models.providers.ollama` nor another custom provider with `api: "ollama"` is
defined, OpenClaw discovers models from `http://127.0.0.1:11434`:

| Behavior             | Detail                                                                                                                                                                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog query        | `/api/tags`                                                                                                                                                                                                                                                                                   |
| Capability detection | Best-effort `/api/show` reads `contextWindow`, `num_ctx` Modelfile parameters, and capabilities (vision/tools/thinking)                                                                                                                                                                       |
| Vision models        | A `vision` capability from `/api/show` marks the model image-capable (`input: ["text", "image"]`)                                                                                                                                                                                             |
| Reasoning detection  | Uses the `thinking` capability from `/api/show` when available; falls back to a name heuristic (`r1`, `reason`, `reasoning`, `think`) when Ollama omits capabilities. `glm-5.2:cloud` and `deepseek-v4-flash\|pro:cloud` are always treated as reasoning regardless of reported capabilities. |
| Token limits         | `maxTokens` defaults to OpenClaw's Ollama max-token cap                                                                                                                                                                                                                                       |
| Costs                | All costs are `0`                                                                                                                                                                                                                                                                             |

```bash
ollama list
openclaw models list
```

Setting `models.providers.ollama` with an explicit `models` array, or a
custom provider with `api: "ollama"` and a non-loopback `baseUrl`, disables
auto-discovery; models must then be defined manually (see
[Configuration](#configuration)). A `models.providers.ollama` entry pointed at
hosted `https://ollama.com` also skips discovery, since Ollama Cloud models
are provider-managed. Loopback custom providers such as
`http://127.0.0.2:11434` still count as local and keep auto-discovery.

You can use a full ref such as `ollama/<pulled-model>:latest` without a
hand-written `models.json` entry; OpenClaw resolves it live. For signed-in
hosts, selecting an unlisted `ollama/<model>:cloud` ref validates that exact
model with `/api/show` and adds it to the runtime catalog only if Ollama
confirms metadata — typos still fail as unknown models.

### Smoke tests

For a narrow text probe that skips the full agent tool surface:

```bash
OLLAMA_API_KEY=ollama-local \
  openclaw infer model run \
    --local \
    --model ollama/llama3.2:latest \
    --prompt "Reply with exactly: pong" \
    --json
```

Add `--file` with an image for a lean vision-model probe (accepts PNG/JPEG/WebP;
non-image files are rejected before Ollama is called — use
`openclaw infer audio transcribe` for audio):

```bash
OLLAMA_API_KEY=ollama-local \
  openclaw infer model run \
    --local \
    --model ollama/qwen2.5vl:7b \
    --prompt "Describe this image in one sentence." \
    --file ./photo.jpg \
    --json
```

Neither path loads chat tools, memory, or session context. If it succeeds
while normal agent replies fail, the issue is likely the model's tool/agent
capacity, not the endpoint.

Selecting a model with `/model ollama/<model>` is an exact user choice: if the
configured `baseUrl` is unreachable, the next reply fails with the provider
error instead of silently falling back to another configured model.

Isolated cron jobs add one local safety check before starting the agent turn:
if the selected model resolves to a local/private-network/`.local` Ollama
provider and `/api/tags` is unreachable, OpenClaw records that run as
`skipped` with the model in the error text. This endpoint check is cached for
5 minutes per host, so repeated cron jobs against a stopped daemon do not all
launch failing requests.

Live verification:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA=1 OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=0 \
  pnpm test:live -- extensions/ollama/ollama.live.test.ts
```

For Ollama Cloud, point the same live test at the hosted endpoint (skips
embeddings by default; force with `OPENCLAW_LIVE_OLLAMA_EMBEDDINGS=1` since a
cloud key may not authorize `/api/embed`):

```bash
export OLLAMA_API_KEY='<your-ollama-cloud-api-key>'
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA=1 \
OPENCLAW_LIVE_OLLAMA_BASE_URL=https://ollama.com \
OPENCLAW_LIVE_OLLAMA_MODEL=glm-5.1:cloud \
OPENCLAW_LIVE_OLLAMA_WEB_SEARCH=1 \
pnpm test:live -- extensions/ollama/ollama.live.test.ts
```

To add a model, pull it and it is discovered automatically:

```bash
ollama pull mistral
```

## Node-local inference

Agents can delegate a short task to an Ollama model on a paired desktop or
server node. The prompt and response cross the existing authenticated
Gateway/node connection; the request runs on the node's own loopback Ollama
endpoint (`http://127.0.0.1:11434`).

<Steps>
  <Step title="Start Ollama on the node">
    ```bash
    ollama pull qwen3:0.6b
    ollama list
    ```
  </Step>
  <Step title="Connect the node host">
    ```bash
    openclaw node run \
      --host <gateway-host> \
      --port 18789 \
      --display-name "Local inference"
    ```

    Approve the device and its node commands on the Gateway host, then verify:

    ```bash
    openclaw devices list
    openclaw devices approve <deviceRequestId>
    openclaw nodes pending
    openclaw nodes approve <nodeRequestId>
    openclaw nodes status --connected
    ```

    A first connection, or an upgrade that adds Ollama commands, can trigger
    node-command approval. If the node connects without advertising
    `ollama.models` and `ollama.chat`, check `openclaw nodes pending` again.

  </Step>
  <Step title="Use it from an agent">
    The bundled Ollama plugin exposes the `node_inference` tool. Agents call
    `action: "discover"` first, then `action: "run"` with a node and model from
    that result (`run` can omit the node when exactly one capable node is
    connected). For example: "Discover the Ollama models on my nodes, then use
    the fastest loaded model to summarize this text."
  </Step>
</Steps>

Discovery reads `/api/tags`, checks `/api/show` capabilities, and uses
`/api/ps` when available to rank already-loaded models first. It returns only
local models Ollama reports as chat-capable (`completion` capability) —
Ollama Cloud rows and embedding-only models are excluded. Each run disables
model thinking and defaults output to 512 tokens (hard cap 8192) unless the
tool call requests a different `maxTokens`; some models (for example GPT-OSS)
do not support disabling thinking and may still emit reasoning tokens.

To keep Ollama running on a node without exposing it to agents:

```bash
openclaw config set plugins.entries.ollama.config.nodeInference.enabled false
```

Restart the node (`openclaw node restart`, or stop/rerun `openclaw node run`
for a foreground session). The node stops advertising `ollama.models` and
`ollama.chat`; Ollama itself and the Gateway's Ollama provider are unaffected.
Set the value back to `true` and restart to re-enable; a changed command
surface may need `openclaw nodes pending` approval again after reconnect.

Verify the node commands directly, without an agent turn:

```bash
openclaw nodes invoke \
  --node "Local inference" \
  --command ollama.models \
  --params '{}' \
  --invoke-timeout 90000 \
  --timeout 100000

openclaw nodes invoke \
  --node "Local inference" \
  --command ollama.chat \
  --params '{"model":"qwen3:0.6b","prompt":"Reply with exactly: pong","maxTokens":32,"timeoutMs":120000}' \
  --invoke-timeout 130000 \
  --timeout 140000
```

`--invoke-timeout` bounds how long the node has to run the command;
`--timeout` bounds the overall Gateway call and should be larger.

Node-local inference always uses the node's own loopback endpoint — it does
not reuse a configured remote/cloud `models.providers.ollama.baseUrl`. The
node commands are available by default on macOS, Linux, and Windows node
hosts and remain subject to normal node pairing/command policy.

## Vision and image description

The bundled Ollama plugin registers Ollama as an image-capable
media-understanding provider, so OpenClaw can route explicit image-description
requests and configured image-model defaults through local or hosted Ollama
vision models.

```bash
ollama pull qwen2.5vl:7b
export OLLAMA_API_KEY="ollama-local"
openclaw infer image describe --file ./photo.jpg --model ollama/qwen2.5vl:7b --json
```

`--model` must be a full `<provider/model>` ref; when set, `infer image
describe` tries that model first instead of skipping description for models
that already support native vision. If the call fails, OpenClaw can continue
through `agents.defaults.imageModel.fallbacks`; file/URL preparation errors
fail before fallback is attempted. Use `infer image describe` for OpenClaw's
image-understanding flow and configured `imageModel`; use `infer model run
--file` for a raw multimodal probe with a custom prompt.

To make Ollama the default image-understanding provider for inbound media:

```json5
{
  agents: {
    defaults: {
      imageModel: {
        primary: "ollama/qwen2.5vl:7b",
      },
    },
  },
}
```

Prefer the full `ollama/<model>` ref. A bare `imageModel` ref such as
`qwen2.5vl:7b` normalizes to `ollama/qwen2.5vl:7b` only when that exact model
is listed under `models.providers.ollama.models` with
`input: ["text", "image"]` and no other configured image provider exposes the
same bare id; otherwise use the provider prefix explicitly.

Slow local vision models can need a longer image-understanding timeout than
cloud models, and can crash on constrained hardware if Ollama tries to
allocate the model's full advertised vision context. Set a capability
timeout and cap `num_ctx`:

```json5
{
  models: {
    providers: {
      ollama: {
        models: [
          {
            id: "qwen2.5vl:7b",
            name: "qwen2.5vl:7b",
            input: ["text", "image"],
            params: { num_ctx: 2048, keep_alive: "1m" },
          },
        ],
      },
    },
  },
  tools: {
    media: {
      image: {
        timeoutSeconds: 180,
        models: [{ provider: "ollama", model: "qwen2.5vl:7b", timeoutSeconds: 300 }],
      },
    },
  },
}
```

This timeout applies to inbound image understanding and to the explicit
`image` tool. `models.providers.ollama.timeoutSeconds` still controls the
underlying Ollama HTTP request guard for normal model calls.

Live verification:

```bash
OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_OLLAMA_IMAGE=1 \
  pnpm test:live -- src/agents/tools/image-tool.ollama.live.test.ts
```

If you define `models.providers.ollama.models` manually, mark vision models
explicitly:

```json5
{
  id: "qwen2.5vl:7b",
  name: "qwen2.5vl:7b",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
}
```

OpenClaw rejects image-description requests for models not marked
image-capable. With implicit discovery, this comes from `/api/show`'s vision
capability.

## Configuration

<Tabs>
  <Tab title="Basic (implicit discovery)">
    ```bash
    export OLLAMA_API_KEY="ollama-local"
    ```

    <Tip>
    If `OLLAMA_API_KEY` is set, you can omit `apiKey` in the provider entry; OpenClaw fills it in for availability checks.
    </Tip>

  </Tab>

  <Tab title="Explicit (manual models)">
    Use explicit config for hosted cloud setup, a non-default host/port, forced
    context windows, or fully manual model lists:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
            api: "ollama",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "kimi-k2.5:cloud",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192
              }
            ]
          }
        }
      }
    }
    ```

  </Tab>

  <Tab title="Custom base URL">
    Explicit config disables auto-discovery, so models must be listed:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            apiKey: "ollama-local",
            baseUrl: "http://ollama-host:11434", // No /v1 - native Ollama API URL
            api: "ollama", // Explicit: guarantees native tool-calling behavior
            timeoutSeconds: 300, // Optional: longer connect/stream budget for cold local models
            models: [
              {
                id: "qwen3:32b",
                name: "qwen3:32b",
                params: {
                  keep_alive: "15m", // Optional: keep the model loaded between turns
                },
              },
            ],
          },
        },
      },
    }
    ```

    <Warning>
    Do not add `/v1`. That path selects OpenAI-compatible mode, where tool calling is not reliable.
    </Warning>

  </Tab>
</Tabs>

## Common recipes

Replace model IDs with exact names from `ollama list` or
`openclaw models list --provider ollama`.

<AccordionGroup>
  <Accordion title="Local model with auto-discovery">
    Ollama on the same machine as the Gateway, discovered automatically:

    ```bash
    ollama serve
    ollama pull gemma4
    export OLLAMA_API_KEY="ollama-local"
    openclaw models list --provider ollama
    openclaw models set ollama/gemma4
    ```

    Do not add a `models.providers.ollama` block unless you need manual models.

  </Accordion>

  <Accordion title="LAN Ollama host with manual models">
    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://gpu-box.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 300,
            contextWindow: 32768,
            maxTokens: 8192,
            models: [
              {
                id: "qwen3.5:9b",
                name: "qwen3.5:9b",
                reasoning: true,
                input: ["text"],
                params: {
                  num_ctx: 32768,
                  thinking: false,
                  keep_alive: "15m",
                },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ollama/qwen3.5:9b" },
        },
      },
    }
    ```

    `contextWindow` is OpenClaw's context budget; `params.num_ctx` is sent to
    Ollama. Keep them aligned when hardware cannot run the model's full
    advertised context.

  </Accordion>

  <Accordion title="Ollama Cloud only">
    No local daemon, hosted models directly:

    ```bash
    export OLLAMA_API_KEY="your-ollama-api-key"
    ```

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "https://ollama.com",
            apiKey: "OLLAMA_API_KEY",
            api: "ollama",
            models: [
              {
                id: "kimi-k2.5:cloud",
                name: "kimi-k2.5:cloud",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "ollama/kimi-k2.5:cloud" },
        },
      },
    }
    ```

    For the dedicated `ollama-cloud` provider id instead of this shape, see
    [Ollama Cloud](/providers/ollama-cloud).

  </Accordion>

  <Accordion title="Cloud plus local through a signed-in daemon">
    ```bash
    ollama signin
    ollama pull gemma4
    ```

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 300,
            models: [
              { id: "gemma4", name: "gemma4", input: ["text"] },
              { id: "kimi-k2.5:cloud", name: "kimi-k2.5:cloud", input: ["text", "image"] },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "ollama/gemma4",
            fallbacks: ["ollama/kimi-k2.5:cloud"],
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Multiple Ollama hosts">
    Custom provider IDs when running more than one Ollama server; each gets its
    own host, models, auth, and timeout.

    ```json5
    {
      models: {
        providers: {
          "ollama-fast": {
            baseUrl: "http://mini.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            contextWindow: 32768,
            models: [{ id: "gemma4", name: "gemma4", input: ["text"] }],
          },
          "ollama-large": {
            baseUrl: "http://gpu-box.local:11434",
            apiKey: "ollama-local",
            api: "ollama",
            timeoutSeconds: 420,
            contextWindow: 131072,
            maxTokens: 16384,
            models: [{ id: "qwen3.5:27b", name: "qwen3.5:27b", input: ["text"] }],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "ollama-fast/gemma4",
            fallbacks: ["ollama-large/qwen3.5:27b"],
          },
        },
      },
    }
    ```

    OpenClaw strips the active provider prefix (falling back to a bare
    `ollama/` prefix) before calling Ollama, so `ollama-large/qwen3.5:27b`
    reaches Ollama as `qwen3.5:27b`.

  </Accordion>

  <Accordion title="Lean local model profile">
    Some local models handle simple prompts but struggle with the full agent
    tool surface. Limit tools and context before touching global runtime
    settings:

    ```json5
    {
      agents: {
        list: [
          {
            id: "local",
            experimental: {
              localModelLean: true,
            },
            model: { primary: "ollama/gemma4" },
          },
        ],
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            apiKey: "ollama-local",
            api: "ollama",
            contextWindow: 32768,
            models: [
              {
                id: "gemma4",
                name: "gemma4",
                input: ["text"],
                params: { num_ctx: 32768 },
                compat: { supportsTools: false },
              },
            ],
          },
        },
      },
    }
    ```

    Use `compat.supportsTools: false` only when the model or server reliably
    fails on tool schemas — it trades agent capability for stability.
    `localModelLean` removes heavyweight browser, cron, message, media-generation,
    voice, and PDF tools from the direct agent surface unless explicitly required,
    and puts larger catalogs behind Tool Search. It does not change Ollama's
    runtime context or thinking mode. Pair it with `params.num_ctx` and
    `params.thinking: false` for small Qwen-style thinking models that loop or
    spend their budget on hidden reasoning.

  </Accordion>
</AccordionGroup>

### Model selection

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/gpt-oss:20b",
        fallbacks: ["ollama/llama3.3", "ollama/qwen2.5-coder:32b"],
      },
    },
  },
}
```

Custom provider ids work the same way: for a ref using the active provider
prefix, such as `ollama-spark/qwen3:32b`, OpenClaw strips that prefix before
calling Ollama, sending `qwen3:32b`.

For slow local models, prefer provider-scoped tuning before raising the whole
agent runtime timeout:

```json5
{
  models: {
    providers: {
      ollama: {
        timeoutSeconds: 300,
        models: [
          {
            id: "gemma4:26b",
            name: "gemma4:26b",
            params: { keep_alive: "15m" },
          },
        ],
      },
    },
  },
}
```

`timeoutSeconds` covers the model HTTP request: connection setup, headers,
body streaming, and the total guarded-fetch abort. `params.keep_alive` is
forwarded as top-level `keep_alive` on native `/api/chat` requests; set it per
model when first-turn load time is the bottleneck.

### Quick verification

```bash
# Ollama daemon visible to this machine
curl http://127.0.0.1:11434/api/tags

# OpenClaw catalog and selected model
openclaw models list --provider ollama
openclaw models status

# Direct model smoke
openclaw infer model run \
  --model ollama/gemma4 \
  --prompt "Reply with exactly: ok"
```

For remote hosts, replace `127.0.0.1` with the `baseUrl` host. If `curl`
works but OpenClaw does not, check whether the Gateway runs on a different
machine, container, or service account.

## Ollama Web Search

OpenClaw bundles **Ollama Web Search** as a `web_search` provider.

| Property    | Detail                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host        | `models.providers.ollama.baseUrl` when set, otherwise `http://127.0.0.1:11434`; `https://ollama.com` uses the hosted API directly                          |
| Auth        | Key-free for a signed-in local host; `OLLAMA_API_KEY` or configured provider auth for direct `https://ollama.com` search or auth-protected hosts           |
| Requirement | Local/self-hosted hosts must be running and signed in with `ollama signin`; direct hosted search needs `baseUrl: "https://ollama.com"` plus a real API key |

Choose it during `openclaw onboard` or `openclaw configure --section web`, or set:

```json5
{
  tools: {
    web: {
      search: {
        provider: "ollama",
      },
    },
  },
}
```

For direct hosted search through Ollama Cloud:

```json5
{
  models: {
    providers: {
      ollama: {
        baseUrl: "https://ollama.com",
        apiKey: "OLLAMA_API_KEY",
        api: "ollama",
        models: [{ id: "kimi-k2.5:cloud", name: "kimi-k2.5:cloud", input: ["text"] }],
      },
    },
  },
  tools: {
    web: {
      search: { provider: "ollama" },
    },
  },
}
```

For a self-hosted host, OpenClaw first tries the local `/api/experimental/web_search`
proxy, then falls back to the hosted `/api/web_search` path on the same host; a
signed-in local daemon normally answers through the local proxy. Direct
`https://ollama.com` calls always use the hosted `/api/web_search` endpoint.

<Note>
For full setup and behavior, see [Ollama Web Search](/tools/ollama-search).
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Legacy OpenAI-compatible mode">
    <Warning>
    **Tool calling is not reliable in this mode.** Use it only when a proxy needs OpenAI format and you do not depend on native tool calling.
    </Warning>

    Set `api: "openai-completions"` explicitly for a proxy behind
    `/v1/chat/completions`:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434/v1",
            api: "openai-completions",
            injectNumCtxForOpenAICompat: true, // default: true
            apiKey: "ollama-local",
            models: [...]
          }
        }
      }
    }
    ```

    This mode may not support streaming and tool calling simultaneously; you
    may need `params: { streaming: false }` on the model.

    OpenClaw injects `options.num_ctx` by default in this mode so Ollama does
    not silently fall back to a 4096-token context. If your proxy rejects
    unknown `options` fields, disable it:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434/v1",
            api: "openai-completions",
            injectNumCtxForOpenAICompat: false,
            apiKey: "ollama-local",
            models: [...]
          }
        }
      }
    }
    ```

  </Accordion>

  <Accordion title="Context windows">
    For auto-discovered models, OpenClaw uses the context window `/api/show`
    reports, including larger `PARAMETER num_ctx` values from custom
    Modelfiles; otherwise it falls back to OpenClaw's default Ollama context
    window.

    Provider-level `contextWindow`, `contextTokens`, and `maxTokens` set
    defaults for every model under that provider and can be overridden per
    model. `contextWindow` is OpenClaw's own prompt/compaction budget. Native
    `/api/chat` requests leave `options.num_ctx` unset unless you set
    `params.num_ctx` explicitly, so Ollama applies its own model,
    `OLLAMA_CONTEXT_LENGTH`, or VRAM-based default; invalid, zero, negative,
    or non-finite `params.num_ctx` values are ignored. If an older config used
    only `contextWindow`/`maxTokens` to force native request context, run
    `openclaw doctor --fix` to copy those into `params.num_ctx`. The
    OpenAI-compatible adapter still injects `options.num_ctx` by default from
    the configured `params.num_ctx` or `contextWindow`; disable with
    `injectNumCtxForOpenAICompat: false` if the upstream rejects `options`.

    Native model entries also accept common Ollama runtime options under
    `params`, forwarded as native `/api/chat` `options`: `num_keep`, `seed`,
    `num_predict`, `top_k`, `top_p`, `min_p`, `typical_p`, `repeat_last_n`,
    `temperature`, `repeat_penalty`, `presence_penalty`, `frequency_penalty`,
    `stop`, `num_batch`, `num_gpu`, `main_gpu`, `use_mmap`, and `num_thread`.
    A few keys (`format`, `keep_alive`, `truncate`, `shift`) are forwarded as
    top-level request fields instead of nested `options`. OpenClaw only
    forwards these Ollama request keys, so runtime-only params such as
    `streaming` are never sent to Ollama. Use `params.think` (or
    `params.thinking`) to set top-level `think`; `false` disables API-level
    thinking for Qwen-style thinking models.

    ```json5
    {
      models: {
        providers: {
          ollama: {
            contextWindow: 32768,
            models: [
              {
                id: "llama3.3",
                contextWindow: 131072,
                maxTokens: 65536,
                params: {
                  num_ctx: 32768,
                  temperature: 0.7,
                  top_p: 0.9,
                  thinking: false,
                },
              }
            ]
          }
        }
      }
    }
    ```

    Per-model `agents.defaults.models["ollama/<model>"].params.num_ctx` also
    works; the explicit provider model entry wins if both are set.

  </Accordion>

  <Accordion title="Thinking control">
    OpenClaw forwards thinking as Ollama expects it: top-level `think`, not
    `options.think`. Auto-discovered models whose `/api/show` reports a
    `thinking` capability expose `/think low`, `/think medium`, `/think high`,
    and `/think max`; non-thinking models expose only `/think off`.

    ```bash
    openclaw agent --model ollama/gemma4 --thinking off
    openclaw agent --model ollama/gemma4 --thinking low
    ```

    Or set a model default:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "ollama/gemma4": {
              thinking: "low",
            },
          },
        },
      },
    }
    ```

    Per-model `params.think`/`params.thinking` can disable or force API
    thinking for a specific model. OpenClaw preserves that explicit config
    when the active run only has the implicit `off` default; a non-off
    runtime command such as `/think medium` still overrides it. A truthy
    thinking request is never sent to a model explicitly marked
    `reasoning: false`; a `think: false` request is always sent regardless.

  </Accordion>

  <Accordion title="Reasoning models">
    Models named `deepseek-r1`, `reasoning`, `reason`, or `think` are treated
    as reasoning-capable by default — no extra config needed:

    ```bash
    ollama pull deepseek-r1:32b
    ```

  </Accordion>

  <Accordion title="Model costs">
    Ollama runs locally and is free, so all model costs are `0` for both
    auto-discovered and manually defined models.
  </Accordion>

  <Accordion title="Memory embeddings">
    The bundled Ollama plugin registers a memory embedding provider for
    [memory search](/concepts/memory). It uses the configured Ollama base URL
    and API key, calls `/api/embed`, and batches multiple memory chunks into
    one `input` request when possible.

    When `proxy.enabled=true`, embedding requests to the exact host-local
    loopback origin derived from the configured `baseUrl` use OpenClaw's
    guarded direct path instead of the managed forward proxy. The configured
    hostname must itself be `localhost` or a loopback IP literal — DNS names
    that merely resolve to loopback still use the managed proxy path. LAN,
    tailnet, private-network, and public Ollama hosts always stay on the
    managed proxy path, and redirects to another host/port do not inherit
    trust. `proxy.loopbackMode: "proxy"` routes loopback traffic through the
    proxy anyway; `proxy.loopbackMode: "block"` denies it before connecting —
    see [Managed proxy](/security/network-proxy#gateway-loopback-mode).

    | Property | Value |
    | --- | --- |
    | Default model | `nomic-embed-text` |
    | Auto-pull | Yes, if not present locally |
    | Default inline concurrency | 1 (other providers default higher; raise with `nonBatchConcurrency` if the host can take it) |

    Query-time embeddings use retrieval prefixes for models that require or
    recommend them: `nomic-embed-text`, `qwen3-embedding`, and
    `mxbai-embed-large`. Document batches stay raw, so existing indexes need
    no format migration.

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            remote: {
              // Default for Ollama. Raise on larger hosts if reindexing is too slow.
              nonBatchConcurrency: 1,
            },
          },
        },
      },
    }
    ```

    For a remote embedding host, keep auth scoped to that host:

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: {
            provider: "ollama",
            model: "nomic-embed-text",
            remote: {
              baseUrl: "http://gpu-box.local:11434",
              apiKey: "ollama-local",
              nonBatchConcurrency: 2,
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Streaming configuration">
    Ollama uses the **native API** (`/api/chat`) by default, which supports
    streaming and tool calling together — no special config needed.

    For native requests, thinking control is forwarded directly: `/think off`
    and `openclaw agent --thinking off` send top-level `think: false` unless
    an explicit `params.think`/`params.thinking` is configured; `/think
    low|medium|high` send the matching effort string; `/think max` maps to
    Ollama's highest effort, `think: "high"`.

    <Tip>
    For the OpenAI-compatible endpoint instead, see "Legacy OpenAI-compatible mode" above — streaming and tool calling may not work together there.
    </Tip>

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="WSL2 crash loop (repeated reboots)">
    On WSL2 with NVIDIA/CUDA, the official Ollama Linux installer creates an
    `ollama.service` systemd unit with `Restart=always`. If that service
    autostarts and loads a GPU-backed model during WSL2 boot, Ollama can pin
    host memory while loading; Hyper-V memory reclaim cannot always reclaim
    those pages, so Windows can terminate the WSL2 VM, systemd restarts
    Ollama, and the loop repeats.

    Evidence: repeated WSL2 reboots/terminations, high CPU in `app.slice` or
    `ollama.service` right after WSL2 startup, and SIGTERM from systemd rather
    than the Linux OOM killer.

    OpenClaw logs a startup warning when it detects WSL2, `ollama.service`
    enabled with `Restart=always`, and visible CUDA markers.

    Mitigation:

    ```bash
    sudo systemctl disable ollama
    ```

    On the Windows side, add this to `%USERPROFILE%\.wslconfig`, then run
    `wsl --shutdown`:

    ```ini
    [experimental]
    autoMemoryReclaim=disabled
    ```

    Or shorten keep-alive / start Ollama manually only when needed:

    ```bash
    export OLLAMA_KEEP_ALIVE=5m
    ollama serve
    ```

    See [ollama/ollama#11317](https://github.com/ollama/ollama/issues/11317).

  </Accordion>

  <Accordion title="Ollama not detected">
    Confirm Ollama is running, `OLLAMA_API_KEY` (or an auth profile) is set,
    and `models.providers.ollama` is **not** defined explicitly:

    ```bash
    ollama serve
    curl http://localhost:11434/api/tags
    ```

  </Accordion>

  <Accordion title="No models available">
    Pull the model locally, or define it explicitly in
    `models.providers.ollama`:

    ```bash
    ollama list  # See what's installed
    ollama pull gemma4
    ollama pull gpt-oss:20b
    ollama pull llama3.3     # Or another model
    ```

  </Accordion>

  <Accordion title="Connection refused">
    ```bash
    # Check if Ollama is running
    ps aux | grep ollama

    # Or restart Ollama
    ollama serve
    ```

  </Accordion>

  <Accordion title="Remote host works with curl but not OpenClaw">
    Verify from the same machine and runtime that runs the Gateway:

    ```bash
    openclaw gateway status --deep
    curl http://ollama-host:11434/api/tags
    ```

    Common causes:

    - `baseUrl` points at `localhost`, but the Gateway runs in Docker or on another host.
    - The URL uses `/v1`, selecting OpenAI-compatible behavior instead of native Ollama.
    - The remote host needs firewall or LAN binding changes.
    - The model is on your laptop's daemon but not the remote one.

  </Accordion>

  <Accordion title="Model outputs tool JSON as text">
    Usually the provider is in OpenAI-compatible mode, or the model cannot
    handle tool schemas. Prefer native mode:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434",
            api: "ollama",
          },
        },
      },
    }
    ```

    If a small local model still fails on tool schemas, set
    `compat.supportsTools: false` on that model entry and retest.

  </Accordion>

  <Accordion title="Kimi or GLM returns garbled symbols">
    Hosted Kimi/GLM responses that are long, non-linguistic symbol runs are
    treated as a failed provider call rather than a successful reply, so
    normal retry/fallback/error handling takes over instead of persisting
    corrupted text into the session.

    If it recurs, capture the model name, the current session file, and
    whether the run used `Cloud + Local` or `Cloud only`, then try a fresh
    session and a fallback model:

    ```bash
    openclaw infer model run --model ollama/kimi-k2.5:cloud --prompt "Reply with exactly: ok" --json
    openclaw models set ollama/gemma4
    ```

  </Accordion>

  <Accordion title="Cold local model times out">
    Large local models can need a long first load. Scope the timeout to the
    Ollama provider and optionally keep the model loaded between turns:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            timeoutSeconds: 300,
            models: [
              {
                id: "gemma4:26b",
                name: "gemma4:26b",
                params: { keep_alive: "15m" },
              },
            ],
          },
        },
      },
    }
    ```

    If the host itself is slow to accept connections, `timeoutSeconds` also
    extends the guarded connect timeout for this provider.

  </Accordion>

  <Accordion title="Large-context model is too slow or runs out of memory">
    Many models advertise contexts larger than your hardware can run
    comfortably. Native Ollama uses its own runtime default unless
    `params.num_ctx` is set. Cap both OpenClaw's budget and Ollama's request
    context for predictable first-token latency:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            contextWindow: 32768,
            maxTokens: 8192,
            models: [
              {
                id: "qwen3.5:9b",
                name: "qwen3.5:9b",
                params: { num_ctx: 32768, thinking: false },
              },
            ],
          },
        },
      },
    }
    ```

    Lower `contextWindow` if OpenClaw sends too much prompt. Lower
    `params.num_ctx` if Ollama's runtime context is too large for the machine.
    Lower `maxTokens` if generation runs too long.

  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Ollama Cloud" href="/providers/ollama-cloud" icon="cloud">
    Cloud-only setup with the dedicated `ollama-cloud` provider.
  </Card>
  <Card title="Model providers" href="/concepts/model-providers" icon="layers">
    Overview of all providers, model refs, and failover behavior.
  </Card>
  <Card title="Model selection" href="/concepts/models" icon="brain">
    How to choose and configure models.
  </Card>
  <Card title="Ollama Web Search" href="/tools/ollama-search" icon="magnifying-glass">
    Full setup and behavior details for Ollama-powered web search.
  </Card>
  <Card title="Configuration" href="/gateway/configuration" icon="gear">
    Full config reference.
  </Card>
</CardGroup>
