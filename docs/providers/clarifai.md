# Clarifai

Clarifai provides access to many LLMs via an OpenAI-compatible API endpoint.

## Important: Full Model URL Required

Clarifai requires the **complete model URL** as the model ID, not just a simple model name. The format is:

```
https://clarifai.com/{user_id}/{app_id}/models/{model_id}
```

Or with a specific version:

```
https://clarifai.com/{user_id}/{app_id}/models/{model_id}/versions/{version_id}
```

For example:
- `https://clarifai.com/openai/chat-completion/models/gpt-4-turbo`
- `https://clarifai.com/openai/chat-completion/models/gpt-oss-120b/versions/f1d2ad8c01c74705868f5c8ae4a1ff7c`


Browse available models at: https://clarifai.com/explore/models

## CLI setup

```bash
moltbot onboard --auth-choice clarifai-api-key --token "$CLARIFAI_PAT"
```

Or interactively:

```bash
moltbot onboard
# Select "Clarifai" when prompted for auth provider
```

## Environment variables

Clarifai accepts either environment variable:

- `CLARIFAI_API_KEY` — Your Clarifai Personal Access Token (PAT)
- `CLARIFAI_PAT` — Alternative name for the same token

## Config snippet

```json5
{
  env: { CLARIFAI_API_KEY: "your-pat-here" },
  agents: {
    defaults: {
      // The model ID is the full Clarifai URL
      model: { primary: "clarifai/https://clarifai.com/openai/chat-completion/models/gpt-4-turbo" }
    }
  }
}
```

## Getting your API key (PAT)

1. Go to [Clarifai Settings → Security](https://clarifai.com/settings/security)
2. Create a new Personal Access Token (PAT)
3. Copy the token and use it as your API key

## Available models

Models are referenced using the full Clarifai URL. Examples:

| Model Reference | Description |
|-----------------|-------------|
| `clarifai/https://clarifai.com/openai/chat-completion/models/gpt-4-turbo` | GPT-4 Turbo via Clarifai |
| `clarifai/https://clarifai.com/openai/chat-completion/models/gpt-oss-120b` | GPT-OSS 120B |
| `clarifai/https://clarifai.com/meta/Llama-2/models/llama2-70b-chat` | Llama 2 70B Chat |

Find more models at: https://clarifai.com/explore/models

## Notes

- Model refs use the format `clarifai/{full_clarifai_url}`
- Uses OpenAI-compatible `/v1/chat/completions` endpoint
- PAT (Personal Access Token) is used for authentication
- The endpoint is: `https://api.clarifai.com/v2/ext/openai/v1`

## Manual provider configuration

For custom setups or additional models:

```json5
{
  models: {
    providers: {
      clarifai: {
        baseUrl: "https://api.clarifai.com/v2/ext/openai/v1",
        api: "openai-completions",
        apiKey: "your-pat-here",
        models: [
          {
            // Full model URL as the ID
            id: "https://clarifai.com/openai/chat-completion/models/gpt-4-turbo",
            name: "GPT-4 Turbo (Clarifai)",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096
          },
          {
            id: "https://clarifai.com/meta/Llama-2/models/llama2-70b-chat",
            name: "Llama 2 70B Chat",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 4096,
            maxTokens: 4096
          }
        ]
      }
    }
  }
}
```
