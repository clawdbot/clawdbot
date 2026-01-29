---
summary: "Use Cerebras ultra-fast inference for LLaMA, Qwen, GLM models via OpenAI-compatible API"
read_when:
  - You want to use Cerebras inference
  - You need ultra-fast model responses
---
# Cerebras

Cerebras provides **ultra-fast inference** using their custom AI accelerator chips, delivering industry-leading speed for popular open-source models through an OpenAI-compatible API.

## CLI setup

```bash
clawdbot onboard --auth-choice cerebras-api-key
# or non-interactive
clawdbot onboard --cerebras-api-key "$CEREBRAS_API_KEY"
```

## Config snippet

```json5
{
  env: { CEREBRAS_API_KEY: "csk-..." },
  agents: {
    defaults: {
      model: { primary: "cerebras/llama3.1-8b" }
    }
  }
}
```

## Available models

All models run at FP16 or FP16/FP8 precision:

- `cerebras/llama3.1-8b` - LLaMA 3.1 8B (FP16)
- `cerebras/llama-3.3-70b` - LLaMA 3.3 70B (FP16)
- `cerebras/gpt-oss-120b` - GPT OSS 120B (FP16/FP8)
- `cerebras/qwen-3-32b` - Qwen 3 32B (FP16)
- `cerebras/qwen-3-235b-a22b-instruct-2507` - Qwen 3 235B (FP16/FP8)
- `cerebras/zai-glm-4.7` - GLM 4.7 (FP16/FP8)

## Notes

- Base URL: `https://api.cerebras.ai/v1`
- OpenAI-compatible API (drop-in replacement)
- Model refs use `cerebras/<model>` format
- Get API key at: https://cloud.cerebras.ai/
- For more model options, see [/concepts/model-providers](/concepts/model-providers)
