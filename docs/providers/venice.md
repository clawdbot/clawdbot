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

| Mode           | Behavior                                                         | Models                                                        |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| **Private**    | Prompts/responses are never stored or logged. Ephemeral.         | Llama, Qwen, DeepSeek, Kimi, MiniMax, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped before forwarding. | Claude, GPT, Gemini, Grok                                     |

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
    openclaw agent --model venice/kimi-k2-5 --message "Hello, are you working?"
    ```
  </Step>
</Steps>

## Model selection

- **Default**: `venice/kimi-k2-5` (private, reasoning, vision).
- **Strongest anonymized option**: `venice/claude-opus-4-6`.

```bash
openclaw models set venice/kimi-k2-5
openclaw models list --all --provider venice
```

You can also run `openclaw configure` and pick **Model/auth provider > Venice AI**.

<Tip>
| Use case              | Model                                        | Why                                    |
| --------------------- | -------------------------------------------- | -------------------------------------- |
| General chat (default) | `kimi-k2-5`                                  | Strong private reasoning plus vision   |
| Best overall quality   | `claude-opus-4-6`                            | Strongest anonymized Venice option     |
| Privacy + coding       | `qwen3-coder-480b-a35b-instruct-turbo`       | Private coding model with large context |
| Fast + cheap           | `llama-3.2-3b`                               | Compact private model                  |
| Complex private tasks  | `deepseek-v3.2`                              | Strong reasoning; tool calling disabled |
| Uncensored             | `venice-uncensored-1-2`                      | Current uncensored Venice model        |
</Tip>

## Built-in catalog (30 models)

<AccordionGroup>
  <Accordion title="Private models (20) — fully private, no logging">
    | Model ID                               | Name                                 | Context | Notes                      |
    | -------------------------------------- | ------------------------------------- | ------- | --------------------------- |
    | `kimi-k2-5`                            | Kimi K2.5                             | 256k    | Default, reasoning, vision  |
    | `llama-3.3-70b`                        | Llama 3.3 70B                         | 128k    | General                     |
    | `llama-3.2-3b`                         | Llama 3.2 3B                          | 128k    | General                     |
    | `hermes-3-llama-3.1-405b`              | Hermes 3 Llama 3.1 405B               | 128k    | General, tools disabled     |
    | `qwen3-235b-a22b-thinking-2507`        | Qwen3 235B Thinking                   | 128k    | Reasoning                   |
    | `qwen3-235b-a22b-instruct-2507`        | Qwen3 235B Instruct                   | 128k    | General                     |
    | `qwen3-coder-480b-a35b-instruct-turbo` | Qwen3 Coder 480B Turbo                | 256k    | Coding                      |
    | `qwen3-5-35b-a3b`                      | Qwen3.5 35B A3B                       | 256k    | Reasoning, vision           |
    | `qwen3-next-80b`                       | Qwen3 Next 80B                        | 256k    | General                     |
    | `qwen3-vl-235b-a22b`                   | Qwen3 VL 235B (Vision)                | 256k    | Vision                      |
    | `deepseek-v3.2`                        | DeepSeek V3.2                         | 160k    | Reasoning, tools disabled    |
    | `google-gemma-3-27b-it`                | Google Gemma 3 27B Instruct           | 198k    | Vision                       |
    | `openai-gpt-oss-120b`                  | OpenAI GPT OSS 120B                   | 128k    | General                      |
    | `nvidia-nemotron-3-nano-30b-a3b`       | NVIDIA Nemotron 3 Nano 30B            | 128k    | General                      |
    | `olafangensan-glm-4.7-flash-heretic`   | GLM 4.7 Flash Heretic                 | 128k    | Reasoning                    |
    | `zai-org-glm-4.6`                      | GLM 4.6                               | 198k    | General                      |
    | `zai-org-glm-4.7`                      | GLM 4.7                               | 198k    | Reasoning                    |
    | `zai-org-glm-4.7-flash`                | GLM 4.7 Flash                         | 128k    | Reasoning                    |
    | `zai-org-glm-5`                        | GLM 5                                 | 198k    | Reasoning                    |
    | `minimax-m25`                          | MiniMax M2.5                          | 198k    | Reasoning                    |
  </Accordion>

  <Accordion title="Anonymized models (10) — via Venice proxy">
    | Model ID                        | Name                           | Context | Notes                      |
    | -------------------------------- | -------------------------------- | ------- | ---------------------------- |
    | `claude-opus-4-6`               | Claude Opus 4.6 (via Venice)    | 1M      | Reasoning, vision            |
    | `claude-sonnet-4-6`             | Claude Sonnet 4.6 (via Venice)  | 1M      | Reasoning, vision            |
    | `openai-gpt-54`                 | GPT-5.4 (via Venice)            | 1M      | Reasoning, vision            |
    | `openai-gpt-53-codex`           | GPT-5.3 Codex (via Venice)      | 400k    | Reasoning, vision, coding     |
    | `openai-gpt-52`                 | GPT-5.2 (via Venice)            | 256k    | Reasoning                    |
    | `openai-gpt-52-codex`           | GPT-5.2 Codex (via Venice)      | 256k    | Reasoning, vision, coding     |
    | `openai-gpt-4o-2024-11-20`      | GPT-4o (via Venice)             | 128k    | Vision                        |
    | `openai-gpt-4o-mini-2024-07-18` | GPT-4o Mini (via Venice)        | 128k    | Vision                        |
    | `gemini-3-1-pro-preview`        | Gemini 3.1 Pro (via Venice)     | 1M      | Reasoning, vision             |
    | `gemini-3-flash-preview`        | Gemini 3 Flash (via Venice)     | 256k    | Reasoning, vision             |
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

| Feature          | Support                                           |
| ---------------- | ------------------------------------------------- |
| Streaming        | All models                                        |
| Function calling | Most models; disabled per-model where noted above |
| Vision/Images    | Models marked "Vision" above                      |
| JSON mode        | Via `response_format`                             |

## Pricing

Venice uses a credit-based system. Anonymized models cost roughly the same as
direct API pricing plus a small Venice fee. See
[venice.ai/pricing](https://venice.ai/pricing) for current rates.

## Usage examples

```bash
# Default private model
openclaw agent --model venice/kimi-k2-5 --message "Quick health check"

# Claude Opus via Venice (anonymized)
openclaw agent --model venice/claude-opus-4-6 --message "Summarize this task"

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
