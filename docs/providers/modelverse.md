---
summary: "Use Modelverse (UCloud) as an OpenAI-compatible model provider in Clawdbot"
read_when:
  - You want to use Modelverse models in Clawdbot
  - You need the base URL, API key setup, and model refs for Modelverse
---
# Modelverse

Modelverse (UCloud) exposes an **OpenAI-compatible** API that can route to multiple model families.

## Authenticate

Get an API key:
https://console.ucloud-global.com/modelverse/experience/api-keys

Then run:

```bash
clawdbot onboard --auth-choice modelverse-api-key
```

This stores the key in Clawdbot's auth profiles and writes a `models.providers.modelverse` entry.

## Model refs

Use `modelverse/<modelId>`:

- `modelverse/gpt-5.2`
- `modelverse/claude-opus-4-5-20251101`
- `modelverse/claude-sonnet-4-5-20250929`
- `modelverse/deepseek-ai/DeepSeek-V3.2`
- `modelverse/deepseek-ai/DeepSeek-R1`
- `modelverse/deepseek-ai/DeepSeek-V3-0324`
- `modelverse/openai/gpt-4o`
- `modelverse/zai-org/glm-4.7`
- `modelverse/gemini-3-flash-preview`
- `modelverse/gemini-3-pro-preview`
- `modelverse/gemini-2.5-flash`
- `modelverse/gemini-2.5-pro`

Switch models with:

```bash
clawdbot models set modelverse/gpt-5.2
```

## Config snippet (manual)

```json5
{
  env: { MODELVERSE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "modelverse/gpt-5.2" } } },
  models: {
    mode: "merge",
    providers: {
      modelverse: {
        baseUrl: "https://api.modelverse.cn/v1",
        apiKey: "${MODELVERSE_API_KEY}",
        api: "openai-completions",
        models: [{ id: "gpt-5.2", name: "GPT-5.2" }]
      }
    }
  }
}
```

