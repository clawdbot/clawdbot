---
summary: "Use Redpill AI GPU TEE models in Clawdbot"
read_when:
  - You want privacy-focused inference with hardware-verified security
  - You want GPU TEE model setup guidance
  - You want to deploy Clawdbot on Phala Cloud for full TEE privacy
---
# Redpill AI

Redpill AI provides access to AI models running in GPU-based Trusted Execution Environments (TEEs) with cryptographic attestation. All models run inside secure hardware enclaves, ensuring memory encryption, tamper-proof execution, and verifiable computation.

## Why Redpill in Clawdbot

- **Hardware-verified privacy** via GPU TEE technology with cryptographic attestation
- **Zero trust architecture** with memory encryption and isolated execution
- **18 verified models** across 4 TEE providers (Phala, Tinfoil, Chutes, Near-AI)
- **Verifiable computation** ensuring your prompts and responses stay private
- OpenAI-compatible `/v1` endpoints

## Privacy Tiers

Redpill offers two privacy levels:

| Tier | Description | Models | Status |
|------|-------------|--------|--------|
| **GPU TEE** | Hardware-verified privacy with cryptographic attestation. Models run in secure enclaves with memory encryption and tamper-proof execution. | 18 models across Phala, Tinfoil, Chutes, Near-AI | ✅ Available |
| **Extended** | Additional models with standard privacy (no TEE hardware guarantee). | TBD | 🔜 Coming soon |

## Features

- **GPU TEE security**: All models run in hardware-secured enclaves with cryptographic attestation
- **Memory encryption**: Data stays encrypted in GPU memory during inference
- **Tamper-proof execution**: Verifiable computation guarantees no unauthorized access
- **4 TEE providers**: Phala Network (10 models), Tinfoil (4), Chutes (1), Near-AI (3)
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: ✅ Supported on all models
- **Function calling**: ✅ Supported on select models
- **Vision**: ✅ Supported on Qwen3 VL 30B model
- **No hard rate limits**: Fair-use throttling may apply for extreme usage

## Setup

### 1. Get API Key

