---
summary: "Use Kilo Gateway's unified API to access many models in Moltbot"
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Kilo Gateway in Moltbot
---
# Kilo Gateway

Kilo Gateway provides a **unified API** that routes requests to many models behind a single
endpoint and API key. It is OpenAI-compatible, so most OpenAI SDKs work by switching the base URL.

## Getting an API key

1. Go to [app.kilo.ai](https://app.kilo.ai)
2. Sign in or create an account
3. Navigate to API Keys and generate a new key

## CLI setup

```bash
moltbot onboard --kilocode-api-key <key>
```

Or set the environment variable:

```bash
export KILOCODE_API_KEY="your-api-key"
```

## Config snippet

```json5
{
  env: { KILOCODE_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kilocode/anthropic/claude-opus-4.5" }
    }
  }
}
```

## Notes

- Model refs are `kilocode/<provider>/<model>` (e.g., `kilocode/anthropic/claude-opus-4.5`).
- Default model: `kilocode/anthropic/claude-opus-4.5`
- Base URL: `https://api.kilo.ai/api/openrouter/`
- For more model/provider options, see [/concepts/model-providers](/concepts/model-providers).
- Kilo Gateway uses a Bearer token with your API key under the hood.
