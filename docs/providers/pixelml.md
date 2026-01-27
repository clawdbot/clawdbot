---
summary: "Use PixelML multi-model API in Clawdbot"
read_when:
  - You want to use PixelML models in Clawdbot
  - You need PixelML setup guidance
---
# PixelML

PixelML provides a unified OpenAI-compatible API for accessing multiple AI models including GPT-4o, Claude, and more.

## Features

- **Multi-model access**: Use GPT, Claude, and other models through a single API
- **OpenAI-compatible**: Standard `/v1` endpoints for easy integration
- **Streaming**: Supported on all models
- **Vision**: Supported on models with vision capability

## Setup

### 1. Get API Key

1. Sign up at [platform.pixelml.com](https://platform.pixelml.com)
2. Go to your account settings and create an API key
3. Copy your API key

### 2. Configure Clawdbot

**Option A: Environment Variable**

```bash
export PIXELML_API_KEY="your-api-key"
```

**Option B: Interactive Setup (Recommended)**

```bash
clawdbot onboard --auth-choice pixelml-api-key
```

This will:
1. Prompt for your API key (or use existing `PIXELML_API_KEY`)
2. Configure the provider automatically
3. Set the default model

**Option C: Non-interactive**

```bash
clawdbot onboard --non-interactive \
  --auth-choice pixelml-api-key \
  --pixelml-api-key "your-api-key"
```

### 3. Verify Setup

```bash
clawdbot chat --model pixelml/gpt-4o-mini "Hello, are you working?"
```

## Available Models

| Model ID | Name | Context | Features |
|----------|------|---------|----------|
| `gpt-4o-mini` | GPT-4o Mini | 128k | Vision |
| `gpt-4o` | GPT-4o | 128k | Vision |
| `claude-4.5-haiku` | Claude 4.5 Haiku | 200k | Vision |
| `claude-4.5-sonnet` | Claude 4.5 Sonnet | 200k | Vision, Reasoning |

## Model Selection

Change your default model anytime:

```bash
clawdbot models set pixelml/gpt-4o-mini
clawdbot models set pixelml/claude-4.5-sonnet
```

List all available models:

```bash
clawdbot models list | grep pixelml
```

## Usage Examples

```bash
# Use GPT-4o Mini (default)
clawdbot chat --model pixelml/gpt-4o-mini "Hello"

# Use Claude via PixelML
clawdbot chat --model pixelml/claude-4.5-sonnet "Write a poem"

# Use GPT-4o for vision tasks
clawdbot chat --model pixelml/gpt-4o
```

## Config File Example

```json5
{
  env: { PIXELML_API_KEY: "your-api-key" },
  agents: { defaults: { model: { primary: "pixelml/gpt-4o-mini" } } },
  models: {
    mode: "merge",
    providers: {
      pixelml: {
        baseUrl: "https://ishi.pixelml.com/v1",
        apiKey: "${PIXELML_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "gpt-4o-mini",
            name: "GPT-4o Mini",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 16384
          }
        ]
      }
    }
  }
}
```

## Troubleshooting

### API key not recognized

```bash
echo $PIXELML_API_KEY
clawdbot models list | grep pixelml
```

### Connection issues

PixelML API is at `https://ishi.pixelml.com/v1`. Ensure your network allows HTTPS connections.

## Links

- [PixelML](https://platform.pixelml.com)
