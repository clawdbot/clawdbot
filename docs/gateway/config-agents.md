---
summary: "Agent defaults, multi-agent routing, session, messages, and talk config"
read_when:
  - Tuning agent defaults (models, thinking, workspace, heartbeat, media, skills)
  - Configuring multi-agent routing and bindings
  - Adjusting session, message delivery, and talk-mode behavior
title: "Configuration — agents"
---

Agent-scoped configuration keys under `agents.*`, `multiAgent.*`, `session.*`,
`messages.*`, and `talk.*`. For channels, tools, gateway runtime, and other
top-level keys, see [Configuration reference](/gateway/configuration-reference).

## Agent defaults

### `agents.defaults.workspace`

Default: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

### `agents.defaults.repoRoot`

Optional repository root shown in the system prompt's Runtime line. If unset, OpenClaw auto-detects by walking upward from the workspace.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skills`

Optional default skill allowlist for agents that do not set
`agents.list[].skills`.

```json5
{
  agents: {
    defaults: { skills: ["github", "weather"] },
    list: [
      { id: "writer" }, // inherits github, weather
      { id: "docs", skills: ["docs-search"] }, // replaces defaults
      { id: "locked-down", skills: [] }, // no skills
    ],
  },
}
```

- Omit `agents.defaults.skills` for unrestricted skills by default.
- Omit `agents.list[].skills` to inherit the defaults.
- Set `agents.list[].skills: []` for no skills.
- A non-empty `agents.list[].skills` list is the final set for that agent; it
  does not merge with defaults.

### `agents.defaults.skipBootstrap`