1. Sign up at [redpill.ai](https://redpill.ai)
2. Navigate to **API Keys** in your dashboard
3. Create a new API key
4. Copy your API key (format: `rp_xxxxxxxxxxxx`)

### 2. Configure Clawdbot

**Option A: Environment Variable**

```bash
export REDPILL_API_KEY="rp_xxxxxxxxxxxx"
```

**Option B: Interactive Setup (Recommended)**

```bash
clawdbot onboard --auth-choice redpill-api-key
```

This will:
1. Prompt for your API key (or use existing `REDPILL_API_KEY`)
2. Show all available GPU TEE models
3. Let you pick your default model
4. Configure the provider automatically

**Option C: Non-interactive**

```bash
clawdbot onboard --non-interactive \
  --auth-choice redpill-api-key \
  --token "rp_xxxxxxxxxxxx"
```

### 3. Verify Setup

```bash
clawdbot agent --message "Hello, are you working?"
```

## Model Selection

After setup, Clawdbot shows all available Redpill models. Pick based on your needs:

- **Default (our pick)**: `redpill/deepseek/deepseek-v3.2` for strong reasoning with GPU TEE privacy.
- **Best reasoning**: `redpill/deepseek/deepseek-r1-0528` or `redpill/moonshotai/kimi-k2-thinking` for complex reasoning tasks.
- **Best coding**: `redpill/qwen/qwen3-coder-480b-a35b-instruct` for code generation and analysis.
- **Vision tasks**: `redpill/qwen/qwen3-vl-30b-a3b-instruct` for image understanding.
- **Fast + capable**: `redpill/meta-llama/llama-3.3-70b-instruct` for balanced performance.

Change your default model anytime using the `/model` directive in chat:

```
/model redpill/deepseek/deepseek-r1-0528
```

List all available models:

```bash
clawdbot models list | grep redpill
```

## GPU TEE Models (18 Total)

All models run in hardware-secured GPU TEE environments with cryptographic attestation.

### Phala Network (10 models)

| Model ID | Name | Context | Max Output | Features |
|----------|------|---------|------------|----------|
| `z-ai/glm-4.7-flash` | GLM 4.7 Flash | 203k | 128k | General, multilingual |
| `qwen/qwen3-embedding-8b` | Qwen3 Embedding 8B | 33k | 512 | Embeddings |
| `phala/uncensored-24b` | Uncensored 24B | 33k | 8k | Uncensored |
| `deepseek/deepseek-v3.2` | DeepSeek v3.2 | 164k | 8k | **Default**, reasoning |
| `qwen/qwen3-vl-30b-a3b-instruct` | Qwen3 VL 30B | 128k | 8k | Vision |
| `sentence-transformers/all-minilm-l6-v2` | All-MiniLM-L6-v2 | 512 | 512 | Embeddings |
| `qwen/qwen-2.5-7b-instruct` | Qwen 2.5 7B Instruct | 33k | 8k | General |
| `google/gemma-3-27b-it` | Gemma 3 27B IT | 54k | 8k | General |
| `openai/gpt-oss-120b` | GPT OSS 120B | 131k | 8k | General |
| `openai/gpt-oss-20b` | GPT OSS 20B | 131k | 8k | General |

### Tinfoil (4 models)

| Model ID | Name | Context | Max Output | Features |
|----------|------|---------|------------|----------|
| `moonshotai/kimi-k2-thinking` | Kimi K2 Thinking | 262k | 8k | Reasoning |
| `deepseek/deepseek-r1-0528` | DeepSeek R1 | 164k | 8k | Reasoning |
| `qwen/qwen3-coder-480b-a35b-instruct` | Qwen3 Coder 480B | 262k | 8k | Code |
| `meta-llama/llama-3.3-70b-instruct` | Llama 3.3 70B Instruct | 131k | 8k | General |

### Chutes (1 model)

| Model ID | Name | Context | Max Output | Features |
|----------|------|---------|------------|----------|
| `minimax/minimax-m2.1` | MiniMax M2.1 | 197k | 8k | General |

### Near-AI (3 models)

| Model ID | Name | Context | Max Output | Features |
|----------|------|---------|------------|----------|
| `deepseek/deepseek-chat-v3.1` | DeepSeek Chat v3.1 | 164k | 8k | General |
| `qwen/qwen3-30b-a3b-instruct-2507` | Qwen3 30B Instruct | 262k | 8k | General |
| `z-ai/glm-4.6` | GLM 4.6 | 203k | 128k | General, multilingual |

## Which Model Should I Use?

| Use Case | Recommended Model | Why |
|----------|-------------------|-----|
| **General chat** | `deepseek/deepseek-v3.2` | Default, strong reasoning, GPU TEE |
| **Complex reasoning** | `deepseek/deepseek-r1-0528` | Reasoning-optimized with R1 architecture |
| **Long context reasoning** | `moonshotai/kimi-k2-thinking` | 262k context, reasoning-focused |
| **Coding** | `qwen/qwen3-coder-480b-a35b-instruct` | Code-specialized, 262k context |
| **Vision tasks** | `qwen/qwen3-vl-30b-a3b-instruct` | Only vision model, 128k context |
| **Fast + balanced** | `meta-llama/llama-3.3-70b-instruct` | Llama 3.3, good all-around |
| **Uncensored** | `phala/uncensored-24b` | No content restrictions |
| **Embeddings** | `qwen/qwen3-embedding-8b` | Text embeddings |

## Pricing

Redpill uses a credit-based system. Check [redpill.ai/pricing](https://redpill.ai/pricing) for current rates.

All GPU TEE models incur costs based on:
- Input tokens (per 1M tokens)
- Output tokens (per 1M tokens)
- TEE attestation overhead (minimal)

## Usage Examples

```bash
# Use default model (configured in agents.defaults.model.primary)
clawdbot agent --message "Your question here"

# Configure a specific default model
clawdbot config set agents.defaults.model.primary redpill/deepseek/deepseek-r1-0528

# Use with local session
clawdbot agent --local --session-id my-session --message "Your question here"

# Switch model mid-chat using /model directive
> /model redpill/moonshotai/kimi-k2-thinking
```

## Streaming & Tool Support

| Feature | Support |
|---------|---------|
| **Streaming** | ✅ All models |
| **Function calling** | ✅ Select models (check model capabilities) |
| **Vision/Images** | ✅ Qwen3 VL 30B only |
| **JSON mode** | ✅ Supported via `response_format` |

## Troubleshooting

### API key not recognized

```bash
echo $REDPILL_API_KEY
clawdbot models list | grep redpill
```

Ensure the key starts with `rp_`.

### Model not available

Run `clawdbot models list | grep redpill` to see currently available models. All 18 GPU TEE models should be listed.

### Connection issues

Redpill API is at `https://api.redpill.ai/v1`. Ensure your network allows HTTPS connections.

### TEE attestation failed

If you receive attestation errors:
1. Try a different TEE provider model
2. Verify your API key is valid
3. Check the main Redpill website for service announcements

## Config File Example

```json5
{
  env: { REDPILL_API_KEY: "rp_..." },
  agents: { defaults: { model: { primary: "redpill/deepseek/deepseek-v3.2" } } },
  models: {
    mode: "merge",
    providers: {
      redpill: {
        baseUrl: "https://api.redpill.ai/v1",
        apiKey: "${REDPILL_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "deepseek/deepseek-v3.2",
            name: "DeepSeek v3.2 (GPU TEE)",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 164000,
            maxTokens: 8192
          }
        ]
      }
    }
  }
}
```

## Deploy on Phala Cloud (Full TEE Stack)

For maximum privacy, deploy Clawdbot itself inside a Phala Cloud CVM (Confidential Virtual Machine). This creates an end-to-end TEE stack where both the application and the AI inference run in hardware-secured enclaves.

### Why Phala Cloud + Redpill

| Layer | TEE Protection |
|-------|----------------|
| **Application** | Clawdbot runs in Phala Cloud CVM with Intel TDX |
| **AI Inference** | Redpill routes to GPU TEE models (Phala, Tinfoil, etc.) |
| **Result** | Your prompts never leave secure enclaves from input to output |

### Prerequisites

1. [Phala Cloud](https://cloud.phala.network) account with API key
2. [Redpill AI](https://redpill.ai) API key
3. Docker installed locally
4. Phala CLI: `npm install -g phala`

### Quick Deployment

**1. Authenticate with Phala Cloud**

```bash
phala auth login <your-phala-cloud-api-key>
```

**2. Create docker-compose.phala.yml**

The container auto-configures Redpill as the default provider when `REDPILL_API_KEY` is set on first boot.

```yaml
# docker-compose.phala.yml for Phala Cloud CVM
services:
  clawdbot:
    image: hashwarlock/clawdbot:redpill
    environment:
      HOME: /home/node
      TERM: xterm-256color
      # Auto-configures Redpill provider on first boot
      REDPILL_API_KEY: ${REDPILL_API_KEY}
      # Auto-configures messaging channels when tokens are provided
      TELEGRAM_BOT_TOKEN: ${TELEGRAM_BOT_TOKEN:-}
      DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN:-}
      # Gateway configuration
      GATEWAY_PORT: ${GATEWAY_PORT:-18789}
      GATEWAY_AUTH: ${GATEWAY_AUTH:-off}
      # Persistence paths
      CLAWDBOT_STATE_DIR: /data/.clawdbot
      CLAWDBOT_WORKSPACE_DIR: /data/workspace
    volumes:
      - clawdbot-data:/data
    network_mode: host
    restart: unless-stopped

volumes:
  clawdbot-data:
```

**3. Create .env file**

```bash
# .env - secrets are encrypted to the TEE
REDPILL_API_KEY=rp_xxxxxxxxxxxx
# Optional: messaging channels (auto-configure on boot)
# TELEGRAM_BOT_TOKEN=your-telegram-bot-token
# DISCORD_BOT_TOKEN=your-discord-bot-token
# Optional: protect the web UI with password auth
# GATEWAY_AUTH=password
# GATEWAY_PASSWORD=your-secure-password
```

**4. Deploy to Phala Cloud**

```bash
phala deploy \
  --name clawdbot-tee \
  --compose ./docker-compose.phala.yml \
  --env-file ./.env \
  --vcpu 2 \
  --memory 4G \
  --disk-size 20G
```

**5. Access the Gateway**

After deployment, get your CVM's public URL:

```bash
phala cvms get clawdbot-tee
```

The gateway URL follows the Phala Cloud dstack format: `https://<DSTACK_APP_ID>-18789.<DSTACK_GATEWAY_URL>`. If you enabled `GATEWAY_AUTH=password`, add `?password=your-password` to the URL.

### Managing Your Deployment

```bash
# View logs
phala cvms logs clawdbot-tee

# Check status
phala cvms get clawdbot-tee

# SSH into CVM (if deployed with --dev-os)
phala ssh clawdbot-tee

# Update deployment (use CVM ID from phala cvms get)
phala deploy --cvm-id app_xxxxx --compose ./docker-compose.phala.yml

# Or if phala.toml exists from initial deploy, just run:
phala deploy
```

### Configuration via Web UI

Redpill is automatically configured as the default provider on first boot. If you provided `TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN`, those channels are also auto-configured and running.

Access your gateway URL to:

1. Configure additional channels (Slack, Signal, WhatsApp) via the Channels page
2. Start chatting with full TEE privacy (Redpill is already set as default)
3. View and switch models via the Config page (`/config`)

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDPILL_API_KEY` | Yes | Your Redpill API key (auto-configures all 18 GPU TEE models on first boot) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token (auto-configures and starts Telegram channel on boot) |
| `DISCORD_BOT_TOKEN` | No | Discord bot token (auto-configures and starts Discord channel on boot) |
| `GATEWAY_PORT` | No | Gateway port (default: `18789`) |
| `GATEWAY_AUTH` | No | Gateway auth mode: `off`, `token`, or `password` (default: `off`) |
| `GATEWAY_TOKEN` | No | Gateway token (required when `GATEWAY_AUTH=token`) |
| `GATEWAY_PASSWORD` | No | Gateway password (required when `GATEWAY_AUTH=password`) |
| `CLAWDBOT_STATE_DIR` | No | Config/credentials path (default: `/data/.clawdbot`) |
| `CLAWDBOT_WORKSPACE_DIR` | No | Workspace path (default: `/data/workspace`) |

### Securing Your Deployment

For production deployments, enable gateway authentication to protect the web UI:

```bash
# .env - with password auth enabled
REDPILL_API_KEY=rp_xxxxxxxxxxxx
GATEWAY_AUTH=password
GATEWAY_PASSWORD=your-secure-password
```

Access the UI: `https://<DSTACK_APP_ID>-18789.<DSTACK_GATEWAY_URL>?password=your-secure-password`

For token-based auth (alternative):

```bash
GATEWAY_AUTH=token
GATEWAY_TOKEN=your-secret-gateway-token
```

Access with: `https://<DSTACK_APP_ID>-18789.<DSTACK_GATEWAY_URL>?token=your-secret-gateway-token`

### Adding Messaging Channels

The following channels work in Docker/Linux environments (no Mac services required):

| Channel | Setup | Environment Variables |
|---------|-------|----------------------|
| **Telegram** | Easy | `TELEGRAM_BOT_TOKEN` |
| **Discord** | Easy | `DISCORD_BOT_TOKEN` |
| **Slack** | Medium | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` |
| **WhatsApp** | Medium | QR code login via `/setup` wizard |
| **Signal** | Hard | Requires `signal-cli` + Java |

Configure channels via the `/setup` wizard at `https://<cvm-url>:18789/setup`.

### Persistent Storage

The `clawdbot-data` volume stores:
- Channel credentials and tokens
- Agent configurations
- Session history
- Workspace files

Data persists across CVM restarts and upgrades.

## More Information

- [Redpill AI](https://redpill.ai)
- [API Documentation](https://docs.redpill.ai)
- [GPU TEE Technology](https://docs.redpill.ai/privacy/overview)
- [Pricing](https://redpill.ai/pricing)
- [Phala Cloud](https://cloud.phala.network)
- [Phala Cloud CLI Docs](https://docs.phala.network/phala-cloud/references/phala-cloud-cli/phala/overview)
