---
summary: "Use Mistral models and Voxtral transcription with OpenClaw"
read_when:
  - You want to use Mistral models in OpenClaw
  - You want Voxtral realtime transcription for Voice Call
  - You need Mistral API key onboarding and model refs
title: "Mistral"
---

OpenClaw includes a bundled Mistral plugin that registers four contracts: chat completions, media understanding (Voxtral batch transcription), realtime STT for Voice Call (Voxtral Realtime), and memory embeddings (`mistral-embed`).

| Property         | Value                                       |
| ---------------- | ------------------------------------------- |
| Provider id      | `mistral`                                   |
| Plugin           | bundled, `enabledByDefault: true`           |
| Auth env var     | `MISTRAL_API_KEY`                           |
| Onboarding flag  | `--auth-choice mistral-api-key`             |
| Direct CLI flag  | `--mistral-api-key <key>`                   |
| API              | OpenAI-compatible (`openai-completions`)    |
| Base URL         | `https://api.mistral.ai/v1`                 |
| Default model    | `mistral/mistral-large-latest`              |
| Embedding model  | `mistral-embed`                             |
| Voxtral batch    | `voxtral-mini-latest` (audio transcription) |
| Voxtral realtime | `voxtral-mini-transcribe-realtime-2602`     |

## Getting started

