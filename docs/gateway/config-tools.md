---
summary: "Tools config (policy, experimental toggles, provider-backed tools) and custom provider/base-URL setup"
read_when:
  - Configuring `tools.*` policy, allowlists, or experimental features
  - Registering custom providers or overriding base URLs
  - Setting up OpenAI-compatible self-hosted endpoints
title: "Configuration — tools and custom providers"
---

`tools.*` config keys and custom provider / base-URL setup. For agents,
channels, and other top-level config keys, see
[Configuration reference](/gateway/configuration-reference).

## Tools

### Tool profiles

`tools.profile` sets a base allowlist before `tools.allow`/`tools.deny`:

Local onboarding defaults new local configs to `tools.profile: "coding"` when unset (existing explicit profiles are preserved).

| Profile     | Includes                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` only                                                                                                           |
| `coding`    | `group:fs`, `group:runtime`, `group:web`, `group:sessions`, `group:memory`, `cron`, `image`, `image_generate`, `video_generate` |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`                                       |
| `full`      | No restriction (same as unset)                                                                                                  |

### Tool groups

| Group              | Tools                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `group:runtime`    | `exec`, `process`, `code_execution` (`bash` is accepted as an alias for `exec`)                                         |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                                                  |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status` |
| `group:memory`     | `memory_search`, `memory_get`                                                                                           |
| `group:web`        | `web_search`, `x_search`, `web_fetch`                                                                                   |
| `group:ui`         | `browser`, `canvas`                                                                                                     |
| `group:automation` | `cron`, `gateway`                                                                                                       |
| `group:messaging`  | `message`                                                                                                               |
| `group:nodes`      | `nodes`                                                                                                                 |
| `group:agents`     | `agents_list`                                                                                                           |
| `group:media`      | `image`, `image_generate`, `video_generate`, `tts`                                                                      |
| `group:openclaw`   | All built-in tools (excludes provider plugins)                                                                          |

### `tools.allow` / `tools.deny`

Global tool allow/deny policy (deny wins). Case-insensitive, supports `*` wildcards. Applied even when Docker sandbox is off.

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

### `tools.byProvider`

Further restrict tools for specific providers or models. Order: base profile → provider profile → allow/deny.

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
      "openai/gpt-5.4": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

### `tools.elevated`

Controls elevated exec access outside the sandbox:

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["1234567890123", "987654321098765432"],
      },
    },
  },
}
```

- Per-agent override (`agents.list[].tools.elevated`) can only further restrict.
- `/elevated on|off|ask|full` stores state per session; inline directives apply to single message.
- Elevated `exec` bypasses sandboxing and uses the configured escape path (`gateway` by default, or `node` when the exec target is `node`).

### `tools.exec`

```json5
{
  tools: {
    exec: {
      backgroundMs: 10000,
      timeoutSec: 1800,
      cleanupMs: 1800000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      applyPatch: {
        enabled: false,
        allowModels: ["gpt-5.5"],
      },
    },
  },
}
```

### `tools.loopDetection`

Tool-loop safety checks are **disabled by default**. Set `enabled: true` to activate detection.
Settings can be defined globally in `tools.loopDetection` and overridden per-agent at `agents.list[].tools.loopDetection`.

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      historySize: 30,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `historySize`: max tool-call history retained for loop analysis.
- `warningThreshold`: repeating no-progress pattern threshold for warnings.
- `criticalThreshold`: higher repeating threshold for blocking critical loops.
- `globalCircuitBreakerThreshold`: hard stop threshold for any no-progress run.
- `detectors.genericRepeat`: warn on repeated same-tool/same-args calls.
- `detectors.knownPollNoProgress`: warn/block on known poll tools (`process.poll`, `command_status`, etc.).
- `detectors.pingPong`: warn/block on alternating no-progress pair patterns.
- If `warningThreshold >= criticalThreshold` or `criticalThreshold >= globalCircuitBreakerThreshold`, validation fails.

