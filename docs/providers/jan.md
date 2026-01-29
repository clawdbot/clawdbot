---
summary: "Run Clawdbot with jan.ai (local LLM runtime using llama.cpp)"
read_when:
  - You want to run Clawdbot with local models via jan.ai
  - You need jan.ai setup and configuration guidance
---
# jan.ai

jan.ai is a local LLM runtime built on llama.cpp with OpenAI-compatible API. Clawdbot integrates with jan.ai and can **auto-discover available models** when you opt in with `JAN_API_KEY` (or an auth profile) and do not define an explicit `models.providers.jan` entry.

## Quick start

1) Install jan.ai: https://jan.ai

2) Download models using jan.ai's UI or CLI

3) Enable jan.ai for Clawdbot (any value works; jan.ai doesn't require a real key):

```bash
# Set environment variable
export JAN_API_KEY="jan-local"

# Or configure in your config file
clawdbot config set models.providers.jan.apiKey "jan-local"
```

4) Use jan.ai models:

```json5
{
  agents: {
    defaults: {
      model: { primary: "jan/llama-3.3-70b" }
    }
  }
}
```

## Model discovery (implicit provider)

When you set `JAN_API_KEY` (or an auth profile) and **do not** define `models.providers.jan`, Clawdbot discovers models from the local jan.ai instance at `http://127.0.0.1:1337/v1`:

- Queries `/v1/models` endpoint
- Includes all models from jan.ai
- Marks `reasoning` when model ID contains "r1" or "reasoning" (case-insensitive)
- Sets `input: ["text"]` for all models (jan.ai primarily supports text models)
- Sets `contextWindow` to 128000
- Sets `maxTokens` to 8192
- Sets all costs to `0` (local provider)

This avoids manual model entries while keeping the catalog aligned with your jan.ai installation.

To see what models are available:

```bash
clawdbot models list
```

If you set `models.providers.jan` explicitly, auto-discovery is skipped and you must define models manually (see below).

## Configuration

### Basic setup (implicit discovery)

The simplest way to enable jan.ai is via environment variable:

```bash
export JAN_API_KEY="jan-local"
```

### Explicit setup (manual models)

Use explicit config when:
- jan.ai runs on another host/port.
- You want to force specific context windows or model lists.
- You want to override default model settings.

```json5
{
  models: {
    providers: {
      jan: {
        baseUrl: "http://127.0.0.1:1337/v1",
        apiKey: "jan-local",
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

If `JAN_API_KEY` is set, you can omit `apiKey` in the provider entry and Clawdbot will fill it for availability checks.

### Custom base URL (explicit config)

If jan.ai is running on a different host or port (explicit config disables auto-discovery, so define models manually):

```json5
{
  models: {
    providers: {
      jan: {
        apiKey: "jan-local",
        baseUrl: "http://jan-host:1337/v1",
        api: "openai-completions"
      }
    }
  }
}
```

### Model selection

Once configured, all your jan.ai models are available:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "jan/llama-3.3-70b",
        fallback: ["jan/qwen2.5-coder-32b"]
      }
    }
  }
}
```

## Advanced

### Reasoning models

Clawdbot marks models as reasoning-capable when the model ID contains "r1" or "reasoning" (case-insensitive). This includes models like DeepSeek-R1 and other reasoning models.

### Model Costs

jan.ai runs locally, so all model costs are set to $0.

### Context windows

For auto-discovered models, Clawdbot defaults to a context window of 128000 and maxTokens of 8192. You can override these values in explicit provider config.

## Troubleshooting

### jan.ai not detected

Make sure jan.ai is running and that you set `JAN_API_KEY` (or an auth profile), and that you did **not** define an explicit `models.providers.jan` entry.

And that the API is accessible:

```bash
curl http://localhost:1337/v1/models
```

### No models available

Make sure jan.ai has models downloaded and available. Check the jan.ai UI to ensure models are installed, or download models through jan.ai's interface.

To verify API endpoint accessibility:

```bash
curl http://localhost:1337/v1/models
```

### Connection refused

Check that jan.ai is running on the correct port (default 1337):

```bash
# Check if jan.ai is running on port 1337
netstat -an | grep 1337

# Or restart jan.ai
# Restart through the jan.ai application or service
```

## See Also

- [Model Providers](/concepts/model-providers) - Overview of all providers
- [Model Selection](/concepts/models) - How to choose models
- [Gateway Configuration](/gateway/configuration) - Full config reference
- [Ollama Provider](/providers/ollama) - Similar local provider for comparison
