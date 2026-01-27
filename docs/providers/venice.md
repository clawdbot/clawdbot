---
summary: "Use Venice AI privacy-focused models in Moltbot"
read_when:
  - You want privacy-focused inference in Moltbot
  - You want Venice AI setup guidance
---
# Venice AI (Venius highlight)

**Venius** is our highlight Venice setup for privacy-first inference with optional anonymized access to proprietary models.

Venice AI provides privacy-focused AI inference with support for uncensored models and access to major proprietary models through their anonymized proxy. All inference is private by default—no training on your data, no logging.

## Why Venice in Moltbot

- **Private inference** for open-source models (no logging).
- **Uncensored models** when you need them.
- **Anonymized access** to proprietary models (Opus/GPT/Gemini) when quality matters.
- OpenAI-compatible `/v1` endpoints.

## Privacy Modes

Venice offers two privacy levels — understanding this is key to choosing your model:

| Mode | Description | Models |
|------|-------------|--------|
| **Private** | Fully private. Prompts/responses are **never stored or logged**. Ephemeral. | Llama, Qwen, DeepSeek, Venice Uncensored, etc. |
| **Anonymized** | Proxied through Venice with metadata stripped. The underlying provider (OpenAI, Anthropic) sees anonymized requests. | Claude, GPT, Gemini, Grok, Kimi, MiniMax |

## Features

- **Privacy-focused**: Choose between "private" (fully private) and "anonymized" (proxied) modes
- **Uncensored models**: Access to models without content restrictions
- **Major model access**: Use Claude, GPT-5.2, Gemini, Grok via Venice's anonymized proxy
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: ✅ Supported on all models
- **Function calling**: ✅ Supported on select models (check model capabilities)
- **Vision**: ✅ Supported on models with vision capability
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Setup

### 1. Get API Key

