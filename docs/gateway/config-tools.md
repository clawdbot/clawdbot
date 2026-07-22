---
summary: "Tools config (policy, experimental toggles, provider-backed tools) and custom provider/base-URL setup"
read_when:
  - Configuring `tools.*` policy, allowlists, or experimental features
  - Registering custom providers or overriding base URLs
  - Setting up OpenAI-compatible self-hosted endpoints
title: "Configuration — tools and custom providers"
sidebarTitle: "Tools and custom providers"
---

`tools.*` config keys and custom provider / base-URL setup. For agents, channels, and other top-level config keys, see [Configuration reference](/gateway/configuration-reference).

## Tools

### Tool profiles

`tools.profile` sets a base allowlist before `tools.allow`/`tools.deny`:

<Note>
Local onboarding defaults new local configs to `tools.profile: "coding"` when unset (existing explicit profiles are preserved).
</Note>

| Profile     | Includes                                                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` only                                                                                                                                                                                                                                   |
| `coding`    | `group:fs`, `group:runtime`, `group:web`, `group:sessions`, `group:memory`, `cron`, `get_goal`, `create_goal`, `update_goal`, `update_plan`, `ask_user`, `skill_workshop`, `image`, `image_generate`, `music_generate`, `video_generate`                |
| `messaging` | `group:messaging`, `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `ask_user` |
| `full`      | No restriction (same as unset)                                                                                                                                                                                                                          |

`coding` and `messaging` also implicitly allow `bundle-mcp` (configured MCP servers).

### Tool groups

| Group              | Tools                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `group:runtime`    | `exec`, `process`, `code_execution` (`bash` is accepted as an alias for `exec`)                                                                                                                                                                        |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                                                                                                                                                                                 |
| `group:sessions`   | `sessions`, `sessions_list`, `sessions_history`, `sessions_search`, `conversations_list`, `conversations_send`, `conversations_turn`, `sessions_send`, `sessions_spawn`, `sessions_yield`, `subagents`, `session_status`, `spawn_task`, `dismiss_task` |
| `group:memory`     | `memory_search`, `memory_get`                                                                                                                                                                                                                          |
| `group:web`        | `web_search`, `x_search`, `web_fetch`                                                                                                                                                                                                                  |
| `group:ui`         | `browser`, `screen`, `terminal`, `canvas`, `show_widget`                                                                                                                                                                                               |
| `group:automation` | `heartbeat_respond`, `cron`, `gateway`                                                                                                                                                                                                                 |
| `group:messaging`  | `message`                                                                                                                                                                                                                                              |
| `group:nodes`      | `nodes`, `computer`                                                                                                                                                                                                                                    |
| `group:agents`     | `agents_list`, `get_goal`, `create_goal`, `update_goal`, `update_plan`, `ask_user`, `skill_workshop`                                                                                                                                                   |
| `group:media`      | `image`, `image_generate`, `music_generate`, `video_generate`, `tts`                                                                                                                                                                                   |
| `group:openclaw`   | All built-in tools above except `read`/`write`/`edit`/`apply_patch`/`exec`/`process`/`canvas` (excludes plugin tools)                                                                                                                                  |
| `group:plugins`    | Tools owned by loaded plugins, including configured MCP servers exposed through `bundle-mcp`                                                                                                                                                           |

`spawn_task` lets a coding agent propose confirmed follow-up work without starting it. The Control UI shows the title and summary as an actionable chip; a Gateway-backed TUI shows an equivalent interactive prompt. Accepting either creates a fresh managed-worktree session and sends the full prompt there while the current turn continues. `dismiss_task` withdraws a still-pending suggestion by the ephemeral `task_id` returned from `spawn_task`.

The tools are offered only when the initiating operator surface can receive and action Gateway task-suggestion events. Channel sessions and local/embedded TUI sessions do not receive them; channel transports need a portable typed task action before they can safely expose this flow. Suggestions are process-local and disappear when the Gateway restarts. Both tools remain in the `coding` profile and `group:sessions`, so normal `tools.allow` and `tools.deny` policy configures them automatically when the surface supports them.

### MCP and plugin tools inside sandbox tool policy

Configured MCP servers are exposed as plugin-owned tools under the `bundle-mcp` plugin id. Normal tool profiles can allow them, but `tools.sandbox.tools` is an additional gate for sandboxed sessions. If sandbox mode is `"all"` or `"non-main"`, include one of these entries in the sandbox tool allowlist when MCP/plugin tools should be visible:

- `bundle-mcp` for OpenClaw-managed MCP servers from `mcp.servers`
- the plugin id for a specific native plugin
- `group:plugins` for all loaded plugin-owned tools
- exact MCP server tool names or server globs such as `outlook__send_mail` or `outlook__*` when you only want one server

Server globs use the provider-safe MCP server prefix, not necessarily the raw `mcp.servers` key. Non-`[A-Za-z0-9_-]` characters become `-`, names that do not start with a letter get an `mcp-` prefix, and long or duplicate prefixes may be truncated or suffixed; for example, `mcp.servers["Outlook Graph"]` uses a glob like `outlook-graph__*`.

```json5
{
  agents: { defaults: { sandbox: { mode: "all" } } },
  mcp: {
    servers: {
      outlook: { command: "node", args: ["./outlook-mcp.js"] },
    },
  },
  tools: {
    sandbox: {
      tools: {
        alsoAllow: ["web_search", "web_fetch", "memory_search", "memory_get", "bundle-mcp"],
      },
    },
  },
}
```

Without that sandbox-layer entry, the MCP server can still load successfully while its tools are filtered before the provider request. Use `openclaw doctor` to catch this shape for OpenClaw-managed servers in `mcp.servers`. MCP servers loaded from bundled plugin manifests or Claude `.mcp.json` use the same sandbox gate, but this diagnostic does not enumerate those sources yet; use the same allowlist entries if their tools disappear in sandboxed turns.

### `tools.codeMode`

`tools.codeMode` enables the generic OpenClaw code-mode surface. When enabled
for a run with tools, normal OpenClaw tools move behind the in-sandbox `tools.*`
catalog bridge, and MCP tools are available through the generated `MCP`
namespace. The model normally sees `exec` and `wait`; tools such as `computer`
whose structured results cannot cross the JSON-only bridge stay direct.

```json5
{
  tools: {
    codeMode: {
      enabled: true,
    },
  },
}
```

The shorthand is also accepted:

```json5
{
  tools: { codeMode: true },
}
```

MCP declarations are exposed through the read-only virtual API file surface in
code mode. Guest code can call `API.list("mcp")` and
`API.read("mcp/<server>.d.ts")` to inspect TypeScript-style signatures before
calling `MCP.<server>.<tool>()`. See [Code Mode](/tools/code-mode) for the
runtime contract, limits, and debugging steps.

### `tools.allow` / `tools.deny`

Global tool allow/deny policy (deny wins). Case-insensitive, supports `*` wildcards. Applied even when Docker sandbox is off.

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

`write` and `apply_patch` are separate tool ids. `allow: ["write"]` also enables `apply_patch` for compatible models, but `deny: ["write"]` does not deny `apply_patch`. To block all file mutation, deny `group:fs` or list each mutating tool explicitly:

```json5
{
  tools: { deny: ["write", "edit", "apply_patch"] },
}
```

<Note>
`allow` and `alsoAllow` cannot both be set in the same scope (`tools`, `tools.byProvider.<id>`, `agents.entries.*.tools`) — config validation rejects it. Merge `alsoAllow` entries into `allow`, or drop `allow` and use `profile` + `alsoAllow` instead.
</Note>

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

### `tools.toolsBySender`

Restricts tools for a specific requester identity. This is defense-in-depth on top of channel access control; sender values must come from the channel adapter, not message text.

```json5
{
  tools: {
    toolsBySender: {
      "channel:discord:1234567890123": { alsoAllow: ["group:fs"] },
      "id:guest-user-id": { deny: ["group:runtime", "group:fs"] },
      "*": { deny: ["exec", "process", "write", "edit", "apply_patch"] },
    },
  },
}
```

Keys use explicit prefixes: `channel:<channelId>:<senderId>`, `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, or `"*"`. Channel ids are canonical OpenClaw ids; aliases such as `teams` normalize to `msteams`. Legacy unprefixed keys are accepted as `id:` only. Matching order is channel+id, id, e164, username, name, then wildcard.

Per-agent `agents.entries.*.tools.toolsBySender` overrides the global sender match when it matches, even with an empty `{}` policy.

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

- Per-agent override (`agents.entries.*.tools.elevated`) can only further restrict.
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
      approvalRunningNoticeMs: 10000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      commandHighlighting: false,
      applyPatch: {
        enabled: true,
        allowModels: ["gpt-5.6-sol"],
      },
    },
  },
}
```

