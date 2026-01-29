---
summary: "Together AI setup (auth + model selection)"
read_when:
  - You want to use Together AI with Moltbot
  - You need the API key env var or CLI auth choice
---
# Together AI


The [Together AI](https://together.ai) provides access to leading open-source models including Llama, DeepSeek, Kimi, and more through a unified API.

- Provider: `together`
- Auth: `TOGETHER_API_KEY`
- API: OpenAI-compatible

## Quick start

1) Set the API key (recommended: store it for the Gateway):

```bash
moltbot onboard --auth-choice together-api-key
```

2) Set a default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "together/zai-org/GLM-4.7" }
    }
  }
}
```

## Non-interactive example

```bash
moltbot onboard --non-interactive \
  --mode local \
  --auth-choice together-api-key \
  --together-api-key "$TOGETHER_API_KEY"
```

This will set `together/zai-org/GLM-4.7` as the default model.

## Environment note

If the Gateway runs as a daemon (launchd/systemd), make sure `TOGETHER_API_KEY`
is available to that process (for example, in `~/.clawdbot/.env` or via
`env.shellEnv`).

## Available models

Together AI provides access to many popular open-source models:

- **GLM 4.7 Fp8** - Default model with 200K context window
- **Llama 3.3 70B Instruct Turbo** - Fast, efficient instruction following
- **Llama 4 Scout** - Vision model with image understanding
- **Llama 4 Maverick** - Advanced vision and reasoning
- **DeepSeek V3.1** - Powerful coding and reasoning model
- **DeepSeek R1** - Advanced reasoning model
- **Kimi K2 Instruct** - High-performance model with 262K context window

All models support standard chat completions and are OpenAI API compatible.