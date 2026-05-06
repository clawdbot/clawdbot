---
summary: "Use DeepInfra's unified API to access the most popular open source and frontier models in OpenClaw"
read_when:
  - You want a single API key for the top open source LLMs
  - You want to run models via DeepInfra's API in OpenClaw
title: "DeepInfra"
---

DeepInfra provides a **unified API** that routes requests to the most popular open source and frontier models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting an API key

1. Go to [https://deepinfra.com/](https://deepinfra.com/)
2. Sign in or create an account
3. Navigate to Dashboard / Keys and generate a new API key or use the auto created one

## CLI setup

```bash
openclaw onboard --deepinfra-api-key <key>
```

Or set the environment variable:

```bash
export DEEPINFRA_API_KEY="<your-deepinfra-api-key>" # pragma: allowlist secret
```

## Config snippet

```json5
{
  env: { DEEPINFRA_API_KEY: "<your-deepinfra-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "deepinfra/deepseek-ai/DeepSeek-V3.2" },
    },
  },
}
```

## Supported OpenClaw surfaces

The bundled plugin registers all DeepInfra surfaces that match current
OpenClaw provider contracts:

| Surface                  | Default model                      | OpenClaw config/tool                                     |
| ------------------------ | ---------------------------------- | -------------------------------------------------------- |
| Chat / model provider    | `deepseek-ai/DeepSeek-V3.2`        | `agents.defaults.model`                                  |
| Image generation/editing | `black-forest-labs/FLUX-1-schnell` | `image_generate`, `agents.defaults.imageGenerationModel` |
| Media understanding      | `moonshotai/Kimi-K2.5` for images  | inbound image understanding                              |
| Speech-to-text           | `openai/whisper-large-v3-turbo`    | inbound audio transcription                              |
| Text-to-speech           | `hexgrad/Kokoro-82M`               | `messages.tts.provider: "deepinfra"`                     |
| Video generation         | `Pixverse/Pixverse-T2V`            | `video_generate`, `agents.defaults.videoGenerationModel` |
| Memory embeddings        | `BAAI/bge-m3`                      | `agents.defaults.memorySearch.provider: "deepinfra"`     |

DeepInfra also exposes reranking, classification, object-detection, and other
native model types. OpenClaw does not currently have first-class provider
contracts for those categories, so this plugin does not register them yet.

## Available models

OpenClaw dynamically discovers available DeepInfra models at startup. Use
`/models deepinfra` to see the full list of models available.

Any model available on [DeepInfra.com](https://deepinfra.com/) can be used with the `deepinfra/` prefix:

```
deepinfra/MiniMaxAI/MiniMax-M2.5
deepinfra/deepseek-ai/DeepSeek-V3.2
deepinfra/moonshotai/Kimi-K2.5
deepinfra/zai-org/GLM-5.1
...and many more
```

## Notes

- Model refs are `deepinfra/<provider>/<model>` (e.g., `deepinfra/Qwen/Qwen3-Max`).
- Default model: `deepinfra/deepseek-ai/DeepSeek-V3.2`
- Base URL: `https://api.deepinfra.com/v1/openai`
- Native video generation uses `https://api.deepinfra.com/v1/inference/<model>`.

## Related

- [Model providers](/concepts/model-providers)
- [All providers](/providers/index)
