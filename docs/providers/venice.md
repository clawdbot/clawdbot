---
summary: "Use Venice AI privacy-focused models in OpenClaw"
read_when:
  - You want privacy-focused inference in OpenClaw
  - You want Venice AI setup guidance
title: "Venice AI"
---

Venice AI provides **privacy-focused AI inference** with support for uncensored models and access to major proprietary models through their anonymized proxy. All inference is private by default — no training on your data, no logging.

## Why Venice in OpenClaw

- **Private inference** for open-source models (no logging).
- **Uncensored models** when you need them.
- **Anonymized access** to proprietary models (Opus/GPT/Gemini) when quality matters.
- OpenAI-compatible `/v1` endpoints.

## Privacy modes

Venice offers two privacy levels — understanding this is key to choosing your model:

| Mode           | Description                                                                                                                       | Models                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Private**    | Fully private. Prompts/responses are **never stored or logged**. Ephemeral.                                                       | Llama, Qwen, DeepSeek, Kimi, MiniMax, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic, Google, xAI) sees anonymized requests. | Claude, GPT, Gemini, Grok                                     |

<Warning>
Anonymized models are **not** fully private. Venice strips metadata before forwarding, but the underlying provider (OpenAI, Anthropic, Google, xAI) still processes the request. Choose **Private** models when full privacy is required.
</Warning>

## Features

- **Privacy-focused**: Choose between "private" (fully private) and "anonymized" (proxied) modes
- **Uncensored models**: Access to models without content restrictions
- **Major model access**: Use Claude, GPT, Gemini, and Grok via Venice's anonymized proxy
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: Supported on all models
- **Function calling**: Supported on select models (check model capabilities)
- **Vision**: Supported on models with vision capability
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Getting started

