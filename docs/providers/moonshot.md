---
summary: "Configure Moonshot Kimi models vs Kimi Coding (separate providers + keys)"
read_when:
  - You want Moonshot Kimi K3/K2 (Moonshot Open Platform) vs Kimi Coding setup
  - You need to understand separate endpoints, keys, and model refs
  - You want copy/paste config for either provider
title: "Moonshot AI"
---

Moonshot provides the Kimi API with OpenAI-compatible endpoints. Fresh Moonshot
onboarding selects `moonshot/kimi-k3`; use `kimi/kimi-for-coding` for the
separate Kimi Coding provider.

<Warning>
Moonshot and Kimi Coding are **separate providers**, each shipped as a separate external plugin. Keys are not interchangeable, endpoints differ, and model refs differ (`moonshot/...` vs `kimi/...`).
</Warning>

## Built-in model catalog

[//]: # "moonshot-kimi-k2-ids:start"

| Model ref                           | Name                     | Reasoning        | Input              | Context   | Max output |
| ----------------------------------- | ------------------------ | ---------------- | ------------------ | --------- | ---------- |
| `moonshot/kimi-k3`                  | Kimi K3                  | low / high / max | text, image, video | 1,048,576 | 1,048,576  |
| `moonshot/kimi-k2.7-code`           | Kimi K2.7 Code           | Always on        | text, image, video | 262,144   | 262,144    |
| `moonshot/kimi-k2.7-code-highspeed` | Kimi K2.7 Code HighSpeed | Always on        | text, image, video | 262,144   | 262,144    |

[//]: # "moonshot-kimi-k2-ids:end"

Catalog cost estimates use Moonshot's published pay-as-you-go rates. Check the
live vendor pages for [Kimi K3](https://platform.kimi.ai/docs/pricing/chat-k3)
and [Kimi K2.7 Code](https://platform.kimi.ai/docs/pricing/chat-k27-code)
before making cost decisions.

Kimi K3 always reasons and accepts `reasoning_effort` values `low`, `high`,
and `max` (the default). OpenClaw exposes those exact levels and maps `/think
xhigh` to `max`; it omits the K2-only `thinking` field and removes sampling
overrides (`temperature`, `top_p`, `n`, `presence_penalty`, and
`frequency_penalty`) that K3 fixes to provider defaults. Kimi K2.7 Code also
always uses native thinking but requires both `thinking` and
`reasoning_effort` to be omitted; the HighSpeed variant uses the same contract.
Kimi K3 is the onboarding default.
See Moonshot's [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart).

## Getting started

Both Moonshot and Kimi Coding are external plugins - install one before
onboarding.

<Tabs>
  <Tab title="Moonshot API">
    **Best for:** Kimi K3 and K2 models via the Moonshot Open Platform.

    <Steps>
      <Step title="Install the plugin">
        ```bash
        openclaw plugins install @openclaw/moonshot-provider
        openclaw gateway restart
        ```
      </Step>
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
      <Step title="Confirm the Kimi K3 default">
        Fresh onboarding selects Kimi K3. Existing installations can switch explicitly:

        ```bash
        openclaw models set moonshot/kimi-k3
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
          --thinking max \
          --json
        ```

        The JSON response should report `provider: "moonshot"` and
        `model: "kimi-k3"`. The assistant transcript entry stores normalized
        token usage plus estimated cost under `usage.cost` when Moonshot returns
        usage metadata.
      </Step>
    </Steps>

    ### Config example

    ```json5
    {
      env: { vars: { MOONSHOT_API_KEY: "sk-..." } },
      agents: {
        defaults: {
          model: { primary: "moonshot/kimi-k3" },
          models: {
            // moonshot-kimi-k2-aliases:start
            "moonshot/kimi-k3": { alias: "Kimi K3" },
            "moonshot/kimi-k2.7-code": { alias: "Kimi K2.7 Code" },
            "moonshot/kimi-k2.7-code-highspeed": { alias: "Kimi K2.7 Code HighSpeed" },
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
                id: "kimi-k3",
                name: "Kimi K3",
                reasoning: true,
                thinkingLevelMap: {
                  off: null,
                  minimal: null,
                  low: "low",
                  medium: null,
                  high: "high",
                  xhigh: "max",
                  max: "max",
                },
                input: ["text", "image", "video"],
                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
                contextWindow: 1048576,
                maxTokens: 1048576,
              },
              {
                id: "kimi-k2.7-code",
                name: "Kimi K2.7 Code",
                reasoning: true,
                input: ["text", "image", "video"],
                cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
              },
              {
                id: "kimi-k2.7-code-highspeed",
                name: "Kimi K2.7 Code HighSpeed",
                reasoning: true,
                input: ["text", "image", "video"],
                cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
                contextWindow: 262144,
                maxTokens: 262144,
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
    Kimi Coding uses a different API key and provider prefix (`kimi/...`) than Moonshot (`moonshot/...`). Current refs are `kimi/k3` for up to 1M context (tier-gated), `kimi/k3-256k` for 256K context with lower quota use, `kimi/kimi-for-coding`, and `kimi/kimi-for-coding-highspeed`. Legacy refs `kimi/kimi-code` and `kimi/k2p5` normalize to `kimi/kimi-for-coding`; legacy `kimi/k3[1m]` normalizes to `kimi/k3`.
    </Note>

    The coding service accepts both OpenAI-compatible
    `https://api.kimi.com/coding/v1` and Anthropic-compatible
    `https://api.kimi.com/coding/` clients. This plugin uses Anthropic Messages.
    Create membership keys in the
    [Kimi Code Console](https://www.kimi.com/code/console); current membership
    pricing lives on [Kimi's pricing page](https://www.kimi.com/membership/pricing).

    | Model ref | Name | Reasoning | Input | Context | Max output |
    | --- | --- | --- | --- | --- | --- |
    | `kimi/k3` | Kimi K3 | adaptive; low / high / max effort | text, image | 1,048,576 | 131,072 |
    | `kimi/k3-256k` | Kimi K3 (256k) | adaptive; low / high / max effort | text, image | 262,144 | 131,072 |

    The K3 catalog estimates $3/MTok input, $15/MTok output, $0.30/MTok
    cache reads, and $0/MTok cache writes. The catalog reports K3's maximum
    context; your Kimi membership may enforce a lower live limit.

    <Steps>
      <Step title="Install the plugin">
        ```bash
        openclaw plugins install @openclaw/kimi-provider
        openclaw gateway restart
        ```
      </Step>
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

    Kimi Code K3 always uses adaptive thinking when reasoning is enabled and
    defaults to high effort. `/think minimal|low` maps to low effort,
    `/think medium|high|adaptive` maps to high effort, and `/think xhigh|max`
    maps to max effort. `/think off` sends `thinking.type: "disabled"`.

    See the official [Kimi Code model table](https://www.kimi.com/code/docs/en/kimi-code/models.html) for current plan availability.

    ### Config example

    ```json5
    {
      env: { vars: { KIMI_API_KEY: "sk-..." } },
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

The Moonshot plugin also registers **Kimi** as a `web_search` provider, backed by Moonshot web search.

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
    Moonshot API Kimi K3 always reasons at maximum effort. OpenClaw exposes only
    `/think max`, sends `reasoning_effort: "max"`, and ignores stale lower or
    `off` settings.

    Kimi Code K3 exposes `/think off|minimal|low|medium|high|adaptive|xhigh|max`.
    Its Anthropic-compatible endpoint receives `thinking.type: "disabled"` for
    off. Every enabled level uses adaptive thinking; minimal/low maps to low
    effort, medium/high/adaptive maps to high effort, and xhigh/max maps to max
    effort. This applies to both `kimi/k3` and `kimi/k3-256k`. Legacy
    `kimi/k3[1m]` normalizes to `kimi/k3`.
    Moonshot API K3 supports `auto`, `none`, `required`, and pinned tool choices,
    so OpenClaw preserves the requested `tool_choice`. For multi-turn tool use,
    OpenClaw preserves the assistant reasoning content required by Moonshot's
    replay contract.

    Kimi K2.7 Code always uses native thinking. Moonshot requires clients to
    omit the `thinking` field for this model, so OpenClaw exposes only `on` and
    ignores stale `off` settings. K2.7 also fixes `temperature`, `top_p`, `n`,
    `presence_penalty`, and `frequency_penalty`; OpenClaw omits configured
    overrides for those fields.

    Other Moonshot Kimi models support binary native thinking:

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

    OpenClaw maps runtime `/think` levels for those models:

    | `/think` level       | Moonshot behavior          |
    | -------------------- | -------------------------- |
    | `/think off`         | `thinking.type=disabled`   |
    | Any non-off level    | `thinking.type=enabled`    |

    <Warning>
    When Moonshot K2 thinking is enabled, `tool_choice` must be `auto` or `none`. A pinned tool choice (`type: "tool"` or `type: "function"`) forces thinking back to `disabled` instead, so the requested tool still runs; `tool_choice: "required"` is normalized to `auto` instead. Kimi K2.7 Code cannot disable thinking, so its incompatible `tool_choice` is normalized to `auto`. Kimi K3 uses its separate reasoning-effort contract and preserves supported tool choices.
    </Warning>

    Kimi K2.6 also accepts an optional `thinking.keep` field that controls
    multi-turn retention of `reasoning_content`. Set it to `"all"` to keep full
    reasoning across turns; omit it (or leave it `null`) to use the server
    default strategy. OpenClaw only forwards `thinking.keep` for
    `moonshot/kimi-k2.6` and strips it from other models. Kimi K2.7 Code
    preserves full reasoning history by default while OpenClaw omits the entire
    `thinking` field.

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
    Moonshot Kimi serves native tool_call ids shaped like `functions.<name>:<index>`. OpenClaw preserves the first occurrence of each native Kimi id and rewrites later duplicates to deterministic OpenAI-style `call_*` ids. Matching tool results are remapped with the same id so replay remains unique without stripping Kimi's first native id. This behavior is wired into the bundled Moonshot provider and is not a user-configurable setting.
  </Accordion>

  <Accordion title="Streaming usage compatibility">
    Native Moonshot endpoints (`https://api.moonshot.ai/v1` and
    `https://api.moonshot.cn/v1`) advertise streaming usage compatibility.
    OpenClaw keys this off the endpoint host, not the provider id, so a custom
    provider id pointed at the same native Moonshot host inherits the same
    streaming-usage behavior.

    With the catalog K3 pricing, streamed usage that includes input, output,
    and cache-read tokens is also converted into local estimated USD cost for
    `/status`, `/usage full`, `/usage cost`, and transcript-backed session
    accounting.

  </Accordion>

  <Accordion title="Endpoint and model ref reference">
    | Provider   | Model ref prefix | Endpoint                      | Auth env var        |
    | ---------- | ---------------- | ------------------------------ | ------------------- |
    | Moonshot   | `moonshot/`      | `https://api.moonshot.ai/v1`  | `MOONSHOT_API_KEY`  |
    | Moonshot CN| `moonshot/`      | `https://api.moonshot.cn/v1`  | `MOONSHOT_API_KEY`  |
    | Kimi Coding| `kimi/`          | Kimi Coding endpoint           | `KIMI_API_KEY`      |
    | Web search | N/A              | Same as Moonshot API region    | `KIMI_API_KEY` or `MOONSHOT_API_KEY` |

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