### `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "brave_api_key", // or BRAVE_API_KEY env
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
      fetch: {
        enabled: true,
        provider: "firecrawl", // optional; omit for auto-detect
        maxChars: 50000,
        maxCharsCap: 50000,
        maxResponseBytes: 2000000,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
        maxRedirects: 3,
        readability: true,
        userAgent: "custom-ua",
      },
    },
  },
}
```

### `tools.media`

Configures inbound media understanding (image/audio/video):

```json5
{
  tools: {
    media: {
      concurrency: 2,
      asyncCompletion: {
        directSend: false, // opt-in: send finished async music/video directly to the channel
      },
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

<Accordion title="Media model entry fields">

**Provider entry** (`type: "provider"` or omitted):

- `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc.)
- `model`: model id override
- `profile` / `preferredProfile`: `auth-profiles.json` profile selection

**CLI entry** (`type: "cli"`):

- `command`: executable to run
- `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc.)

**Common fields:**

- `capabilities`: optional list (`image`, `audio`, `video`). Defaults: `openai`/`anthropic`/`minimax` → image, `google` → image+audio+video, `groq` → audio.
- `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: per-entry overrides.
- Failures fall back to the next entry.

Provider auth follows standard order: `auth-profiles.json` → env vars → `models.providers.*.apiKey`.

**Async completion fields:**

- `asyncCompletion.directSend`: when `true`, completed async `music_generate`
  and `video_generate` tasks try direct channel delivery first. Default: `false`
  (legacy requester-session wake/model-delivery path).

</Accordion>

### `tools.agentToAgent`

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `tools.sessions`

Controls which sessions can be targeted by the session tools (`sessions_list`, `sessions_history`, `sessions_send`).

Default: `tree` (current session + sessions spawned by it, such as subagents).

```json5
{
  tools: {
    sessions: {
      // "self" | "tree" | "agent" | "all"
      visibility: "tree",
    },
  },
}
```

Notes:

- `self`: only the current session key.
- `tree`: current session + sessions spawned by the current session (subagents).
- `agent`: any session belonging to the current agent id (can include other users if you run per-sender sessions under the same agent id).
- `all`: any session. Cross-agent targeting still requires `tools.agentToAgent`.
- Sandbox clamp: when the current session is sandboxed and `agents.defaults.sandbox.sessionToolsVisibility="spawned"`, visibility is forced to `tree` even if `tools.sessions.visibility="all"`.

### `tools.sessions_spawn`

Controls inline attachment support for `sessions_spawn`.

```json5
{
  tools: {
    sessions_spawn: {
      attachments: {
        enabled: false, // opt-in: set true to allow inline file attachments
        maxTotalBytes: 5242880, // 5 MB total across all files
        maxFiles: 50,
        maxFileBytes: 1048576, // 1 MB per file
        retainOnSessionKeep: false, // keep attachments when cleanup="keep"
      },
    },
  },
}
```

Notes:

- Attachments are only supported for `runtime: "subagent"`. ACP runtime rejects them.
- Files are materialized into the child workspace at `.openclaw/attachments/<uuid>/` with a `.manifest.json`.
- Attachment content is automatically redacted from transcript persistence.
- Base64 inputs are validated with strict alphabet/padding checks and a pre-decode size guard.
- File permissions are `0700` for directories and `0600` for files.
- Cleanup follows the `cleanup` policy: `delete` always removes attachments; `keep` retains them only when `retainOnSessionKeep: true`.

<a id="toolsexperimental"></a>

### `tools.experimental`

Experimental built-in tool flags. Default off unless a strict-agentic GPT-5 auto-enable rule applies.

```json5
{
  tools: {
    experimental: {
      planTool: true, // enable experimental update_plan
    },
  },
}
```

Notes:

- `planTool`: enables the structured `update_plan` tool for non-trivial multi-step work tracking.
- Default: `false` unless `agents.defaults.embeddedPi.executionContract` (or a per-agent override) is set to `"strict-agentic"` for an OpenAI or OpenAI Codex GPT-5-family run. Set `true` to force the tool on outside that scope, or `false` to keep it off even for strict-agentic GPT-5 runs.
- When enabled, the system prompt also adds usage guidance so the model only uses it for substantial work and keeps at most one step `in_progress`.

### `agents.defaults.subagents`

```json5
{
  agents: {
    defaults: {
      subagents: {
        allowAgents: ["research"],
        model: "minimax/MiniMax-M2.7",
        maxConcurrent: 8,
        runTimeoutSeconds: 900,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`: default model for spawned sub-agents. If omitted, sub-agents inherit the caller's model.
- `allowAgents`: default allowlist of target agent ids for `sessions_spawn` when the requester agent does not set its own `subagents.allowAgents` (`["*"]` = any; default: same agent only).
- `runTimeoutSeconds`: default timeout (seconds) for `sessions_spawn` when the tool call omits `runTimeoutSeconds`. `0` means no timeout.
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.

---

## Custom providers and base URLs

OpenClaw uses the built-in model catalog. Add custom providers via `models.providers` in config or `~/.openclaw/agents/<agentId>/agent/models.json`.

```json5
{
  models: {
    mode: "merge", // merge (default) | replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions", // openai-completions | openai-responses | anthropic-messages | google-generative-ai
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            contextTokens: 96000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

- Use `authHeader: true` + `headers` for custom auth needs.
- Override agent config root with `OPENCLAW_AGENT_DIR` (or `PI_CODING_AGENT_DIR`, a legacy environment variable alias).
- Merge precedence for matching provider IDs:
  - Non-empty agent `models.json` `baseUrl` values win.
  - Non-empty agent `apiKey` values win only when that provider is not SecretRef-managed in current config/auth-profile context.
  - SecretRef-managed provider `apiKey` values are refreshed from source markers (`ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs) instead of persisting resolved secrets.
  - SecretRef-managed provider header values are refreshed from source markers (`secretref-env:ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs).
  - Empty or missing agent `apiKey`/`baseUrl` fall back to `models.providers` in config.
  - Matching model `contextWindow`/`maxTokens` use the higher value between explicit config and implicit catalog values.
  - Matching model `contextTokens` preserves an explicit runtime cap when present; use it to limit effective context without changing native model metadata.
  - Use `models.mode: "replace"` when you want config to fully rewrite `models.json`.
  - Marker persistence is source-authoritative: markers are written from the active source config snapshot (pre-resolution), not from resolved runtime secret values.

### Provider field details

- `models.mode`: provider catalog behavior (`merge` or `replace`).
- `models.providers`: custom provider map keyed by provider id.
  - Safe edits: use `openclaw config set models.providers.<id> '<json>' --strict-json --merge` or `openclaw config set models.providers.<id>.models '<json-array>' --strict-json --merge` for additive updates. `config set` refuses destructive replacements unless you pass `--replace`.
- `models.providers.*.api`: request adapter (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`, etc).
- `models.providers.*.apiKey`: provider credential (prefer SecretRef/env substitution).
- `models.providers.*.auth`: auth strategy (`api-key`, `token`, `oauth`, `aws-sdk`).
- `models.providers.*.injectNumCtxForOpenAICompat`: for Ollama + `openai-completions`, inject `options.num_ctx` into requests (default: `true`).
- `models.providers.*.authHeader`: force credential transport in the `Authorization` header when required.
- `models.providers.*.baseUrl`: upstream API base URL.
- `models.providers.*.headers`: extra static headers for proxy/tenant routing.
- `models.providers.*.request`: transport overrides for model-provider HTTP requests.
  - `request.headers`: extra headers (merged with provider defaults). Values accept SecretRef.
  - `request.auth`: auth strategy override. Modes: `"provider-default"` (use provider's built-in auth), `"authorization-bearer"` (with `token`), `"header"` (with `headerName`, `value`, optional `prefix`).
  - `request.proxy`: HTTP proxy override. Modes: `"env-proxy"` (use `HTTP_PROXY`/`HTTPS_PROXY` env vars), `"explicit-proxy"` (with `url`). Both modes accept an optional `tls` sub-object.
  - `request.tls`: TLS override for direct connections. Fields: `ca`, `cert`, `key`, `passphrase` (all accept SecretRef), `serverName`, `insecureSkipVerify`.
  - `request.allowPrivateNetwork`: when `true`, allow HTTPS to `baseUrl` when DNS resolves to private, CGNAT, or similar ranges, via the provider HTTP fetch guard (operator opt-in for trusted self-hosted OpenAI-compatible endpoints). WebSocket uses the same `request` for headers/TLS but not that fetch SSRF gate. Default `false`.
- `models.providers.*.models`: explicit provider model catalog entries.
- `models.providers.*.models.*.contextWindow`: native model context window metadata.
- `models.providers.*.models.*.contextTokens`: optional runtime context cap. Use this when you want a smaller effective context budget than the model's native `contextWindow`.
- `models.providers.*.models.*.compat.supportsDeveloperRole`: optional compatibility hint. For `api: "openai-completions"` with a non-empty non-native `baseUrl` (host not `api.openai.com`), OpenClaw forces this to `false` at runtime. Empty/omitted `baseUrl` keeps default OpenAI behavior.
- `models.providers.*.models.*.compat.requiresStringContent`: optional compatibility hint for string-only OpenAI-compatible chat endpoints. When `true`, OpenClaw flattens pure text `messages[].content` arrays into plain strings before sending the request.
- `plugins.entries.amazon-bedrock.config.discovery`: Bedrock auto-discovery settings root.
- `plugins.entries.amazon-bedrock.config.discovery.enabled`: turn implicit discovery on/off.
- `plugins.entries.amazon-bedrock.config.discovery.region`: AWS region for discovery.
- `plugins.entries.amazon-bedrock.config.discovery.providerFilter`: optional provider-id filter for targeted discovery.
- `plugins.entries.amazon-bedrock.config.discovery.refreshInterval`: polling interval for discovery refresh.
- `plugins.entries.amazon-bedrock.config.discovery.defaultContextWindow`: fallback context window for discovered models.
- `plugins.entries.amazon-bedrock.config.discovery.defaultMaxTokens`: fallback max output tokens for discovered models.

### Provider examples

<Accordion title="Cerebras (GLM 4.6 / 4.7)">

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

Use `cerebras/zai-glm-4.7` for Cerebras; `zai/glm-4.7` for Z.AI direct.

</Accordion>

<Accordion title="OpenCode">

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

Set `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`). Use `opencode/...` refs for the Zen catalog or `opencode-go/...` refs for the Go catalog. Shortcut: `openclaw onboard --auth-choice opencode-zen` or `openclaw onboard --auth-choice opencode-go`.

</Accordion>

<Accordion title="Z.AI (GLM-4.7)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

Set `ZAI_API_KEY`. `z.ai/*` and `z-ai/*` are accepted aliases. Shortcut: `openclaw onboard --auth-choice zai-api-key`.

- General endpoint: `https://api.z.ai/api/paas/v4`
- Coding endpoint (default): `https://api.z.ai/api/coding/paas/v4`
- For the general endpoint, define a custom provider with the base URL override.

</Accordion>

<Accordion title="Moonshot AI (Kimi)">

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.6" },
      models: { "moonshot/kimi-k2.6": { alias: "Kimi K2.6" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.6",
            name: "Kimi K2.6",
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
            contextWindow: 262144,
            maxTokens: 262144,
          },
        ],
      },
    },
  },
}
```

For the China endpoint: `baseUrl: "https://api.moonshot.cn/v1"` or `openclaw onboard --auth-choice moonshot-api-key-cn`.

Native Moonshot endpoints advertise streaming usage compatibility on the shared
`openai-completions` transport, and OpenClaw keys that off endpoint capabilities
rather than the built-in provider id alone.

</Accordion>

<Accordion title="Kimi Coding">

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi/kimi-code" },
      models: { "kimi/kimi-code": { alias: "Kimi Code" } },
    },
  },
}
```

Anthropic-compatible, built-in provider. Shortcut: `openclaw onboard --auth-choice kimi-code-api-key`.

</Accordion>

<Accordion title="Synthetic (Anthropic-compatible)">

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.5" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.5": { alias: "MiniMax M2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.5",
            name: "MiniMax M2.5",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Base URL should omit `/v1` (Anthropic client appends it). Shortcut: `openclaw onboard --auth-choice synthetic-api-key`.

</Accordion>

<Accordion title="MiniMax M2.7 (direct)">

```json5
{
  agents: {
    defaults: {
      model: { primary: "minimax/MiniMax-M2.7" },
      models: {
        "minimax/MiniMax-M2.7": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.7",
            name: "MiniMax M2.7",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
            contextWindow: 204800,
            maxTokens: 131072,
          },
        ],
      },
    },
  },
}
```

Set `MINIMAX_API_KEY`. Shortcuts:
`openclaw onboard --auth-choice minimax-global-api` or
`openclaw onboard --auth-choice minimax-cn-api`.
The model catalog defaults to M2.7 only.
On the Anthropic-compatible streaming path, OpenClaw disables MiniMax thinking
by default unless you explicitly set `thinking` yourself. `/fast on` or
`params.fastMode: true` rewrites `MiniMax-M2.7` to
`MiniMax-M2.7-highspeed`.

</Accordion>

<Accordion title="Local models (LM Studio)">

See [Local Models](/gateway/local-models). TL;DR: run a large local model via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.

</Accordion>

---

## Related

- [Configuration reference](/gateway/configuration-reference) — other top-level keys
- [Configuration — agents](/gateway/config-agents)
- [Configuration — channels](/gateway/config-channels)
- [Tools and plugins](/tools)
