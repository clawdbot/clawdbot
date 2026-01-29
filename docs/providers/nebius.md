---
summary: "Use Nebius OpenAI-compatible inference for GLM and other frontier open models"
read_when:
  - You want to use Nebius inference
  - You need OpenAI-compatible access to GLM models
---
# Nebius

Nebius provides **OpenAI-compatible inference** for frontier and open-source models, including **GLM**, via the Nebius TokenFactory API. This allows seamless drop-in usage with existing OpenAI-style clients and tooling.

## CLI setup

```bash
clawdbot onboard --auth-choice nebius-api-key
# or non-interactive
clawdbot onboard --nebius-api-key "$NEBIUS_API_KEY"

```

## Config snippet

```json5
{
  env: { NEBIUS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "nebius/zai-glm-7",
        fallbacks: ["nebius/zai-glm-5"]
      }
    }
  }
}
```

## Available models

- `zai-org/GLM-4.7-FP8` – GLM 7
- `zai-org/GLM-4.5` – GLM 5

## Notes

- Base URL: https://api.tokenfactory.nebius.com/v1
- OpenAI-compatible Chat Completions API
- Model refs use nebius/<model> format
- Set NEBIUS_API_KEY in the environment or config
- Works with standard OpenAI SDKs (Python, JS, etc.)