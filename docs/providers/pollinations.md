---
summary: "Use Pollinations.ai unified Gen-AI platform with Clawdbot"
read_when:
  - You want to use Pollinations.ai models in Clawdbot
  - You need access to multiple AI providers through a single API
---
# Pollinations

[Pollinations.ai](https://pollinations.ai) is an open-source Gen-AI platform that provides a unified API gateway for accessing multiple AI models including GPT-5, Claude, Gemini, Flux (image generation), and more. It uses an OpenAI-compatible API format, making it easy to integrate with Clawdbot.

## Features

- **Unified API** — Access GPT-5, Claude, Gemini, Grok, and more through a single endpoint
- **Image Generation** — Flux, GPT Image, Seedream, and other image models
- **Video Generation** — Text-to-video with Seedance and Veo (alpha)
- **Audio** — Text-to-speech, speech-to-text, and voice options
- **Pay-as-you-go** — Simple Pollen credits system ($1 ≈ 1 Pollen)
- **OpenAI-compatible** — Works with existing OpenAI API clients

## Getting your API key

1. Visit [enter.pollinations.ai](https://enter.pollinations.ai)
2. Log in with your GitHub account
3. Create an API key from the dashboard
4. Choose between:
   - **Publishable keys (pk_)** — Frontend use, with rate limits
   - **Secret keys (sk_)** — Server-side only, no rate limits (keep secret!)

You can scope each API key to specific models or allow access to all models.

## Configuration

### CLI setup

```bash
clawdbot onboard --auth-choice pollinations
# or non-interactive
clawdbot config set env.POLLINATIONS_API_KEY "sk-..."
```

### Config snippet

```json5
{
  env: { POLLINATIONS_API_KEY: "sk-..." },
  models: {
    providers: {
      pollinations: {
        baseUrl: "https://gen.pollinations.ai/v1",
        apiKey: "${POLLINATIONS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "openai",
            name: "GPT-5 via Pollinations",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0.002, output: 0.006, cacheRead: 0.001, cacheWrite: 0.0025 },
            contextWindow: 128000,
            maxTokens: 16384
          },
          {
            id: "claude",
            name: "Claude via Pollinations",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
            contextWindow: 200000,
            maxTokens: 8192
          },
          {
            id: "gemini",
            name: "Gemini via Pollinations",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0005 },
            contextWindow: 128000,
            maxTokens: 8192
          }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "pollinations/openai" }
    }
  }
}
```

## Available models

Pollinations provides access to many models through its unified API:

### Text Generation
- `openai` — GPT-5
- `claude` — Claude (latest)
- `gemini` — Gemini Pro
- `gemini-large` — Gemini with code execution
- `gemini-search` — Gemini with Google Search
- `grok` — Grok
- `nomnom` (alias `gemini-scrape`) — Web research and scraping

### Image Generation
- `flux` — FLUX models for text-to-image
- `gptimage-large` — GPT Image
- `seedream` — Seedream image generation
- `klein` — FLUX.2 klein for fast text-to-image

### Video Generation (alpha)
- `seedance` — Text-to-video
- `veo` — Text-to-video

## Authentication

Pollinations supports two authentication methods:

1. **API Key in URL** (for simple requests):
   ```bash
   curl 'https://gen.pollinations.ai/text/hello?key=YOUR_API_KEY'
   ```

2. **Bearer Token in Header** (recommended for Clawdbot):
   ```bash
   curl 'https://gen.pollinations.ai/v1/chat/completions' \
     -H 'Authorization: Bearer YOUR_API_KEY' \
     -H 'Content-Type: application/json' \
     -d '{"model": "openai", "messages": [{"role": "user", "content": "Hello"}]}'
   ```

Clawdbot uses the Bearer Token method automatically when you set `POLLINATIONS_API_KEY`.

## Security

- **Never share your API key publicly** — Don't commit keys to Git repositories
- **Use environment variables** — Store your key in `.env` files
- **Use secret keys for production** — Secret keys (sk_) have no rate limits and should only be used server-side
- **Scope your keys** — When creating keys, restrict them to only the models you need

## Pricing

Pollinations uses a **Pollen credits system**:
- $1 ≈ 1 Pollen
- Pay-as-you-go billing
- Different tier levels (Seed, Flower, Nectar) provide different usage quotas
- Seed tier is automatic on first login

Check your balance and usage:
```bash
# Balance
curl 'https://gen.pollinations.ai/account/balance' \
  -H 'Authorization: Bearer YOUR_API_KEY'

# Usage history
curl 'https://gen.pollinations.ai/account/usage' \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

## Notes

- **OpenAI-compatible** — Pollinations uses the OpenAI Completions API format, so it works seamlessly with Clawdbot's OpenAI provider adapter
- **Multi-modal support** — Many models support both text and image inputs
- **Tool support** — Gemini models include code_execution and google_search tools
- **Response formats** — Some responses may include special content blocks (image_url, thinking) depending on the model
- **Beta status** — Pollinations is in active development; features and pricing may change

## Troubleshooting

### Authentication errors

If you see `401 Unauthorized`:
- Verify your API key is correct
- Make sure you're using the right key type (secret keys for server-side)
- Check that your key hasn't expired

### Model not found

If a model isn't available:
- Check the [API documentation](https://enter.pollinations.ai/api/docs) for current model names
- Some models may be in limited access or beta
- Try using a different model from the list above

### Rate limits (publishable keys only)

Publishable keys (pk_) have rate limits. If you hit limits:
- Use a secret key (sk_) for server-side usage
- Upgrade your tier for higher quotas
- Check your usage at [enter.pollinations.ai](https://enter.pollinations.ai)

## See Also

- [Pollinations.ai Website](https://pollinations.ai)
- [API Documentation](https://enter.pollinations.ai/api/docs)
- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Configuration](/gateway/configuration) - Full config reference
