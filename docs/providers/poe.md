---
summary: "Use Poe API to access Claude, GPT, Gemini, Llama, and hundreds of bots"
read_when:
  - You want to use Poe API in Clawdbot
  - You need access to multiple models with one API key
---
# Poe

Poe provides an API at `api.poe.com` that gives access to Claude, GPT, Gemini, Llama, and hundreds of community bots through a single API key.

## Quick start

1. Get an API key from [poe.com/api_key](https://poe.com/api_key)
2. Enable the plugin and authenticate:

```bash
clawdbot plugins enable poe
clawdbot models auth login --provider poe
```

3. Enter your API key when prompted and select a default model.

## CLI setup

```bash
clawdbot onboard --auth-choice apiKey --token-provider poe --token "$POE_API_KEY"
```

## Config snippet

```json5
{
  env: { POE_API_KEY: "..." },
  agents: {
    defaults: {
      model: { primary: "poe/claude-sonnet-4.5" }
    }
  }
}
```

## Available models

| Model ID | Name | Reasoning | Vision | Context |
|----------|------|-----------|--------|---------|
| claude-opus-4.5 | Claude Opus 4.5 | No | Yes | 200K |
| claude-sonnet-4.5 | Claude Sonnet 4.5 | No | Yes | 200K |
| claude-haiku-4.5 | Claude Haiku 4.5 | No | Yes | 200K |
| claude-code | Claude Code | No | Yes | 200K |
| gpt-5.2-codex | GPT-5.2 Codex | No | Yes | 128K |
| gpt-5.1-codex | GPT-5.1 Codex | No | Yes | 128K |
| gpt-5.1-codex-mini | GPT-5.1 Codex Mini | No | Yes | 128K |
| gpt-5.1-codex-max | GPT-5.1 Codex Max | No | Yes | 128K |
| o3-pro | o3 Pro | Yes | Yes | 128K |
| gemini-3-pro | Gemini 3 Pro | No | Yes | 128K |
| gemini-3-flash | Gemini 3 Flash | No | Yes | 128K |
| grok-4 | Grok 4 | No | Yes | 128K |
| deepseek-r1 | DeepSeek R1 | Yes | No | 128K |
| deepseek-v3.2 | DeepSeek V3.2 | No | No | 128K |

Model IDs match the Poe API. Access additional bots by adding them to `models.providers.poe.models`.

## Notes

- Rate limit: 500 requests per minute
- Bot names are case-sensitive (use exact names from poe.com)
- Pricing varies by bot; check poe.com for current rates

## Troubleshooting

**401 Unauthorized**: Your API key may be invalid or expired. Get a new key from [poe.com/api_key](https://poe.com/api_key).

**Model not found**: Verify the bot name is correct and available on your Poe account. Bot names are case-sensitive.
