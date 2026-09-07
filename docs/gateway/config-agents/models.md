---
summary: "Default model, fallback chain, per-purpose model slots, and model selection scope"
read_when:
  - Setting the default model or its fallback chain
  - Pointing image, TTS, or summary work at a different model
  - Choosing how far a model change applies
title: "Configuration — agent models"
---

`agents.defaults.model` and `agents.defaults.modelSelectionScope`: which model an agent uses, what it falls back to, and how far a model change applies.

## `agents.defaults.model`

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.7": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.7"],
      },
      utilityModel: "openai/gpt-5.4-mini",
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      mediaModels: {
        image: {
          primary: "openai/gpt-image-2",
          fallbacks: ["google/gemini-3.1-flash-image"],
        },
        video: {
          primary: "qwen/wan2.6-t2v",
          fallbacks: ["qwen/wan2.6-i2v"],
        },
      },
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4-mini"],
      },
      params: { cacheRetention: "long" }, // global default provider params
      pdfMaxMb: 10,
      pdfMaxPages: 20,
      thinkingDefault: "low",
      fastModeDefault: false,
      verboseDefault: "off",
      toolProgressDetail: "explain",
      reasoningDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      maxConcurrent: 4,
    },
  },
}
```

- `model`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - String form sets only the primary model.
  - Object form sets primary plus ordered failover models.
- `utilityModel`: optional `provider/model` ref or alias for short internal tasks. It currently powers generated Control UI session titles, Telegram DM topic titles, Discord auto-thread titles, and [progress-draft narration](/concepts/progress-drafts#status-headline). When unset, OpenClaw derives the primary provider's declared small-model default when one exists (OpenAI → `gpt-5.6-luna`, Anthropic → `claude-haiku-4-5`); title tasks otherwise use the agent's primary model, and narration stays off. If a distinct utility model cannot prepare or complete a generated title, OpenClaw retries that title once with the primary model. For dashboard titles, automatic utility derivation and the regular fallback use the effective session provider and auth profile; an explicit utility model keeps its configured provider/auth. Set `utilityModel: ""` to skip the alternate utility route; dashboard title generation still proceeds directly to the regular session model. `agents.entries.*.utilityModel` overrides the default, and an operation-specific model override wins over both. Utility tasks make separate model calls and send task-specific content to the selected model provider. Dashboard title generation sends at most the first 1,000 characters of the first non-command message; narration sends the inbound request plus compact redacted tool summaries. Choose a provider that matches your cost and data-handling requirements.
- `imageModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the `view_image` tool path as its vision-model config when the active model cannot accept images. Native-vision models receive loaded image bytes directly instead.
  - Also used as fallback routing when the selected/default model cannot accept image input.
  - Prefer explicit `provider/model` refs. Bare IDs are accepted for compatibility; if a bare ID uniquely matches a configured image-capable entry in `models.providers.*.models`, OpenClaw qualifies it to that provider. Ambiguous configured matches require an explicit provider prefix.
- `mediaModels.image`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared image-generation capability and any future tool/plugin surface that generates images.
  - Typical values: `google/gemini-3.1-flash-image` for native Gemini image generation, `fal/fal-ai/flux/dev` for fal, `openai/gpt-image-2` for OpenAI Images, or `openai/gpt-image-1.5` for transparent-background OpenAI PNG/WebP output.
  - If you select a provider/model directly, configure matching provider auth too (for example `GEMINI_API_KEY` or `GOOGLE_API_KEY` for `google/*`, `OPENAI_API_KEY` or OpenAI Codex OAuth for `openai/gpt-image-2` / `openai/gpt-image-1.5`, `FAL_KEY` for `fal/*`).
  - If omitted, `image_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered image-generation providers in provider-id order.
- `mediaModels.music`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared music-generation capability and the built-in `music_generate` tool.
  - Typical values: `google/lyria-3-clip-preview`, `google/lyria-3-pro-preview`, or `minimax/music-2.6`.
  - If omitted, `music_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered music-generation providers in provider-id order.
  - If you select a provider/model directly, configure the matching provider auth/API key too.
