---
summary: "Run OpenClaw with Ollama (cloud and local models)"
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
  - You want Ollama vision models for image understanding
title: "Ollama"
---

OpenClaw integrates with Ollama's native API (`/api/chat`) for hosted cloud models and local/self-hosted Ollama servers. You can use Ollama in three modes: `Cloud + Local` through a reachable Ollama host, `Cloud only` against `https://ollama.com`, or `Local only` against a reachable Ollama host.

<Warning>
**Remote Ollama users**: Do not use the `/v1` OpenAI-compatible URL (`http://host:11434/v1`) with OpenClaw. This breaks tool calling and models may output raw tool JSON as plain text. Use the native Ollama API URL instead: `baseUrl: "http://host:11434"` (no `/v1`).
</Warning>

## Getting started

Choose your preferred setup method and mode.

<Tabs>
  <Tab title="Onboarding (recommended)">
    **Best for:** fastest path to a working Ollama cloud or local setup.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        ```

        Select **Ollama** from the provider list.
      </Step>
      <Step title="Choose your mode">
        - **Cloud + Local** — local Ollama host plus cloud models routed through that host
        - **Cloud only** — hosted Ollama models via `https://ollama.com`
        - **Local only** — local models only
      </Step>
      <Step title="Select a model">
        `Cloud only` prompts for `OLLAMA_API_KEY` and suggests hosted cloud defaults. `Cloud + Local` and `Local only` ask for an Ollama base URL, discover available models, and auto-pull the selected local model if it is not available yet. `Cloud + Local` also checks whether that Ollama host is signed in for cloud access.
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider ollama
        ```
      </Step>
    </Steps>

    ### Non-interactive mode

    ```bash
    openclaw onboard --non-interactive \
      --auth-choice ollama \
      --accept-risk
    ```

    Optionally specify a custom base URL or model:

    ```bash
    openclaw onboard --non-interactive \
      --auth-choice ollama \
      --custom-base-url "http://ollama-host:11434" \
      --custom-model-id "qwen3.5:27b" \
      --accept-risk
    ```

  </Tab>

  <Tab title="Manual setup">
    **Best for:** full control over cloud or local setup.

    <Steps>
      <Step title="Choose cloud or local">
        - **Cloud + Local**: install Ollama, sign in with `ollama signin`, and route cloud requests through that host
        - **Cloud only**: use `https://ollama.com` with an `OLLAMA_API_KEY`
        - **Local only**: install Ollama from [ollama.com/download](https://ollama.com/download)
      </Step>
      <Step title="Pull a local model (local only)">
        ```bash
        ollama pull gemma4
        # or
        ollama pull gpt-oss:20b
        # or
        ollama pull llama3.3
        ```
      </Step>
      <Step title="Enable Ollama for OpenClaw">
        For `Cloud only`, use your real `OLLAMA_API_KEY`. For host-backed setups, any placeholder value works:

        ```bash
        # Cloud
        export OLLAMA_API_KEY="your-ollama-api-key"

        # Local-only
        export OLLAMA_API_KEY="ollama-local"

        # Or configure in your config file
        openclaw config set models.providers.ollama.apiKey "OLLAMA_API_KEY"
        ```
      </Step>
      <Step title="Inspect and set your model">
        ```bash
        openclaw models list
        openclaw models set ollama/gemma4
        ```

        Or set the default in config:

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

## Cloud models

<Tabs>
  <Tab title="Cloud + Local">
    `Cloud + Local` uses a reachable Ollama host as the control point for both local and cloud models. This is Ollama's preferred hybrid flow.

    Use **Cloud + Local** during setup. OpenClaw prompts for the Ollama base URL, discovers local models from that host, and checks whether the host is signed in for cloud access with `ollama signin`. When the host is signed in, OpenClaw also suggests hosted cloud defaults such as `kimi-k2.5:cloud`, `minimax-m2.7:cloud`, and `glm-5.1:cloud`.

    If the host is not signed in yet, OpenClaw keeps the setup local-only until you run `ollama signin`.

  </Tab>

  <Tab title="Cloud only">
    `Cloud only` runs against Ollama's hosted API at `https://ollama.com`.

    Use **Cloud only** during setup. OpenClaw prompts for `OLLAMA_API_KEY`, sets `baseUrl: "https://ollama.com"`, and seeds the hosted cloud model list. This path does **not** require a local Ollama server or `ollama signin`.

    The cloud model list shown during `openclaw onboard` is populated live from `https://ollama.com/api/tags`, capped at 500 entries, so the picker reflects the current hosted catalog rather than a static seed. If `ollama.com` is unreachable or returns no models at setup time, OpenClaw falls back to the previous hardcoded suggestions so onboarding still completes.

  </Tab>

  <Tab title="Local only">
    In local-only mode, OpenClaw discovers models from the configured Ollama instance. This path is for local or self-hosted Ollama servers.

    OpenClaw currently suggests `gemma4` as the local default.

  </Tab>
</Tabs>

## Model discovery (implicit provider)

When you set `OLLAMA_API_KEY` (or an auth profile) and **do not** define `models.providers.ollama`, OpenClaw discovers models from the local Ollama instance at `http://127.0.0.1:11434`.

| Behavior             | Detail                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog query        | Queries `/api/tags`                                                                                                                                                 |
| Capability detection | Uses best-effort `/api/show` lookups to read `contextWindow` and detect capabilities (including vision)                                                             |
| Vision models        | Models with a `vision` capability reported by `/api/show` are marked as image-capable (`input: ["text", "image"]`), so OpenClaw auto-injects images into the prompt |
| Reasoning detection  | Marks `reasoning` with a model-name heuristic (`r1`, `reasoning`, `think`)                                                                                          |
| Token limits         | Sets `maxTokens` to the default Ollama max-token cap used by OpenClaw                                                                                               |
| Costs                | Sets all costs to `0`                                                                                                                                               |

This avoids manual model entries while keeping the catalog aligned with the local Ollama instance.

```bash
# See what models are available
ollama list
openclaw models list
```

To add a new model, simply pull it with Ollama:

```bash
ollama pull mistral
```

The new model will be automatically discovered and available to use.

<Note>
If you set `models.providers.ollama` explicitly, auto-discovery is skipped and you must define models manually. See the explicit config section below.
</Note>

## Vision and image description

The bundled Ollama plugin registers Ollama as an image-capable media-understanding provider. This lets OpenClaw route explicit image-description requests and configured image-model defaults through local or hosted Ollama vision models.

For local vision, pull a model that supports images:

```bash
ollama pull qwen2.5vl:7b
export OLLAMA_API_KEY="ollama-local"
```

Then verify with the infer CLI:

```bash
openclaw infer image describe \
  --file ./photo.jpg \
  --model ollama/qwen2.5vl:7b \
  --json
```

`--model` must be a full `<provider/model>` ref. When it is set, `openclaw infer image describe` runs that model directly instead of skipping description because the model supports native vision.

To make Ollama the default image-understanding model for inbound media, configure `agents.defaults.imageModel`:

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

If you define `models.providers.ollama.models` manually, mark vision models with image input support:

```json5
{
  id: "qwen2.5vl:7b",
  name: "qwen2.5vl:7b",
  input: ["text", "image"],
  contextWindow: 128000,
  maxTokens: 8192,
}
```

OpenClaw rejects image-description requests for models that are not marked image-capable. With implicit discovery, OpenClaw reads this from Ollama when `/api/show` reports a vision capability.

## Configuration

<Tabs>
  <Tab title="Basic (implicit discovery)">
    The simplest local-only enablement path is via environment variable:

    ```bash
    export OLLAMA_API_KEY="ollama-local"
    ```

    <Tip>
    If `OLLAMA_API_KEY` is set, you can omit `apiKey` in the provider entry and OpenClaw will fill it for availability checks.
    </Tip>

  </Tab>

  <Tab title="Explicit (manual models)">
    Use explicit config when you want hosted cloud setup, Ollama runs on another host/port, you want to force specific context windows or model lists, or you want fully manual model definitions.

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
    If Ollama is running on a different host or port (explicit config disables auto-discovery, so define models manually):

    ```json5
    {
      models: {
        providers: {
          ollama: {
            apiKey: "ollama-local",
            baseUrl: "http://ollama-host:11434", // No /v1 - use native Ollama API URL
            api: "ollama", // Set explicitly to guarantee native tool-calling behavior
          },
        },
      },
    }
    ```

    <Warning>
    Do not add `/v1` to the URL. The `/v1` path uses OpenAI-compatible mode, where tool calling is not reliable. Use the base Ollama URL without a path suffix.
    </Warning>

  </Tab>
</Tabs>

### Model selection

Once configured, all your Ollama models are available:

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

## Ollama Web Search

OpenClaw supports **Ollama Web Search** as a bundled `web_search` provider.

| Property    | Detail                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Host        | Uses your configured Ollama host (`models.providers.ollama.baseUrl` when set, otherwise `http://127.0.0.1:11434`) |
| Auth        | Key-free                                                                                                          |
| Requirement | Ollama must be running and signed in with `ollama signin`                                                         |

Choose **Ollama Web Search** during `openclaw onboard` or `openclaw configure --section web`, or set:

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

<Note>
For the full setup and behavior details, see [Ollama Web Search](/tools/ollama-search).
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Legacy OpenAI-compatible mode">
    <Warning>
    **Tool calling is not reliable in OpenAI-compatible mode.** Use this mode only if you need OpenAI format for a proxy and do not depend on native tool calling behavior.
    </Warning>

    If you need to use the OpenAI-compatible endpoint instead (for example, behind a proxy that only supports OpenAI format), set `api: "openai-completions"` explicitly:

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

    This mode may not support streaming and tool calling simultaneously. You may need to disable streaming with `params: { streaming: false }` in model config.

    When `api: "openai-completions"` is used with Ollama, OpenClaw injects `options.num_ctx` by default so Ollama does not silently fall back to a 4096 context window. If your proxy/upstream rejects unknown `options` fields, disable this behavior:

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
    For auto-discovered models, OpenClaw uses the context window reported by Ollama when available, otherwise it falls back to the default Ollama context window used by OpenClaw.

    You can override `contextWindow` and `maxTokens` in explicit provider config:

    ```json5
    {
      models: {
        providers: {
          ollama: {
            models: [
              {
                id: "llama3.3",
                contextWindow: 131072,
                maxTokens: 65536,
              }
            ]
          }
        }
      }
    }
    ```

  </Accordion>

  <Accordion title="Reasoning models">
    OpenClaw treats models with names such as `deepseek-r1`, `reasoning`, or `think` as reasoning-capable by default.

    ```bash
    ollama pull deepseek-r1:32b
    ```

    No additional configuration is needed -- OpenClaw marks them automatically.

  </Accordion>

  <Accordion title="Model costs">
    Ollama is free and runs locally, so all model costs are set to $0. This applies to both auto-discovered and manually defined models.
  </Accordion>

  <Accordion title="Memory embeddings">
    The bundled Ollama plugin registers a memory embedding provider for
    [memory search](/concepts/memory). It uses the configured Ollama base URL
    and API key.

    | Property      | Value               |
    | ------------- | ------------------- |
    | Default model | `nomic-embed-text`  |
    | Auto-pull     | Yes — the embedding model is pulled automatically if not present locally |

    To select Ollama as the memory search embedding provider:

    ```json5
    {
      agents: {
        defaults: {
          memorySearch: { provider: "ollama" },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Streaming configuration">
    OpenClaw's Ollama integration uses the **native Ollama API** (`/api/chat`) by default, which fully supports streaming and tool calling simultaneously. No special configuration is needed.

    For native `/api/chat` requests, OpenClaw also forwards thinking control directly to Ollama: `/think off` and `openclaw agent --thinking off` send top-level `think: false`, while non-`off` thinking levels send `think: true`.

    <Tip>
    If you need to use the OpenAI-compatible endpoint, see the "Legacy OpenAI-compatible mode" section above. Streaming and tool calling may not work simultaneously in that mode.
    </Tip>

  </Accordion>
</AccordionGroup>

## Troubleshooting

<AccordionGroup>
  <Accordion title="Ollama not detected">
    Make sure Ollama is running and that you set `OLLAMA_API_KEY` (or an auth profile), and that you did **not** define an explicit `models.providers.ollama` entry:

    ```bash
    ollama serve
    ```

    Verify that the API is accessible:

    ```bash
    curl http://localhost:11434/api/tags
    ```

  </Accordion>

  <Accordion title="No models available">
    If your model is not listed, either pull the model locally or define it explicitly in `models.providers.ollama`.

    ```bash
    ollama list  # See what's installed
    ollama pull gemma4
    ollama pull gpt-oss:20b
    ollama pull llama3.3     # Or another model
    ```

  </Accordion>

  <Accordion title="Connection refused">
    Check that Ollama is running on the correct port:

    ```bash
    # Check if Ollama is running
    ps aux | grep ollama

    # Or restart Ollama
    ollama serve
    ```

  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
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