Values shown are defaults except `applyPatch.allowModels` (empty/unset by default, meaning any compatible model may use `apply_patch`). `approvalRunningNoticeMs` emits a running notice when approval-backed exec runs long; `0` disables it.

### `tools.loopDetection`

Tool-loop safety checks are **disabled by default**. Set `enabled: true` to activate detection. Settings can be defined globally in `tools.loopDetection` and overridden per-agent at `agents.entries.*.tools.loopDetection`.

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
    },
  },
}
```

### `tools.web`

```json5
{
  tools: {
    web: {
      search: {
        enabled: true,
        apiKey: "brave_api_key", // or BRAVE_API_KEY env (Brave provider)
        maxResults: 5,
        timeoutSeconds: 30,
        cacheTtlMinutes: 15,
      },
      fetch: {
        enabled: true,
        provider: "firecrawl", // optional; omit for auto-detect
        maxChars: 20000,
        maxCharsCap: 20000,
        maxResponseBytes: 750000,
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

Values shown are defaults except `provider` and `userAgent`. `maxResponseBytes` clamps to 32000–10000000; `maxChars` clamps to `maxCharsCap` (raise `maxCharsCap` to allow larger responses).

### `tools.media`

Configures inbound media understanding (image/audio/video):

```json5
{
  tools: {
    media: {
      concurrency: 2,
      models: [
        { provider: "openai", model: "gpt-4o-mini-transcribe", capabilities: ["audio"] },
        {
          type: "cli",
          command: "whisper",
          args: ["--model", "base", "{{MediaPath}}"],
          capabilities: ["audio"],
        },
        { provider: "ollama", model: "gemma4:26b", capabilities: ["image"] },
        { provider: "google", model: "gemini-3-flash-preview", capabilities: ["video"] },
      ],
      audio: { enabled: true, preferredModel: "openai/gpt-4o-mini-transcribe" },
      image: { enabled: true, preferredModel: "ollama/gemma4:26b" },
      video: { enabled: true },
    },
  },
}
```

`tools.media.models` is the only configured model list. Every entry declares the capabilities it handles. The optional `preferredModel` selector accepts `provider/model`, a model id, `provider:<id>` for provider-default entries, or `cli:command`; matching entries move to the front of that capability's fallback order. Per-capability prompts, limits, request settings, scope, attachment policy, and audio transcript echo remain defaults for configured and auto-detected models; a model entry can override model-specific fields.

<AccordionGroup>
  <Accordion title="Media model entry fields">
    **Provider entry** (`type: "provider"` or omitted):

    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc.)
    - `model`: model id override
    - `profile` / `preferredProfile`: `auth-profiles.json` profile selection

    **CLI entry** (`type: "cli"`):

    - `command`: executable to run
    - `args`: templated args (supports `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc.; `openclaw doctor --fix` migrates deprecated `{input}` placeholders to `{{MediaPath}}`)

    **Common fields:**

    - `capabilities`: list containing one or more of `image`, `audio`, and `video`.
    - `prompt`, `maxChars`, `maxBytes`, `timeoutSeconds`, `language`: per-entry overrides.
    - Matching image model `timeoutSeconds` entries also apply when the agent calls the explicit `image` tool. For image understanding, this timeout applies to the request itself and is not reduced by earlier preparation work.
    - Failures fall back to the next entry.

    Provider auth follows standard order: `auth-profiles.json` → env vars → `models.providers.*.apiKey`.

  </Accordion>
</AccordionGroup>

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

Default: `tree` (current session + sessions spawned by it, such as subagents, plus ambient
watched group sessions for the same agent).

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

<AccordionGroup>
  <Accordion title="Visibility scopes">
    - `self`: only the current session key.
    - `tree`: current session + sessions spawned by the current session (subagents). For read operations, it also includes same-agent group sessions that the current session watches through ambient group awareness.
    - `agent`: any session belonging to the current agent id (can include other users if you run per-sender sessions under the same agent id).
    - `all`: any session. Cross-agent targeting still requires `tools.agentToAgent`.
    - Sandbox clamp: when the current session is sandboxed and `agents.defaults.sandbox.sessionToolsVisibility="spawned"` (the default), visibility is forced to `tree` even if `tools.sessions.visibility="all"`.
    - When not `all`, `sessions_list` includes a compact `visibility` field
      describing the effective mode and a warning that some sessions may be
      omitted outside the current scope.

  </Accordion>
</AccordionGroup>

With the default `session.dmScope: "main"`, human activity in a group makes that same-agent group
session ambiently visible to the agent's main session. In a multi-user setup, `"main"` also shares
one DM session across users, so each user routed there can read from ambiently watched groups,
including through session-memory `memory_search`. Use a per-peer `dmScope` for DM isolation, or set
`tools.sessions.visibility: "self"` to opt out of ambient watched-session reads.

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

<AccordionGroup>
  <Accordion title="Attachment notes">
    - Attachments require `enabled: true`.
    - Subagent attachments are materialized into the child workspace at `.openclaw/attachments/<uuid>/` with a `.manifest.json`.
    - ACP attachments are image-only and forwarded inline to the ACP runtime after the same file count, per-file byte, and total byte limits pass.
    - Attachment content is automatically redacted from transcript persistence.
    - Base64 inputs are validated with strict alphabet/padding checks and a pre-decode size guard.
    - Subagent attachment file permissions are `0700` for directories and `0600` for files.
    - Subagent cleanup follows the `cleanup` policy: `delete` always removes attachments; `keep` retains them only when `retainOnSessionKeep: true`.

  </Accordion>
</AccordionGroup>

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

- `planTool`: enables the structured `update_plan` tool for non-trivial multi-step work tracking.
- Default: `false` unless `agents.defaults.embeddedAgent.executionContract` (or a per-agent override) is set to `"strict-agentic"` for an `openai` provider run against a GPT-5-family model id (this covers OpenAI Codex CLI runs too, since Codex auth/model routing lives under the `openai` provider). Set `true` to force the tool on outside that scope, or `false` to keep it off even for strict-agentic GPT-5 runs.
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
        announceTimeoutMs: 120000,
        archiveAfterMinutes: 60,
      },
    },
  },
}
```

- `model`: default model for spawned sub-agents. If omitted, sub-agents inherit the caller's model.
- `allowAgents`: default allowlist of configured target agent ids for `sessions_spawn` when the requester agent does not set its own `subagents.allowAgents` (`["*"]` = any configured target; default: same agent only). Stale entries whose agent config was deleted are rejected by `sessions_spawn` and omitted from `agents_list`; run `openclaw doctor --fix` to clean them up.
- `maxConcurrent`: max concurrent sub-agent runs. Default: `8`.
- `runTimeoutSeconds`: timeout (seconds) for `sessions_spawn` when the caller does not pass its own override. Default: `0` (no timeout); the `900` shown above is a common opt-in value, not the built-in default.
- `announceTimeoutMs`: per-call timeout (milliseconds) for gateway `agent` announce delivery attempts. Default: `120000`. Transient retries can make the total announce wait longer than one configured timeout.
- `archiveAfterMinutes`: minutes after a sub-agent session completes before it is auto-archived. Default: `60`; `0` disables auto-archive.
- Per-subagent tool policy: `tools.subagents.tools.allow` / `tools.subagents.tools.deny`.

---

## Custom providers and base URLs

Provider plugins publish their own model catalog rows. Add custom providers via `models.providers` in config or `~/.openclaw/agents/<agentId>/agent/models.json`.

Configuring a custom/local provider `baseUrl` is also the narrow network trust decision for model HTTP requests: OpenClaw allows that exact `scheme://host:port` origin through the guarded fetch path, without adding a separate config option or trusting other private origins.

```json5
{
  models: {
    mode: "merge", // merge (default) | replace
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions", // openai-completions | openai-responses | anthropic-messages | google-generative-ai | etc.
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

<AccordionGroup>
  <Accordion title="Auth and merge precedence">
    - Use `authHeader: true` + `headers` for custom auth needs.
    - Override agent config root with `OPENCLAW_AGENT_DIR`.
    - Merge precedence for matching provider IDs:
      - Non-empty agent `models.json` `baseUrl` values win.
      - Non-empty agent `apiKey` values win only when that provider is not SecretRef-managed in current config/auth-profile context.
      - SecretRef-managed provider `apiKey` values are refreshed from source markers (`ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs) instead of persisting resolved secrets.
      - SecretRef-managed provider header values are refreshed from source markers (`secretref-env:ENV_VAR_NAME` for env refs, `secretref-managed` for file/exec refs).
      - Empty or missing agent `apiKey`/`baseUrl` fall back to `models.providers` in config.
      - Matching model `contextWindow`/`maxTokens`: the explicit config value wins when present and valid (a positive finite number); otherwise the implicit/generated catalog value is used.
      - Matching model `contextTokens` follows the same explicit-wins-else-implicit rule; use it to limit effective context without changing native model metadata.
      - Provider-plugin catalogs are stored as generated plugin-owned catalog shards under the agent's plugin state.
      - Use `models.mode: "replace"` when you want config to fully rewrite `models.json` and skip merging in plugin-owned catalog shards.
      - Marker persistence is source-authoritative: markers are written from the active source config snapshot (pre-resolution), not from resolved runtime secret values.

  </Accordion>
</AccordionGroup>

### Provider field details

<AccordionGroup>
  <Accordion title="Top-level catalog">
    - `models.mode`: provider catalog behavior (`merge` or `replace`).
    - `models.providers`: custom provider map keyed by provider id.
      - Safe edits: use `openclaw config set models.providers.<id> '<json>' --strict-json --merge` or `openclaw config set models.providers.<id>.models '<json-array>' --strict-json --merge` for additive updates. `config set` refuses destructive replacements unless you pass `--replace`.

  </Accordion>
  <Accordion title="Provider connection and auth">
    - `models.providers.*.api`: request adapter (`openai-completions`, `openai-responses`, `openai-chatgpt-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`, `github-copilot`, `bedrock-converse-stream`, `ollama`, `azure-openai-responses`). For self-hosted `/v1/chat/completions` backends such as MLX, vLLM, SGLang, and most OpenAI-compatible local servers, use `openai-completions`. A custom provider with `baseUrl` but no `api` defaults to `openai-completions`; set `openai-responses` only when the backend supports `/v1/responses`.
    - `models.providers.*.apiKey`: provider credential (prefer SecretRef/env substitution).
    - `models.providers.*.auth`: auth strategy (`api-key`, `token`, `oauth`, `aws-sdk`).
    - `models.providers.*.contextWindow`: default native context window for models under this provider when the model entry does not set `contextWindow`.
    - `models.providers.*.contextTokens`: default effective runtime context cap for models under this provider when the model entry does not set `contextTokens`.
    - `models.providers.*.maxTokens`: default output-token cap for models under this provider when the model entry does not set `maxTokens`.
    - `models.providers.*.timeoutSeconds`: optional per-provider model HTTP request timeout in seconds, including connect, headers, body, and total request abort handling.
    - `models.providers.*.injectNumCtxForOpenAICompat`: for Ollama + `openai-completions`, inject `options.num_ctx` into requests (default: `true`).
    - `models.providers.*.authHeader`: force credential transport in the `Authorization` header when required.
    - `models.providers.*.baseUrl`: upstream API base URL.
    - `models.providers.*.headers`: extra static headers for proxy/tenant routing.

  </Accordion>
  <Accordion title="Request transport overrides">
    `models.providers.*.request`: transport overrides for model-provider HTTP requests.

    - `request.headers`: extra headers (merged with provider defaults). Values accept SecretRef.
    - `request.auth`: auth strategy override. Modes: `"provider-default"` (use provider's built-in auth), `"authorization-bearer"` (with `token`), `"header"` (with `headerName`, `value`, optional `prefix`).
    - `request.proxy`: HTTP proxy override. Modes: `"env-proxy"` (use `HTTP_PROXY`/`HTTPS_PROXY` env vars), `"explicit-proxy"` (with `url`). Both modes accept an optional `tls` sub-object.
    - `request.tls`: TLS override for direct connections. Fields: `ca`, `cert`, `key`, `passphrase` (all accept SecretRef), `serverName`, `insecureSkipVerify`.
    - `request.allowPrivateNetwork`: when `true`, allow model-provider HTTP requests to private, CGNAT, or similar ranges through the provider HTTP fetch guard. Custom/local provider base URLs already trust the exact configured origin, except metadata/link-local origins, which remain blocked without explicit opt-in. Set this to `false` to opt out of exact-origin trust. WebSocket uses the same `request` for headers/TLS but not that fetch SSRF gate. Default `false`.

  </Accordion>
  <Accordion title="Model catalog entries">
    - `models.providers.*.models`: explicit provider model catalog entries.
    - `models.providers.*.models.*.input`: model input modalities. Use `["text"]` for text-only models and `["text", "image"]` for native image/vision models. Image attachments are only injected into agent turns when the selected model is marked image-capable.
    - `models.providers.*.models.*.contextWindow`: native model context window metadata. This overrides provider-level `contextWindow` for that model.
    - `models.providers.*.models.*.contextTokens`: optional runtime context cap. This overrides provider-level `contextTokens`; use it when you want a smaller effective context budget than the model's native `contextWindow`; `openclaw models list` shows both values when they differ.

    #### Custom provider capability declarations

    Provider catalogs own `compat` for bundled and catalog-known model routes. Do not copy those flags into config: OpenClaw uses the catalog row when the configured `api` and `baseUrl` still identify that route. `openclaw doctor --fix` removes matching legacy overrides and reports divergent values for review.

    A `compat` block remains supported for a genuinely custom provider, custom model, or catalog model routed to a different endpoint. Set only capabilities verified against that endpoint:

    | Custom-route key | Runtime contract |
    | --- | --- |
    | `supportsStore` | Accepts the OpenAI `store` request field. |
    | `supportsPromptCacheKey` | Accepts OpenAI prompt-cache/session-affinity keys. |
    | `supportsDeveloperRole` | Accepts `developer` messages instead of requiring `system`. |
    | `supportsReasoningEffort` | Accepts a reasoning-effort control. |
    | `supportsTemperature` | Accepts `temperature` for this model and adapter. |
    | `supportsUsageInStreaming` | Emits usage metadata in streaming responses. |
    | `supportsTools` | Supports structured tool/function calling. Set `false` to disable tools. |
    | `supportsStrictMode` | Accepts strict tool schemas. |
    | `requiresStringContent` | Requires plain-string Chat Completions message content. |
    | `strictMessageKeys` | Requires outgoing messages to contain only accepted keys. |
    | `visibleReasoningDetailTypes` | Names reasoning detail block types safe to show in transcripts. |
    | `supportedReasoningEfforts` | Lists the endpoint's accepted reasoning labels. |
    | `reasoningEffortMap` | Maps OpenClaw thinking labels to endpoint-specific labels. |
    | `maxTokensField` | Selects `max_tokens` or `max_completion_tokens`. |
    | `thinkingFormat` | Selects the endpoint's reasoning payload dialect. |
    | `requiresToolResultName` | Requires a tool name on tool-result messages. |
    | `requiresAssistantAfterToolResult` | Requires an assistant message after tool results. |
    | `requiresThinkingAsText` | Replays reasoning as text rather than structured content. |
    | `requiresReasoningContentOnAssistantMessages` | Preserves DeepSeek-style `reasoning_content` during replay. |
    | `toolSchemaProfile` | Selects a provider-defined tool-schema normalization profile. |
    | `unsupportedToolSchemaKeywords` | Removes named JSON Schema keywords rejected by the endpoint. |
    | `toolCallArgumentsEncoding` | Selects the endpoint's tool-call argument encoding. |
    | `requiresOpenAiAnthropicToolPayload` | Converts OpenAI-shaped tool calls to Anthropic-family payloads. |

  </Accordion>
  <Accordion title="Amazon Bedrock discovery">
    - `plugins.entries.amazon-bedrock.config.discovery`: Bedrock auto-discovery settings root.
    - `plugins.entries.amazon-bedrock.config.discovery.enabled`: turn implicit discovery on/off.
    - `plugins.entries.amazon-bedrock.config.discovery.region`: AWS region for discovery.
    - `plugins.entries.amazon-bedrock.config.discovery.providerFilter`: optional provider-id filter for targeted discovery.
    - `plugins.entries.amazon-bedrock.config.discovery.refreshInterval`: polling interval for discovery refresh.
    - `plugins.entries.amazon-bedrock.config.discovery.defaultContextWindow`: fallback context window for discovered models.
    - `plugins.entries.amazon-bedrock.config.discovery.defaultMaxTokens`: fallback max output tokens for discovered models.

  </Accordion>
</AccordionGroup>

Interactive custom-provider onboarding infers image input for known vision-model-id patterns, including GPT-4o/GPT-4.1/GPT-5+, the `o1`/`o3`/`o4` reasoning families, Claude, Gemini, any `-vl`-suffixed id (Qwen-VL and similar), and named families such as LLaVA, Pixtral, InternVL, Mllama, MiniCPM-V, and GLM-4V; it skips the extra question for known text-only families (Llama, DeepSeek, Mistral/Mixtral, Kimi/Moonshot, Codestral, Devstral, Phi, QwQ, CodeLlama, and bare Qwen ids without a vl/vision suffix). Unknown model IDs still prompt for image support. Non-interactive onboarding uses the same inference; pass `--custom-image-input` to force image-capable metadata or `--custom-text-input` to force text-only metadata.

### Provider examples

<AccordionGroup>
  <Accordion title="Cerebras (GLM 4.7 / GPT OSS)">
    The official external `cerebras` provider plugin can configure this via `openclaw onboard --auth-choice cerebras-api-key`. Use explicit provider config only when overriding defaults.

    ```json5
    {
      env: { CEREBRAS_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: {
            primary: "cerebras/zai-glm-4.7",
            fallbacks: ["cerebras/gpt-oss-120b"],
          },
          models: {
            "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
            "cerebras/gpt-oss-120b": { alias: "GPT OSS 120B (Cerebras)" },
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
              { id: "gpt-oss-120b", name: "GPT OSS 120B (Cerebras)" },
            ],
          },
        },
      },
    }
    ```

    Use `cerebras/zai-glm-4.7` for Cerebras; `zai/glm-4.7` for Z.AI direct.

  </Accordion>
  <Accordion title="Kimi Coding">
    ```json5
    {
      env: { KIMI_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "kimi/kimi-for-coding" },
          models: { "kimi/kimi-for-coding": { alias: "Kimi Code" } },
        },
      },
    }
    ```

    Anthropic-compatible, built-in provider. Shortcut: `openclaw onboard --auth-choice kimi-code-api-key`.

  </Accordion>
  <Accordion title="Local models (LM Studio)">
    See [Local Models](/gateway/local-models). TL;DR: run a large local model via LM Studio Responses API on serious hardware; keep hosted models merged for fallback.
  </Accordion>
  <Accordion title="MiniMax M3 (direct)">
    ```json5
    {
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M3" },
          models: {
            "minimax/MiniMax-M3": { alias: "Minimax" },
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
                id: "MiniMax-M3",
                name: "MiniMax M3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 },
                contextWindow: 1000000,
                maxTokens: 131072,
              },
            ],
          },
        },
      },
    }
    ```

    Set `MINIMAX_API_KEY`. Shortcuts: `openclaw onboard --auth-choice minimax-global-api` or `openclaw onboard --auth-choice minimax-cn-api`. The model catalog defaults to M3 and also includes the M2.7 variants. On the Anthropic-compatible streaming path, OpenClaw disables MiniMax M2.x thinking by default unless you explicitly set `thinking` yourself; MiniMax-M3 (and M3.x) stays on the provider's omitted/adaptive thinking path by default. `/fast on` or `params.fastMode: true` rewrites `MiniMax-M2.7` to `MiniMax-M2.7-highspeed`.

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

    Native Moonshot endpoints advertise streaming usage compatibility on the shared `openai-completions` transport, and OpenClaw keys that off endpoint capabilities rather than the built-in provider id alone.

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
  <Accordion title="Synthetic (Anthropic-compatible)">
    ```json5
    {
      env: { SYNTHETIC_API_KEY: "sk-..." },
      agents: {
        defaults: {
          model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M3" },
          models: { "synthetic/hf:MiniMaxAI/MiniMax-M3": { alias: "MiniMax M3" } },
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
                id: "hf:MiniMaxAI/MiniMax-M3",
                name: "MiniMax M3",
                reasoning: true,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 262144,
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

    Set `ZAI_API_KEY`. Model refs use the canonical `zai/*` provider ID. Shortcut: `openclaw onboard --auth-choice zai-api-key`.

    - General endpoint: `https://api.z.ai/api/paas/v4`
    - Coding endpoint: `https://api.z.ai/api/coding/paas/v4`
    - The default `zai-api-key` auth choice probes your key and auto-detects which endpoint it belongs to (falling back to a prompt, defaulting to Global, if detection is inconclusive). Dedicated CN and Coding-Plan auth choices are also available for explicit selection.
    - For the general endpoint, define a custom provider with the base URL override.

  </Accordion>
</AccordionGroup>

---

## Related

- [Configuration — agents](/gateway/config-agents)
- [Configuration — channels](/gateway/config-channels)
- [Configuration reference](/gateway/configuration-reference) — other top-level keys
- [Tools and plugins](/tools)
