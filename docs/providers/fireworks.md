---
summary: "Use Fireworks AI serverless models in Clawdbot"
read_when:
  - You want fast serverless inference in Clawdbot
  - You want Fireworks AI setup guidance
---
# Fireworks AI

Fireworks AI provides fast, cost-effective serverless inference for popular open-source models including DeepSeek, Qwen, Llama, GLM, and more. All models run on optimized infrastructure with low latency and competitive pricing.

## Why Fireworks in Clawdbot

- **Fast inference** with optimized serving infrastructure.
- **Wide model selection** including DeepSeek V3.2, Qwen3, Llama 3.3, GLM-4.7, and more.
- **Serverless** — no infrastructure management, pay per token.
- **OpenAI-compatible** `/v1` endpoints.

## Features

- **Serverless inference**: No GPU management, instant scaling
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: Supported on all models
- **Function calling**: Supported on most models
- **Vision**: Supported on vision-capable models (Qwen VL series)
- **Reasoning models**: DeepSeek R1, Qwen3 Thinking, Kimi K2 Thinking, Kimi K2.5

## Setup

### 1. Get API Key

1. Sign up at [fireworks.ai](https://fireworks.ai)
2. Go to **Account → API Keys → Create API Key**
3. Copy your API key

### 2. Configure Clawdbot

**Option A: Environment Variable**

```bash
export FIREWORKS_API_KEY="fw_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
clawdbot onboard --auth-choice fireworks-api-key
```

This will:
1. Prompt for your API key (or use existing `FIREWORKS_API_KEY`)
2. Configure the Fireworks provider with available models
3. Let you pick your default model
4. Set up the provider automatically

**Option C: Non-interactive**

```bash
clawdbot onboard --non-interactive \
  --auth-choice fireworks-api-key \
  --fireworks-api-key "fw_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
clawdbot chat --model fireworks/accounts/fireworks/models/deepseek-v3p2 "Hello, are you working?"
```

## Model Selection

Clawdbot includes a curated catalog of popular Fireworks models. Pick based on your needs:

- **Default**: `deepseek-v3p2` (DeepSeek V3.2) — strong reasoning, balanced performance.
- **Best reasoning**: `deepseek-r1-0528` or `qwen3-235b-a22b-thinking-2507`
- **Coding**: `qwen3-coder-480b-a35b-instruct`
- **Vision**: `qwen3-vl-235b-a22b-instruct` or `qwen2p5-vl-32b-instruct`

Change your default model anytime:

```bash
clawdbot models set fireworks/accounts/fireworks/models/deepseek-v3p2
clawdbot models set fireworks/accounts/fireworks/models/qwen3-235b-a22b-thinking-2507
```

List all available models:

```bash
clawdbot models list | grep fireworks
```

## Which Model Should I Use?

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **General chat** | `deepseek-v3p2` | Strong all-around performance |
| **Complex reasoning** | `deepseek-r1-0528` | Best for step-by-step reasoning |
| **Agentic tasks** | `gpt-oss-120b` | Designed for reasoning and agentic use |
| **Coding** | `qwen3-coder-480b-a35b-instruct` | Code-optimized, 262k context |
| **Vision tasks** | `qwen3-vl-235b-a22b-instruct` | Best multimodal capabilities |
| **Fast + cheap** | `qwen3-8b` | Lightweight, low latency |
| **Long context** | `kimi-k2-instruct-0905` | 262k context window |

## Available Models (26 Total)

### Text Models

| Model ID | Name | Context | Features |
|----------|------|---------|----------|
| `deepseek-r1-0528` | Deepseek R1 05/28 | 163k | Reasoning |
| `deepseek-v3-0324` | Deepseek V3 03-24 | 163k | General |
| `deepseek-v3p1` | DeepSeek V3.1 | 163k | General |
| `deepseek-v3p1-terminus` | DeepSeek V3.1 Terminus | 163k | General |
| `deepseek-v3p2` | Deepseek v3.2 | 163k | General |
| `glm-4p6` | GLM-4.6 | 202k | Reasoning |
| `glm-4p7` | GLM-4.7 | 202k | Reasoning |
| `gpt-oss-120b` | OpenAI gpt-oss-120b | 131k | Reasoning |
| `gpt-oss-20b` | OpenAI gpt-oss-20b | 131k | Reasoning |
| `kimi-k2-instruct-0905` | Kimi K2 Instruct 0905 | 262k | Long context |
| `kimi-k2p5` | Kimi K2.5 | 262k | Vision, reasoning |
| `kimi-k2-thinking` | Kimi K2 Thinking | 256k | Reasoning |
| `llama-v3p3-70b-instruct` | Llama 3.3 70B Instruct | 131k | General |
| `minimax-m2` | MiniMax-M2 | 196k | Agentic, coding |
| `minimax-m2p1` | MiniMax-M2.1 | 204k | Agentic, coding |
| `qwen3-235b-a22b` | Qwen3 235B A22B | 131k | General |
| `qwen3-235b-a22b-instruct-2507` | Qwen3 235B A22B Instruct 2507 | 262k | General |
| `qwen3-235b-a22b-thinking-2507` | Qwen3 235B A22B Thinking 2507 | 262k | Reasoning |
| `qwen3-8b` | Qwen3 8B | 40k | Fast |
| `qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B A35B Instruct | 262k | Coding |

### Vision Models

| Model ID | Name | Context | Features |
|----------|------|---------|----------|
| `qwen2p5-vl-32b-instruct` | Qwen2.5-VL 32B Instruct | 128k | Vision |
| `qwen3-vl-235b-a22b-instruct` | Qwen3 VL 235B A22B Instruct | 262k | Vision |
| `qwen3-vl-235b-a22b-thinking` | Qwen3 VL 235B A22B Thinking | 262k | Vision, reasoning |
| `qwen3-vl-30b-a3b-instruct` | Qwen3 VL 30B A3B Instruct | 262k | Vision |
| `qwen3-vl-30b-a3b-thinking` | Qwen3 VL 30B A3B Thinking | 262k | Vision, reasoning |

## Model Catalog

Clawdbot includes a curated catalog of popular Fireworks serverless LLM models.

## Model IDs

Fireworks model IDs use the full resource path format:

```
accounts/fireworks/models/<model-name>
```

When using models in Clawdbot, prefix with the provider:

```bash
clawdbot chat --model fireworks/accounts/fireworks/models/deepseek-v3p2
```

## Streaming and Tool Support

| Feature | Support |
|---------|---------|
| **Streaming** | All models |
| **Function calling** | Most models (check `supportsTools` in API) |
| **Vision/Images** | Vision models only |
| **JSON mode** | Supported via `response_format` |

## Pricing

Fireworks uses pay-per-token pricing. Check [fireworks.ai/pricing](https://fireworks.ai/pricing) for current rates. Generally:

- Smaller models (8B-30B): Lower cost, faster
- Larger models (70B+): Higher quality, higher cost
- MoE models: Cost-effective for their capability

## Usage Examples

```bash
# Use DeepSeek V3.2 (recommended default)
clawdbot chat --model fireworks/accounts/fireworks/models/deepseek-v3p2

# Use reasoning model
clawdbot chat --model fireworks/accounts/fireworks/models/deepseek-r1-0528

# Use coding model
clawdbot chat --model fireworks/accounts/fireworks/models/qwen3-coder-480b-a35b-instruct

# Use vision model
clawdbot chat --model fireworks/accounts/fireworks/models/qwen3-vl-235b-a22b-instruct
```

## Troubleshooting

### API key not recognized

```bash
echo $FIREWORKS_API_KEY
clawdbot models list | grep fireworks
```

Ensure the key is valid and has not expired.

### Model not available

Run `clawdbot models list` to see currently available models in the catalog. If a model you need is missing, you can add it manually to your config file.

### Connection issues

Fireworks API is at `https://api.fireworks.ai`. Ensure your network allows HTTPS connections.

## Config file example

```json5
{
  env: { FIREWORKS_API_KEY: "fw_..." },
  agents: { defaults: { model: { primary: "fireworks/accounts/fireworks/models/deepseek-v3p2" } } },
  models: {
    mode: "merge",
    providers: {
      fireworks: {
        baseUrl: "https://api.fireworks.ai/inference/v1",
        apiKey: "${FIREWORKS_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "accounts/fireworks/models/deepseek-v3p2",
            name: "DeepSeek V3.2",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 163840,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Links

- [Fireworks AI](https://fireworks.ai)
- [API Documentation](https://docs.fireworks.ai)
- [Pricing](https://fireworks.ai/pricing)
- [Model List](https://fireworks.ai/models)