1. Sign up at [venice.ai](https://venice.ai)
2. Go to **Settings → API Keys → Create new key**
3. Copy your API key (format: `vapi_xxxxxxxxxxxx`)

### 2. Configure Moltbot

**Option A: Environment Variable**

```bash
export VENICE_API_KEY="vapi_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
moltbot onboard --auth-choice venice-api-key
```

This will:
1. Prompt for your API key (or use existing `VENICE_API_KEY`)
2. Show all available Venice models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
moltbot onboard --non-interactive \
  --auth-choice venice-api-key \
  --venice-api-key "vapi_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
moltbot chat --model venice/llama-3.3-70b "Hello, are you working?"
```

## Model Selection

After setup, Moltbot shows all available Venice models. Pick based on your needs:

- **Default (our pick)**: `venice/llama-3.3-70b` for private, balanced performance.
- **Best overall quality**: `venice/claude-opus-45` for hard jobs (Opus remains the strongest).
- **Privacy**: Choose "private" models for fully private inference.
- **Capability**: Choose "anonymized" models to access Claude, GPT, Gemini via Venice's proxy.

Change your default model anytime:

```bash
moltbot models set venice/claude-opus-45
moltbot models set venice/llama-3.3-70b
```

List all available models:

```bash
moltbot models list | grep venice
```

## Configure via `moltbot configure`

1. Run `moltbot configure`
2. Select **Model/auth**
3. Choose **Venice AI**

## Which Model Should I Use?

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **General chat** | `llama-3.3-70b` | Good all-around, fully private |
| **Best overall quality** | `claude-opus-45` | Opus remains the strongest for hard tasks |
| **Privacy + Claude quality** | `claude-opus-45` | Best reasoning via anonymized proxy |
| **Coding** | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 262k context |
| **Vision tasks** | `qwen3-vl-235b-a22b` | Best private vision model |
| **Uncensored** | `venice-uncensored` | No content restrictions |
| **Fast + cheap** | `qwen3-4b` | Lightweight, still capable |
| **Complex reasoning** | `deepseek-v3.2` | Strong reasoning, private |

## Available Models (25 Total)

### Private Models (15) — Fully Private, No Logging

| Model ID | Name | Context (tokens) | Features |
|----------|------|------------------|----------|
| `llama-3.3-70b` | Llama 3.3 70B | 131k | General |
| `llama-3.2-3b` | Llama 3.2 3B | 131k | Fast, lightweight |
| `hermes-3-llama-3.1-405b` | Hermes 3 Llama 3.1 405B | 131k | Complex tasks |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B Thinking | 131k | Reasoning |
| `qwen3-235b-a22b-instruct-2507` | Qwen3 235B Instruct | 131k | General |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B | 262k | Code |
| `qwen3-next-80b` | Qwen3 Next 80B | 262k | General |
| `qwen3-vl-235b-a22b` | Qwen3 VL 235B | 262k | Vision |
| `qwen3-4b` | Venice Small (Qwen3 4B) | 32k | Fast, reasoning |
| `deepseek-v3.2` | DeepSeek V3.2 | 163k | Reasoning |
| `venice-uncensored` | Venice Uncensored | 32k | Uncensored |
| `mistral-31-24b` | Venice Medium (Mistral) | 131k | Vision |
| `google-gemma-3-27b-it` | Gemma 3 27B Instruct | 202k | Vision |
| `openai-gpt-oss-120b` | OpenAI GPT OSS 120B | 131k | General |
| `zai-org-glm-4.7` | GLM 4.7 | 202k | Reasoning, multilingual |

### Anonymized Models (10) — Via Venice Proxy

| Model ID | Original | Context (tokens) | Features |
|----------|----------|------------------|----------|
| `claude-opus-45` | Claude Opus 4.5 | 202k | Reasoning, vision |
| `claude-sonnet-45` | Claude Sonnet 4.5 | 202k | Reasoning, vision |
| `openai-gpt-52` | GPT-5.2 | 262k | Reasoning |
| `openai-gpt-52-codex` | GPT-5.2 Codex | 262k | Reasoning, vision |
| `gemini-3-pro-preview` | Gemini 3 Pro | 202k | Reasoning, vision |
| `gemini-3-flash-preview` | Gemini 3 Flash | 262k | Reasoning, vision |
| `grok-41-fast` | Grok 4.1 Fast | 262k | Reasoning, vision |
| `grok-code-fast-1` | Grok Code Fast 1 | 262k | Reasoning, code |
| `kimi-k2-thinking` | Kimi K2 Thinking | 262k | Reasoning |
| `minimax-m21` | MiniMax M2.1 | 202k | Reasoning |

## Model Discovery

Moltbot automatically discovers models from the Venice API when `VENICE_API_KEY` is set. If the API is unreachable, it falls back to a static catalog.

The `/models` endpoint is public (no auth needed for listing), but inference requires a valid API key.

## Streaming & Tool Support

| Feature | Support |
|---------|---------|
| **Streaming** | ✅ All models |
| **Function calling** | ✅ Most models (check `supportsFunctionCalling` in API) |
| **Vision/Images** | ✅ Models marked with "Vision" feature |
| **JSON mode** | ✅ Supported via `response_format` |

## Pricing

Venice uses a credit-based system. Check [venice.ai/pricing](https://venice.ai/pricing) for current rates:

- **Private models**: Generally lower cost
- **Anonymized models**: Similar to direct API pricing + small Venice fee

## Comparison: Venice vs Direct API

| Aspect | Venice (Anonymized) | Direct API |
|--------|---------------------|------------|
| **Privacy** | Metadata stripped, anonymized | Your account linked |
| **Latency** | +10-50ms (proxy) | Direct |
| **Features** | Most features supported | Full features |
| **Billing** | Venice credits | Provider billing |

## Usage Examples

```bash
# Use default private model
moltbot chat --model venice/llama-3.3-70b

# Use Claude via Venice (anonymized)
moltbot chat --model venice/claude-opus-45

# Use uncensored model
moltbot chat --model venice/venice-uncensored

# Use vision model with image
moltbot chat --model venice/qwen3-vl-235b-a22b

# Use coding model
moltbot chat --model venice/qwen3-coder-480b-a35b-instruct
```

## Troubleshooting

### API key not recognized

```bash
echo $VENICE_API_KEY
moltbot models list | grep venice
```

Ensure the key starts with `vapi_`.

### Model not available

The Venice model catalog updates dynamically. Run `moltbot models list` to see currently available models. Some models may be temporarily offline.

### Connection issues

Venice API is at `https://api.venice.ai/api/v1`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { VENICE_API_KEY: "vapi_..." },
  agents: { defaults: { model: { primary: "venice/llama-3.3-70b" } } },
  models: {
    mode: "merge",
    providers: {
      venice: {
        baseUrl: "https://api.venice.ai/api/v1",
        apiKey: "${VENICE_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b",
            name: "Llama 3.3 70B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 131072,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Links

- [Venice AI](https://venice.ai)
- [API Documentation](https://docs.venice.ai)
- [Pricing](https://venice.ai/pricing)
- [Status](https://status.venice.ai)
