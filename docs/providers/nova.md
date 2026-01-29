---
summary: "Use Amazon Nova with Moltbot"
read_when:
  - You want to use Amazon Nova models in Moltbot
  - You need to configure Nova via API key
---
# Amazon Nova

Amazon Nova provides multimodal AI models via an OpenAI-compatible chat completion API. Moltbot supports Nova via API key authentication.

## Available Models

- **Nova 2 Lite** (`nova-2-lite-v1`) - Fast multimodal model, 64K context

## CLI setup

To configure Nova with an API key:

```bash
moltbot onboard --auth-choice nova-api-key
# or non-interactive
moltbot onboard --nova-api-key "$NOVA_API_KEY"
```

Get your API key at: https://nova.amazon.com/dev/api

## Config snippet

```json5
{
  env: { NOVA_API_KEY: "..." },
  agents: { defaults: { model: { primary: "nova/nova-2-lite-v1" } } },
  models: {
    providers: {
      nova: {
        baseUrl: "https://api.nova.amazon.com/v1",
        api: "openai-completions",
        apiKey: "${NOVA_API_KEY}"
      }
    }
  }
}
```

## Notes

- Nova models are available under the `nova/` provider prefix.
- The default model is `nova/nova-2-lite-v1`.
- Nova uses OpenAI-compatible chat completion endpoints.
- Nova 2 Lite supports both text and image inputs.
