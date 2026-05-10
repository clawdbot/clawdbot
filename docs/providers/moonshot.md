---
summary: "Configure Moonshot K2 vs Kimi Coding (separate providers + keys)"
read_when:
  - You want Moonshot K2 (Moonshot Open Platform) vs Kimi Coding setup
  - You need to understand separate endpoints, keys, and model refs
  - You want copy/paste config for either provider
title: "Moonshot AI"
---

Moonshot provides the Kimi API with OpenAI-compatible endpoints. Configure the
provider and set the default model to `moonshot/kimi-k2.6`, or use
Kimi Coding with `kimi/kimi-for-coding`.

<Warning>
Moonshot and Kimi Coding are **separate providers**. Keys are not interchangeable, endpoints differ, and model refs differ (`moonshot/...` vs `kimi/...`).
</Warning>

## Built-in model catalog

[//]: # "moonshot-kimi-k2-ids:start"

| Model ref                         | Name                   | Reasoning | Input       | Context | Max output |
| --------------------------------- | ---------------------- | --------- | ----------- | ------- | ---------- |
| `moonshot/kimi-k2.6`              | Kimi K2.6              | No        | text, image | 262,144 | 262,144    |
| `moonshot/kimi-k2.5`              | Kimi K2.5              | No        | text, image | 262,144 | 262,144    |
| `moonshot/kimi-k2-thinking`       | Kimi K2 Thinking       | Yes       | text        | 262,144 | 262,144    |
| `moonshot/kimi-k2-thinking-turbo` | Kimi K2 Thinking Turbo | Yes       | text        | 262,144 | 262,144    |
| `moonshot/kimi-k2-turbo`          | Kimi K2 Turbo          | No        | text        | 256,000 | 16,384     |

[//]: # "moonshot-kimi-k2-ids:end"

Bundled cost estimates for current Moonshot-hosted K2 models use Moonshot's
published pay-as-you-go rates: Kimi K2.6 is $0.16/MTok cache hit,
$0.95/MTok input, and $4.00/MTok output; Kimi K2.5 is $0.10/MTok cache hit,
$0.60/MTok input, and $3.00/MTok output. Other legacy catalog entries keep
zero-cost placeholders unless you override them in config.

## Getting started

Choose your provider and follow the setup steps.

<Tabs>
  <Tab title="Moonshot API">
    **Best for:** Kimi K2 models via the Moonshot Open Platform.

    <Steps>
      <Step title="Choose your endpoint region">
        | Auth choice            | Endpoint                       | Region        |
        | ---------------------- | ------------------------------ | ------------- |
        | `moonshot-api-key`     | `https://api.moonshot.ai/v1`   | International |
        | `moonshot-api-key-cn`  | `https://api.moonshot.cn/v1`   | China         |
      </Step>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice moonshot-api-key
        ```

        Or for the China endpoint:

        ```bash
        openclaw onboard --auth-choice moonshot-api-key-cn
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "moonshot/kimi-k2.6" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify models are available">
        ```bash
        openclaw models list --provider moonshot
        ```
      </Step>
      <Step title="Run a live smoke test">
        Use an isolated state dir when you want to verify model access and cost
        tracking without touching your normal sessions:

        ```bash
        OPENCLAW_CONFIG_PATH=/tmp/openclaw-kimi/openclaw.json \
        OPENCLAW_STATE_DIR=/tmp/openclaw-kimi \
        openclaw agent --local \
          --session-id live-kimi-cost \
          --message 'Reply exactly: KIMI_LIVE_OK' \
          --thinking off \
          --json
        ```

        The JSON response should report `provider: "moonshot"` and
        `model: "kimi-k2.6"`. The assistant transcript entry stores normalized
        token usage plus estimated cost under `usage.cost` when Moonshot returns
        usage metadata.
      </Step>
    </Steps>

    ### Config example

    ```json5
    {
      env: { MOONSHOT_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "moonshot/kimi-k2.6" },
          models: {
            // moonshot-kimi-k2-aliases:start
            "moonshot/kimi-k2.6": { alias: "Kimi K2.6" },
            "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
            "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
            "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
            "moonshot/kimi-k2-turbo": { alias: "Kimi K2 Turbo" },
            // moonshot-kimi-k2-aliases:end
          },
        },
      },
      models: {
        mode: "merge",
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            apiKey: "${MOONSHOT_API_KEY}",
            api: "openai-completions",
            models: [
              // moonshot-kimi-k2-models:start
              {
                id: "kimi-k2.6",
                name: "Kimi K2.6",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2.5",
                name: "Kimi K2.5",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking",
                name: "Kimi K2 Thinking",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-thinking-turbo",
                name: "Kimi K2 Thinking Turbo",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2-turbo",
                name: "Kimi K2 Turbo",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 16384,
              },
              // moonshot-kimi-k2-models:end
            ],
          },
        },
      },
    }
    ```

  </Tab>

  <Tab title="Kimi Coding">
    **Best for:** code-focused tasks via the Kimi Coding endpoint.

    <Note>
    Kimi Coding uses a different API key and provider prefix (`kimi/...`) than Moonshot (`moonshot/...`). The stable API model ref is `kimi/kimi-for-coding`; legacy refs `kimi/kimi-code` and `kimi/k2p5` remain accepted and normalize to that API model id.
    </Note>

    <Steps>
      <Step title="Run onboarding">
        ```bash
        openclaw onboard --auth-choice kimi-code-api-key
        ```
      </Step>
      <Step title="Set a default model">
        ```json5
        {
          agents: {
            defaults: {
              model: { primary: "kimi/kimi-for-coding" },
            },
          },
        }
        ```
      </Step>
      <Step title="Verify the model is available">
        ```bash
        openclaw models list --provider kimi
        ```
      </Step>
    </Steps>

    ### Config example

    ```json5
    {
      env: { KIMI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-for-coding" },
          models: {
            "kimi/kimi-for-coding": { alias: "Kimi" },
          },
        },
      },
    }
    ```

  </Tab>
</Tabs>

## Kimi web search

OpenClaw also ships **Kimi** as a `web_search` provider, backed by Moonshot web
search.

<Steps>
  <Step title="Run interactive web search setup">
    ```bash
    openclaw configure --section web
    ```

    Choose **Kimi** in the web-search section to store
    `plugins.entries.moonshot.config.webSearch.*`.

  </Step>
  <Step title="Configure the web search region and model">
    Interactive setup prompts for:

    | Setting             | Options                                                              |
    | ------------------- | -------------------------------------------------------------------- |
    | API region          | `https://api.moonshot.ai/v1` (international) or `https://api.moonshot.cn/v1` (China) |
    | Web search model    | Defaults to `kimi-k2.6`                                             |

  </Step>
</Steps>

Config lives under `plugins.entries.moonshot.config.webSearch`:

```json5
{
  plugins: {
    entries: {
      moonshot: {
        config: {
          webSearch: {
            apiKey: "sk-...", // or use KIMI_API_KEY / MOONSHOT_API_KEY
            baseUrl: "https://api.moonshot.ai/v1",
            model: "kimi-k2.6",
          },
        },
      },
    },
  },
  tools: {
    web: {
      search: {
        provider: "kimi",
      },
    },
  },
}
```

## Advanced configuration

<AccordionGroup>
  <Accordion title="Native thinking mode">
    Moonshot Kimi supports binary native thinking:

    - `thinking: { type: "enabled" }`
    - `thinking: { type: "disabled" }`

    Configure it per model via `agents.defaults.models.<provider/model>.params`:

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.6": {
              params: {
                thinking: { type: "disabled" },
              },
            },
          },
        },
      },
    }
    ```

    OpenClaw also maps runtime `/think` levels for Moonshot:

    | `/think` level       | Moonshot behavior          |
    | -------------------- | -------------------------- |
    | `/think off`         | `thinking.type=disabled`   |
    | Any non-off level    | `thinking.type=enabled`    |

    <Warning>
    When Moonshot thinking is enabled, `tool_choice` must be `auto` or `none`. OpenClaw normalizes incompatible `tool_choice` values to `auto` for compatibility.
    </Warning>

    Kimi K2.6 also accepts an optional `thinking.keep` field that controls
    multi-turn retention of `reasoning_content`. Set it to `"all"` to keep full
    reasoning across turns; omit it (or leave it `null`) to use the server
    default strategy. OpenClaw only forwards `thinking.keep` for
    `moonshot/kimi-k2.6` and strips it from other models.

    ```json5
    {
      agents: {
        defaults: {
          models: {
            "moonshot/kimi-k2.6": {
              params: {
                thinking: { type: "enabled", keep: "all" },
              },
            },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Tool call id sanitization">
    Moonshot Kimi serves tool_call ids shaped like `functions.<name>:<index>`. OpenClaw preserves them unchanged so multi-turn tool calls keep working.

    To force strict sanitization on a custom OpenAI-compatible provider, set `sanitizeToolCallIds: true`:

    ```json5
    {
      models: {
        providers: {
          "my-kimi-proxy": {
            api: "openai-completions",
            sanitizeToolCallIds: true,
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title="Streaming usage compatibility">
    Native Moonshot endpoints (`https://api.moonshot.ai/v1` and
    `https://api.moonshot.cn/v1`) advertise streaming usage compatibility on the
    shared `openai-completions` transport. OpenClaw keys that off endpoint
    capabilities, so compatible custom provider ids targeting the same native
    Moonshot hosts inherit the same streaming-usage behavior.

    With the bundled K2.6 pricing, streamed usage that includes input, output,
    and cache-read tokens is also converted into local estimated USD cost for
    `/status`, `/usage full`, `/usage cost`, and transcript-backed session
    accounting.

  </Accordion>

  <Accordion title="Endpoint and model ref reference">
    | Provider   | Model ref prefix | Endpoint                      | Auth env var        |
    | ---------- | ---------------- | ----------------------------- | ------------------- |
    | Moonshot   | `moonshot/`      | `https://api.moonshot.ai/v1`  | `MOONSHOT_API_KEY`  |
    | Moonshot CN| `moonshot/`      | `https://api.moonshot.cn/v1`  | `MOONSHOT_API_KEY`  |
    | Kimi Coding| `kimi/`          | Kimi Coding endpoint          | `KIMI_API_KEY`      |
    | Web search | N/A              | Same as Moonshot API region   | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |

    - Kimi web search uses `KIMI_API_KEY` or `MOONSHOT_API_KEY`, and defaults to `https://api.moonshot.ai/v1` with model `kimi-k2.6`.
    - Override pricing and context metadata in `models.providers` if needed.
    - If Moonshot publishes different context limits for a model, adjust `contextWindow` accordingly.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Web search" href="/tools/web" icon="magnifying-glass">
    Configuring web search providers including Kimi.
  </Card>
  <Card title="Configuration reference" href="/gateway/configuration-reference" icon="gear">
    Full config schema for providers, models, and plugins.
  </Card>
  <Card title="Moonshot Open Platform" href="https://platform.moonshot.ai" icon="globe">
    Moonshot API key management and documentation.
  </Card>
</CardGroup>
