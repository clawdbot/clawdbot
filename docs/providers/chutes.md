---
summary: "Use Chutes AI with Clawdbot"
read_when:
  - You want to use Chutes AI models in Clawdbot
  - You need to configure Chutes via OAuth or API key
---
# Chutes AI

Chutes provides high-performance inference for open-weight models, including GLM 4.6 TEE. Clawdbot supports Chutes via both OAuth and API key authentication.

## CLI setup

To configure Chutes with an API key:

```bash
clawdbot onboard --auth-choice chutes-api-key
# or non-interactive
clawdbot onboard --chutes-api-key "$CHUTES_API_KEY"
```

To configure Chutes with OAuth (browser-based):

```bash
clawdbot onboard --auth-choice chutes
```

## Config snippet

```json5
{
  env: { CHUTES_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "chutes/zai-org/GLM-4.6-TEE" } } },
  models: {
    providers: {
      chutes: {
        baseUrl: "https://llm.chutes.ai/v1",
        api: "openai-completions",
        apiKey: "${CHUTES_API_KEY}"
      }
    }
  }
}
```

## Notes

- Chutes models are available under the `chutes/` provider prefix.
- The default model is `chutes/zai-org/GLM-4.6-TEE`.
- Chutes uses OpenAI-compatible endpoints.