<Steps>
  <Step title="Get your API key">
    1. Sign up at [venice.ai](https://venice.ai)
    2. Go to **Settings > API Keys > Create new key**
    3. Copy your API key (format: `vapi_xxxxxxxxxxxx`)
  </Step>
  <Step title="Configure OpenClaw">
    Choose your preferred setup method:

    <Tabs>
      <Tab title="Interactive (recommended)">
        ```bash
        openclaw onboard --auth-choice venice-api-key
        ```

        This will:
        1. Prompt for your API key (or use existing `VENICE_API_KEY`)
        2. Show all available Venice models
        3. Let you pick your default model
        4. Configure the provider automatically
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
    openclaw agent --model venice/kimi-k2-5 --message "Hello, are you working?"
    ```
  </Step>
</Steps>

## Model selection

After setup, OpenClaw shows all available Venice models. Pick based on your needs:

- **Default model**: `venice/kimi-k2-5` for strong private reasoning plus vision.
- **High-capability option**: `venice/claude-opus-4-6` for the strongest anonymized Venice path.
- **Privacy**: Choose "private" models for fully private inference.
- **Capability**: Choose "anonymized" models to access Claude, GPT, Gemini via Venice's proxy.

Change your default model anytime:

```bash
openclaw models set venice/kimi-k2-5
openclaw models set venice/claude-opus-4-6
```

List all available models:

```bash
openclaw models list | grep venice
```

You can also run `openclaw configure`, select **Model/auth**, and choose **Venice AI**.

<Tip>
Use the table below to pick the right model for your use case.

| Use Case                   | Recommended Model                | Why                                          |
| -------------------------- | -------------------------------- | -------------------------------------------- |
| **General chat (default)** | `kimi-k2-5`                      | Strong private reasoning plus vision         |
| **Best overall quality**   | `claude-opus-4-6`                | Strongest anonymized Venice option           |
| **Privacy + coding**       | `qwen3-coder-480b-a35b-instruct` | Private coding model with large context      |
| **Private vision**         | `kimi-k2-5`                      | Vision support without leaving private mode  |
| **Fast + cheap**           | `qwen3-4b`                       | Lightweight reasoning model                  |
| **Complex private tasks**  | `deepseek-v3.2`                  | Strong reasoning, but no Venice tool support |
| **Uncensored**             | `venice-uncensored`              | No content restrictions                      |

</Tip>

## DeepSeek V4 replay behavior

If Venice exposes DeepSeek V4 models such as `venice/deepseek-v4-pro` or
`venice/deepseek-v4-flash`, OpenClaw fills the required DeepSeek V4
`reasoning_content` replay placeholder on assistant messages when the proxy
omits it. Venice rejects DeepSeek's native top-level `thinking` control, so
OpenClaw keeps that provider-specific replay fix separate from the native
DeepSeek provider's thinking controls.

## Built-in catalog (41 total)

<AccordionGroup>
  <Accordion title="Private models (26) — fully private, no logging">
    | Model ID                               | Name                                | Context | Features                   |
    | -------------------------------------- | ----------------------------------- | ------- | -------------------------- |
    | `kimi-k2-5`                            | Kimi K2.5                           | 256k    | Default, reasoning, vision |
    | `kimi-k2-thinking`                     | Kimi K2 Thinking                    | 256k    | Reasoning                  |
    | `llama-3.3-70b`                        | Llama 3.3 70B                       | 128k    | General                    |
    | `llama-3.2-3b`                         | Llama 3.2 3B                        | 128k    | General                    |
    | `hermes-3-llama-3.1-405b`              | Hermes 3 Llama 3.1 405B            | 128k    | General, tools disabled    |
    | `qwen3-235b-a22b-thinking-2507`        | Qwen3 235B Thinking                | 128k    | Reasoning                  |
    | `qwen3-235b-a22b-instruct-2507`        | Qwen3 235B Instruct                | 128k    | General                    |
    | `qwen3-coder-480b-a35b-instruct`       | Qwen3 Coder 480B                   | 256k    | Coding                     |
    | `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo             | 256k    | Coding                     |
    | `qwen3-5-35b-a3b`                      | Qwen3.5 35B A3B                    | 256k    | Reasoning, vision          |
    | `qwen3-next-80b`                       | Qwen3 Next 80B                     | 256k    | General                    |
    | `qwen3-vl-235b-a22b`                   | Qwen3 VL 235B (Vision)             | 256k    | Vision                     |
    | `qwen3-4b`                             | Venice Small (Qwen3 4B)            | 32k     | Fast, reasoning            |
    | `deepseek-v3.2`                        | DeepSeek V3.2                      | 160k    | Reasoning, tools disabled  |
    | `venice-uncensored`                    | Venice Uncensored (Dolphin-Mistral) | 32k     | Uncensored, tools disabled |
    | `mistral-31-24b`                       | Venice Medium (Mistral)            | 128k    | Vision                     |
    | `google-gemma-3-27b-it`                | Google Gemma 3 27B Instruct        | 198k    | Vision                     |
    | `openai-gpt-oss-120b`                  | OpenAI GPT OSS 120B               | 128k    | General                    |
    | `nvidia-nemotron-3-nano-30b-a3b`       | NVIDIA Nemotron 3 Nano 30B         | 128k    | General                    |
    | `olafangensan-glm-4.7-flash-heretic`   | GLM 4.7 Flash Heretic              | 128k    | Reasoning                  |
    | `zai-org-glm-4.6`                      | GLM 4.6                            | 198k    | General                    |
    | `zai-org-glm-4.7`                      | GLM 4.7                            | 198k    | Reasoning                  |
    | `zai-org-glm-4.7-flash`                | GLM 4.7 Flash                      | 128k    | Reasoning                  |
    | `zai-org-glm-5`                        | GLM 5                              | 198k    | Reasoning                  |
    | `minimax-m21`                          | MiniMax M2.1                       | 198k    | Reasoning                  |
    | `minimax-m25`                          | MiniMax M2.5                       | 198k    | Reasoning                  |
  </Accordion>

  <Accordion title="Anonymized models (15) — via Venice proxy">
    | Model ID                        | Name                           | Context | Features                  |
    | ------------------------------- | ------------------------------ | ------- | ------------------------- |
    | `claude-opus-4-6`               | Claude Opus 4.6 (via Venice)   | 1M      | Reasoning, vision         |
    | `claude-opus-4-5`               | Claude Opus 4.5 (via Venice)   | 198k    | Reasoning, vision         |
    | `claude-sonnet-4-6`             | Claude Sonnet 4.6 (via Venice) | 1M      | Reasoning, vision         |
    | `claude-sonnet-4-5`             | Claude Sonnet 4.5 (via Venice) | 198k    | Reasoning, vision         |
    | `openai-gpt-54`                 | GPT-5.4 (via Venice)           | 1M      | Reasoning, vision         |
    | `openai-gpt-53-codex`           | GPT-5.3 Codex (via Venice)     | 400k    | Reasoning, vision, coding |
    | `openai-gpt-52`                 | GPT-5.2 (via Venice)           | 256k    | Reasoning                 |
    | `openai-gpt-52-codex`           | GPT-5.2 Codex (via Venice)     | 256k    | Reasoning, vision, coding |
    | `openai-gpt-4o-2024-11-20`      | GPT-4o (via Venice)            | 128k    | Vision                    |
    | `openai-gpt-4o-mini-2024-07-18` | GPT-4o Mini (via Venice)       | 128k    | Vision                    |
    | `gemini-3-1-pro-preview`        | Gemini 3.1 Pro (via Venice)    | 1M      | Reasoning, vision         |
    | `gemini-3-pro-preview`          | Gemini 3 Pro (via Venice)      | 198k    | Reasoning, vision         |
    | `gemini-3-flash-preview`        | Gemini 3 Flash (via Venice)    | 256k    | Reasoning, vision         |
    | `grok-41-fast`                  | Grok 4.1 Fast (via Venice)     | 1M      | Reasoning, vision         |
    | `grok-code-fast-1`              | Grok Code Fast 1 (via Venice)  | 256k    | Reasoning, coding         |
  </Accordion>
</AccordionGroup>

## Model discovery

OpenClaw automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

The `/models` endpoint is public (no auth needed for listing), but inference requires a valid API key.

## Streaming and tool support

| Feature              | Support                                              |
| -------------------- | ---------------------------------------------------- |
| **Streaming**        | All models                                           |
| **Function calling** | Most models (check `supportsFunctionCalling` in API) |
| **Vision/Images**    | Models marked with "Vision" feature                  |
| **JSON mode**        | Supported via `response_format`                      |

## Pricing

Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:

- **Private models**: Generally lower cost
- **Anonymized models**: Similar to direct API pricing + small Venice fee

### Venice (anonymized) vs direct API

| Aspect       | Venice (Anonymized)           | Direct API          |
| ------------ | ----------------------------- | ------------------- |
| **Privacy**  | Metadata stripped, anonymized | Your account linked |
| **Latency**  | +10-50ms (proxy)              | Direct              |
| **Features** | Most features supported       | Full features       |
| **Billing**  | Venice credits                | Provider billing    |

## Usage examples

```bash
# Use the default private model
openclaw agent --model venice/kimi-k2-5 --message "Quick health check"

# Use Claude Opus via Venice (anonymized)
openclaw agent --model venice/claude-opus-4-6 --message "Summarize this task"

# Use uncensored model
openclaw agent --model venice/venice-uncensored --message "Draft options"

# Use vision model with image
openclaw agent --model venice/qwen3-vl-235b-a22b --message "Review attached image"

# Use coding model
openclaw agent --model venice/qwen3-coder-480b-a35b-instruct --message "Refactor this function"
```

## Troubleshooting

<AccordionGroup>
  <Accordion title="API key not recognized">
    ```bash
    echo $VENICE_API_KEY
    openclaw models list | grep venice
    ```

    Ensure the key starts with `vapi_`.

  </Accordion>

  <Accordion title="Model not available">
    The Venice model catalog updates dynamically. Run `openclaw models list` to see currently available models. Some models may be temporarily offline.
  </Accordion>

  <Accordion title="Connection issues">
    Venice API is at `https://api.venice.ai/api/v1`. Ensure your network allows HTTPS connections.
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
      agents: { defaults: { model: { primary: "venice/kimi-k2-5" } } },
      models: {
        mode: "merge",
        providers: {
          venice: {
            baseUrl: "https://api.venice.ai/api/v1",
            apiKey: "${VENICE_API_KEY}",
            api: "openai-completions",
            models: [
              {
                id: "kimi-k2-5",
                name: "Kimi K2.5",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 256000,
                maxTokens: 65536,
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
