---
summary: "Extension config: MCP servers, skills, plugin entries, and the canvas widget presenter"
read_when:
  - Registering an MCP server or plugin entry
  - Tuning skill discovery or plugin config
  - Configuring the canvas widget presenter
title: "Configuration — MCP, skills, and plugins"
---

Extension surfaces: `mcp.*`, `skills.*`, `plugins.*`, and `canvas.*`.

For the full key index and the other top-level config domains, see [Configuration reference](/gateway/configuration-reference).

## MCP

OpenClaw-managed MCP server definitions live under `mcp.servers` and are
consumed by embedded OpenClaw and other runtime adapters. The `openclaw mcp list`,
`show`, `set`, and `unset` commands manage this block without connecting to the
target server during config edits.

```json5
{
  mcp: {
    servers: {
      docs: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-fetch"],
      },
      remote: {
        url: "https://example.com/mcp",
        transport: "streamable-http", // streamable-http | sse
        requestTimeoutMs: 20000,
        connectionTimeoutMs: 5000,
        supportsParallelToolCalls: true,
        headers: {
          Authorization: "Bearer ${MCP_REMOTE_TOKEN}",
        },
        auth: "oauth",
        oauth: {
          identity: "per-requester", // shared | per-requester; default: shared
          scope: "docs.read",
        },
        sslVerify: true,
        clientCert: "/path/to/client.crt",
        clientKey: "/path/to/client.key",
        toolFilter: {
          include: ["search_*"],
          exclude: ["admin_*"],
        },
        // Optional Codex app-server projection controls.
        codex: {
          agents: ["main"],
          defaultToolsApprovalMode: "approve", // auto | prompt | approve
        },
      },
    },
  },
}
```

- `mcp.servers`: named stdio or remote MCP server definitions for runtimes that
  expose configured MCP tools.
  Remote entries use `transport: "streamable-http"` or `transport: "sse"`;
  `type: "http"` is a CLI-native alias that `openclaw mcp set` and
  `openclaw doctor --fix` normalize into the canonical `transport` field.
- `mcp.servers.<name>.enabled`: set `false` to keep a saved server definition
  while excluding it from embedded OpenClaw MCP discovery and tool projection.
- `mcp.servers.<name>.requestTimeoutMs`: per-server MCP request timeout in milliseconds.
- `mcp.servers.<name>.connectionTimeoutMs`: per-server connection timeout in milliseconds.
- `mcp.servers.<name>.supportsParallelToolCalls`: optional concurrency hint for
  adapters that can choose whether to issue parallel MCP tool calls.
- `mcp.servers.<name>.auth`: set `"oauth"` for HTTP MCP servers that require
  OAuth. Run `openclaw mcp login <name>` to store tokens under OpenClaw state.
- `mcp.servers.<name>.oauth`: optional OAuth scope, redirect URL, and client
  metadata URL overrides.
- `mcp.servers.<name>.oauth.identity`: credential ownership. Omit it or set
  `"shared"` for operator-managed credentials; set `"per-requester"` to isolate
  credentials for each authenticated sender. Per-requester OAuth requires an
  HTTP server URL, cannot use `oauth.authProfileId`, and requires
  `gateway.publicOrigin` for its callback.
- `mcp.servers.<name>.sslVerify`, `clientCert`, `clientKey`: HTTP TLS controls
  for private endpoints and mutual TLS.
- `mcp.servers.<name>.toolFilter`: optional per-server tool selection. `include`
  limits the discovered MCP tools to matching names; `exclude` hides matching
  names. Entries are exact MCP tool names or simple `*` globs. Servers with
  resources or prompts also generate utility tool names (`resources_list`,
  `resources_read`, `prompts_list`, `prompts_get`), and those names use the
  same filter.
- `mcp.servers.<name>.codex`: optional Codex app-server projection controls.
  This block is OpenClaw metadata for Codex app-server threads only; it does not
  affect ACP sessions, generic Codex harness config, or other runtime adapters.
  Non-empty `codex.agents` limits the server to the listed OpenClaw agent ids.
  Empty, blank, or invalid scoped agent lists are rejected by config validation
  and omitted by the runtime projection path instead of becoming global.
  `codex.defaultToolsApprovalMode` emits Codex's native
  `default_tools_approval_mode` for that server. OpenClaw strips the `codex`
  block before passing native `mcp_servers` config to Codex. Omit the block to
  keep the server projected for every Codex app-server agent with Codex's
  default MCP approval behavior.
