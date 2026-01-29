---
summary: "Use Morpheus decentralized inference in Clawdbot"
read_when:
  - You want decentralized AI inference in Clawdbot
  - You want Morpheus API setup guidance
---
# Morpheus Inference API

**Morpheus** provides decentralized AI inference via the Morpheus Network, offering FREE access to open-source models during Open Beta.

The Morpheus Inference API is a simple, OpenAI-compatible gateway providing users access to the Morpheus Inference Marketplace. Providers host hardware and offer inference, while the API abstracts these efforts for a seamless experience.

## Why Morpheus in Clawdbot

- **Decentralized inference** from the Morpheus Inference Marketplace
- **FREE during Open Beta** (until 1/31/26)
- **20+ models** including Llama, Qwen, DeepSeek, GLM, Kimi, and more
- OpenAI-compatible `/v1` endpoints

## Features

- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: Supported on all models
- **Function calling**: Supported on most models
- **Vision**: Supported on select models (e.g., `mistral-31-24b`)
- **Web search**: Add `:web` suffix to any model for web search capabilities

## Setup

### 1. Get API Key

1. Create an account at [app.mor.org](https://app.mor.org)
2. Click **Create API Key** and copy it immediately
3. Your API key format: `sk-xxxxxxxxxxxxx`

### 2. Configure Clawdbot

**Option A: Environment Variable**

```bash
export MORPHEUS_API_KEY="sk-xxxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
clawdbot onboard --auth-choice morpheus-api-key
```

This will:
1. Prompt for your API key (or use existing `MORPHEUS_API_KEY`)
2. Show all available Morpheus models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
clawdbot onboard --non-interactive \
  --auth-choice morpheus-api-key \
  --morpheus-api-key "sk-xxxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
clawdbot chat --model morpheus/llama-3.3-70b "Hello, are you working?"
```

## Model Selection

After setup, Clawdbot shows all available Morpheus models. Pick based on your needs:

- **Default (our pick)**: `morpheus/llama-3.3-70b` for reliable, balanced performance
- **Best for coding**: `morpheus/qwen3-coder-480b-a35b-instruct` with 256K context
- **Best for reasoning**: `morpheus/kimi-k2-thinking` for deep analysis
- **Fastest**: `morpheus/llama-3.2-3b` for low-latency responses

Change your default model anytime:

```bash
clawdbot models set morpheus/llama-3.3-70b
clawdbot models set morpheus/kimi-k2-thinking
```

List all available models:

```bash
clawdbot models list | grep morpheus
```

## Available Models

### Flagship Models

| Model ID | Name | Context | Best For |
|----------|------|---------|----------|
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B | 256K | Code generation |
| `hermes-3-llama-3.1-405b` | Hermes 3 Llama 405B | 128K | General purpose |
| `gpt-oss-120b` | GPT OSS 120B | 128K | GPT-style responses |

### Reasoning Models

| Model ID | Name | Context | Best For |
|----------|------|---------|----------|
| `kimi-k2-thinking` | Kimi K2 Thinking | 256K | Deep reasoning, math, coding |
| `glm-4.7-thinking` | GLM 4.7 Thinking | 198K | Extended thinking |
| `glm-4.7` | GLM 4.7 | 198K | Reasoning, multilingual |
| `qwen3-235b` | Qwen3 235B | 128K | Complex reasoning |

### Mid-Size Models

| Model ID | Name | Context | Best For |
|----------|------|---------|----------|
| `llama-3.3-70b` | Llama 3.3 70B | 128K | General purpose |
| `qwen3-next-80b` | Qwen3 Next 80B | 256K | Long context |
| `mistral-31-24b` | Mistral 31 24B | 128K | Fast, vision |
| `venice-uncensored` | Venice Uncensored | 32K | Uncensored, creative |
| `hermes-4-14b` | Hermes 4 14B | 128K | Efficient |

### Fast Models

| Model ID | Name | Context | Best For |
|----------|------|---------|----------|
| `llama-3.2-3b` | Llama 3.2 3B | 128K | Fastest responses |
| `qwen3-4b` | Qwen3 4B | 32K | Lightweight, reasoning |

### Web-Enabled Models

Add `:web` suffix to any model for web search:
- `llama-3.3-70b:web`
- `kimi-k2-thinking:web`
- `qwen3-coder-480b-a35b-instruct:web`

## Model Discovery

Clawdbot automatically discovers models from the Morpheus API when `MORPHEUS_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

## Streaming & Tool Support

| Feature | Support |
|---------|---------|
| **Streaming** | All models |
| **Function calling** | Most models |
| **Vision/Images** | `mistral-31-24b` |
| **JSON mode** | Supported via `response_format` |

## Pricing

Morpheus is **FREE during Open Beta** (until 1/31/26). Billing infrastructure will be implemented soon.

## Config File Example

```json5
{
  env: { MORPHEUS_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "morpheus/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      morpheus: {
        baseUrl: "https://api.mor.org/api/v1",
        apiKey: "${MORPHEUS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Usage Examples

```bash
# Use default model
clawdbot chat --model morpheus/llama-3.3-70b

# Use coding model
clawdbot chat --model morpheus/qwen3-coder-480b-a35b-instruct

# Use reasoning model
clawdbot chat --model morpheus/kimi-k2-thinking

# Use with web search
clawdbot chat --model morpheus/llama-3.3-70b:web
```

## Troubleshooting

### API key not recognized

```bash
echo $MORPHEUS_API_KEY
clawdbot models list | grep morpheus
```

Ensure the key starts with `sk-`.

### Model not available

Model availability depends on active providers in the Morpheus marketplace. Run `clawdbot models list` to see currently available models.

### Connection issues

Morpheus API is at `https://api.mor.org/api/v1`. Ensure your network allows HTTPS connections.

## Links

- [Morpheus API Docs](https://apidocs.mor.org)
- [Morpheus App](https://app.mor.org)
- [Morpheus Discord](https://discord.gg/kyVaxTHnvB)
- [Morpheus Twitter](https://x.com/morpheusais)