- `mediaModels.video`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared video-generation capability and the built-in `video_generate` tool.
  - Typical values: `qwen/wan2.6-t2v`, `qwen/wan2.6-i2v`, `qwen/wan2.6-r2v`, `qwen/wan2.6-r2v-flash`, or `qwen/wan2.7-r2v`.
  - If omitted, `video_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered video-generation providers in provider-id order.
  - If you select a provider/model directly, configure the matching provider auth/API key too.
  - The official Qwen video-generation plugin supports up to 1 output video, 1 input image, 4 input videos, 10 seconds duration, and provider-level `size`, `aspectRatio`, `resolution`, `audio`, and `watermark` options.
- `pdfModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the `pdf` tool for model routing.
  - If omitted, the PDF tool falls back to `imageModel`, then to the resolved session/default model.
- `pdfMaxMb`: default PDF size limit for the `pdf` tool when `maxBytesMb` is not passed at call time.
- `pdfMaxPages`: default maximum pages considered by extraction fallback mode in the `pdf` tool.
- `fastModeDefault`: default fast mode for agents. Values: `"auto"`, `true`, `false`. Per-agent `agents.entries.*.fastModeDefault` overrides it when no per-message or session fast-mode override is set.
- `verboseDefault`: default verbose level for agents. Values: `"off"`, `"on"`, `"full"`. Default: `"off"`.
- `toolProgressDetail`: detail mode for `/verbose` tool summaries and progress-draft tool lines. Values: `"explain"` (default, compact human labels) or `"raw"` (append raw command/detail when available). Per-agent `agents.entries.*.toolProgressDetail` overrides this default.
- `reasoningDefault`: default reasoning visibility for agents. Values: `"off"`, `"on"`, `"stream"`. Per-agent `agents.entries.*.reasoningDefault` overrides this default. Configured reasoning defaults are only applied for owners, authorized senders, or operator-admin gateway contexts when no per-message or session reasoning override is set.
- `elevatedDefault`: default elevated-output level for agents. Values: `"off"`, `"on"`, `"ask"`, `"full"`. Default: `"on"`.
- `model.primary`: format `provider/model` (e.g. `openai/gpt-5.6-sol` for Codex OAuth access). If you omit the provider, OpenClaw tries an alias first, then a unique configured-provider match for that exact model id, and only then falls back to the configured default provider (deprecated compatibility behavior, so prefer explicit `provider/model`). If that provider no longer exposes the configured default model, OpenClaw falls back to the first configured provider/model instead of surfacing a stale removed-provider default.
- To cap active input for one model, set `models.providers.<provider>.models[].contextTokens`; use `contextWindow` on the same entry for its native window. See [OpenAI context window defaults](/providers/openai/setup#context-window-defaults-and-long-context-opt-in).
- `models`: configured aliases and per-model settings. Each entry can include `alias` (shortcut) and `params` (provider-specific, for example `temperature`, `maxTokens`, `cacheRetention`, `context1m`, `anthropicServerCompaction`, `anthropicCompactThreshold`, `responsesServerCompaction`, `responsesCompactThreshold`, OpenRouter `provider` routing, `chat_template_kwargs`, `extra_body`/`extraBody`). Adding entries does not restrict model overrides.
  - Use `provider/*` entries such as `"openai/*": {}` or `"vllm/*": {}` to show all discovered models for selected providers without manually listing every model id.
  - Add `agentRuntime` to a `provider/*` entry when every dynamically discovered model for that provider should use the same runtime. Exact `provider/model` runtime policy still wins over the wildcard.
  - Add `codeMode: true` or `codeMode: false` to an exact `provider/model` entry to override OpenClaw Code Mode activation. Omit it to inherit the global `tools.codeMode` default, including `"auto"`; agent-specific activation settings take precedence. This changes neither runtime selection nor Codex native Code Mode. The Control UI model editor offers **Default**, **On**, and **Off** alongside runtime settings. See [per-model Code Mode](/tools/code-mode#override-one-model) for precedence and an example.
  - Safe metadata edits: use `openclaw config set agents.defaults.models '<json>' --strict-json --merge` to add entries. `config set` refuses replacements that would remove existing entries unless you pass `--replace`.
- `modelPolicy.allow`: explicit override allowlist. Accepts aliases, exact `provider/model` refs, and trailing prefix wildcards such as `openai/*` or `clawrouter/anthropic/*`. Omit it or use `[]` to allow any model. `agents.entries.*.modelPolicy.allow` replaces the default policy for that agent; an explicit empty list opts that agent into allow-any.
  - Provider-scoped configure/onboarding flows merge selected provider models into this map and preserve unrelated providers already configured.
  - For direct Anthropic models using API-key auth, set `params.anthropicServerCompaction: true` to enable server-side compaction. Use `params.anthropicCompactThreshold` to override the input-token trigger; the default is `max(50000, floor(contextWindow * 0.7))`, and lower configured values clamp to `50000`. OAuth/subscription and non-direct endpoints are excluded. See [Anthropic server-side compaction](/providers/anthropic#advanced-configuration).
  - For store-capable direct OpenAI Responses models, server-side compaction is enabled automatically and the same effective threshold delays local preflight compaction. Use `params.responsesServerCompaction: false` to stop injecting `context_management`, or `params.responsesCompactThreshold` to override the default of 70% of the resolved context window (80,000 when unavailable). ChatGPT OAuth, custom proxies, and routes with `compat.supportsStore: false` do not enable this path. See [OpenAI server-side compaction](/providers/openai/advanced#advanced-configuration).
- `params`: global default provider parameters applied to all models. Set at `agents.defaults.params` (e.g. `{ cacheRetention: "long" }`).
- `params` merge precedence (config): `agents.defaults.params` (global base), then `agents.defaults.models["provider/model"].params` (shared per-model), then `agents.entries.*.models["provider/model"].params` (agent-specific per-model), then `agents.entries.*.params` (agent-wide). Later layers override by key. See [Prompt Caching](/reference/prompt-caching) for details.
- `models.providers.openrouter.params.provider`: OpenRouter-wide default provider-routing policy. OpenClaw forwards this to OpenRouter's request `provider` object; per-model `agents.defaults.models["openrouter/<model>"].params.provider` and agent params override by key. See [OpenRouter provider routing](/providers/openrouter#advanced-configuration).
- `params.extra_body`/`params.extraBody`: advanced pass-through JSON merged into `api: "openai-completions"` request bodies for OpenAI-compatible proxies. If it collides with generated request keys, the extra body wins; non-native completions routes still strip OpenAI-only `store` afterward.
- `params.chat_template_kwargs`: vLLM/OpenAI-compatible chat-template arguments merged into top-level `api: "openai-completions"` request bodies. For `vllm/nemotron-3-*` with thinking off, the bundled vLLM plugin automatically sends `enable_thinking: false` and `force_nonempty_content: true`; explicit `chat_template_kwargs` override generated defaults, and `extra_body.chat_template_kwargs` still has final precedence. Configured vLLM Qwen and Nemotron thinking models expose binary `/think` choices (`off`, `on`) instead of the multi-level effort ladder.
- `compat.thinkingFormat`: OpenAI-compatible thinking payload style. Use `"together"` for Together-style `reasoning.enabled`, `"qwen"` for Qwen-style top-level `enable_thinking`, or `"qwen-chat-template"` for `chat_template_kwargs.enable_thinking` on Qwen-family backends that support request-level chat-template kwargs, such as vLLM. OpenClaw maps disabled thinking to `false` and enabled thinking to `true`, and configured vLLM Qwen models expose binary `/think` choices for these formats.
- `compat.supportedReasoningEfforts`: per-model OpenAI-compatible reasoning effort list. Include `"xhigh"` for custom endpoints that truly accept it; OpenClaw then exposes `/think xhigh` in command menus, Gateway session rows, session patch validation, agent CLI validation, and `llm-task` validation for that configured provider/model. Use `compat.reasoningEffortMap` when the backend wants a provider-specific value for a canonical level.
- `params.preserveThinking`: Z.AI-only opt-in for preserved thinking. When enabled and thinking is on, OpenClaw sends `thinking.clear_thinking: false` and replays prior `reasoning_content`; see [Z.AI thinking and preserved thinking](/providers/zai#advanced-configuration).
- `localService`: optional provider-level process manager for local/self-hosted model servers. When the selected model belongs to that provider, OpenClaw probes `healthUrl` (or `baseUrl + "/models"`), starts `command` with `args` if the endpoint is down, waits up to `readyTimeoutMs`, then sends the model request. `command` must be an absolute path. `idleStopMs: 0` keeps the process alive until OpenClaw exits; a positive value stops the OpenClaw-spawned process after that many idle milliseconds. See [Local model services](/gateway/local-model-services).
- Runtime policy belongs on providers or models, not on `agents.defaults`. Use `models.providers.<provider>.agentRuntime` for provider-wide rules or `agents.defaults.models["provider/model"].agentRuntime` / `agents.entries.*.models["provider/model"].agentRuntime` for model-specific rules. A provider/model prefix alone never selects a harness. With runtime unset or `auto`, OpenAI may select Codex implicitly only for an exact official HTTPS Platform Responses or ChatGPT Responses route with no authored request override. See [OpenAI implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime).
- Config writers that mutate these fields (for example `/models set`, `/models set-image`, and fallback add/remove commands) save canonical object form and preserve existing fallback lists when possible.
- `maxConcurrent`: max parallel agent runs across sessions (each session still serialized). By default, OpenClaw uses `min(16, max(8, available CPU parallelism))`, based on `os.availableParallelism()` with `os.cpus().length` as a fallback.

<a id="agentsdefaultsmodelselectionscope" />

## `agents.defaults.modelSelectionScope`

Scope for chat commands and Gateway session model updates without an explicit scope.
The default is `"session"`: changing a model in one chat does not change other
chats or the configured default, including when the caller is an owner/admin.

```json5
{
  agents: { defaults: { modelSelectionScope: "session" } },
}
```

| Value       | Effect                                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"session"` | Change only the current session's model selection.                                                                                                              |
| `"agent"`   | Also update the current agent's explicit primary at `agents.entries.<agent>.model`, creating that primary when needed. Never change the shared global fallback. |
| `"global"`  | Also update the shared `agents.defaults.model` fallback. Do not replace other agents' explicit primaries or other sessions' pins.                               |
| Unset       | Change only the current session, the same as `"session"`.                                                                                                       |

Agent/global writes require an explicit scope flag or configuration choice. Explicit `/model` flags
`-s`/`--session`, `-a`/`--agent`, and `-g`/`--global` take precedence over the setting.
Without owner/admin authority, bare commands remain session-only and explicit
`-a` or `-g` requests are rejected. Telegram callback pickers and the embedded local TUI remain
session-only even when this setting is configured. There are no per-agent or
per-channel overrides of this setting.

Agent and global updates can affect new and existing unpinned sessions and cron
jobs that inherit the changed default on their next run. They do not rewrite
other sessions' explicit model selections. `/model default -s` clears only the
current session's selection so it inherits the current configured default.
Selecting the effective configured default clears the session model pin, but
agent/global scope still requests a write to the configured target.
See [Model selection in chat](/concepts/models#model-in-chat) for persistence,
permissions, and picker behavior.