- Session-scoped bundled MCP runtimes use a built-in 10-minute idle TTL.
  One-shot embedded runs request run-end cleanup; the TTL is the backstop for long-lived sessions and future callers.
- MCP config changes retire only changed or removed server connections. Unchanged
  servers keep their transports and tool catalogs; active runs can continue calling
  their tools and resources. The next turn's discovery creates changed servers from the new config. Plugin
  reloads also retire connections owned by the replaced plugins or their resolvers.
  Requester sign-in tools refresh on the next message after runtime replacement.
- Runtime discovery also honors MCP tool-list change notifications by dropping
  the affected server's cached catalog. Servers that advertise resources or
  prompts get utility tools for listing/reading resources and listing/fetching
  prompts. Repeated tool-call failures pause the affected server briefly before
  another call is attempted.

See [MCP](/cli/mcp#openclaw-as-an-mcp-client-registry) and
[CLI backends](/gateway/cli-backends#bundle-mcp-overlays) for runtime behavior.

## Skills

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/path/to/agent-scripts/skills"],
      allowSymlinkTargets: ["~/path/to/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun
      allowUploadedArchives: false,
    },
    entries: {
      "image-lab": {
        apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY" }, // or plaintext string
        env: { GEMINI_API_KEY: "GEMINI_KEY_HERE" },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

- `allowBundled`: optional allowlist for bundled skills only (managed/workspace skills unaffected).
- `load.extraDirs`: extra shared skill roots (lowest precedence).
- `load.allowSymlinkTargets`: trusted real target roots that skill symlinks may
  resolve into when the link lives outside its configured source root.
- `install.preferBrew`: when true, prefer Homebrew installers when `brew` is
  available before falling back to other installer kinds.
- `install.nodeManager`: node installer preference for `metadata.openclaw.install`
  specs (`npm` | `pnpm` | `yarn` | `bun`).
- `install.allowUploadedArchives`: allow trusted `operator.admin` Gateway
  clients to install private zip archives staged through `skills.upload.*`
  (default: false). This only enables the uploaded-archive path; normal ClawHub
  installs do not require it.
- `entries.<skillKey>.enabled: false` disables a skill even if bundled/installed.
- `entries.<skillKey>.apiKey`: convenience for skills declaring a primary env var (plaintext string or SecretRef object).
- `limits.maxCandidatesPerRoot`, `limits.maxSkillsLoadedPerSource`, `limits.maxSkillsInPrompt`, `limits.maxSkillsPromptChars`, `limits.maxSkillFileBytes`: bound skill discovery and the model-facing skills prompt.
- Skill Workshop autonomy/approval settings (`workshop.autonomous.mode`, `workshop.approvalPolicy`, `workshop.maxPending`, `workshop.maxSkillBytes`) are documented in [Skills configuration](/tools/skills-config).

---

## Plugins

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: [],
    load: {
      paths: ["~/path/to/oss/voice-call-plugin"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        hooks: {
          allowPromptInjection: false,
        },
        config: { provider: "twilio" },
      },
    },
  },
}
```

- Loaded from package or bundle directories under `~/.openclaw/extensions` and `<workspace>/.openclaw/extensions`, plus files or directories listed in `plugins.load.paths`.
- Put standalone plugin files in `plugins.load.paths`; auto-discovered extension roots ignore top-level `.js`, `.mjs`, and `.ts` files so helper scripts in those roots do not block startup.
- Discovery accepts native OpenClaw plugins plus compatible Codex bundles and Claude bundles, including manifestless Claude default-layout bundles.
- With the default hybrid reload mode, ordinary plugin policy and entry changes hot-reload the plugin runtime. Plugin code, metadata, and discovery-root changes require a Gateway restart; active plugins can also declare restart-triggering config prefixes.
- `allow`: optional allowlist (only listed plugins load). `deny` wins.
- `plugins.entries.<id>.apiKey`: plugin-level API key convenience field (when supported by the plugin).
- `plugins.entries.<id>.env`: plugin-scoped env var map.
- `plugins.entries.<id>.hooks.allowPromptInjection`: when `false`, core blocks prompt-mutating hooks such as `before_prompt_build`. Applies to native plugin hooks and supported bundle-provided hook directories.
- `plugins.entries.<id>.hooks.allowConversationAccess`: when `true`, trusted non-bundled plugins may read raw conversation content from typed hooks such as `before_model_resolve`, `agent_turn_prepare`, `before_prompt_build`, `before_agent_reply`, `llm_input`, `llm_output`, `before_agent_run`, `before_agent_finalize`, and `agent_end`.
- `plugins.entries.<id>.subagent.allowModelOverride`: explicitly trust this plugin to request per-run `provider` and `model` overrides for background subagent runs.
- `plugins.entries.<id>.subagent.allowedModels`: optional allowlist of canonical `provider/model` targets for trusted subagent overrides. Use `"*"` only when you intentionally want to allow any model.
- `plugins.entries.<id>.llm.allowModelOverride`: explicitly trust this plugin to request model overrides for `api.runtime.llm.complete`.
- `plugins.entries.<id>.llm.allowedModels`: optional allowlist of canonical `provider/model` targets for trusted model overrides. Use `"*"` only when you intentionally want to allow any model override.
- `plugins.entries.<id>.llm.allowedCompletionModels`: optional allowlist applied to every plugin LLM completion, including host-resolved defaults and overrides. Use `"*"` only when you intentionally want to allow any model.
- `plugins.entries.<id>.llm.allowAuthProfileOverride`: explicitly trust this plugin to select a non-default auth profile for isolated `api.runtime.llm.complete` execution. Direct `model@profile` calls remain governed by model-override policy.
- `plugins.entries.<id>.llm.allowAgentIdOverride`: explicitly trust this plugin to run `api.runtime.llm.complete` against a non-default agent id.
- `plugins.entries.<id>.config`: plugin-defined config object (validated by native OpenClaw plugin schema when available).
- Channel plugin account/runtime settings live under `channels.<id>` and should be described by the owning plugin's manifest `channelConfigs` metadata, not by a central OpenClaw option registry.

### Codex harness plugin config

The bundled `codex` plugin owns native Codex app-server harness settings under
`plugins.entries.codex.config`. See
[Codex harness reference](/plugins/codex-harness-reference) for the full config
surface and [Codex harness](/plugins/codex-harness) for the runtime model.

`codexPlugins` applies only to sessions that select the native Codex harness.
It does not enable Codex plugins for OpenClaw provider runs, ACP
conversation bindings, or any non-Codex harness.

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_all_plugins: true,
            allow_destructive_actions: "auto",
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
                allow_destructive_actions: false,
              },
            },
          },
        },
      },
    },
  },
}
```

- `plugins.entries.codex.config.codexPlugins.enabled`: enables native Codex
  plugin/app support for the Codex harness. Default: `false`.
- `plugins.entries.codex.config.codexPlugins.allow_all_plugins`: exposes every
  currently accessible app connected to the authenticated Codex account in
  each new native Codex thread. Default: `false`.
- `plugins.entries.codex.config.codexPlugins.allow_destructive_actions`:
  default destructive-action policy for configured plugin app elicitations.
  Use `true` to accept safe Codex approval schemas without prompting, `false`
  to decline them, `"auto"` to route Codex-required approvals through OpenClaw
  plugin approvals, or `"ask"` to prompt for every plugin write/destructive
  action without durable approval. The `"ask"` mode clears durable Codex
  per-tool approval overrides for the affected app and selects the human
  approvals reviewer for that app before the Codex thread starts.
  Default: `true`.
- `plugins.entries.codex.config.codexPlugins.plugins.<key>.enabled`: enables a
  configured plugin entry when global `codexPlugins.enabled` is also true.
  Default: `true` for explicit entries.
- `plugins.entries.codex.config.codexPlugins.plugins.<key>.marketplaceName`:
  stable marketplace identity, required with `pluginName` for every resolved
  entry. Supports any valid marketplace already discoverable by Codex,
  including `"openai-curated"`, `"openai-bundled"`,
  `"openai-primary-runtime"`, `"workspace-directory"`, and repository-local
  marketplace identities. Entries missing either identity field are ignored.
- `plugins.entries.codex.config.codexPlugins.plugins.<key>.pluginName`: stable
  Codex plugin identity, required with `marketplaceName`. Use the exact
  identity reported by Codex for marketplaces whose plugin identifiers are
  marketplace-qualified. `/codex plugins available` lists discoverable
  identities, and an owner or `operator.admin` can install one with
  `/codex plugins install <plugin>@<marketplace>`.
- `plugins.entries.codex.config.codexPlugins.plugins.<key>.allow_destructive_actions`:
  per-plugin destructive-action override. When omitted, the global
  `allow_destructive_actions` value is used. The per-plugin value accepts the
  same `true`, `false`, `"auto"`, or `"ask"` policies.

Each admitted plugin app that uses `"ask"` routes that app's approval requests
to the human reviewer. Other apps and non-app thread approvals keep their
configured reviewer, so mixed plugin policies do not inherit `"ask"` behavior.

`codexPlugins.enabled` is the global enablement directive. Explicit plugin
entries written by migration preserve durable curated install and repair
eligibility. An owner or `operator.admin` can add other discovered plugins with
`/codex plugins install <plugin>@<marketplace>`; Codex still controls upstream
installation and connector authentication. Plugins without exact identity,
installation, or accessible app ownership fail closed. `plugins["*"]` is not
supported, and local `marketplacePath` values are intentionally not config
fields because they are host-specific. See
[Native Codex plugins](/plugins/codex-native-plugins) for app-server version and
readiness requirements.

`app/installed` readiness checks (with authorized metadata from batched
`app/read`) are cached for one hour and refreshed
asynchronously when stale. Codex thread app config is computed at Codex harness
session establishment, not on every turn; use `/new`, `/reset`, or a gateway
restart after changing native plugin config.

`codexPlugins.allow_all_plugins` snapshots every currently accessible account
app into each new native Codex thread. It does not install plugins or apps, and
inaccessible apps stay excluded. Account apps use the global
`codexPlugins.allow_destructive_actions` policy. Explicit plugin entries take
precedence when the same app is present in both paths. If `app/installed`
cannot be read, account-wide exposure fails closed.

- `plugins.entries.firecrawl.config.webFetch`: Firecrawl web-fetch provider settings.
  - `apiKey`: Optional Firecrawl API key for higher limits (accepts SecretRef). Falls back to `plugins.entries.firecrawl.config.webSearch.apiKey` or `FIRECRAWL_API_KEY` env var.
  - `baseUrl`: Firecrawl API base URL (default: `https://api.firecrawl.dev`; self-hosted overrides must target private/internal endpoints).
  - `onlyMainContent`: extract only the main content from pages (default: `true`).
  - `maxAgeMs`: maximum cache age in milliseconds (default: `172800000` / 2 days).
  - `timeoutSeconds`: scrape request timeout in seconds (default: `60`).
- `plugins.entries.xai.config.xSearch`: xAI X Search (Grok web search) settings.
  - `enabled`: enable the X Search provider.
  - `model`: Grok model to use for search (e.g. `"grok-4.3"`).
- `plugins.entries.memory-core.config.dreaming`: memory dreaming settings. See [Dreaming](/concepts/dreaming) for phases and thresholds.
  - `enabled`: master dreaming switch (default `false`).
  - `frequency`: cron cadence for each full dreaming sweep (`"0 3 * * *"` by default).
  - `model`: optional Dream Diary subagent model override. Requires `plugins.entries.memory-core.subagent.allowModelOverride: true`; pair with `allowedModels` to restrict targets. Model-unavailable errors retry once with the session default model; trust or allowlist failures do not fall back silently.
  - phase policy and thresholds are implementation details (not user-facing config keys).
- Full memory config lives in [Memory configuration reference](/reference/memory-config):
  - `memory.search.*`
  - `agents.entries.*.memory.search.*` for per-agent overrides
  - `memory.citations`
  - `plugins.entries.memory-core.config.dreaming`
- Enabled Claude bundle plugins can also contribute embedded OpenClaw defaults from `settings.json`; OpenClaw applies those as sanitized agent settings, not as raw OpenClaw config patches.
- `plugins.slots.memory`: pick the active memory plugin id, or `"none"` to disable memory plugins.
- `plugins.slots.contextEngine`: pick the active context engine plugin id; defaults to `"legacy"` unless you install and select another engine.

See [Plugins](/tools/plugin).

---

## Canvas widget presenter

```json5
{
  plugins: {
    entries: {
      canvas: {
        config: {
          host: {
            enabled: true, // set false, or use OPENCLAW_SKIP_CANVAS_HOST=1
          },
        },
      },
    },
  },
}
```

- `host.enabled` is the single Canvas host switch and defaults to enabled. It
  gates hosted widget documents under `/__openclaw__/canvas/` and A2UI renderer
  assets under `/__openclaw__/a2ui/`.
- Local-only: keep `gateway.bind: "loopback"` (default).
- Non-loopback binds: these routes require Gateway auth (token/password/trusted-proxy), same as other Gateway HTTP surfaces.
- Node WebViews typically don't send auth headers; after a macOS node is paired and connected, the Gateway advertises a node-scoped `pluginSurfaceUrls.canvas` capability URL.
- Capability URLs are bound to the active node WS session and expire quickly. IP-based fallback is not used.
- Changes require a gateway restart.

---
