---
summary: "Run OpenClaw with Ollama (cloud and local models)"
read_when:
  - You want to run OpenClaw with cloud or local models via Ollama
  - You need Ollama setup and configuration guidance
title: "Ollama"
---

# Ollama

Ollama is a local LLM runtime that makes it easy to run open-source models on your machine. OpenClaw integrates with Ollama's native API (`/api/chat`), supports streaming and tool calling, and can auto-discover local Ollama models when you opt in with `OLLAMA_API_KEY` (or an auth profile) and do not define an explicit `models.providers.ollama` entry.

<Warning>
**Remote Ollama users**: Do not use the `/v1` OpenAI-compatible URL (`http://host:11434/v1`) with OpenClaw. This breaks tool calling and models may output raw tool JSON as plain text. Use the native Ollama API URL instead: `baseUrl: "http://host:11434"` (no `/v1`).
</Warning>

## Getting started

Choose your preferred setup method and mode.

<Tabs>
  <Tab title="Onboarding (recommended)">
    **Best for:** fastest path to a working Ollama setup with automatic model discovery.

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard
        ```

        Select **Ollama** from the provider list.
      </Step>
      <Step title="Choose your mode">
        - **Cloud + Local** — cloud-hosted models and local models together
        - **Local** — local models only

        If you choose **Cloud + Local** and are not signed in to ollama.com, onboarding opens a browser sign-in flow.
      </Step>
      <Step title="Select a model">
        Onboarding discovers available models and suggests defaults. It auto-pulls the selected model if it is not available locally.
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
    **Best for:** full control over installation, model pulls, and config.

    <Steps>
      <Step title="Install Ollama">
        Download from [ollama.com/download](https://ollama.com/download).
      </Step>
      <Step title="Pull a local model">
        ```bash
        ollama pull gemma4
        # or
        ollama pull gpt-oss:20b
        # or
        ollama pull llama3.3
        ```
      </Step>
      <Step title="Sign in for cloud models (optional)">
        If you want cloud models too:

        ```bash
        ollama signin
        ```
      </Step>
      <Step title="Enable Ollama for OpenClaw">
        Set any value for the API key (Ollama does not require a real key):

        ```bash
        # Set environment variable
        export OLLAMA_API_KEY="ollama-local"

        # Or configure in your config file
        openclaw config set models.providers.ollama.apiKey "ollama-local"
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
    Cloud models let you run cloud-hosted models alongside your local models. Examples include `kimi-k2.5:cloud`, `minimax-m2.7:cloud`, and `glm-5.1:cloud` -- these do **not** require a local `ollama pull`.

    Select **Cloud + Local** mode during setup. The wizard checks whether you are signed in and opens a browser sign-in flow when needed. If authentication cannot be verified, the wizard falls back to local model defaults.

    You can also sign in directly at [ollama.com/signin](https://ollama.com/signin).

    OpenClaw currently suggests these cloud defaults: `kimi-k2.5:cloud`, `minimax-m2.7:cloud`, `glm-5.1:cloud`.

  </Tab>

  <Tab title="Local only">
    In local-only mode, OpenClaw discovers models from the local Ollama instance. No cloud sign-in is needed.

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

## Configuration

<Tabs>
  <Tab title="Basic (implicit discovery)">
    The simplest way to enable Ollama is via environment variable:

    ```bash
    export OLLAMA_API_KEY="ollama-local"
    ```

    <Tip>
    If `OLLAMA_API_KEY` is set, you can omit `apiKey` in the provider entry and OpenClaw will fill it for availability checks.
    </Tip>

  </Tab>

  <Tab title="Explicit (manual models)">
    Use explicit config when Ollama runs on another host/port, you want to force specific context windows or model lists, or you want fully manual model definitions.

    ```json5
    {
      models: {
        providers: {
          ollama: {
            baseUrl: "http://ollama-host:11434",
            apiKey: "ollama-local",
            api: "ollama",
            models: [
              {
                id: "gpt-oss:20b",
                name: "GPT-OSS 20B",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 8192 * 10
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
