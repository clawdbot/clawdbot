---
summary: "Use Nillion nilAI privacy-preserving models in Moltbot"
read_when:
  - You want privacy-preserving AI inference in Moltbot
  - You want Nillion nilAI setup guidance
---
# Nillion nilAI

Nillion provides privacy-preserving AI inference using blind computation. Your data remains private throughout the entire inference process - nilAI serves models running in a TEE and other techniques to ensure your prompts and responses are never exposed.

## Why Nillion in Moltbot

- **Privacy-preserving inference** using blind computation.
- **Reasoning support** for complex tasks.
- **Tool calling** support for function execution.
- **OpenAI-compatible** `/v1` endpoints for easy integration.

## Features

| Feature | Support |
|---------|---------|
| **Streaming** | Supported |
| **Reasoning** | Supported |
| **Tool/Function calling** | Supported |
| **Text generation** | Supported |
| **Vision/Images** | Not supported |

## Setup

### 1. Get API Key

1. Sign up at [nilai.nillion.com](https://nilai.nillion.com)
2. Navigate to API settings
3. Create a new API key
4. Copy your API key

### 2. Configure Moltbot

**Option A: Environment Variable**

```bash
export NILLION_API_KEY="your-api-key"
```

**Option B: Interactive Setup (Recommended)**

```bash
moltbot onboard --auth-choice nillion-api-key
```

This will:
1. Prompt for your API key (or use existing `NILLION_API_KEY`)
2. Show available Nillion models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
moltbot onboard --non-interactive \
  --auth-choice nillion-api-key \
  --nillion-api-key "your-api-key"
```

### 3. Verify Setup

```bash
# List available models
moltbot models list | grep nillion

# Run an agent turn
moltbot agent --session-id test --message "Hello, are you working?"
```

## Model Selection

After setup, Moltbot shows available Nillion models.

- **Default**: `nillion/openai/gpt-oss-20b` (nilAI Private 20B) for privacy-preserving inference with reasoning.

Change your default model anytime:

```bash
moltbot models set "nillion/openai/gpt-oss-20b"
```

List all available models:

```bash
moltbot models list | grep nillion
```

## Configure via `moltbot configure`

1. Run `moltbot configure`
2. Select **Model/auth**
3. Choose **Nillion nilAI**

## Available Models

| Model ID | Display Name | Context (tokens) | Features |
|----------|--------------|------------------|----------|
| `openai/gpt-oss-20b` | nilAI Private 20B | 128k | Reasoning, Tool calling |

The full model reference is `nillion/openai/gpt-oss-20b`.

## Reasoning Support

nilAI Private 20B supports reasoning, which enables the model to think through complex problems step by step before providing an answer. This is particularly useful for:

- Complex problem solving
- Multi-step reasoning tasks
- Tool/function calling decisions

## Tool Calling

nilAI supports function/tool calling, allowing the model to:

- Invoke external tools when needed
- Return structured function call responses
- Handle parallel tool calls

## Usage Examples

```bash
# Start an agent session
moltbot agent --session-id myproject --message "Help me with my code"

# Use with the TUI (terminal user interface)
moltbot tui

# Send a message via a channel
moltbot message send --target "+1234567890" --text "Hello from nilAI"

# Open the dashboard
moltbot dashboard
```

## Troubleshooting

### API key not recognized

```bash
echo $NILLION_API_KEY
moltbot models list | grep nillion
```

Ensure the key is correctly set.

### Connection issues

Nillion API is at `https://nilai-f910.nillion.network/v1`. Ensure your network allows HTTPS connections.

### Model not found

The model reference includes the full path: `nillion/openai/gpt-oss-20b`. Make sure to use the complete reference.

## Config file example

```json5
{
  env: { NILLION_API_KEY: "your-key" },
  agents: { defaults: { model: { primary: "nillion/openai/gpt-oss-20b" } } },
  models: {
    mode: "merge",
    providers: {
      nillion: {
        baseUrl: "https://nilai-f910.nillion.network/v1",
        apiKey: "${NILLION_API_KEY}",
        api: "openai-responses",
        models: [
          {
            id: "openai/gpt-oss-20b",
            name: "nilAI Private 20B",
            reasoning: true,
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

## Links

- [Nillion](https://nillion.com)
- [nilAI Documentation](https://nilai.nillion.com)
