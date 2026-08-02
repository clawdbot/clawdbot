---
summary: "Use Venice AI privacy-focused models in OpenClaw"
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want Venice AI setup guidance
title: "Venice AI"
---

[Venice AI](https://venice.ai) provides privacy-focused inference: open models run
with no logging, plus anonymized proxy access to Claude, GPT, Gemini, and Grok.
All endpoints are OpenAI-compatible (`/v1`).

## Privacy modes

| Mode           | Behavior                                                         | Models                                                          |
| -------------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| **Private**    | Prompts/responses are never stored or logged. Ephemeral.         | GLM, Gemma, Grok, Qwen, DeepSeek, Kimi, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped before forwarding. | Claude, GPT, and selected Qwen models                           |

<Warning>
Anonymized models are not fully private. Venice strips metadata before forwarding, but the underlying provider (OpenAI, Anthropic, Google, xAI) still processes the request. Use Private models when full privacy is required.
</Warning>

## Getting started

<Steps>
  <Step title="Install the plugin">
    ```bash
    openclaw plugins install @openclaw/venice-provider
    ```
  </Step>
  <Step title="Get your API key">
    1. Sign up at [venice.ai](https://venice.ai)
    2. Go to **Settings > API Keys > Create new key**
    3. Copy your API key (format: `vapi_xxxxxxxxxxxx`)
  </Step>
  <Step title="Configure OpenClaw">
    <Tabs>
      <Tab title="Interactive (recommended)">
        ```bash
        openclaw onboard --auth-choice venice-api-key
        ```

        Prompts for the API key (or reuses an existing `VENICE_API_KEY`), lists available Venice models, and sets your default model.
      </Tab>
      <Tab title="Environment variable">
        ```bash
        export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
        ```
      </Tab>
      <Tab title="Non-interactive">
        ```bash
        openclaw onboard --non-interactive \
          --auth-choice venice-api-key \
          --venice-api-key "vapi_xxxxxxxxxxxx"
        ```
      </Tab>
    </Tabs>

  </Step>
  <Step title="Verify setup">
    ```bash
    openclaw agent --model venice/zai-org-glm-4.7 --message "Hello, are you working?"
    ```
  </Step>
</Steps>

## Model selection

- **Default**: `venice/zai-org-glm-4.7` (private reasoning).
- **Strongest anonymized option**: `venice/claude-opus-5`.

```bash
openclaw models set venice/zai-org-glm-4.7
openclaw models list --all --provider venice
```

You can also run `openclaw configure` and pick **Model/auth provider > Venice AI**.

<Tip>
| Use case              | Model                                        | Why                                    |
| --------------------- | -------------------------------------------- | -------------------------------------- |
| General chat (default) | `zai-org-glm-4.7`                             | Venice live default trait              |
| Best overall quality   | `claude-opus-5`                              | Current promoted anonymized Opus model |
| Privacy + coding       | `qwen3-coder-480b-a35b-instruct-turbo`       | Private coding model with large context |
| Fast + cheap           | `google-gemma-4-31b-it`                      | Low-cost promoted private vision model |
| Complex private tasks  | `deepseek-v3.2`                              | Promoted private reasoning model       |
| Uncensored             | `venice-uncensored-1-2`                      | Current uncensored Venice model        |
</Tip>

## Built-in catalog (16 visible models)

<AccordionGroup>
  <Accordion title="Private models (10) — fully private, no logging">
    | Model ID                               | Name                        | Context | Notes                       |
    | -------------------------------------- | --------------------------- | ------- | --------------------------- |
    | `zai-org-glm-5-2`                      | GLM 5.2                     | 1M      | Recommended, coding         |
    | `zai-org-glm-4.7`                      | GLM 4.7                     | 198k    | Private reasoning           |
    | `venice-uncensored-1-2`                | Venice Uncensored 1.2       | 128k    | Most uncensored, vision     |
    | `google-gemma-4-31b-it`                | Google Gemma 4 31B Instruct | 256k    | Recommended, vision         |
    | `kimi-k2-6`                            | Kimi K2.6                   | 256k    | Recommended, coding, vision |
    | `deepseek-v3.2`                        | DeepSeek V3.2               | 160k    | Recommended, reasoning      |
    | `qwen3-235b-a22b-thinking-2507`        | Qwen3 235B Thinking         | 128k    | Default reasoning           |
    | `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo      | 256k    | Default coding              |
    | `qwen3-vl-235b-a22b`                   | Qwen3 VL 235B               | 128k    | Default vision              |
    | `grok-4-5`                             | Grok 4.5                    | 500k    | Recommended, coding, vision |
  </Accordion>

  <Accordion title="Anonymized models (6) — via Venice proxy">
    | Model ID            | Name                             | Context | Notes                       |
    | ------------------- | -------------------------------- | ------- | --------------------------- |
    | `qwen-3-7-max`      | Qwen 3.7 Max (via Venice)        | 1M      | Recommended, coding, vision |
    | `qwen-3-7-plus`     | Qwen 3.7 Plus (via Venice)       | 1M      | Recommended, coding, vision |
    | `claude-fable-5`    | Claude Fable 5 (via Venice)      | 1M      | Recommended, coding, vision |
    | `claude-opus-5`     | Claude Opus 5 (via Venice)       | 1M      | Recommended, coding, vision |
    | `claude-sonnet-4-6` | Claude Sonnet 4.6 (via Venice)   | 1M      | Recommended, coding, vision |
    | `openai-gpt-56-sol` | GPT-5.6 Sol (via Venice)         | 1M      | Recommended, vision         |
  </Accordion>

  <Accordion title="Deprecated compatibility rows (3) — hidden from pickers">
    | Model ID                | Replacement                 |
    | ----------------------- | --------------------------- |
    | `zai-org-glm-4.6`       | `zai-org-glm-4.7`           |
    | `google-gemma-3-27b-it` | `google-gemma-4-31b-it`     |
    | `kimi-k2-5`             | `kimi-k2-6`                 |
  </Accordion>
</AccordionGroup>

Grok-backed Venice models (`grok-4-3` and similar) get the same tool-schema
compat patch as the native xAI provider, since they share the same upstream
tool-call format.

## Model discovery

The bundled catalog above is a manifest-backed seed list. At runtime OpenClaw
refreshes it from the Venice `/models` API and falls back to the seed list if
the API is unreachable. The `/models` endpoint is public (no auth needed for
listing), but inference requires a valid API key.

Venice may continue accepting retired model IDs as provider-owned aliases. The
OpenClaw catalog advertises only the canonical model IDs returned by `/models`.

## DeepSeek V4 replay behavior

If Venice exposes DeepSeek V4 models such as `deepseek-v4-pro` or
`deepseek-v4-flash`, OpenClaw fills the required `reasoning_content` replay
field on assistant messages when Venice omits it, and strips `thinking`/
`reasoning`/`reasoning_effort` from the request payload (Venice rejects
DeepSeek's native `thinking` control on these models). This replay fix is
separate from the native DeepSeek provider's own thinking controls.

## Streaming and tool support

| Feature          | Support                                                |
| ---------------- | ------------------------------------------------------ |
| Streaming        | All models                                             |
| Function calling | All visible seed models; live rows follow API metadata |
| Vision/Images    | Models marked "Vision" above                           |
| JSON mode        | Via `response_format`                                  |

## Pricing

Venice uses a credit-based system. Anonymized models cost roughly the same as
direct API pricing plus a small Venice fee. See
[venice.ai/pricing](https://venice.ai/pricing) for current rates.

## Usage examples

```bash
# Default private model
openclaw agent --model venice/zai-org-glm-4.7 --message "Quick health check"

# Claude Opus via Venice (anonymized)
openclaw agent --model venice/claude-opus-5 --message "Summarize this task"

# Uncensored model
openclaw agent --model venice/venice-uncensored-1-2 --message "Draft options"

# Vision model with image
openclaw agent --model venice/qwen3-vl-235b-a22b --message "Review attached image"

# Coding model
openclaw agent --model venice/qwen3-coder-480b-a35b-instruct-turbo --message "Refactor this function"
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="API key not recognized">
    ```bash
    echo $VENICE_API_KEY
    openclaw models list | grep venice
    ```

    Confirm the key starts with `vapi_`.

  </Accordion>

  <Accordion title="Model not available">
    Run `openclaw models list --all --provider venice` to see currently
    available models; the catalog changes as Venice adds or retires models.
  </Accordion>

  <Accordion title="Connection issues">
    Venice API is at `https://api.venice.ai/api/v1`. Confirm your network allows HTTPS to that host.
  </Accordion>
</AccordionGroup>

<Note>
More help: [Troubleshooting](/help/troubleshooting) and [FAQ](/help/faq).
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Config file example">
    ```json5
    {
      env: { VENICE_API_KEY: "vapi_..." },
      agents: { defaults: { model: { primary: "venice/zai-org-glm-4.7" } } },
      models: {
        mode: "merge",
        providers: {
          venice: {
            baseUrl: "https://api.venice.ai/api/v1",
            apiKey: "${VENICE_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "zai-org-glm-4.7",
                name: "GLM 4.7",
                reasoning: true,
                input: ["text"],
                cost: { input: 0.55, output: 2.65, cacheRead: 0.11, cacheWrite: 0 },
                contextWindow: 198000,
                maxTokens: 16384,
              },
            ],
          },
        },
      },
    }
    ```
  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Venice AI" href="https://venice.ai" icon="globe">
    Venice AI homepage and account signup.
  </Card>
  <Card title="API documentation" href="https://docs.venice.ai" icon="book">
    Venice API reference and developer docs.
  </Card>
  <Card title="Pricing" href="https://venice.ai/pricing" icon="credit-card">
    Current Venice credit rates and plans.
  </Card>
</CardGroup>
