---
summary: "Run OpenClaw for free or low cost using local models and budget-friendly providers"
read_when:
  - You want to minimize API costs
  - You want to run OpenClaw with local models
  - You're looking for cheaper alternatives to Claude/OpenAI
title: "Running OpenClaw on a Budget"
---

# Running OpenClaw on a Budget

OpenClaw works with many AI providers, from expensive frontier models to completely free local options. This guide helps you choose the most cost-effective setup for your needs.

## Cost comparison at a glance

| Provider | Cost | Best for |
|----------|------|----------|
| [Ollama](#free-local-models-with-ollama) | **Free** | Privacy, offline use, unlimited usage |
| [DeepSeek](#very-cheap-deepseek-api) | ~$0.14/M input | High quality at low cost |
| [OpenRouter](#flexible-openrouter) | Varies | Access to many models, pay-per-use |
| [Venice](#privacy-focused-venice) | Subscription | Privacy + hosted convenience |
| [Claude/OpenAI API](#when-to-use-frontier-models) | $3-15/M input | Maximum capability |

## Free: Local models with Ollama

The cheapest way to run OpenClaw is with local models via [Ollama](/providers/ollama). Models run entirely on your machine with zero API costs.

### Quick start

1. Install Ollama from [ollama.ai](https://ollama.ai)

2. Pull a capable model:

```bash
# General purpose (recommended starting point)
ollama pull llama3.3

# For coding tasks
ollama pull qwen2.5-coder:32b

# For reasoning tasks
ollama pull deepseek-r1:32b
```

3. Enable in OpenClaw:

```bash
export OLLAMA_API_KEY="ollama-local"
```

4. Set as default model:

```json5
{
  agents: {
    defaults: {
      model: { primary: "ollama/llama3.3" },
    },
  },
}
```

OpenClaw auto-discovers tool-capable Ollama models. Run `openclaw models list` to see available models.

### Hardware requirements

| Model size | RAM needed | GPU VRAM |
|------------|------------|----------|
| 7B params | 8GB | 6GB |
| 13B params | 16GB | 10GB |
| 32B params | 32GB | 24GB |
| 70B params | 64GB+ | 48GB+ |

**Tip:** `llama3.3` is a 70B model. If your hardware is closer to the top of the table, start with a smaller model such as `mistral` (7B) to test your setup, then move up.

### Recommended local models

- **llama3.3** - Best balance of speed and capability for general use
- **qwen2.5-coder:32b** - Excellent for coding tasks
- **deepseek-r1:32b** - Strong reasoning, marked as `reasoning: true` automatically
- **mistral** - Fast and lightweight

## Very cheap: DeepSeek API

[DeepSeek](https://deepseek.com) offers high-quality models at very competitive prices (~10x cheaper than Claude/OpenAI for many tasks).

### Configuration

```json5
{
  models: {
    providers: {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        apiKey: "$DEEPSEEK_API_KEY",  // or set env var
        api: "openai-completions",
        models: [
          {
            id: "deepseek-chat",
            name: "DeepSeek Chat",
            contextWindow: 200000,
            maxTokens: 8192,
            reasoning: false,
            cost: { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 }
          },
          {
            id: "deepseek-reasoner",
            name: "DeepSeek Reasoner",
            contextWindow: 200000,
            maxTokens: 8192,
            reasoning: true,
            cost: { input: 0.55, output: 2.19, cacheRead: 0.055, cacheWrite: 0.55 }
          }
        ]
      }
    }
  },
  agents: {
    defaults: {
      model: { primary: "deepseek/deepseek-chat" },
    },
  },
}
```

**Note:** Get your API key at [platform.deepseek.com](https://platform.deepseek.com).

## Flexible: OpenRouter

[OpenRouter](/providers/openrouter) provides unified access to many models through a single API. Pay only for what you use, with access to both budget and premium options.

### Setup

```bash
openclaw onboard --auth-choice apiKey --token-provider openrouter --token "$OPENROUTER_API_KEY"
```

### Budget-friendly models on OpenRouter

```json5
{
  agents: {
    defaults: {
      model: {
        // Use a cheap model by default
        primary: "openrouter/meta-llama/llama-3.3-70b-instruct",
        // Fall back to Claude for complex tasks
        fallbacks: ["openrouter/anthropic/claude-sonnet-4-5"],
      },
    },
  },
}
```

Check [openrouter.ai/models](https://openrouter.ai/models) for current pricing. Sort by price to find the cheapest options.

## Privacy-focused: Venice

[Venice](/providers/venice) offers privacy-first inference with no data retention. It's our recommended hosted option for users who want convenience without compromising privacy.

```json5
{
  agents: {
    defaults: {
      model: { primary: "venice/llama-3.3-70b" },
    },
  },
}
```

## Monitoring your costs

OpenClaw includes built-in cost tracking:

### Check current usage

```
/status
```

Shows session model, context usage, and estimated cost.

### Enable per-response tracking

```
/usage full
```

Appends token counts and costs to every response.

### View session cost summary

```
/usage cost
```

Shows accumulated costs from session logs.

## Tips for reducing costs

### 1. Use `/compact` regularly

Long conversations accumulate context. Summarize periodically:

```
/compact
```

### 2. Choose smaller models for simple tasks

Use expensive models only when needed:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "ollama/llama3.3",  // Free for most tasks
        fallbacks: ["anthropic/claude-sonnet-4-5"],  // Paid backup
      },
    },
  },
}
```

### 3. Keep skill descriptions short

Skills are injected into every prompt. Verbose descriptions add token overhead.

### 4. Leverage prompt caching

For Anthropic models, keep the cache warm to reduce costs:

```json5
{
  agents: {
    defaults: {
      heartbeat: { every: "55m" },  // Just under 1h cache TTL
    },
  },
}
```

### 5. Trim large tool outputs

Configure tools to return only essential information.

## When to use frontier models

Local and budget models work well for:
- Casual conversations
- Simple coding tasks
- Research and summarization
- Routine automation

Consider Claude or GPT-4 for:
- Complex multi-step reasoning
- Large codebase refactoring
- Tasks requiring deep context understanding
- When accuracy is critical

## Automatic: Smart Model Tiering

OpenClaw can automatically route simple queries to a cheaper model, keeping your primary model for work that needs it.

Note the direction of the default: tiering routes a message to the **cheap** model unless it matches a complexity signal. It is an opt-out list, not an opt-in one, so more than just pleasantries will go to the cheap model.

### Enable tiering

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",  // Complex tasks
        tiering: {
          enabled: true,
          simple: "ollama/llama3.3",  // Simple queries (free)
        },
      },
    },
  },
}
```

### How it works

A message goes to the **primary** model when it matches any complexity signal:

- Code requests: "write a function that..."
- Multi-step reasoning: "step by step", "compare and contrast"
- System operations: "git commit", "npm install"
- Two or more question words ("what", "why", "how", "explain", ...)
- Requests for an enumerated list: "show me all ..."
- Messages longer than 500 characters (see `complexLengthThreshold`)

Everything else goes to the **cheap** model, including short greetings
("hi", "thanks", "yes") and single-word messages. Because the classifier only
looks at the wording of the message, it is a cost heuristic and not a capability
check: if the cheap model is much weaker than your primary, expect some
misroutes.

Only the current message is classified. In group batches and queued turns that
carry earlier context, the accumulated history is ignored.

### What tiering never overrides

Tiering only replaces the model you would otherwise have got by default. It
leaves a deliberate choice alone:

- An inline `/model` directive on the message
- A sticky session model set earlier with `/model`
- `agents.defaults.heartbeat.model` on heartbeat runs

It also respects the `agents.defaults.models` allowlist: if you keep one, the
tiered model must be in it, exactly as with `/model`.

Tiering applies on every surface — chat channels, the `openclaw agent` CLI, the
gateway RPC, and the OpenAI-compatible HTTP APIs.

### Customize detection

```json5
{
  tiering: {
    enabled: true,
    simple: "ollama/llama3.3",
    // Custom patterns that trigger complex tier (regex)
    complexPatterns: ["\\bspecial\\b.*\\bkeyword\\b"],
    // Character threshold for complexity (default: 500)
    complexLengthThreshold: 300,
  },
}
```

Patterns are validated when the config loads, so an uncompilable regex is
reported instead of being silently ignored. Only the first 4000 characters of a
message are scanned for patterns, regardless of `complexLengthThreshold`.

### Per-agent tiering

Set `tiering` on an individual agent to override the global config. Fields merge
over `agents.defaults.model.tiering`, so you can change just one:

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        tiering: { enabled: true, simple: "ollama/llama3.3" },
      },
    },
    list: [
      {
        id: "researcher",
        // Inherits enabled: true, but routes simple work elsewhere.
        model: { tiering: { simple: "deepseek/deepseek-chat" } },
      },
      {
        id: "oncall",
        // Always uses the primary model.
        model: { tiering: { enabled: false } },
      },
    ],
  },
}
```

## Hybrid approach

The most cost-effective setup often combines approaches:

```json5
{
  agents: {
    defaults: {
      model: {
        // Free local model for routine work
        primary: "ollama/llama3.3",
        // Cheap API for when local isn't enough
        fallbacks: ["deepseek/deepseek-chat", "anthropic/claude-sonnet-4-5"],
      },
    },
  },
}
```

## See also

- [Ollama provider](/providers/ollama) - Full local model setup
- [OpenRouter provider](/providers/openrouter) - Multi-model access
- [Token use and costs](/token-use) - Detailed cost tracking
- [Model providers](/providers/index) - All supported providers
