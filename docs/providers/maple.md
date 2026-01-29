# Maple AI Provider

Maple AI provides TEE-based (Trusted Execution Environment) private inference using Confidential Computing. All inference runs in secure enclaves with end-to-end encryption and cryptographic attestations, ensuring your prompts and responses remain private.

## How It Works

Maple AI runs as a local proxy (desktop app or Docker container) that connects to secure TEE enclaves. Your data is encrypted end-to-end and never visible to Maple or any third party. Maple runs the largest, state-of-the-art open models and does not share any data back to the model creators. Sign up at [trymaple.ai](https://trymaple.ai) to get started. Maple Proxy requires a paid account with API credits.

1. **Desktop App or Docker**: Run the Maple proxy locally
2. **Local Proxy**: Default endpoint at `http://127.0.0.1:8080/v1`
3. **TEE Backend**: Requests are forwarded to Maple's secure enclaves
4. **Cryptographic Attestation**: Verify the enclave is running trusted code

## Features

- **End-to-end encryption**: Your prompts and responses are encrypted
- **Cryptographic attestations**: Verify the secure enclave integrity
- **Open-source verifiable code**: Audit the code running in the enclave
- **OpenAI-compatible API**: Standard `/v1` endpoints for easy integration
- **Streaming**: Required for all completions

## Setup

### 1. Install Maple Proxy

**Desktop App (Recommended)**

Download and run the Maple desktop app from [trymaple.ai/downloads](https://trymaple.ai/downloads). The proxy runs automatically on `http://127.0.0.1:8080/v1`.

**Docker**

```bash
docker run -p 8080:8080 \
  -e MAPLE_BACKEND_URL=https://enclave.trymaple.ai \
  -e MAPLE_ENABLE_CORS=true \
  trymaple/proxy
```

### 2. Generate API Key

Open the Maple app and generate an API key. This key authenticates your requests to the local proxy.

### 3. Configure Moltbot

**Option A: Interactive Setup (Recommended)**

```bash
moltbot onboard --auth-choice maple-api-key
```

This will:
1. Prompt for your API key
2. Ask for the proxy URL (defaults to `http://127.0.0.1:8080/v1`)
3. Configure the provider automatically

**Option B: Environment Variable**

```bash
export MAPLE_API_KEY="your-api-key"
```

**Option C: Non-interactive**

```bash
moltbot onboard --non-interactive \
  --auth-choice maple-api-key \
  --token "your-api-key" \
  --token-provider maple
```

### 4. Verify Setup

```bash
moltbot chat --model maple/llama-3.3-70b "Hello, are you working?"
```

## Available Models

| Model ID | Name | Use Case | Pricing |
|----------|------|----------|---------|
| `kimi-k2-thinking` | Kimi K2 Thinking | Complex agentic workflows, multi-step coding, web research | $4/$4 per M tokens |
| `gpt-oss-120b` | GPT OSS 120B | Creative writing, structured data | $4/$4 |
| `deepseek-r1-0528` | DeepSeek R1 | Research, advanced math, coding | $4/$4 |
| `qwen3-coder-480b` | Qwen3 Coder 480B | Agentic coding, large codebase analysis, browser automation | $4/$4 |
| `qwen3-vl-30b` | Qwen3 VL 30B | Image and video analysis, screenshot-to-code, OCR, GUI automation | $4/$4 |
| `llama-3.3-70b` | Llama 3.3 70B | General reasoning, conversation | $4/$4 |
| `gemma-3-27b` | Gemma 3 27B | General purpose, efficient | $10/$10 |

## Model Selection

Change your default model anytime:

```bash
moltbot models set maple/llama-3.3-70b
moltbot models set maple/deepseek-r1-0528
```

List available models:

```bash
moltbot models list | grep maple
```

## Configuration

### Custom Proxy URL

If running the proxy on a different host or port:

```yaml
# ~/.moltbot.yaml
models:
  providers:
    maple:
      baseUrl: "http://192.168.1.100:8080/v1"
      api: "openai-completions"
      apiKey: "MAPLE_API_KEY"
```

### Docker Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MAPLE_BACKEND_URL` | TEE enclave URL | `https://enclave.trymaple.ai` |
| `MAPLE_ENABLE_CORS` | Enable CORS headers | `false` |
| `RUST_LOG` | Log level | `info` |

## Usage Examples

```bash
# General chat
moltbot chat --model maple/llama-3.3-70b

# Advanced reasoning
moltbot chat --model maple/kimi-k2-thinking

# Research and coding
moltbot chat --model maple/deepseek-r1-0528

# Vision tasks
moltbot chat --model maple/qwen3-vl-30b

# Coding tasks
moltbot chat --model maple/qwen3-coder-480b
```

## Privacy and Security

### Why TEE?

Trusted Execution Environments (TEEs) provide hardware-level isolation:

- **Memory encryption**: Data is encrypted in memory
- **Attestation**: Cryptographic proof of what code is running
- **Isolation**: Even the host system cannot access enclave data

### Security Proof Attestation

Maple provides cryptographic attestations that prove the integrity of the secure enclave. You can view the current attestations at [trymaple.ai/proof](https://trymaple.ai/proof).

The Maple Proxy automatically verifies these attestations before connecting to the backend. If the attestation is invalid or tampered with, the proxy refuses to connect, similar to how SSL/TLS certificates protect web connections. This ensures you're always communicating with a genuine, unmodified Maple enclave.

### Verification

You can verify the enclave attestation to ensure:

1. The code running matches the open-source release
2. The TEE hardware is genuine
3. No tampering has occurred

Visit [trymaple.ai/proof](https://trymaple.ai/proof) to inspect the current attestation details.

## Troubleshooting

### Proxy not running

Ensure the Maple app is running or Docker container is active:

```bash
curl http://127.0.0.1:8080/health
```

### Connection refused

Check the proxy URL is correct and the service is running:

```bash
# Test connectivity
curl -H "Authorization: Bearer $MAPLE_API_KEY" \
  http://127.0.0.1:8080/v1/models
```

### Model not available

The model list is fetched from the proxy. Ensure your Maple subscription includes the model you're trying to use.

## Links

- [Maple AI](https://trymaple.ai)
- [Downloads](https://trymaple.ai/downloads)
- [Security Proof](https://trymaple.ai/proof)
- [Proxy Documentation](https://blog.trymaple.ai/maple-proxy-documentation/)
- [Maple GitHub](https://github.com/OpenSecretCloud/Maple)
- [Maple Proxy GitHub](https://github.com/OpenSecretCloud/maple-proxy)
