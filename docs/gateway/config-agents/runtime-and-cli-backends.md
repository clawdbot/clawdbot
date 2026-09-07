---
summary: "Agent runtime policy on providers and models, CLI backend selection, and GPT-5 personality"
read_when:
  - Choosing which harness runs a model
  - Selecting a registered CLI backend
  - Setting the OpenAI GPT-5 personality
title: "Configuration — agent runtime and CLI backends"
---

Runtime policy decides which harness executes a model run. It lives on providers and models, not on `agents.defaults`.

## Runtime policy

```json5
{
  models: {
    providers: {
      openai: {
        agentRuntime: { id: "codex" },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
      models: {
        "anthropic/claude-opus-5": {
          agentRuntime: { id: "claude-cli" },
        },
        "vllm/*": {
          agentRuntime: { id: "openclaw" },
        },
      },
    },
  },
}
```

- `id`: `"auto"`, `"openclaw"`, a registered plugin harness id, or a supported CLI backend alias. The bundled Codex plugin registers `codex`; the bundled Anthropic plugin provides the `claude-cli` CLI backend.
- `id: "auto"` lets registered plugin harnesses claim effective routes that declare or otherwise satisfy their support contract, and uses OpenClaw when no harness matches. An explicit plugin runtime such as `id: "codex"` requires that harness and a compatible effective route; it fails closed if either is unavailable or if execution fails.
- `id: "pi"` is accepted only as a deprecated alias for `openclaw` to preserve shipped configs from v2026.5.22 and earlier. New config should use `openclaw`.
- Runtime precedence is exact model policy first (`agents.entries.*.models["provider/model"]`, `agents.defaults.models["provider/model"]`, or `models.providers.<provider>.models[]`), then `agents.entries.*` / `agents.defaults.models["provider/*"]`, then provider-wide policy at `models.providers.<provider>.agentRuntime`.
- Whole-agent runtime keys are legacy. `agents.defaults.agentRuntime`, `agents.entries.*.agentRuntime`, session runtime pins, and `OPENCLAW_AGENT_RUNTIME` are ignored by runtime selection. Run `openclaw doctor --fix` to remove stale values.
- Eligible exact official HTTPS OpenAI Responses/ChatGPT routes with no authored request override may use the Codex harness implicitly. Provider/model `agentRuntime.id: "codex"` makes Codex a fail-closed requirement but does not make an incompatible route compatible.
- For Claude CLI deployments, prefer `model: "anthropic/claude-opus-5"` plus model-scoped `agentRuntime.id: "claude-cli"`. Legacy `claude-cli/<model>` refs still work for compatibility, but new config should keep provider/model selection canonical and put the execution backend in provider/model runtime policy.
- This controls text agent turns and tool-free utility completions, including session digests, progress narration, and tool-call titles. Media generation, vision, PDF, music, video, and TTS still use their provider/model settings.

**Built-in alias shorthands** (only apply when the model is in `agents.defaults.models`):

| Alias               | Model                           |
| ------------------- | ------------------------------- |
| `opus`              | `anthropic/claude-opus-5`       |
| `sonnet`            | `anthropic/claude-sonnet-5`     |
| `gpt`               | `openai/gpt-5.4`                |
| `gpt-mini`          | `openai/gpt-5.4-mini`           |
| `gpt-nano`          | `openai/gpt-5.4-nano`           |
| `gemini`            | `google/gemini-3.1-pro-preview` |
| `gemini-flash`      | `google/gemini-3-flash-preview` |
| `gemini-flash-lite` | `google/gemini-3.1-flash-lite`  |

Your configured aliases always win over defaults.

Z.AI GLM-4.x models automatically enable thinking mode unless you set `--thinking off` or define `agents.defaults.models["zai/<model>"].params.thinking` yourself.
Z.AI models enable `tool_stream` by default for tool call streaming. Set `agents.defaults.models["zai/<model>"].params.tool_stream` to `false` to disable it.
Anthropic Claude Opus 4.8 keeps thinking off by default in OpenClaw; when adaptive thinking is explicitly enabled, Anthropic's provider-owned effort default is `high`. Claude 4.6 models default to `adaptive` when no explicit thinking level is set.

## CLI backend selection

CLI adapter mechanics are registered by plugins, not configured under agent
defaults. Select a registered CLI backend with model-scoped `agentRuntime.id`,
as shown above. See [CLI backends](/gateway/cli-backends) for operations and
[building CLI backend plugins](/plugins/cli-backend-plugins) for command,
session, image, and parser registration.

## OpenAI GPT-5 personality

The bundled OpenAI plugin owns the GPT-5 friendly interaction-style setting. Matching GPT-5-family prompts receive the shared behavior contract; `personality` controls only the friendly style layer. Native Codex app-server routes keep Codex-owned base/model instructions instead of this OpenClaw GPT-5 contribution, and OpenClaw disables Codex's built-in personality for native threads.

```json5
{
  plugins: {
    entries: {
      openai: {
        config: {
          personality: "friendly", // friendly | on | off
        },
      },
    },
  },
}
```

- `"friendly"` (default) and `"on"` enable the friendly interaction-style layer.
- `"off"` disables only the friendly layer; the tagged GPT-5 behavior contract remains enabled.

See [OpenAI GPT-5 prompt contribution](/providers/openai/advanced#gpt-5-prompt-contribution) for provider and native Codex behavior.
