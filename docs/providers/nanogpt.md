---
summary: "Use NanoGPT's OpenAI-compatible API in Moltbot"
read_when:
  - You want to use NanoGPT as a model provider
  - You need a NanoGPT API key or base URL setup
---
# NanoGPT

NanoGPT exposes OpenAI-compatible endpoints. Moltbot registers it as the
`nanogpt` provider.

## Quick setup

### Option 1: Browser login (recommended)

Use the device flow to authenticate via your browser:

```bash
moltbot models auth login-nanogpt
```

This opens your browser, you approve access, and Moltbot receives your API key automatically.

Add `--set-default` to also set NanoGPT as your default model:

```bash
moltbot models auth login-nanogpt --set-default
```

### Option 2: API key

1) Set `NANOGPT_API_KEY` (or run the wizard below).
2) Run onboarding:

```bash
moltbot onboard --auth-choice nanogpt-api-key
```

The default model is set to:

```
nanogpt/zai-org/glm-4.7
```

## Config example

```json5
{
  env: { NANOGPT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "nanogpt/zai-org/glm-4.7" },
      models: { "nanogpt/zai-org/glm-4.7": { alias: "GLM 4.7" } }
    }
  },
  models: {
    mode: "merge",
    providers: {
      nanogpt: {
        baseUrl: "https://nano-gpt.com/api/v1",
        apiKey: "${NANOGPT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "zai-org/glm-4.7",
            name: "GLM 4.7",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 65535
          }
        ]
      }
    }
  }
}
```

## Notes

- Model refs use `nanogpt/<modelId>`.
- If you enable a model allowlist (`agents.defaults.models`), add every model you plan to use.
- For the full provider catalog and configuration rules, see [Model providers](/concepts/model-providers).