Disables automatic creation of workspace bootstrap files (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`).

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.contextInjection`

Controls when workspace bootstrap files are injected into the system prompt. Default: `"always"`.

- `"continuation-skip"`: safe continuation turns (after a completed assistant response) skip workspace bootstrap re-injection, reducing prompt size. Heartbeat runs and post-compaction retries still rebuild context.
- `"never"`: disable workspace bootstrap and context-file injection on every turn. Use this only for agents that fully own their prompt lifecycle (custom context engines, native runtimes that build their own context, or specialized bootstrap-free workflows). Heartbeat and compaction-recovery turns also skip injection.

```json5
{
  agents: { defaults: { contextInjection: "continuation-skip" } },
}
```

### `agents.defaults.bootstrapMaxChars`

Max characters per workspace bootstrap file before truncation. Default: `12000`.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 12000 } },
}
```

### `agents.defaults.bootstrapTotalMaxChars`

Max total characters injected across all workspace bootstrap files. Default: `60000`.

```json5
{
  agents: { defaults: { bootstrapTotalMaxChars: 60000 } },
}
```

### `agents.defaults.bootstrapPromptTruncationWarning`

Controls agent-visible warning text when bootstrap context is truncated.
Default: `"once"`.

- `"off"`: never inject warning text into the system prompt.
- `"once"`: inject warning once per unique truncation signature (recommended).
- `"always"`: inject warning on every run when truncation exists.

```json5
{
  agents: { defaults: { bootstrapPromptTruncationWarning: "once" } }, // off | once | always
}
```

### Context budget ownership map

OpenClaw has multiple high-volume prompt/context budgets, and they are
intentionally split by subsystem instead of all flowing through one generic
knob.

- `agents.defaults.bootstrapMaxChars` /
  `agents.defaults.bootstrapTotalMaxChars`:
  normal workspace bootstrap injection.
- `agents.defaults.startupContext.*`:
  one-shot reset/startup model-run prelude, including recent daily
  `memory/*.md` files. Bare chat `/new` and `/reset` commands are
  acknowledged without invoking the model.
- `skills.limits.*`:
  the compact skills list injected into the system prompt.
- `agents.defaults.contextLimits.*`:
  bounded runtime excerpts and injected runtime-owned blocks.
- `memory.qmd.limits.*`:
  indexed memory-search snippet and injection sizing.

Use the matching per-agent override only when one agent needs a different
budget:

- `agents.list[].skillsLimits.maxSkillsPromptChars`
- `agents.list[].contextLimits.*`

#### `agents.defaults.startupContext`

Controls the first-turn startup prelude injected on reset/startup model runs.
Bare chat `/new` and `/reset` commands acknowledge the reset without invoking
the model, so they do not load this prelude.

```json5
{
  agents: {
    defaults: {
      startupContext: {
        enabled: true,
        applyOn: ["new", "reset"],
        dailyMemoryDays: 2,
        maxFileBytes: 16384,
        maxFileChars: 1200,
        maxTotalChars: 2800,
      },
    },
  },
}
```

#### `agents.defaults.contextLimits`

Shared defaults for bounded runtime context surfaces.

```json5
{
  agents: {
    defaults: {
      contextLimits: {
        memoryGetMaxChars: 12000,
        memoryGetDefaultLines: 120,
        toolResultMaxChars: 16000,
        postCompactionMaxChars: 1800,
      },
    },
  },
}
```

- `memoryGetMaxChars`: default `memory_get` excerpt cap before truncation
  metadata and continuation notice are added.
- `memoryGetDefaultLines`: default `memory_get` line window when `lines` is
  omitted.
- `toolResultMaxChars`: live tool-result cap used for persisted results and
  overflow recovery.
- `postCompactionMaxChars`: AGENTS.md excerpt cap used during post-compaction
  refresh injection.

#### `agents.list[].contextLimits`

Per-agent override for the shared `contextLimits` knobs. Omitted fields inherit
from `agents.defaults.contextLimits`.

```json5
{
  agents: {
    defaults: {
      contextLimits: {
        memoryGetMaxChars: 12000,
        toolResultMaxChars: 16000,
      },
    },
    list: [
      {
        id: "tiny-local",
        contextLimits: {
          memoryGetMaxChars: 6000,
          toolResultMaxChars: 8000,
        },
      },
    ],
  },
}
```

#### `skills.limits.maxSkillsPromptChars`

Global cap for the compact skills list injected into the system prompt. This
does not affect reading `SKILL.md` files on demand.

```json5
{
  skills: {
    limits: {
      maxSkillsPromptChars: 18000,
    },
  },
}
```

#### `agents.list[].skillsLimits.maxSkillsPromptChars`

Per-agent override for the skills prompt budget.

```json5
{
  agents: {
    list: [
      {
        id: "tiny-local",
        skillsLimits: {
          maxSkillsPromptChars: 6000,
        },
      },
    ],
  },
}
```

### `agents.defaults.imageMaxDimensionPx`

Max pixel size for the longest image side in transcript/tool image blocks before provider calls.
Default: `1200`.

Lower values usually reduce vision-token usage and request payload size for screenshot-heavy runs.
Higher values preserve more visual detail.

```json5
{
  agents: { defaults: { imageMaxDimensionPx: 1200 } },
}
```

### `agents.defaults.userTimezone`

Timezone for system prompt context (not message timestamps). Falls back to host timezone.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Time format in system prompt. Default: `auto` (OS preference).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `agents.defaults.model`

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
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      imageGenerationModel: {
        primary: "openai/gpt-image-2",
        fallbacks: ["google/gemini-3.1-flash-image-preview"],
      },
      videoGenerationModel: {
        primary: "qwen/wan2.6-t2v",
        fallbacks: ["qwen/wan2.6-i2v"],
      },
      pdfModel: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["openai/gpt-5.4-mini"],
      },
      params: { cacheRetention: "long" }, // global default provider params
      agentRuntime: {
        id: "pi", // pi | auto | registered harness id, e.g. codex
        fallback: "pi", // pi | none
      },
      pdfMaxBytesMb: 10,
      pdfMaxPages: 20,
      thinkingDefault: "low",
      verboseDefault: "off",
      reasoningDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      contextTokens: 200000,
      maxConcurrent: 3,
    },
  },
}
```

- `model`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - String form sets only the primary model.
  - Object form sets primary plus ordered failover models.
- `imageModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the `image` tool path as its vision-model config.
  - Also used as fallback routing when the selected/default model cannot accept image input.
  - Prefer explicit `provider/model` refs. Bare IDs are accepted for compatibility; if a bare ID uniquely matches a configured image-capable entry in `models.providers.*.models`, OpenClaw qualifies it to that provider. Ambiguous configured matches require an explicit provider prefix.
- `imageGenerationModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared image-generation capability and any future tool/plugin surface that generates images.
  - Typical values: `google/gemini-3.1-flash-image-preview` for native Gemini image generation, `fal/fal-ai/flux/dev` for fal, `openai/gpt-image-2` for OpenAI Images, or `openai/gpt-image-1.5` for transparent-background OpenAI PNG/WebP output.
  - If you select a provider/model directly, configure matching provider auth too (for example `GEMINI_API_KEY` or `GOOGLE_API_KEY` for `google/*`, `OPENAI_API_KEY` or OpenAI Codex OAuth for `openai/gpt-image-2` / `openai/gpt-image-1.5`, `FAL_KEY` for `fal/*`).
  - If omitted, `image_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered image-generation providers in provider-id order.
- `musicGenerationModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared music-generation capability and the built-in `music_generate` tool.
  - Typical values: `google/lyria-3-clip-preview`, `google/lyria-3-pro-preview`, or `minimax/music-2.6`.
  - If omitted, `music_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered music-generation providers in provider-id order.
  - If you select a provider/model directly, configure the matching provider auth/API key too.
- `videoGenerationModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the shared video-generation capability and the built-in `video_generate` tool.
  - Typical values: `qwen/wan2.6-t2v`, `qwen/wan2.6-i2v`, `qwen/wan2.6-r2v`, `qwen/wan2.6-r2v-flash`, or `qwen/wan2.7-r2v`.
  - If omitted, `video_generate` can still infer an auth-backed provider default. It tries the current default provider first, then the remaining registered video-generation providers in provider-id order.
  - If you select a provider/model directly, configure the matching provider auth/API key too.
  - The bundled Qwen video-generation provider supports up to 1 output video, 1 input image, 4 input videos, 10 seconds duration, and provider-level `size`, `aspectRatio`, `resolution`, `audio`, and `watermark` options.
- `pdfModel`: accepts either a string (`"provider/model"`) or an object (`{ primary, fallbacks }`).
  - Used by the `pdf` tool for model routing.
  - If omitted, the PDF tool falls back to `imageModel`, then to the resolved session/default model.
- `pdfMaxBytesMb`: default PDF size limit for the `pdf` tool when `maxBytesMb` is not passed at call time.
- `pdfMaxPages`: default maximum pages considered by extraction fallback mode in the `pdf` tool.
- `verboseDefault`: default verbose level for agents. Values: `"off"`, `"on"`, `"full"`. Default: `"off"`.
- `reasoningDefault`: default reasoning visibility for agents. Values: `"off"`, `"on"`, `"stream"`. Per-agent `agents.list[].reasoningDefault` overrides this default. Configured reasoning defaults are only applied for owners, authorized senders, or operator-admin gateway contexts when no per-message or session reasoning override is set.
- `elevatedDefault`: default elevated-output level for agents. Values: `"off"`, `"on"`, `"ask"`, `"full"`. Default: `"on"`.
- `model.primary`: format `provider/model` (e.g. `openai/gpt-5.5` for API-key access or `openai-codex/gpt-5.5` for Codex OAuth). If you omit the provider, OpenClaw tries an alias first, then a unique configured-provider match for that exact model id, and only then falls back to the configured default provider (deprecated compatibility behavior, so prefer explicit `provider/model`). If that provider no longer exposes the configured default model, OpenClaw falls back to the first configured provider/model instead of surfacing a stale removed-provider default.
- `models`: the configured model catalog and allowlist for `/model`. Each entry can include `alias` (shortcut) and `params` (provider-specific, for example `temperature`, `maxTokens`, `cacheRetention`, `context1m`, `responsesServerCompaction`, `responsesCompactThreshold`, `chat_template_kwargs`, `extra_body`/`extraBody`).
  - Safe edits: use `openclaw config set agents.defaults.models '<json>' --strict-json --merge` to add entries. `config set` refuses replacements that would remove existing allowlist entries unless you pass `--replace`.
  - Provider-scoped configure/onboarding flows merge selected provider models into this map and preserve unrelated providers already configured.
  - For direct OpenAI Responses models, server-side compaction is enabled automatically. Use `params.responsesServerCompaction: false` to stop injecting `context_management`, or `params.responsesCompactThreshold` to override the threshold. See [OpenAI server-side compaction](/providers/openai#server-side-compaction-responses-api).
- `params`: global default provider parameters applied to all models. Set at `agents.defaults.params` (e.g. `{ cacheRetention: "long" }`).
- `params` merge precedence (config): `agents.defaults.params` (global base) is overridden by `agents.defaults.models["provider/model"].params` (per-model), then `agents.list[].params` (matching agent id) overrides by key. See [Prompt Caching](/reference/prompt-caching) for details.
- `params.extra_body`/`params.extraBody`: advanced pass-through JSON merged into `api: "openai-completions"` request bodies for OpenAI-compatible proxies. If it collides with generated request keys, the extra body wins; non-native completions routes still strip OpenAI-only `store` afterward.
- `params.chat_template_kwargs`: vLLM/OpenAI-compatible chat-template arguments merged into top-level `api: "openai-completions"` request bodies. For `vllm/nemotron-3-*` with thinking off, the bundled vLLM plugin automatically sends `enable_thinking: false` and `force_nonempty_content: true`; explicit `chat_template_kwargs` override generated defaults, and `extra_body.chat_template_kwargs` still has final precedence. For vLLM Qwen thinking controls, set `params.qwenThinkingFormat` to `"chat-template"` or `"top-level"` on that model entry.
- `compat.supportedReasoningEfforts`: per-model OpenAI-compatible reasoning effort list. Include `"xhigh"` for custom endpoints that truly accept it; OpenClaw then exposes `/think xhigh` in command menus, Gateway session rows, session patch validation, agent CLI validation, and `llm-task` validation for that configured provider/model. Use `compat.reasoningEffortMap` when the backend wants a provider-specific value for a canonical level.
- `params.preserveThinking`: Z.AI-only opt-in for preserved thinking. When enabled and thinking is on, OpenClaw sends `thinking.clear_thinking: false` and replays prior `reasoning_content`; see [Z.AI thinking and preserved thinking](/providers/zai#thinking-and-preserved-thinking).
- `agentRuntime`: default low-level agent runtime policy. Omitted id defaults to OpenClaw Pi. Use `id: "pi"` to force the built-in PI harness, `id: "auto"` to let registered plugin harnesses claim supported models, a registered harness id such as `id: "codex"`, or a supported CLI backend alias such as `id: "claude-cli"`. Set `fallback: "none"` to disable automatic PI fallback. Explicit plugin runtimes such as `codex` fail closed by default unless you set `fallback: "pi"` in the same override scope. Keep model refs canonical as `provider/model`; select Codex, Claude CLI, Gemini CLI, and other execution backends through runtime config instead of legacy runtime provider prefixes. See [Agent runtimes](/concepts/agent-runtimes) for how this differs from provider/model selection.
- Config writers that mutate these fields (for example `/models set`, `/models set-image`, and fallback add/remove commands) save canonical object form and preserve existing fallback lists when possible.
- `maxConcurrent`: max parallel agent runs across sessions (each session still serialized). Default: 4.

### `agents.defaults.agentRuntime`

`agentRuntime` controls which low-level executor runs agent turns. Most
deployments should keep the default OpenClaw Pi runtime. Use it when a trusted
plugin provides a native harness, such as the bundled Codex app-server harness,
or when you want a supported CLI backend such as Claude CLI. For the mental
model, see [Agent runtimes](/concepts/agent-runtimes).

```json5
{
  agents: {
    defaults: {
      model: "openai/gpt-5.5",
      agentRuntime: {
        id: "codex",
        fallback: "none",
      },
    },
  },
}
```

- `id`: `"auto"`, `"pi"`, a registered plugin harness id, or a supported CLI backend alias. The bundled Codex plugin registers `codex`; the bundled Anthropic plugin provides the `claude-cli` CLI backend.
- `fallback`: `"pi"` or `"none"`. In `id: "auto"`, omitted fallback defaults to `"pi"` so old configs can keep using PI when no plugin harness claims a run. In explicit plugin runtime mode, such as `id: "codex"`, omitted fallback defaults to `"none"` so a missing harness fails instead of silently using PI. Runtime overrides do not inherit fallback from a broader scope; set `fallback: "pi"` alongside the explicit runtime when you intentionally want that compatibility fallback. Selected plugin harness failures always surface directly.
- Environment overrides: `OPENCLAW_AGENT_RUNTIME=<id|auto|pi>` overrides `id`; `OPENCLAW_AGENT_HARNESS_FALLBACK=pi|none` overrides fallback for that process.
- For Codex-only deployments, set `model: "openai/gpt-5.5"` and `agentRuntime.id: "codex"`. You may also set `agentRuntime.fallback: "none"` explicitly for readability; it is the default for explicit plugin runtimes.
- For Claude CLI deployments, prefer `model: "anthropic/claude-opus-4-7"` plus `agentRuntime.id: "claude-cli"`. Legacy `claude-cli/claude-opus-4-7` model refs still work for compatibility, but new config should keep provider/model selection canonical and put the execution backend in `agentRuntime.id`.
- Older runtime-policy keys are rewritten to `agentRuntime` by `openclaw doctor --fix`.
- Harness choice is pinned per session id after the first embedded run. Config/env changes affect new or reset sessions, not an existing transcript. Legacy sessions with transcript history but no recorded pin are treated as PI-pinned. `/status` reports the effective runtime, for example `Runtime: OpenClaw Pi Default` or `Runtime: OpenAI Codex`.
- This only controls text agent-turn execution. Media generation, vision, PDF, music, video, and TTS still use their provider/model settings.

**Built-in alias shorthands** (only apply when the model is in `agents.defaults.models`):

| Alias               | Model                                      |
| ------------------- | ------------------------------------------ |
| `opus`              | `anthropic/claude-opus-4-6`                |
| `sonnet`            | `anthropic/claude-sonnet-4-6`              |
| `gpt`               | `openai/gpt-5.5` or `openai-codex/gpt-5.5` |
| `gpt-mini`          | `openai/gpt-5.4-mini`                      |
| `gpt-nano`          | `openai/gpt-5.4-nano`                      |
| `gemini`            | `google/gemini-3.1-pro-preview`            |
| `gemini-flash`      | `google/gemini-3-flash-preview`            |
| `gemini-flash-lite` | `google/gemini-3.1-flash-lite-preview`     |

Your configured aliases always win over defaults.

Z.AI GLM-4.x models automatically enable thinking mode unless you set `--thinking off` or define `agents.defaults.models["zai/<model>"].params.thinking` yourself.
Z.AI models enable `tool_stream` by default for tool call streaming. Set `agents.defaults.models["zai/<model>"].params.tool_stream` to `false` to disable it.
Anthropic Claude 4.6 models default to `adaptive` thinking when no explicit thinking level is set.

### `agents.defaults.cliBackends`

Optional CLI backends for text-only fallback runs (no tool calls). Useful as a backup when API providers fail.

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          command: "/opt/homebrew/bin/codex",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          // Or use systemPromptFileArg when the CLI accepts a prompt file flag.
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

- CLI backends are text-first; tools are always disabled.
- Sessions supported when `sessionArg` is set.
- Image pass-through supported when `imageArg` accepts file paths.

### `agents.defaults.systemPromptOverride`

Replace the entire OpenClaw-assembled system prompt with a fixed string. Set at the default level (`agents.defaults.systemPromptOverride`) or per agent (`agents.list[].systemPromptOverride`). Per-agent values take precedence; an empty or whitespace-only value is ignored. Useful for controlled prompt experiments.

```json5
{
  agents: {
    defaults: {
      systemPromptOverride: "You are a helpful assistant.",
    },
  },
}
```

### `agents.defaults.promptOverlays`

Provider-independent prompt overlays applied by model family. GPT-5-family model ids receive the shared behavior contract across providers; `personality` controls only the friendly interaction-style layer.

```json5
{
  agents: {
    defaults: {
      promptOverlays: {
        gpt5: {
          personality: "friendly", // friendly | on | off
        },
      },
    },
  },
}
```

- `"friendly"` (default) and `"on"` enable the friendly interaction-style layer.
- `"off"` disables only the friendly layer; the tagged GPT-5 behavior contract remains enabled.
- Legacy `plugins.entries.openai.config.personality` is still read when this shared setting is unset.

### `agents.defaults.heartbeat`

Periodic heartbeat runs.

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // 0m disables
        model: "openai/gpt-5.4-mini",
        includeReasoning: false,
        includeSystemPromptSection: true, // default: true; false omits the Heartbeat section from the system prompt
        lightContext: false, // default: false; true keeps only HEARTBEAT.md from workspace bootstrap files
        isolatedSession: false, // default: false; true runs each heartbeat in a fresh session (no conversation history)
        skipWhenBusy: false, // default: false; true also waits for subagent/nested lanes
        session: "main",
        to: "+15555550123",
        directPolicy: "allow", // allow (default) | block
        target: "none", // default: none | options: last | whatsapp | telegram | discord | ...
        prompt: "Read HEARTBEAT.md if it exists...",
        ackMaxChars: 300,
        suppressToolErrorWarnings: false,
        timeoutSeconds: 45,
      },
    },
  },
}
```

- `every`: duration string (ms/s/m/h). Default: `30m` (API-key auth) or `1h` (OAuth auth). Set to `0m` to disable.
- `includeSystemPromptSection`: when false, omits the Heartbeat section from the system prompt and skips `HEARTBEAT.md` injection into bootstrap context. Default: `true`.
- `suppressToolErrorWarnings`: when true, suppresses tool error warning payloads during heartbeat runs.
- `timeoutSeconds`: maximum time in seconds allowed for a heartbeat agent turn before it is aborted. Leave unset to use `agents.defaults.timeoutSeconds`.
- `directPolicy`: direct/DM delivery policy. `allow` (default) permits direct-target delivery. `block` suppresses direct-target delivery and emits `reason=dm-blocked`.
- `lightContext`: when true, heartbeat runs use lightweight bootstrap context and keep only `HEARTBEAT.md` from workspace bootstrap files.
- `isolatedSession`: when true, each heartbeat runs in a fresh session with no prior conversation history. Same isolation pattern as cron `sessionTarget: "isolated"`. Reduces per-heartbeat token cost from ~100K to ~2-5K tokens.
- `skipWhenBusy`: when true, heartbeat runs defer on extra busy lanes: subagent or nested command work. Cron lanes always defer heartbeats, even without this flag.
- Per-agent: set `agents.list[].heartbeat`. When any agent defines `heartbeat`, **only those agents** run heartbeats.
- Heartbeats run full agent turns — shorter intervals burn more tokens.

### `agents.defaults.compaction`

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard", // default | safeguard
        provider: "my-provider", // id of a registered compaction provider plugin (optional)
        timeoutSeconds: 900,
        reserveTokensFloor: 24000,
        keepRecentTokens: 50000,
        identifierPolicy: "strict", // strict | off | custom
        identifierInstructions: "Preserve deployment IDs, ticket IDs, and host:port pairs exactly.", // used when identifierPolicy=custom
        qualityGuard: { enabled: true, maxRetries: 1 },
        midTurnPrecheck: { enabled: false }, // optional Pi tool-loop pressure check
        postCompactionSections: ["Session Startup", "Red Lines"], // [] disables reinjection
        model: "openrouter/anthropic/claude-sonnet-4-6", // optional compaction-only model override
        truncateAfterCompaction: true, // rotate to a smaller successor JSONL after compaction
        maxActiveTranscriptBytes: "20mb", // optional preflight local compaction trigger
        notifyUser: true, // send brief notices when compaction starts and completes (default: false)
        memoryFlush: {
          enabled: true,
          model: "ollama/qwen3:8b", // optional memory-flush-only model override
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with the exact silent token NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

- `mode`: `default` or `safeguard` (chunked summarization for long histories). See [Compaction](/concepts/compaction).
- `provider`: id of a registered compaction provider plugin. When set, the provider's `summarize()` is called instead of built-in LLM summarization. Falls back to built-in on failure. Setting a provider forces `mode: "safeguard"`. See [Compaction](/concepts/compaction).
- `timeoutSeconds`: maximum seconds allowed for a single compaction operation before OpenClaw aborts it. Default: `900`.
- `keepRecentTokens`: Pi cut-point budget for keeping the most recent transcript tail verbatim. Manual `/compact` honors this when explicitly set; otherwise manual compaction is a hard checkpoint.
- `identifierPolicy`: `strict` (default), `off`, or `custom`. `strict` prepends built-in opaque identifier retention guidance during compaction summarization.
- `identifierInstructions`: optional custom identifier-preservation text used when `identifierPolicy=custom`.
- `qualityGuard`: retry-on-malformed-output checks for safeguard summaries. Enabled by default in safeguard mode; set `enabled: false` to skip the audit.
- `midTurnPrecheck`: optional Pi tool-loop pressure check. When `enabled: true`, OpenClaw checks context pressure after tool results are appended and before the next model call. If the context no longer fits, it aborts the current attempt before submitting the prompt and reuses the existing precheck recovery path to truncate tool results or compact and retry. Works with both `default` and `safeguard` compaction modes. Default: disabled.
- `postCompactionSections`: optional AGENTS.md H2/H3 section names to re-inject after compaction. Defaults to `["Session Startup", "Red Lines"]`; set `[]` to disable reinjection. When unset or explicitly set to that default pair, older `Every Session`/`Safety` headings are also accepted as a legacy fallback.
- `model`: optional `provider/model-id` override for compaction summarization only. Use this when the main session should keep one model but compaction summaries should run on another; when unset, compaction uses the session's primary model.
- `maxActiveTranscriptBytes`: optional byte threshold (`number` or strings like `"20mb"`) that triggers normal local compaction before a run when the active JSONL grows past the threshold. Requires `truncateAfterCompaction` so successful compaction can rotate to a smaller successor transcript. Disabled when unset or `0`.
- `notifyUser`: when `true`, sends brief notices to the user when compaction starts and when it completes (for example, "Compacting context..." and "Compaction complete"). Disabled by default to keep compaction silent.
- `memoryFlush`: silent agentic turn before auto-compaction to store durable memories. Set `model` to an exact provider/model such as `ollama/qwen3:8b` when this housekeeping turn should stay on a local model; the override does not inherit the active session fallback chain. Skipped when workspace is read-only.

### `agents.defaults.contextPruning`

Prunes **old tool results** from in-memory context before sending to the LLM. Does **not** modify session history on disk.

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "cache-ttl", // off | cache-ttl
        ttl: "1h", // duration (ms/s/m/h), default unit: minutes
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

<Accordion title="cache-ttl mode behavior">

- `mode: "cache-ttl"` enables pruning passes.
- `ttl` controls how often pruning can run again (after the last cache touch).
- Pruning soft-trims oversized tool results first, then hard-clears older tool results if needed.

**Soft-trim** keeps beginning + end and inserts `...` in the middle.

**Hard-clear** replaces the entire tool result with the placeholder.

Notes:

- Image blocks are never trimmed/cleared.
- Ratios are character-based (approximate), not exact token counts.
- If fewer than `keepLastAssistants` assistant messages exist, pruning is skipped.

</Accordion>

See [Session Pruning](/concepts/session-pruning) for behavior details.

### Block streaming

```json5
{
  agents: {
    defaults: {
      blockStreamingDefault: "off", // on | off
      blockStreamingBreak: "text_end", // text_end | message_end
      blockStreamingChunk: { minChars: 800, maxChars: 1200 },
      blockStreamingCoalesce: { idleMs: 1000 },
      humanDelay: { mode: "natural" }, // off | natural | custom (use minMs/maxMs)
    },
  },
}
```

- Non-Telegram channels require explicit `*.blockStreaming: true` to enable block replies.
- Channel overrides: `channels.<channel>.blockStreamingCoalesce` (and per-account variants). Signal/Slack/Discord/Google Chat default `minChars: 1500`.
- `humanDelay`: randomized pause between block replies. `natural` = 800–2500ms. Per-agent override: `agents.list[].humanDelay`.

See [Streaming](/concepts/streaming) for behavior + chunking details.

### Typing indicators

```json5
{
  agents: {
    defaults: {
      typingMode: "instant", // never | instant | thinking | message
      typingIntervalSeconds: 6,
    },
  },
}
```

- Defaults: `instant` for direct chats/mentions, `message` for unmentioned group chats.
- Per-session overrides: `session.typingMode`, `session.typingIntervalSeconds`.

See [Typing Indicators](/concepts/typing-indicators).

<a id="agentsdefaultssandbox"></a>

### `agents.defaults.sandbox`

Optional sandboxing for the embedded agent. See [Sandboxing](/gateway/sandboxing) for the full guide.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        backend: "docker", // docker | ssh | openshell
        scope: "agent", // session | agent | shared
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/home/user/source:/source:rw"],
        },
        ssh: {
          target: "user@gateway-host:22",
          command: "ssh",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
          identityFile: "~/.ssh/id_ed25519",
          certificateFile: "~/.ssh/id_ed25519-cert.pub",
          knownHostsFile: "~/.ssh/known_hosts",
          // SecretRefs / inline contents also supported:
          // identityData: { source: "env", provider: "default", id: "SSH_IDENTITY" },
          // certificateData: { source: "env", provider: "default", id: "SSH_CERTIFICATE" },
          // knownHostsData: { source: "env", provider: "default", id: "SSH_KNOWN_HOSTS" },
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          network: "openclaw-sandbox-browser",
          cdpPort: 9222,
          cdpSourceRange: "172.21.0.1/32",
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24,
          maxAgeDays: 7,
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

<Accordion title="Sandbox details">

**Backend:**

- `docker`: local Docker runtime (default)
- `ssh`: generic SSH-backed remote runtime
- `openshell`: OpenShell runtime

When `backend: "openshell"` is selected, runtime-specific settings move to
`plugins.entries.openshell.config`.

**SSH backend config:**

- `target`: SSH target in `user@host[:port]` form
- `command`: SSH client command (default: `ssh`)
- `workspaceRoot`: absolute remote root used for per-scope workspaces
- `identityFile` / `certificateFile` / `knownHostsFile`: existing local files passed to OpenSSH
- `identityData` / `certificateData` / `knownHostsData`: inline contents or SecretRefs that OpenClaw materializes into temp files at runtime
- `strictHostKeyChecking` / `updateHostKeys`: OpenSSH host-key policy knobs

**SSH auth precedence:**

- `identityData` wins over `identityFile`
- `certificateData` wins over `certificateFile`
- `knownHostsData` wins over `knownHostsFile`
- SecretRef-backed `*Data` values are resolved from the active secrets runtime snapshot before the sandbox session starts

**SSH backend behavior:**

- seeds the remote workspace once after create or recreate
- then keeps the remote SSH workspace canonical
- routes `exec`, file tools, and media paths over SSH
- does not sync remote changes back to the host automatically
- does not support sandbox browser containers

**Workspace access:**

- `none`: per-scope sandbox workspace under `~/.openclaw/sandboxes`
- `ro`: sandbox workspace at `/workspace`, agent workspace mounted read-only at `/agent`
- `rw`: agent workspace mounted read/write at `/workspace`

**Scope:**

- `session`: per-session container + workspace
- `agent`: one container + workspace per agent (default)
- `shared`: shared container and workspace (no cross-session isolation)

**OpenShell plugin config:**

```json5
{
  plugins: {
    entries: {
      openshell: {
        enabled: true,
        config: {
          mode: "mirror", // mirror | remote
          from: "openclaw",
          remoteWorkspaceDir: "/sandbox",
          remoteAgentWorkspaceDir: "/agent",
          gateway: "lab", // optional
          gatewayEndpoint: "https://lab.example", // optional
          policy: "strict", // optional OpenShell policy id
          providers: ["openai"], // optional
          autoProviders: true,
          timeoutSeconds: 120,
        },
      },
    },
  },
}
```

**OpenShell mode:**

- `mirror`: seed remote from local before exec, sync back after exec; local workspace stays canonical
- `remote`: seed remote once when the sandbox is created, then keep the remote workspace canonical

In `remote` mode, host-local edits made outside OpenClaw are not synced into the sandbox automatically after the seed step.
Transport is SSH into the OpenShell sandbox, but the plugin owns sandbox lifecycle and optional mirror sync.

**`setupCommand`** runs once after container creation (via `sh -lc`). Needs network egress, writable root, root user.

**Containers default to `network: "none"`** — set to `"bridge"` (or a custom bridge network) if the agent needs outbound access.
`"host"` is blocked. `"container:<id>"` is blocked by default unless you explicitly set
`sandbox.docker.dangerouslyAllowContainerNamespaceJoin: true` (break-glass).

**Inbound attachments** are staged into `media/inbound/*` in the active workspace.

**`docker.binds`** mounts additional host directories; global and per-agent binds are merged.

**Sandboxed browser** (`sandbox.browser.enabled`): Chromium + CDP in a container. noVNC URL injected into system prompt. Does not require `browser.enabled` in `openclaw.json`.
noVNC observer access uses VNC auth by default and OpenClaw emits a short-lived token URL (instead of exposing the password in the shared URL).

- `allowHostControl: false` (default) blocks sandboxed sessions from targeting the host browser.
- `network` defaults to `openclaw-sandbox-browser` (dedicated bridge network). Set to `bridge` only when you explicitly want global bridge connectivity.
- `cdpSourceRange` optionally restricts CDP ingress at the container edge to a CIDR range (for example `172.21.0.1/32`).
- `sandbox.browser.binds` mounts additional host directories into the sandbox browser container only. When set (including `[]`), it replaces `docker.binds` for the browser container.
- Launch defaults are defined in `scripts/sandbox-browser-entrypoint.sh` and tuned for container hosts:
  - `--remote-debugging-address=127.0.0.1`
  - `--remote-debugging-port=<derived from OPENCLAW_BROWSER_CDP_PORT>`
  - `--user-data-dir=${HOME}/.chrome`
  - `--no-first-run`
  - `--no-default-browser-check`
  - `--disable-3d-apis`
  - `--disable-gpu`
  - `--disable-software-rasterizer`
  - `--disable-dev-shm-usage`
  - `--disable-background-networking`
  - `--disable-features=TranslateUI`
  - `--disable-breakpad`
  - `--disable-crash-reporter`
  - `--renderer-process-limit=2`
  - `--no-zygote`
  - `--metrics-recording-only`
  - `--disable-extensions` (default enabled)
  - `--disable-3d-apis`, `--disable-software-rasterizer`, and `--disable-gpu` are
    enabled by default and can be disabled with
    `OPENCLAW_BROWSER_DISABLE_GRAPHICS_FLAGS=0` if WebGL/3D usage requires it.
  - `OPENCLAW_BROWSER_DISABLE_EXTENSIONS=0` re-enables extensions if your workflow
    depends on them.
  - `--renderer-process-limit=2` can be changed with
    `OPENCLAW_BROWSER_RENDERER_PROCESS_LIMIT=<N>`; set `0` to use Chromium's
    default process limit.
  - plus `--no-sandbox` when `noSandbox` is enabled.
  - Defaults are the container image baseline; use a custom browser image with a custom
    entrypoint to change container defaults.

</Accordion>

Browser sandboxing and `sandbox.docker.binds` are Docker-only.

Build images:

```bash
scripts/sandbox-setup.sh           # main sandbox image
scripts/sandbox-browser-setup.sh   # optional browser image
```

### `agents.list` (per-agent overrides)

Use `agents.list[].tts` to give an agent its own TTS provider, voice, model,
style, or auto-TTS mode. The agent block deep-merges over global
`messages.tts`, so shared credentials can stay in one place while individual
agents override only the voice or provider fields they need. The active agent's
override applies to automatic spoken replies, `/tts audio`, `/tts status`, and
the `tts` agent tool. See [Text-to-speech](/tools/tts#per-agent-voice-overrides)
for provider examples and precedence.

```json5
{
  agents: {
    list: [
      {
        id: "main",
        default: true,
        name: "Main Agent",
        workspace: "~/.openclaw/workspace",
        agentDir: "~/.openclaw/agents/main/agent",
        model: "anthropic/claude-opus-4-6", // or { primary, fallbacks }
        thinkingDefault: "high", // per-agent thinking level override
        reasoningDefault: "on", // per-agent reasoning visibility override
        fastModeDefault: false, // per-agent fast mode override
        agentRuntime: { id: "auto", fallback: "pi" },
        params: { cacheRetention: "none" }, // overrides matching defaults.models params by key
        tts: {
          providers: {
            elevenlabs: { voiceId: "EXAVITQu4vr4xnSDxMaL" },
          },
        },
        skills: ["docs-search"], // replaces agents.defaults.skills when set
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
        groupChat: { mentionPatterns: ["@openclaw"] },
        sandbox: { mode: "off" },
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
        subagents: { allowAgents: ["*"] },
        tools: {
          profile: "coding",
          allow: ["browser"],
          deny: ["canvas"],
          elevated: { enabled: true },
        },
      },
    ],
  },
}
```

- `id`: stable agent id (required).
- `default`: when multiple are set, first wins (warning logged). If none set, first list entry is default.
- `model`: string form sets a strict per-agent primary with no model fallback; object form `{ primary }` is also strict unless you add `fallbacks`. Use `{ primary, fallbacks: [...] }` to opt that agent into fallback, or `{ primary, fallbacks: [] }` to make strict behavior explicit. Cron jobs that only override `primary` still inherit default fallbacks unless you set `fallbacks: []`.
- `params`: per-agent stream params merged over the selected model entry in `agents.defaults.models`. Use this for agent-specific overrides like `cacheRetention`, `temperature`, or `maxTokens` without duplicating the whole model catalog.
- `tts`: optional per-agent text-to-speech overrides. The block deep-merges over `messages.tts`, so keep shared provider credentials and fallback policy in `messages.tts` and set only persona-specific values such as provider, voice, model, style, or auto mode here.
- `skills`: optional per-agent skill allowlist. If omitted, the agent inherits `agents.defaults.skills` when set; an explicit list replaces defaults instead of merging, and `[]` means no skills.
- `thinkingDefault`: optional per-agent default thinking level (`off | minimal | low | medium | high | xhigh | adaptive | max`). Overrides `agents.defaults.thinkingDefault` for this agent when no per-message or session override is set. The selected provider/model profile controls which values are valid; for Google Gemini, `adaptive` keeps provider-owned dynamic thinking (`thinkingLevel` omitted on Gemini 3/3.1, `thinkingBudget: -1` on Gemini 2.5).
- `reasoningDefault`: optional per-agent default reasoning visibility (`on | off | stream`). Overrides `agents.defaults.reasoningDefault` for this agent when no per-message or session reasoning override is set.
- `fastModeDefault`: optional per-agent default for fast mode (`true | false`). Applies when no per-message or session fast-mode override is set.
- `agentRuntime`: optional per-agent low-level runtime policy override. Use `{ id: "codex" }` to make one agent Codex-only while other agents keep the default PI fallback in `auto` mode.
- `runtime`: optional per-agent runtime descriptor. Use `type: "acp"` with `runtime.acp` defaults (`agent`, `backend`, `mode`, `cwd`) when the agent should default to ACP harness sessions.
- `identity.avatar`: workspace-relative path, `http(s)` URL, or `data:` URI.
- `identity` derives defaults: `ackReaction` from `emoji`, `mentionPatterns` from `name`/`emoji`.
- `subagents.allowAgents`: allowlist of agent ids for explicit `sessions_spawn.agentId` targets (`["*"]` = any; default: same agent only). Include the requester id when self-targeted `agentId` calls should be allowed.
- Sandbox inheritance guard: if the requester session is sandboxed, `sessions_spawn` rejects targets that would run unsandboxed.
- `subagents.requireAgentId`: when true, block `sessions_spawn` calls that omit `agentId` (forces explicit profile selection; default: false).

---

## Multi-agent routing

Run multiple isolated agents inside one Gateway. See [Multi-Agent](/concepts/multi-agent).

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
}
```

### Binding match fields

- `type` (optional): `route` for normal routing (missing type defaults to route), `acp` for persistent ACP conversation bindings.
- `match.channel` (required)
- `match.accountId` (optional; `*` = any account; omitted = default account)
- `match.peer` (optional; `{ kind: direct|group|channel, id }`)
- `match.guildId` / `match.teamId` (optional; channel-specific)
- `acp` (optional; only for `type: "acp"`): `{ mode, label, cwd, backend }`

**Deterministic match order:**

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (exact, no peer/guild/team)
5. `match.accountId: "*"` (channel-wide)
6. Default agent

Within each tier, the first matching `bindings` entry wins.

For `type: "acp"` entries, OpenClaw resolves by exact conversation identity (`match.channel` + account + `match.peer.id`) and does not use the route binding tier order above.

### Per-agent access profiles

<Accordion title="Full access (no sandbox)">

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="Read-only tools + workspace">

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "ro" },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

</Accordion>

<Accordion title="No filesystem access (messaging only)">

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: { mode: "all", scope: "agent", workspaceAccess: "none" },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

</Accordion>

See [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) for precedence details.

---

## Session

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main", // main | per-peer | per-channel-peer | per-account-channel-peer
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily", // daily | idle
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      direct: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    parentForkMaxTokens: 100000, // skip parent-thread fork above this token count (0 disables)
    maintenance: {
      mode: "warn", // warn | enforce
      pruneAfter: "30d",
      maxEntries: 500,
      resetArchiveRetention: "30d", // duration or false
      maxDiskBytes: "500mb", // optional hard budget
      highWaterBytes: "400mb", // optional cleanup target
    },
    threadBindings: {
      enabled: true,
      idleHours: 24, // default inactivity auto-unfocus in hours (`0` disables)
      maxAgeHours: 0, // default hard max age in hours (`0` disables)
    },
    mainKey: "main", // legacy (runtime always uses "main")
    agentToAgent: { maxPingPongTurns: 5 },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

<Accordion title="Session field details">

- **`scope`**: base session grouping strategy for group-chat contexts.
  - `per-sender` (default): each sender gets an isolated session within a channel context.
  - `global`: all participants in a channel context share a single session (use only when shared context is intended).
- **`dmScope`**: how DMs are grouped.
  - `main`: all DMs share the main session.
  - `per-peer`: isolate by sender id across channels.
  - `per-channel-peer`: isolate per channel + sender (recommended for multi-user inboxes).
  - `per-account-channel-peer`: isolate per account + channel + sender (recommended for multi-account).
- **`identityLinks`**: map canonical ids to provider-prefixed peers for cross-channel session sharing. Dock commands such as `/dock_discord` use the same map to switch the active session's reply route to another linked channel peer; see [Channel docking](/concepts/channel-docking).
- **`reset`**: primary reset policy. `daily` resets at `atHour` local time; `idle` resets after `idleMinutes`. When both configured, whichever expires first wins. Daily reset freshness uses the session row's `sessionStartedAt`; idle reset freshness uses `lastInteractionAt`. Background/system-event writes such as heartbeat, cron wakeups, exec notifications, and gateway bookkeeping can update `updatedAt`, but they do not keep daily/idle sessions fresh.
- **`resetByType`**: per-type overrides (`direct`, `group`, `thread`). Legacy `dm` accepted as alias for `direct`.
- **`parentForkMaxTokens`**: max parent-session `totalTokens` allowed when creating a forked thread session (default `100000`).
  - If parent `totalTokens` is above this value, OpenClaw starts a fresh thread session instead of inheriting parent transcript history.
  - Set `0` to disable this guard and always allow parent forking.
- **`mainKey`**: legacy field. Runtime always uses `"main"` for the main direct-chat bucket.
- **`agentToAgent.maxPingPongTurns`**: maximum reply-back turns between agents during agent-to-agent exchanges (integer, range: `0`–`5`). `0` disables ping-pong chaining.
- **`sendPolicy`**: match by `channel`, `chatType` (`direct|group|channel`, with legacy `dm` alias), `keyPrefix`, or `rawKeyPrefix`. First deny wins.
- **`maintenance`**: session-store cleanup + retention controls.
  - `mode`: `warn` emits warnings only; `enforce` applies cleanup.
  - `pruneAfter`: age cutoff for stale entries (default `30d`).
  - `maxEntries`: maximum number of entries in `sessions.json` (default `500`). Runtime writes batch cleanup with a small high-water buffer for production-sized caps; `openclaw sessions cleanup --enforce` applies the cap immediately.
  - `rotateBytes`: deprecated and ignored; `openclaw doctor --fix` removes it from older configs.
  - `resetArchiveRetention`: retention for `*.reset.<timestamp>` transcript archives. Defaults to `pruneAfter`; set `false` to disable.
  - `maxDiskBytes`: optional sessions-directory disk budget. In `warn` mode it logs warnings; in `enforce` mode it removes oldest artifacts/sessions first.
  - `highWaterBytes`: optional target after budget cleanup. Defaults to `80%` of `maxDiskBytes`.
- **`threadBindings`**: global defaults for thread-bound session features.
  - `enabled`: master default switch (providers can override; Discord uses `channels.discord.threadBindings.enabled`)
  - `idleHours`: default inactivity auto-unfocus in hours (`0` disables; providers can override)
  - `maxAgeHours`: default hard max age in hours (`0` disables; providers can override)

</Accordion>

---

## Messages

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions", // group-mentions | group-all | direct | all
    removeAckAfterReply: false,
    queue: {
      mode: "steer", // steer | queue (legacy one-at-a-time) | followup | collect | steer-backlog | steer+backlog | interrupt
      debounceMs: 500,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "steer",
        telegram: "steer",
      },
    },
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
      },
    },
  },
}
```

### Response prefix

Per-channel/account overrides: `channels.<channel>.responsePrefix`, `channels.<channel>.accounts.<id>.responsePrefix`.

Resolution (most specific wins): account → channel → global. `""` disables and stops cascade. `"auto"` derives `[{identity.name}]`.

**Template variables:**

| Variable          | Description            | Example                     |
| ----------------- | ---------------------- | --------------------------- |
| `{model}`         | Short model name       | `claude-opus-4-6`           |
| `{modelFull}`     | Full model identifier  | `anthropic/claude-opus-4-6` |
| `{provider}`      | Provider name          | `anthropic`                 |
| `{thinkingLevel}` | Current thinking level | `high`, `low`, `off`        |
| `{identity.name}` | Agent identity name    | (same as `"auto"`)          |

Variables are case-insensitive. `{think}` is an alias for `{thinkingLevel}`.

### Ack reaction

- Defaults to active agent's `identity.emoji`, otherwise `"👀"`. Set `""` to disable.
- Per-channel overrides: `channels.<channel>.ackReaction`, `channels.<channel>.accounts.<id>.ackReaction`.
- Resolution order: account → channel → `messages.ackReaction` → identity fallback.
- Scope: `group-mentions` (default), `group-all`, `direct`, `all`.
- `removeAckAfterReply`: removes ack after reply on reaction-capable channels such as Slack, Discord, Telegram, WhatsApp, and BlueBubbles.
- `messages.statusReactions.enabled`: enables lifecycle status reactions on Slack, Discord, and Telegram.
  On Slack and Discord, unset keeps status reactions enabled when ack reactions are active.
  On Telegram, set it explicitly to `true` to enable lifecycle status reactions.

### Inbound debounce

Batches rapid text-only messages from the same sender into a single agent turn. Media/attachments flush immediately. Control commands bypass debouncing.

### TTS (text-to-speech)

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: { enabled: true },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      providers: {
        elevenlabs: {
          apiKey: "elevenlabs_api_key",
          baseUrl: "https://api.elevenlabs.io",
          voiceId: "voice_id",
          modelId: "eleven_multilingual_v2",
          seed: 42,
          applyTextNormalization: "auto",
          languageCode: "en",
          voiceSettings: {
            stability: 0.5,
            similarityBoost: 0.75,
            style: 0.0,
            useSpeakerBoost: true,
            speed: 1.0,
          },
        },
        microsoft: {
          voice: "en-US-AvaMultilingualNeural",
          lang: "en-US",
          outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        },
        openai: {
          apiKey: "openai_api_key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini-tts",
          voice: "alloy",
        },
      },
    },
  },
}
```

- `auto` controls the default auto-TTS mode: `off`, `always`, `inbound`, or `tagged`. `/tts on|off` can override local prefs, and `/tts status` shows the effective state.
- `summaryModel` overrides `agents.defaults.model.primary` for auto-summary.
- `modelOverrides` is enabled by default; `modelOverrides.allowProvider` defaults to `false` (opt-in).
- API keys fall back to `ELEVENLABS_API_KEY`/`XI_API_KEY` and `OPENAI_API_KEY`.
- Bundled speech providers are plugin-owned. If `plugins.allow` is set, include each TTS provider plugin you want to use, for example `microsoft` for Edge TTS. The legacy `edge` provider id is accepted as an alias for `microsoft`.
- `providers.openai.baseUrl` overrides the OpenAI TTS endpoint. Resolution order is config, then `OPENAI_TTS_BASE_URL`, then `https://api.openai.com/v1`.
- When `providers.openai.baseUrl` points to a non-OpenAI endpoint, OpenClaw treats it as an OpenAI-compatible TTS server and relaxes model/voice validation.

---

## Talk

Defaults for Talk mode (macOS/iOS/Android).

```json5
{
  talk: {
    provider: "elevenlabs",
    providers: {
      elevenlabs: {
        voiceId: "elevenlabs_voice_id",
        voiceAliases: {
          Clawd: "EXAVITQu4vr4xnSDxMaL",
          Roger: "CwhRBWXzGAHq8TQ4Fs17",
        },
        modelId: "eleven_v3",
        outputFormat: "mp3_44100_128",
        apiKey: "elevenlabs_api_key",
      },
      mlx: {
        modelId: "mlx-community/Soprano-80M-bf16",
      },
      system: {},
    },
    speechLocale: "ru-RU",
    silenceTimeoutMs: 1500,
    interruptOnSpeech: true,
  },
}
```

- `talk.provider` must match a key in `talk.providers` when multiple Talk providers are configured.
- Legacy flat Talk keys (`talk.voiceId`, `talk.voiceAliases`, `talk.modelId`, `talk.outputFormat`, `talk.apiKey`) are compatibility-only and are auto-migrated into `talk.providers.<provider>`.
- Voice IDs fall back to `ELEVENLABS_VOICE_ID` or `SAG_VOICE_ID`.
- `providers.*.apiKey` accepts plaintext strings or SecretRef objects.
- `ELEVENLABS_API_KEY` fallback applies only when no Talk API key is configured.
- `providers.*.voiceAliases` lets Talk directives use friendly names.
- `providers.mlx.modelId` selects the Hugging Face repo used by the macOS local MLX helper. If omitted, macOS uses `mlx-community/Soprano-80M-bf16`.
- macOS MLX playback runs through the bundled `openclaw-mlx-tts` helper when present, or an executable on `PATH`; `OPENCLAW_MLX_TTS_BIN` overrides the helper path for development.
- `speechLocale` sets the BCP 47 locale id used by iOS/macOS Talk speech recognition. Leave unset to use the device default.
- `silenceTimeoutMs` controls how long Talk mode waits after user silence before it sends the transcript. Unset keeps the platform default pause window (`700 ms on macOS and Android, 900 ms on iOS`).

---

## Related

- [Configuration reference](/gateway/configuration-reference) — all other config keys
- [Configuration](/gateway/configuration) — common tasks and quick setup
- [Configuration examples](/gateway/configuration-examples)