<Steps>
  <Step title="Get your API key">
    Create an API key in the [Mistral Console](https://console.mistral.ai/).
  </Step>
  <Step title="Run onboarding">
    ```bash
    openclaw onboard --auth-choice mistral-api-key
    ```

    Or pass the key directly:

    ```bash
    openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
    ```

  </Step>
  <Step title="Set a default model">
    ```json5
    {
      env: { MISTRAL_API_KEY: "sk-..." },
      agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
    }
    ```
  </Step>
  <Step title="Verify the model is available">
    ```bash
    openclaw models list --provider mistral
    ```
  </Step>
</Steps>

## Built-in LLM catalog

[Mistral Medium 3.5](https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04)
is the current blended Medium model in the bundled catalog: 128B dense weights,
text and image input, 256K context, function calling, structured output, coding,
and adjustable reasoning through the Chat Completions API. Use
`mistral/mistral-medium-3-5` when you want Mistral's newer unified
agentic/coding model instead of the default `mistral/mistral-large-latest`.

OpenClaw currently ships this bundled Mistral catalog:

| Model ref                        | Input       | Context | Max output | Notes                                                            |
| -------------------------------- | ----------- | ------- | ---------- | ---------------------------------------------------------------- |
| `mistral/mistral-large-latest`   | text, image | 262,144 | 16,384     | Default model                                                    |
| `mistral/mistral-medium-2508`    | text, image | 262,144 | 8,192      | Mistral Medium 3.1                                               |
| `mistral/mistral-medium-3-5`     | text, image | 262,144 | 8,192      | Mistral Medium 3.5; adjustable reasoning                         |
| `mistral/mistral-small-latest`   | text, image | 128,000 | 16,384     | Mistral Small 4; adjustable reasoning via API `reasoning_effort` |
| `mistral/pixtral-large-latest`   | text, image | 128,000 | 32,768     | Pixtral                                                          |
| `mistral/codestral-latest`       | text        | 256,000 | 4,096      | Coding                                                           |
| `mistral/devstral-medium-latest` | text        | 262,144 | 32,768     | Devstral 2                                                       |
| `mistral/magistral-small`        | text        | 128,000 | 40,000     | Reasoning-enabled                                                |

After onboarding, smoke-test Medium 3.5 without starting the Gateway:

```bash
openclaw infer model run --local \
  --model mistral/mistral-medium-3-5 \
  --prompt "Reply with exactly: mistral-ok" \
  --json
```

To browse the bundled catalog row before changing config:

```bash
openclaw models list --all --provider mistral --plain
```

## Audio transcription (Voxtral)

Use Voxtral for batch audio transcription through the media understanding
pipeline.

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

<Tip>
The media transcription path uses `/v1/audio/transcriptions`. The default audio model for Mistral is `voxtral-mini-latest`.
</Tip>

## Voice Call streaming STT

The bundled `mistral` plugin registers Voxtral Realtime as a Voice Call
streaming STT provider.

| Setting      | Config path                                                            | Default                                 |
| ------------ | ---------------------------------------------------------------------- | --------------------------------------- |
| API key      | `plugins.entries.voice-call.config.streaming.providers.mistral.apiKey` | Falls back to `MISTRAL_API_KEY`         |
| Model        | `...mistral.model`                                                     | `voxtral-mini-transcribe-realtime-2602` |
| Encoding     | `...mistral.encoding`                                                  | `pcm_mulaw`                             |
| Sample rate  | `...mistral.sampleRate`                                                | `8000`                                  |
| Target delay | `...mistral.targetStreamingDelayMs`                                    | `800`                                   |

```json5
{
  plugins: {
    entries: {
      "voice-call": {
        config: {
          streaming: {
            enabled: true,
            provider: "mistral",
            providers: {
              mistral: {
                apiKey: "${MISTRAL_API_KEY}",
                targetStreamingDelayMs: 800,
              },
            },
          },
        },
      },
    },
  },
}
```

<Note>
OpenClaw defaults Mistral realtime STT to `pcm_mulaw` at 8 kHz so Voice Call
can forward Twilio media frames directly. Use `encoding: "pcm_s16le"` and a
matching `sampleRate` only if your upstream stream is already raw PCM.
</Note>

## Advanced configuration

<AccordionGroup>
  <Accordion title="Adjustable reasoning">
    `mistral/mistral-small-latest` (Mistral Small 4) and `mistral/mistral-medium-3-5` support [adjustable reasoning](https://docs.mistral.ai/studio-api/conversations/reasoning/adjustable) on the Chat Completions API via `reasoning_effort` (`none` minimizes extra thinking in the output; `high` surfaces full thinking traces before the final answer). Mistral recommends `reasoning_effort="high"` for Medium 3.5 agentic and code use cases.

    OpenClaw maps the session **thinking** level to Mistral's API:

    | OpenClaw thinking level                          | Mistral `reasoning_effort` |
    | ------------------------------------------------ | -------------------------- |
    | **off** / **minimal**                            | `none`                     |
    | **low** / **medium** / **high** / **xhigh** / **adaptive** / **max** | `high`     |

    <Warning>
    Do not combine Medium 3.5 reasoning mode with `temperature: 0`. The Mistral
    HTTP API rejects `reasoning_effort="high"` plus `temperature: 0` with a 400
    response. Leave temperature unset so Mistral uses its default, or follow
    the [Medium 3.5 recommended settings](https://huggingface.co/mistralai/Mistral-Medium-3.5-128B)
    and use `temperature: 0.7` for high reasoning. For deterministic direct
    answers, turn thinking off/minimal so OpenClaw sends
    `reasoning_effort: "none"` before you lower temperature.
    </Warning>

    Example model-scoped config for Medium 3.5 reasoning:

    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "mistral/mistral-medium-3-5" },
          models: {
            "mistral/mistral-medium-3-5": {
              params: { thinking: "high" },
            },
          },
        },
      },
    }
    ```

    <Note>
    Other bundled Mistral catalog models do not use this parameter. Keep using `magistral-*` models when you want Mistral's native reasoning-first behavior.
    </Note>

  </Accordion>

  <Accordion title="Memory embeddings">
    Mistral can serve memory embeddings via `/v1/embeddings` (default model: `mistral-embed`).

    ```json5
    {
      memorySearch: { provider: "mistral" },
    }
    ```

  </Accordion>

  <Accordion title="Auth and base URL">
    - Mistral auth uses `MISTRAL_API_KEY` (Bearer header).
    - Provider base URL defaults to `https://api.mistral.ai/v1` and accepts the standard OpenAI-compatible chat-completions request shape.
    - Onboarding default model is `mistral/mistral-large-latest`.
    - Override the base URL under `models.providers.mistral.baseUrl` only when Mistral explicitly publishes a regional endpoint you need.

  </Accordion>
</AccordionGroup>

## Related

<CardGroup cols={2}>
  <Card title="Model selection" href="/concepts/model-providers" icon="layers">
    Choosing providers, model refs, and failover behavior.
  </Card>
  <Card title="Media understanding" href="/nodes/media-understanding" icon="microphone">
    Audio transcription setup and provider selection.
  </Card>
</CardGroup>
