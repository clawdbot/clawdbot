# W&B Weave Plugin for Clawdbot

Integrates [Weights & Biases Weave](https://weave-docs.wandb.ai/) for comprehensive LLM observability and tracing.

## Features

- **Full System Prompt Capture** - Captures the complete system prompt, tracks changes across requests
- **Multi-Turn Conversation Tracing** - Tracks all LLM requests in a conversation, not just the first
- **Tool Call Spans** - Logs each tool call with inputs, outputs, and duration as child spans
- **Session Lifecycle Tracking** - Monitors session start/end with aggregated metrics
- **All LLM Providers** - Works with Claude, GPT, Gemini, Bedrock, and all pi-ai supported models

## Installation

The plugin is included in Clawdbot. Enable it in your configuration:

```json
{
  "plugins": {
    "entries": {
      "weave": {
        "enabled": true,
        "config": {
          "apiKey": "wandb_...",
          "entity": "your-username"
        }
      }
    }
  }
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | string | **required** | W&B API key ([get one here](https://wandb.ai/settings)) |
| `entity` | string | **required** | W&B entity (username or team name) |
| `project` | string | `"clawdbot"` | Project name for traces |
| `autoTrace` | boolean | `true` | Automatically trace all agent runs |
| `traceToolCalls` | boolean | `true` | Log tool calls as child spans |
| `traceSessions` | boolean | `true` | Track session lifecycle |
| `baseUrl` | string | - | Custom W&B server URL (for self-hosted) |
| `sampleRate` | number | `1.0` | Trace sampling rate (0.0 to 1.0) |
| `debug` | boolean | `false` | Enable verbose debug logging |

## Trace Data

Each agent run trace includes:

### Inputs
- User messages
- Session context (compaction summaries)

### Outputs
- Assistant messages
- Final response
- Tool call results

### Metadata
- **systemPrompt** - Full system prompt (latest version if changed)
- **systemPromptChanges** - Number of times the system prompt changed
- **llmRequests** - Array of all LLM API requests (each with full system prompt)
- **llmRequestCount** - Number of LLM requests made
- **llmTools** - Available tools/functions
- **toolCalls** - Detailed tool execution data

### Tool Call Spans
Each tool call is logged as a child span with:
- Tool name
- Input parameters
- Output/result
- Duration
- Success/error status

## Supported LLM Providers

The plugin works with all providers supported by pi-ai:

| Provider | API | Models |
|----------|-----|--------|
| Anthropic | `anthropic-messages` | Claude Opus 4.5, Claude Sonnet 4.5, etc. |
| Google | `google-generative-ai` | Gemini 3 Pro, Gemini 3 Flash, etc. |
| OpenAI | `openai-completions` | GPT-5.2, GPT-4o, o3, etc. |
| OpenAI | `openai-responses` | Newer response API |
| AWS | `bedrock-converse-stream` | Bedrock models |
| Google Cloud | `google-vertex` | Vertex AI models |
| Others | `openai-completions` | OpenRouter, DeepSeek, Grok, Mistral, etc. |

## Viewing Traces

1. Go to [wandb.ai](https://wandb.ai)
2. Navigate to your project (e.g., `your-username/clawdbot`)
3. Click on "Weave" in the left sidebar
4. Browse traces, view spans, and analyze metrics

## Troubleshooting

### No traces appearing
- Verify your API key is correct
- Check that `autoTrace` is `true`
- Look for errors in Clawdbot logs with `[weave]` prefix

### Missing system prompt
- The `llm_request` hook must be enabled in Clawdbot core
- Check `systemPromptChanges` field to see if prompt changed during conversation

### Partial traces
- Check `sampleRate` - if less than 1.0, some traces are skipped
- Ensure agent completes normally (crashes may lose trace data)

## Development

```bash
# Build
cd extensions/weave
pnpm build

# Watch mode
pnpm dev
```

## Links

- [W&B Weave Documentation](https://weave-docs.wandb.ai/)
- [Weave TypeScript SDK](https://www.npmjs.com/package/weave)
- [Clawdbot Plugin SDK](../../docs/plugins.md)
