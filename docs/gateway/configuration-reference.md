---
summary: "Gateway config reference for core OpenClaw keys, defaults, and links to dedicated subsystem references"
title: "Configuration reference"
read_when:
  - You need exact field-level config semantics or defaults
  - You are validating channel, model, gateway, or tool config blocks
doc-schema-version: 1
---

Field-level reference for `~/.openclaw/openclaw.json`: keys, defaults, and links to deeper subsystem pages. For task-oriented setup guidance, see [Configuration](/gateway/configuration). Channel- and plugin-owned command catalogs and deep memory knobs live on their own pages, not here.

Config format is **JSON5** (comments + trailing commas allowed). All fields are optional; OpenClaw uses safe defaults when omitted.

Code truth beats this page:

- `openclaw config schema` prints the live JSON Schema used for validation and Control UI, with bundled/plugin/channel metadata merged in.
- Agents should call the `gateway` tool action `config.schema.lookup` for one exact path-scoped schema node before editing config.
- `pnpm config:docs:check` / `pnpm config:docs:gen` validate this doc's baseline hash against the current schema surface.

Schema `uiHints` also carry a resolved `advanced` boolean for every path.
Control UI uses it to show common fields first and collapse advanced fields per
section; search still spans both tiers. Tier metadata is presentational only.
When adding a key, declare its tier on the leaf or let it inherit the nearest
ancestor declaration. A path with no declared ancestor is advanced by default.

Dedicated deep references:

- [Memory configuration reference](/reference/memory-config) for `memory.search.*`, `memory.citations`, and dreaming config under `plugins.entries.memory-core.config.dreaming`.
- [Slash commands](/tools/slash-commands) for the current built-in + bundled command catalog.
- Owning channel/plugin pages for channel-specific command surfaces.

---

## Channels

Per-channel config keys live in [Configuration - channels](/gateway/config-channels): `channels.*` for Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, and other channel plugins (auth, access control, multi-account, mention gating).

## Agent defaults, multi-agent, sessions, and messages

See [Configuration - agents](/gateway/config-agents) for:

- `agents.defaults.*` (workspace, model, thinking, heartbeat, memory, media, skills, sandbox)
- `multiAgent.*` (multi-agent routing and bindings)
- `session.*` (session lifecycle, compaction, pruning)
- `messages.*` (message delivery, TTS, markdown rendering)
- `talk.*` (Talk mode)
  - `talk.consultThinkingLevel`: thinking level override for the full OpenClaw agent run behind Control UI Talk realtime consults
  - `talk.consultFastMode`: one-shot fast-mode override for Control UI Talk realtime consults
  - `talk.speechLocale`: optional BCP 47 locale id for Talk speech recognition on Android, iOS, and macOS, and for iOS system-voice fallback
  - `talk.silenceTimeoutMs`: when unset, Talk keeps the platform default pause window before sending the transcript (`700 ms on macOS and Android, 900 ms on iOS`)
  - `talk.realtime.consultRouting`: Gateway relay fallback for finalized realtime Talk transcripts that skip `openclaw_agent_consult`

## `worktreeRoot`

Optional global root directory for [managed worktree](/concepts/managed-worktrees) checkouts. Defaults to `<openclaw-state-dir>/worktrees`.

```json5
{
  worktreeRoot: "/mnt/workspaces/openclaw-worktrees",
}
```

Use an absolute Gateway-host path, `~` for the Gateway user's home directory, or `~/` followed by a folder inside it; relative paths are rejected. OpenClaw creates checkouts at `<worktreeRoot>/<repo-fingerprint>/<name>`. This setting applies to all agents and all managed-worktree owners, with no per-agent override. The shared state database and allocation limits remain under the existing state directory.

Changes affect new allocations only. Registered worktrees retain their original paths for reuse, cleanup, and snapshot restore; existing checkouts are not moved automatically. Keep their original storage available while those records are still needed.

## Tools and custom providers

Tool policy, experimental toggles, provider-backed tool config, and custom
provider / base-URL setup live in
[Configuration - tools and custom providers](/gateway/config-tools).

## Models

Provider definitions, model allowlists, and custom provider setup live in
[Configuration - tools and custom providers](/gateway/config-tools#custom-providers-and-base-urls).
The `models` root also owns global model-catalog behavior.

```json5
{
  models: {
    // Optional. Hosted catalog updates default on.
    catalogRefresh: {
      enabled: true,
      // url: "https://catalog.example.com/openclaw/catalog.json",
    },
  },
}
```

- `models.mode`: provider catalog behavior (`merge` or `replace`).
- `models.providers`: custom provider map keyed by provider id.
- `models.providers.*.localService`: optional on-demand process manager for
  local model servers. OpenClaw probes the configured health endpoint, starts
  the absolute `command` when needed, waits for readiness, then sends the model
  request. See [Local model services](/gateway/local-model-services).
- `models.catalogRefresh.enabled`: controls the hosted model catalog refresh
  (default: `true`). Set it to `false` to prevent all remote catalog requests;
  model metadata and pricing then stay at the values shipped in the installed
  release or declared under `models.providers.*.models[].cost`.
- `models.catalogRefresh.url`: optional HTTPS mirror override (plain HTTP is
  accepted only for explicit localhost testing). The Gateway
  checks in the background at startup and every six hours. A downloaded catalog
  applies on the next Gateway restart; a release whose bundled catalog is newer
  always wins.

Pricing updates ship in the same hosted catalog file as model metadata. The
retired `models.pricing` toggle is removed automatically by `openclaw doctor
--fix`; use `models.catalogRefresh.enabled: false` when OpenClaw must avoid all
hosted catalog traffic.

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
- Changes under `mcp.*` hot-apply by disposing cached session MCP runtimes.
  The next tool discovery/use recreates them from the new config, so removed
  `mcp.servers` entries are reaped immediately instead of waiting for idle TTL.
- Runtime discovery also honors MCP tool-list change notifications by dropping
  the cached catalog for that session. Servers that advertise resources or
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
      extraDirs: ["~/Projects/agent-scripts/skills"],
      allowSymlinkTargets: ["~/Projects/manager/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm", // npm | pnpm | yarn | bun
      allowUploadedArchives: false,
    },
    workshop: {
      allowSymlinkTargetWrites: false,
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
- `workshop.allowSymlinkTargetWrites`: allows Skill Workshop apply to write
  through already-trusted symlink targets (default: false).
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
      paths: ["~/Projects/oss/voice-call-plugin"],
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
- **Config changes require a gateway restart.**
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

## Browser

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    defaultProfile: "user",
    ssrfPolicy: {
      // dangerouslyAllowPrivateNetwork: true, // opt in only for trusted private-network access
      // allowPrivateNetwork: true, // legacy alias
      // allowedHostnames: ["*.example.com", "example.com", "localhost"],
      // blockedHostnames: ["tracker.example.com", "*.ads.example.com"],
    },
    tabCleanup: {
      enabled: true,
    },
    extensionRelay: {
      allowLegacyAuth: true,
    },
    profiles: {
      openclaw: { cdpPort: 18800 },
      work: {
        cdpPort: 18801,
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      },
      chrome: { driver: "extension" },
      user: { driver: "existing-session", attachOnly: true },
      brave: {
        driver: "existing-session",
        attachOnly: true,
        userDataDir: "~/Library/Application Support/BraveSoftware/Brave-Browser",
      },
      remote: { cdpUrl: "http://10.0.0.42:9222" },
    },
    // headless: false,
    // noSandbox: false,
    // extraArgs: [],
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false,
  },
}
```

- `evaluateEnabled: false` disables `act:evaluate` and `wait --fn`.
- `extensionRelay.allowLegacyAuth` defaults to `true` for one Browser Relay
  Authentication migration window. It permits old extension and external CDP
  Bearer, Basic, and token-subprotocol clients. Set it to `false`
  after all relay clients use auth v2; v2 clients never downgrade.
- `tabCleanup` controls best-effort periodic cleanup for tracked primary-agent
  tabs after idle time or when a session exceeds its cap. Tracking applies only
  to tabs created by browser tool `action: "open"`; tabs opened by the user or
  with unknown ownership are never adopted. Disabling `tabCleanup` does not disable explicit session lifecycle cleanup.
- Host-local opens with a stable native CDP target and browser identity are
  stored in shared SQLite state and remain eligible across Gateway restarts for
  `/new` and session lifecycle cleanup. Native tool-facing CDP targets also
  remain eligible for idle and cap cleanup after restart. Chrome MCP uses
  process-local target handles, so cold existing-session records wait for
  lifecycle cleanup rather than risking an idle sweep against unattributable
  post-restart activity. OpenClaw verifies the profile and browser instance
  before closing. Chrome MCP auto-connect, missing `/json/version` browser
  identity, and unresolved native targets remain fully process-local, so they
  are not automatically closed after a restart. Older untracked tabs require
  manual closure. Transient failures stay pending for a later retry. See
  [Tab cleanup ownership](/tools/browser#tab-cleanup-ownership).
- `ssrfPolicy.dangerouslyAllowPrivateNetwork` is disabled when unset, so browser navigation stays strict by default.
- Set `ssrfPolicy.dangerouslyAllowPrivateNetwork: true` only when you intentionally trust private-network browser navigation.
- In strict mode, remote CDP profile endpoints (`profiles.*.cdpUrl`) are subject to the same private-network blocking during reachability/discovery checks.
- `ssrfPolicy.allowPrivateNetwork` remains supported as a legacy alias.
- In strict mode, use the wildcard-aware `ssrfPolicy.allowedHostnames` for exact-host and pattern exceptions.
- `ssrfPolicy.blockedHostnames` denies exact hosts and `*.example.com` subdomains before DNS and allow rules, including private-network exceptions. Wildcards exclude the apex; add `example.com` separately to block it. Empty or unset adds no denials.
- Remote profiles are attach-only (start/stop/reset disabled).
- `profiles.*.cdpUrl` accepts `http://`, `https://`, `ws://`, and `wss://`.
  Use HTTP(S) when you want OpenClaw to discover `/json/version`; use WS(S)
  when your provider gives you a direct DevTools WebSocket URL.
- If an externally managed CDP service is reachable through loopback, set that
  profile's `attachOnly: true`; otherwise OpenClaw treats the loopback port as a
  local managed browser profile and may report local port ownership errors.
- `existing-session` profiles use Chrome MCP instead of CDP and can attach on
  the selected host or through a connected browser node.
- `extension` profiles use the authenticated OpenClaw Chrome extension relay.
  The relay owns its loopback endpoint, so these profiles do not accept
  `cdpUrl`. See [Chrome extension](/tools/chrome-extension).
- `existing-session` profiles can set `userDataDir` to target a specific
  Chromium-based browser profile such as Brave or Edge.
- `existing-session` profiles can set `cdpUrl` when Chrome is already running
  behind a DevTools HTTP(S) discovery endpoint or direct WS(S) endpoint. In that
  mode OpenClaw passes the endpoint to Chrome MCP instead of using auto-connect;
  `userDataDir` is ignored for Chrome MCP launch arguments.
  Valid endpoint arguments in `mcpArgs` take precedence over `cdpUrl`; see
  [Custom Chrome MCP launch](/tools/browser#custom-chrome-mcp-launch).
- `existing-session` profiles keep the current Chrome MCP route limits:
  snapshot/ref-driven actions instead of CSS-selector targeting, one-file upload
  hooks, no dialog timeout overrides, no `wait --load networkidle`, and no
  `responsebody`, PDF export, download interception, or batch actions.
- Local managed `openclaw` profiles get a `cdpPort` allocated from the managed
  range when OpenClaw creates the profile. A profile you declare by hand must
  set `cdpPort` itself, or `cdpUrl` for a remote CDP endpoint; the schema
  rejects an `openclaw` or `clawd` profile that sets neither.
- Local managed profiles can set `executablePath` to override the global
  `browser.executablePath` for that profile. Use this to run one profile in
  Chrome and another in Brave.
- Auto-detect order: default browser if Chromium-based → Chrome → Brave → Edge → Chromium → Chrome Canary.
- `browser.executablePath` and `browser.profiles.<name>.executablePath` both
  accept `~` and `~/...` for your OS home directory before Chromium launch.
  Per-profile `userDataDir` on `existing-session` profiles is also tilde-expanded.
- Control service: loopback only (port derived from `gateway.port`, default `18791`).
- `extraArgs` appends extra launch flags to local Chromium startup (for example
  `--disable-gpu`, window sizing, or debug flags).

---

## UI

```json5
{
  ui: {
    seamColor: "#FF4500",
    prefs: {
      theme: "claw", // claw | knot | dash | absolutely | tide | beacon | phosphor | crt | manuscript | rose | miami | custom
      themeMode: "system", // light | dark | system
      locale: "en",
      chatShowThinking: true,
      chatShowToolCalls: true,
      chatPersistCommentary: true, // Keep commentary after runs in Control UI; does not deliver it to channels
      chatSendShortcut: "enter", // enter | modifier-enter
      chatFollowUpMode: "steer", // steer | queue; omit to use the server queue mode
    },
  },
}
```

Agent display names, emoji, and avatars belong to each agent's `identity` block under `agents.entries`; see [Agent configuration](/gateway/config-agents#agentsentries-per-agent-overrides).

- `seamColor`: operator accent color for native app UI chrome (Talk Mode bubble
  tint, etc.). The Control UI user accent (`ui.prefs.accent`) takes precedence in
  `talk.config` payloads and the macOS app's config snapshot. If neither is set,
  the theme default applies.
- `prefs`: cross-device operator preferences. This is the canonical home so agents can
  change them through the approval gate and every Control UI client stays in
  sync; browsers mirror the values into local storage for instant boot. An
  explicitly read-only connection keeps edits in that browser without attempting
  a config write. Offline edits remain queued for a later writable connection and
  continue as browser-local preferences while reconnected read-only.
  `chatPersistCommentary` defaults to `true`. Setting it to `false` keeps live
  commentary visible during a run but removes it at completion and prevents new
  Codex commentary from entering the durable transcript mirror. Messaging-channel
  delivery remains separate and unchanged.
  Presentation-only preferences such as advanced-tier visibility, text scale,
  chat width, and live sidebar activity stay browser-local and are configured in Settings.
  Connected clients apply server-side changes live: the gateway broadcasts a
  hash-only `config.changed` event after every persisted config write and
  clients refresh their snapshot (skipped while a local settings draft has
  unsaved edits). Reconnecting clients reconcile on connect.

---

## Desktop

The host desktop source lets the Control UI Desktop panel connect to the Gateway
machine. It can attach to an existing loopback RFB server, or supervise a
headless TigerVNC/XFCE desktop on Linux. It is a Labs feature and is off by
default.

```json5
{
  desktop: {
    host: {
      enabled: true,
      managed: true,
      // port: 5900, // Setting a port selects attach mode instead.
      // passwordFile: "/path/to/vnc-password.txt",
    },
  },
}
```

- `desktop.host.enabled`: advertises **This machine** as a desktop source after
  the Gateway restarts.
- `desktop.host.managed`: Linux only. Starts a gateway-supervised, loopback-only
  TigerVNC/XFCE desktop lazily on the first observation and stops it after the
  desktop session's linger period. Default: `false`.
- `desktop.host.port`: loopback RFB port on `127.0.0.1` (default: `5900`).
- `desktop.host.passwordFile`: optional UTF-8 VNC password file for attach mode.
  Without it, the Control UI prompts for a VNC password and keeps it in browser
  memory for that connection. Managed mode always creates its own ephemeral
  password.

OpenClaw connects only through loopback. An explicit `port` always selects
attach mode, and an existing RFB listener on port `5900` takes precedence over
managed mode. Managed mode requires `Xtigervnc`, `tigervncpasswd`, and
`startxfce4`; on Debian/Ubuntu, install
`tigervnc-standalone-server tigervnc-tools xfce4-session`. The Gateway creates a
fresh temporary VNC password for each managed session, never persists it, and
supervises both the VNC server and XFCE session.

Without managed mode, configure third-party servers to listen on loopback when
they support it. On Linux, use loopback-only TigerVNC or `x11vnc`; GNOME Remote
Desktop's VeNCrypt mode is not supported. On Windows, enable VNC authentication
and loopback access in the VNC server.

On macOS, enable **System Settings → General → Sharing → Screen Sharing**.
Modern Screen Sharing uses ARD account authentication, so the Gateway performs
that handshake and gives the browser an already-authenticated no-auth RFB
stream. The macOS account password is not returned in the observe result, URL,
or logs. `openclaw doctor` can offer an explicitly confirmed `sudo launchctl`
repair when Screen Sharing is off; enabling the macOS system service may expose
it on other network interfaces according to macOS Sharing settings.

### Paired node desktops

A paired macOS, Windows, or Linux node can expose its own desktop in the same
Control UI Desktop panel. This path is intentionally off by default and always
uses an existing node-local RFB server on `127.0.0.1`; the Gateway never asks a
node to connect to a caller-selected host or port.

On the node machine, enable the desktop source and configure attach mode:

```json5
{
  desktop: {
    host: {
      enabled: true,
      port: 5900,
      // passwordFile: "/path/to/vnc-password.txt",
    },
  },
}
```

Restart the node host after changing this config. `managed: true` is a Gateway
host feature and does not start a managed desktop inside a node host; paired
nodes must already have a loopback RFB server.

On the Gateway, explicitly arm the dangerous command and restart:

```json5
{
  gateway: {
    nodes: {
      commands: {
        allow: ["desktop.stream"],
        // deny: ["desktop.stream"], // deny always wins
      },
    },
  },
}
```

The node reconnect advertises `desktop.stream` as a pairing-surface upgrade.
Inspect `openclaw nodes pending`, then approve the new request with
`openclaw nodes approve <requestId>`. The node appears in the Desktop picker
only while it is connected and the effective approved command remains allowed.

For VncAuth, `desktop.host.passwordFile` stays on the node and is delivered only
to the Gateway's authenticated relay. Without a password file, the Control UI
prompts for the VNC password. macOS ARD asks for account credentials when you
first connect to a node in the Desktop panel. The panel keeps them in memory
for reconnects to the same node. Closing the panel or selecting another desktop
clears them; an authentication rejection asks for the password again. The
Gateway completes ARD or VNC authentication before exposing a no-auth RFB
handshake to the browser, so credentials are not returned in URLs, logs, or RPC
results.

Desktop bytes use a dedicated outbound binary WebSocket from the node. The
normal node invoke remains only as the cancellable lifecycle handle and never
carries framebuffer data. Reconnecting or changing the node's pairing
generation closes active relays. To disarm the feature, remove
`desktop.stream` from `commands.allow` or add it to `commands.deny`, restart the
Gateway, and reconnect the node.

If the node is missing from the picker, verify all four gates: the node-local
desktop config, the loopback RFB listener, the approved pairing update, and the
Gateway allow/deny policy. After changing any of them, restart the affected
Gateway or node host and check `openclaw nodes pending` again.

---

## Gateway

```json5
{
  gateway: {
    mode: "local", // local | remote
    port: 18789,
    bind: "loopback",
    publicOrigin: "https://gateway.example.com",
    auth: {
      mode: "token", // none | token | password | trusted-proxy
      token: "your-token",
      // password: "your-password", // or OPENCLAW_GATEWAY_PASSWORD
      // trustedProxy: { userHeader: "x-forwarded-user" }, // for mode=trusted-proxy; see /gateway/trusted-proxy-auth
      allowTailscale: true,
      identityScopes: {
        "admin@example.com": ["operator.admin"],
      },
      rateLimit: {
        maxAttempts: 10,
        windowMs: 60000,
        lockoutMs: 300000,
        exemptLoopback: true,
      },
    },
    // Optional person-level access policy for team Gateway deployments.
    roles: {
      default: "guest",
      definitions: {
        maintainer: {
          sessions: { others: "write" }, // none | view | suggest | write
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write", "operator.approvals"],
        },
        guest: {
          sessions: { others: "view" },
          agents: ["roboclaw"],
          scopes: ["operator.read", "operator.write"],
          sandbox: "required", // inherit (default) | required
        },
      },
    },
    tailscale: {
      mode: "off", // off | serve | funnel
    },
    controlUi: {
      enabled: true,
      basePath: "/openclaw",
      // environment: { label: "edge", color: "amber" },
      // root: "dist/control-ui",
      // github: { token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" } },
      // toolTitles: false, // opt-in AI purpose titles for tool calls (spends utility-model tokens)
      // embedSandbox: "scripts", // strict | scripts | trusted
      // allowExternalEmbedUrls: false, // dangerous: allow absolute external http(s) embed URLs
      // automaticallyFetchFavicons: true, // SSRF-guarded link favicon fetches
      // allowedOrigins: ["https://control.example.com"], // required for non-loopback Control UI
      // dangerouslyAllowHostHeaderOriginFallback: false, // dangerous Host-header origin fallback mode
    },
    cliAgents: {
      enabled: false, // Labs: show create-capable CLI session targets in the model picker
    },
    terminal: {
      enabled: false,
      // shell: "/bin/zsh",
    },
    remote: {
      url: "ws://127.0.0.1:18789",
      transport: "ssh", // ssh | direct
      token: "your-token",
      // password: "your-password",
    },
    trustedProxies: ["10.0.0.1"],
    // Optional. Default false.
    allowRealIpFallback: false,
    nodes: {
      pairing: {
        // Silent same-host pairing and access upgrades. Default: enabled.
        // Set false to require explicit approval for every device.
        autoApproveLocal: true,
        // Optional. Default unset/disabled.
        autoApproveCidrs: ["192.168.1.0/24", "fd00:1234:5678::/64"],
        // SSH-verified auto-approval. Default: enabled (true).
        // Set false to disable SSH verification only; this does not affect
        // autoApproveCidrs above. For manual-only node pairing, set false AND
        // unset autoApproveCidrs. Pass an object to tune: { user, identity,
        // timeoutMs, cidrs }.
        sshVerify: true,
      },
      commands: {
        allow: ["canvas.navigate"],
        deny: ["system.run"],
      },
    },
    tools: {
      // Additional /tools/invoke HTTP denies
      deny: ["browser"],
      // Remove tools from the default HTTP deny list for owner/admin callers
      allow: ["gateway"],
    },
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
          timeoutMs: 10000,
        },
      },
    },
  },
}
```

<Accordion title="Gateway field details">

- `mode`: `local` (run gateway) or `remote` (connect to remote gateway). Gateway refuses to start unless `local`.
- `port`: single multiplexed port for WS + HTTP. Precedence: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > `18789`.
- `publicOrigin`: optional externally reachable HTTPS origin of the Gateway,
  without a path, query, or credentials. HTTP is accepted only for literal
  loopback hosts (`localhost`, `127.0.0.1`, or `[::1]`) during local development.
  Per-requester MCP OAuth requires this value and uses
  `<publicOrigin>/oauth/mcp/callback` as its callback URL.
  Slack session-card actions, plugin-generated viewer links, and chat deep links
  into the Control UI also use this origin. Set `gateway.controlUi.basePath`
  separately when the Control UI is served below a reverse-proxy path prefix.
- `bind`: `auto`, `loopback` (default), `lan` (`0.0.0.0`), `tailnet` (Tailscale IPv4 when available, otherwise loopback), or `custom` (one IPv4 address). A resolved `tailnet` address and any `custom` address other than `127.0.0.1` or `0.0.0.0` require `127.0.0.1` on the same port for same-host clients; startup fails if either listener cannot bind. Non-loopback exposure remains limited to the selected interface.
- **Legacy bind aliases**: use bind mode values in `gateway.bind` (`auto`, `loopback`, `lan`, `tailnet`, `custom`), not host aliases (`0.0.0.0`, `127.0.0.1`, `localhost`, `::`, `::1`).
- **Docker note**: the default `loopback` bind listens on `127.0.0.1` inside the container. With Docker bridge networking (`-p 18789:18789`), traffic arrives on `eth0`, so the gateway is unreachable. Use `--network host`, or set `bind: "lan"` (or `bind: "custom"` with `customBindHost: "0.0.0.0"`) to listen on all interfaces.
- **Auth**: required by default. Non-loopback binds require gateway auth. In practice that means a shared token/password or an identity-aware reverse proxy with `gateway.auth.mode: "trusted-proxy"`. Onboarding wizard generates a token by default.
- If both `gateway.auth.token` and `gateway.auth.password` are configured (including SecretRefs), set `gateway.auth.mode` explicitly to `token` or `password`. Startup and service install/repair flows fail when both are configured and mode is unset.
- `gateway.auth.mode: "none"`: explicit no-auth mode. Use only for trusted local loopback setups; this is intentionally not offered by onboarding prompts.
- `gateway.auth.mode: "trusted-proxy"`: delegate browser/user auth to an identity-aware reverse proxy and trust identity headers from `gateway.trustedProxies` (see [Trusted Proxy Auth](/gateway/trusted-proxy-auth)). This mode expects a **non-loopback** proxy source by default; same-host loopback reverse proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true`. Internal same-host callers can use `gateway.auth.password` as a local direct fallback; `gateway.auth.token` remains mutually exclusive with trusted-proxy mode.
- `gateway.auth.allowTailscale`: when `true`, Tailscale Serve identity headers can satisfy Control UI/WebSocket auth (verified via `tailscale whois`). HTTP API endpoints do **not** use that Tailscale header auth; they follow the gateway's normal HTTP auth mode instead. This tokenless flow assumes the gateway host is trusted. Defaults to `true` when `tailscale.mode = "serve"`.
- `gateway.auth.identityScopes`: maps a verified trusted-proxy user or Tailscale WhoIs login to connection-only operator scopes. Email keys match case-insensitively; other identities match exactly. For trusted-proxy Control UI connections, `x-openclaw-scopes` caps device enrollment or upgrade requests and the final device-plus-identity session scopes. Grants do not create or modify pairing records. Token, password, and no-auth connections have no verified identity and receive no grant.
- `gateway.roles`: optional named operator roles for authenticated user profiles on team Gateways. Every definition specifies `sessions.others` (`none`, `view`, `suggest`, or `write`), allowed session-creation and agent-run `agents` (`"*"` or an array of agent IDs), and a closed `scopes` ceiling that also applies to identity-authenticated HTTP requests and signed Control UI plugin grants. Optional `sandbox` is `"inherit"` by default or `"required"` to sandbox sessions created under that role even when the agent's sandbox mode is `"off"`. This requirement is recorded once from the authenticated creator, cannot be changed through role updates or session mutation, and does not affect existing sessions. A sandbox-required person cannot start a host-execution session, including through an invitation; unavailable sandbox backends fail closed, and elevated or host-target overrides cannot escape. The administrator-scoped `users.setRole` Gateway method assigns or clears a profile's role and immediately disconnects its active clients so they reconnect with current authority. Identity-authenticated operator sessions do not receive reusable, person-unbound device/bootstrap tokens while roles are configured, and identity-less device-token or bootstrap-token operator authentication is rejected; reconnect through trusted-proxy or other supported verified identity instead. `default` is required, must name a configured definition, and applies to unassigned profiles. `sessions.others: "none"` also denies Gateway-wide `usage.cost`; audit diagnostics and other `operator.write` control-plane capabilities remain shared-domain surfaces, not hostile-tenant isolation. Omitting `roles` leaves existing solo and shared-secret deployments unchanged. See [Operator scopes](/gateway/operator-scopes#named-operator-roles).
- `gateway.auth.rateLimit`: optional failed-auth limiter. Applies per client IP and per auth scope (shared-secret and device-token are tracked independently). Blocked attempts return `429` + `Retry-After`.
  - On the async Tailscale Serve Control UI path, failed attempts for the same `{scope, clientIp}` are serialized before the failure write. Concurrent bad attempts from the same client can therefore trip the limiter on the second request instead of both racing through as plain mismatches.
  - `gateway.auth.rateLimit.exemptLoopback` defaults to `true`; set `false` when you intentionally want localhost traffic rate-limited too (for test setups or strict proxy deployments).
- Browser-origin WS auth attempts are always throttled with loopback exemption disabled (defense-in-depth against browser-based localhost brute force).
- On loopback, those browser-origin lockouts are isolated per normalized `Origin`
  value, so repeated failures from one localhost origin do not automatically
  lock out a different origin.
- `tailscale.mode`: `serve` (tailnet only, loopback bind) or `funnel` (public, requires auth).
  OpenClaw holds the route as a foreground claim, so startup fails unless the
  route is active and the route is released when the Gateway stops. Named
  Tailscale Services are unsupported because the Tailscale CLI permits them
  only as persistent background routes.
- `tailscale.preserveFunnel`: deprecated migration guard. When `true` and
  `tailscale.mode = "serve"`, OpenClaw checks `tailscale funnel status` before
  re-applying Serve at startup. If that status cannot be inspected, startup
  fails before the ordinary Gateway listener opens. An external Funnel that
  still targets the ordinary Gateway port does not receive managed-ingress
  provenance. OpenClaw leaves the external route unchanged and warns. The
  route can use generic proxy attribution only through an explicitly configured
  `gateway.trustedProxies` source with a valid forwarded client address;
  Gateway-protected routes then require configured auth, while aggregate probes
  and plugin-authenticated webhooks retain their own response and authentication
  policies. First configure `gateway.auth.password` (prefer a SecretRef) or
  `OPENCLAW_GATEWAY_PASSWORD`, and set `gateway.auth.mode` to `password`. Then
  run `openclaw config set gateway.tailscale.mode funnel`, followed by
  `openclaw config unset gateway.tailscale.preserveFunnel`. Default `false`.
- `controlUi.allowedOrigins`: explicit browser-origin allowlist for Gateway WebSocket connects. Required for public non-loopback browser origins. Private same-origin LAN/Tailnet UI loads from loopback, RFC1918/link-local, `.local`, `.ts.net`, or Tailscale CGNAT hosts are accepted without enabling Host-header fallback.
- `controlUi.environment`: optional visual identity for distinguishing Gateway environments. Set `{ label: "edge", color: "amber" }` to show a matching top stripe, agent-avatar ring, environment pills, browser-title suffix, and tinted favicon. `label` is trimmed and must contain 1–24 characters. `color` must be `teal`, `amber`, `purple`, `coral`, `pink`, `blue`, `green`, `red`, or `gray`. The label and color are visible before sign-in; omit the setting to keep the default appearance unchanged.
- `controlUi.github.token`: optional SecretRef-backed service credential for Control UI GitHub previews and project discovery. Prefer this explicit setting when the Gateway should own GitHub service access independently of its shared process environment. When omitted, the shipped `GH_TOKEN` then `GITHUB_TOKEN` process-environment fallback remains active. An explicitly configured but unavailable credential fails closed instead of using that fallback. Its exact environment or store name is excluded from agent execution; a custom name does not clear unrelated native `GH_TOKEN` or `GITHUB_TOKEN` values. This credential is separate from `tools.github` agent identities and does not create an OS-user security boundary.
- `controlUi.toolTitles`: opt in to AI-generated purpose titles for tool calls in Control UI chat. Default: `false` (tool rendering stays fully deterministic with no background model calls). When enabled, the `chat.toolTitles` method labels complex calls through standard utility-model routing — the agent's `utilityModel` (an operator decision that may send bounded tool arguments to the chosen provider, like every utility task), or the session provider's declared small-model default (OpenAI → `gpt-5.6-luna`, Anthropic → `claude-haiku-4-5`) — and caches results in the per-agent state database so repeat views never re-bill. `utilityModel: \"\"` disables titles like every other utility task; titles never fall back to the primary model.
- `controlUi.automaticallyFetchFavicons`: link favicons in Control UI chat. Default: `true`. The authenticated browser asks its same-origin Gateway for each hostname. The Gateway requests only `https://<hostname>/favicon.ico`, rejects IP literals and private/internal destinations, pins public DNS results, revalidates every redirect under the same strict SSRF policy, limits redirects/time/bytes/concurrency, validates the image, and returns a private-cacheable image blob. OpenClaw does not use Google or another favicon service for this flow. This discloses linked hostnames and the Gateway's network address to those destination sites. Set `false` to prevent the browser from requesting favicon routes and the Gateway from contacting link destinations.
- `controlUi.dangerouslyAllowHostHeaderOriginFallback`: dangerous mode that enables Host-header origin fallback for deployments that intentionally rely on Host-header origin policy.
- `cliAgents.enabled`: opt in to the experimental **CLI agents** group in the Control UI new-session model picker. Default: `false`. The group appears only when the Gateway advertises `sessions.catalog.list`, and it includes only catalog providers that support creating sessions. Selecting one opens the same catalog-target new-session flow used by the sidebar catalog action.

  Catalog providers can also advertise terminal-based session creation. The method is available only when Labs `cliAgents.enabled` is on, the Gateway terminal is available, and the selected provider exposes the capability. Callers supply `cwd`; create a fresh worktree first with `worktrees.create` when needed, because terminal start does not provision one.

- `terminal.enabled`: the admin-scoped operator terminal. Default: `true`; set `false` to opt out. The terminal starts a host PTY in the selected agent workspace, inherits the Gateway process environment, and is refused for agents with `sandbox.mode: "all"`. Disable it on deployments where admin operators should not get a host shell; changing it restarts the Gateway and updates the Control UI content security policy.
- `terminal.shell`: optional shell executable. When unset, OpenClaw uses `$SHELL` on Unix and `%ComSpec%` on Windows.
- `terminal.detachedSessionTimeoutSeconds`: how long a terminal session survives after its connection drops (page reload, laptop sleep), staying reattachable via `terminal.attach` with its recent output replayed. Default: `300`. Set `0` to kill sessions the moment their connection drops. Detached sessions keep running their commands, so shorten this on shared or exposed hosts.
- `remote.transport`: `ssh` (default) or `direct` (ws/wss). For `direct`, `remote.url` must be `wss://` for public hosts; plaintext `ws://` is accepted only for loopback, LAN, link-local, `.local`, `.ts.net`, and Tailscale CGNAT hosts.
- `remote.remotePort`: gateway port on the remote SSH host. Defaults to `18789`; use this when the local tunnel port differs from the remote gateway port.
- `remote.tlsFingerprint`: expected SHA-256 certificate fingerprint for a remote `wss://` Gateway. The macOS app applies it to both operator/control and companion-node connections. Without an explicit value, macOS records a first-use pin only after normal system trust succeeds.
- `remote.sshHostKeyPolicy`: macOS SSH tunnel host-key policy. `strict` is the default and requires an already trusted key. `openssh` is an explicit opt-in to the effective OpenSSH configuration for managed aliases; review matching user and system SSH settings before using it. The macOS app and `configure-remote` reset this policy to `strict` when changing targets unless explicitly opted in again.
- `gateway.remote.token` / `.password` are remote-client credential fields. They do not configure gateway auth by themselves.
- `gateway.push.apns.relay.baseUrl`: base HTTPS URL for the external APNs relay used after relay-backed iOS builds publish registrations to the gateway. Public App Store builds use the hosted OpenClaw relay. Custom relay URLs must match a deliberately separate iOS build/deployment path whose relay URL points at that relay.
- `gateway.push.apns.relay.timeoutMs`: gateway-to-relay send timeout in milliseconds. Defaults to `10000`.
- Relay-backed registrations are delegated to a specific gateway identity. The paired iOS app fetches `gateway.identity.get`, includes that identity in the relay registration, and forwards a registration-scoped send grant to the gateway. Another gateway cannot reuse that stored registration.
- `OPENCLAW_APNS_RELAY_BASE_URL` / `OPENCLAW_APNS_RELAY_TIMEOUT_MS`: temporary env overrides for the relay config above.
- `OPENCLAW_APNS_RELAY_ALLOW_HTTP=true`: development-only escape hatch for loopback HTTP relay URLs. Production relay URLs should stay on HTTPS.
- `OPENCLAW_HANDSHAKE_TIMEOUT_MS`: optional environment override for the built-in pre-auth Gateway WebSocket handshake timeout.
- `channels.<provider>.healthMonitor.enabled`: per-channel opt-out for health-monitor restarts while keeping the global monitor enabled.
- `channels.<provider>.accounts.<accountId>.healthMonitor.enabled`: per-account override for multi-account channels. When set, it takes precedence over the channel-level override.
- Local gateway call paths can use `gateway.remote.*` as fallback only when `gateway.auth.*` is unset.
- If `gateway.auth.token` / `gateway.auth.password` is explicitly configured via SecretRef and unresolved, resolution fails closed (no remote fallback masking).
- `trustedProxies`: reverse proxy IPs that terminate TLS or inject forwarded-client headers. Only list proxies you control. Loopback entries are still valid for same-host proxy/local-detection setups (for example Tailscale Serve or a local reverse proxy), but they do **not** make loopback requests eligible for `gateway.auth.mode: "trusted-proxy"`.
- `allowRealIpFallback`: when `true`, the gateway accepts `X-Real-IP` if `X-Forwarded-For` is missing. Default `false` for fail-closed behavior.
- `gateway.nodes.pairing.autoApproveLocal`: silently approves pairing, role upgrades, and scope upgrades from trusted local connections (default: `true`). Scope upgrades additionally require the connection itself to prove local-grade credentials (auth mode `none`, or the shared token/password); Tailscale, trusted-proxy, and device-token connects keep their paired scopes as a durable cap. Set `false` to require explicit approval for every device; metadata-only reconnect refreshes remain automatic.
- `gateway.nodes.pairing.autoApproveCidrs`: optional CIDR/IP allowlist for auto-approving first-time node device pairing with no requested scopes. It is disabled when unset. This does not auto-approve operator/browser/Control UI/WebChat pairing, and it does not auto-approve role, scope, metadata, or public-key upgrades.
- `gateway.nodes.pairing.sshVerify`: SSH-verified auto-approval for first-time node device pairing (default: enabled). The gateway SSHes back to the pairing host (BatchMode, strict host keys) and approves only on an exact `openclaw node identity` device-key match. Same eligibility floor as `autoApproveCidrs`; probes are limited to private/CGNAT source addresses unless `cidrs` overrides them. Set `false` to disable, or `{ user, identity, timeoutMs, cidrs }` to tune. See [Node pairing](/gateway/pairing#ssh-verified-device-auto-approval-default).
- `gateway.nodes.commands.allow` / `gateway.nodes.commands.deny`: global allow/deny shaping for declared node commands after pairing and platform allowlist evaluation. `commands.allow` is the persistent enable for classified commands such as `camera.snap`, `camera.clip`, `codex.exec-server.stdio.v1`, `desktop.stream`, `screen.record`, `health.summary`, `sms.search`, and `sms.send`; `commands.deny` removes a command even if a platform default or explicit allow would otherwise include it. Codex remote execution on a paired device or enrolled cloud node additionally requires a separate critical allow-once approval for every exec-server attempt; persistent allowlisting never grants that approval. Computer and mobile UI control instead rely on default-off node-local enablement plus pairing. iOS Health permission, Android SMS permission, and Gateway command authorization are independent. After a node changes its declared command list, reject and re-approve that device pairing so the gateway stores the updated command snapshot.
- `gateway.tools.deny`: extra tool names blocked for HTTP `POST /tools/invoke` (extends default deny list).
- `gateway.tools.allow`: remove tool names from the default HTTP deny list for
  owner/admin callers. This does not upgrade identity-bearing `operator.write`
  callers into owner/admin access; `cron`, `gateway`, and `nodes` remain
  unavailable to non-owner callers even when allowlisted.

</Accordion>

### OpenAI-compatible endpoints

- Admin HTTP RPC: off by default as the `admin-http-rpc` plugin. Enable the plugin to register `POST /api/v1/admin/rpc`. See [Admin HTTP RPC](/plugins/admin-http-rpc).
- Chat Completions: disabled by default. Enable with `gateway.http.endpoints.chatCompletions.enabled: true`.
- Responses API: `gateway.http.endpoints.responses.enabled`.
- Responses URL-input hardening:
  - `gateway.http.endpoints.responses.maxUrlParts`
  - `gateway.http.endpoints.responses.files.urlAllowlist`
  - `gateway.http.endpoints.responses.images.urlAllowlist`
    Empty allowlists are treated as unset; use `gateway.http.endpoints.responses.files.allowUrl=false`
    and/or `gateway.http.endpoints.responses.images.allowUrl=false` to disable URL fetching.
- Optional response hardening header:
  - `gateway.http.securityHeaders.strictTransportSecurity` (set only for HTTPS origins you control; see [Trusted Proxy Auth](/gateway/trusted-proxy-auth#tls-termination-and-hsts))

### Multi-instance isolation

Run multiple gateways on one host with unique ports and state dirs:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

Convenience flags: `--dev` (uses `~/.openclaw-dev` + port `19001`), `--profile <name>` (uses `~/.openclaw-<name>`).

See [Multiple Gateways](/gateway/multiple-gateways).

### `gateway.tls`

```json5
{
  gateway: {
    tls: {
      enabled: false,
      autoGenerate: false,
      certPath: "/etc/openclaw/tls/server.crt",
      keyPath: "/etc/openclaw/tls/server.key",
      caPath: "/etc/openclaw/tls/ca-bundle.crt",
    },
  },
}
```

- `enabled`: enables TLS termination at the gateway listener (HTTPS/WSS) (default: `false`).
- `autoGenerate`: defaults to `true`. Gateway startup generates a local self-signed cert/key pair only when both files are missing, including at configured paths; for local/dev use only. An existing partial pair is left untouched and startup fails. Generated files are published without overwriting existing paths and their parent directories are synchronized when the filesystem supports it; unsupported directory flushing emits a structured degraded-durability warning.
- `certPath`: filesystem path to the TLS certificate file.
- `keyPath`: filesystem path to the TLS private key file; keep permission-restricted.
- `caPath`: optional CA bundle path for client verification or custom trust chains.

Client commands such as `triage`, `gateway status`, and `gateway probe` only read the public certificate to determine a local TLS pin. They never generate or repair TLS files and do not need the server private key or CA bundle. Without `certPath`, they inspect `gateway/tls/gateway-cert.pem` under the state directory. A missing or unreadable certificate supplies no implicit pin; normal connection trust checks still apply. Start the Gateway to generate a missing pair, or provide the configured certificate files before connecting.

### `gateway.reload`

```json5
{
  gateway: {
    reload: {
      mode: "hybrid", // off | hybrid
    },
  },
}
```

- `mode`: controls how config edits are applied at runtime.
  - `"off"`: ignore live edits; changes require an explicit restart.
  - `"hybrid"` (default): apply hot-safe changes in-process, then restart when a change requires it.

The earlier `"restart"` and `"hot"` values are retired; [`openclaw doctor --fix`](/cli/doctor) maps both to `"hybrid"`.

Reload debounce and in-flight operation deferral are no longer configurable and run behind built-in defaults. [`openclaw doctor --fix`](/cli/doctor) removes the retired `debounceMs` and `deferralTimeoutMs` keys from older config files.

---

## Cloud worker environments

Cloud workers are opt-in. If `cloudWorkers` is absent, or `profiles` is empty, OpenClaw accepts no new cloud-worker creation and does not advertise a Cloud destination. `sessions.dispatch` may remain available for eligible paired-device targets. The config schema and read-only `environments.list` and `environments.status` methods remain available. Durable records created earlier still reconcile and remain visible; the existing gateway/node projection is unchanged.

SSH-backed `remote-exec` providers must return a trusted `hostKey` as exactly `algorithm base64`, without a hostname or comment. Bootstrap writes that key to an isolated `known_hosts` file, uses `StrictHostKeyChecking=yes`, and fails before opening a connection when the provider omits it. There is no trust-on-first-use fallback. These providers also carry workspace traffic over separate pinned SSH connections so rsync cannot block control traffic.

Node-backed providers return an authenticated node device id for either `worker-turn` or `remote-exec`. The Gateway installs the current pinned bundle and transfers the workspace through the node transport; these leases do not return or resolve OpenClaw SSH endpoint credentials. `worker-turn` requires a node lease and launches a restricted OpenClaw worker child. `remote-exec` can use either an enrolled node or an existing SSH-backed provider and keeps the harness plus model authentication on the Gateway.

### Crabbox profile

The bundled `crabbox` provider provisions a disposable machine through the local Crabbox CLI, enrolls it as an ephemeral outbound node, and returns the same node transport for OpenClaw `worker-turn` or Codex `remote-exec`. One configured profile can therefore be selected by both harnesses; the selected session runtime determines its execution semantics. The inner `settings.provider` selects the Crabbox backend; it is separate from the outer OpenClaw provider id.

```json5
{
  gateway: {
    nodes: {
      commands: {
        // Required only when this profile also runs Codex remote-exec sessions.
        allow: ["codex.exec-server.stdio.v1"],
      },
    },
  },
  cloudWorkers: {
    profiles: {
      production: {
        provider: "crabbox",
        suspendAfter: "45m",
        settings: {
          provider: "aws",
          class: "standard",
          ttl: "24h",
          idleTimeout: "60m",
          // Optional absolute path. Default: sibling ../crabbox/bin/crabbox, then PATH.
          binary: "/usr/local/bin/crabbox",
        },
      },
    },
  },
}
```

- `settings.provider` (required): backend from the [Crabbox provider reference](https://crabbox.sh/providers/index.html), passed through `--provider`. Direct or coordinator-backed operation follows Crabbox's configuration.
- `settings.class`: optional Crabbox machine class passed to `--class`. Omission leaves selection to Crabbox unless the placement supplies `machineClass`; OpenClaw does not invent a default or hardware size. Explicit `null`, empty or whitespace strings, and nonstring values are invalid. Edit classless profiles through **Settings → Advanced**.
- `settings.ttl` and `settings.idleTimeout` (required): positive Go duration strings passed to `--ttl` and `--idle-timeout` as provider-side failsafes.
- `settings.warmImage`: prepares a project's committed checkout and node runtime for capture before enrollment, then starts later workers for that project and profile from the image. Without a prepared Git project, capture remains at eligible worker teardown. Pair with `suspendAfter` so suspended sessions can wake warm. Enabled by default when a configured or placement class is known and `setupEnv` is empty or omitted. Without an effective class, omission stays cold. A nonempty `setupEnv` keeps the default cold because forwarded host environment could leave setup-derived credentials in a shared image. Explicit `true` opts in but requires a known effective class before provider commands; explicit `false` always stays cold. The resolved class and original cold/checkpoint choice are recorded before allocation and remain fixed through retries and restart. Images incur provider snapshot storage charges and retain machine-level caches, including pristine Git seeds, alongside whatever `setup` wrote outside scrubbed worker state. Scrubbing has a three-minute timeout; checkpoint creation has a separate three-minute timeout, ten on `machine0`. An uncertain project capture blocks enrollment on its source but still permits lease cleanup. See [Warm images](/gateway/cloud-workers#warm-images) for refresh, retention, and Doctor migration and recovery.
- `settings.binary`: optional absolute Crabbox executable path. Without it, OpenClaw checks the sibling Crabbox checkout, then executable entries on `PATH`, and finally invokes `crabbox` so a missing CLI remains a visible provider error.

Unknown settings are rejected. Crabbox credentials and backend-specific account configuration remain owned by Crabbox; do not place them in `settings`. OpenClaw invokes only the local CLI and makes no provider network calls from this plugin. Provisioning passes one deterministic canonical lease ID through `--lease-id`, keeps `--slug` as display metadata only, and always passes `--keep=true`; OpenClaw owns the external lifecycle and destroys the lease with `crabbox stop --id <canonical-id>`. After an ambiguous result, Gateway reconciliation repeats the same fixed-ID operation. Crabbox must return the exactly attested lease or fail closed; OpenClaw never falls back to slug adoption or replacement allocation.

Provider support and backend-specific setup belong to [Crabbox](https://crabbox.sh/providers/index.html). Configure credentials, coordinator access, networking, and snapshots there rather than duplicating them in OpenClaw settings. The installed backend must satisfy OpenClaw's [cloud-worker lifecycle requirements](/gateway/cloud-workers#crabbox-provider-support).

Crabbox setup uses an environment-owned one-use pairing credential and the configured public Gateway URL. The provider returns the exact authenticated node id; the Gateway then installs its current bundle and transfers the workspace through authenticated node routes. For Codex remote execution, Crabbox prepares the bundled Codex plugin and pinned managed binary in the node's private state, and the Gateway requires the explicitly allowed `codex.exec-server.stdio.v1` command plus critical allow-once approval for each attempt. No OpenClaw worker child or worker slot is used in that mode. OpenClaw does not persist Crabbox SSH endpoint, key, host-key, or fallback-port output.

<Note>
  AWS admission requires `providerMetadata.instanceProfileAttached` to be false. Install Crabbox 0.41.1 or newer for the fixed-ID replay and closed inspection contracts.
</Note>

### Static SSH development profile

```json5
{
  cloudWorkers: {
    profiles: {
      development: {
        provider: "static-ssh",
        settings: {
          host: "worker.example.test",
          port: 22,
          user: "openclaw",
          hostKey: "ssh-ed25519 <base64-public-host-key>",
          keyRef: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_WORKER_SSH_KEY",
          },
        },
      },
    },
  },
}
```

- `profiles`: named worker profiles with non-empty, whitespace-trimmed ids. Each profile selects a provider registered by a plugin.
- `provider`: non-empty worker provider id. The examples use the bundled `crabbox` provider and the QA Lab `static-ssh` provider.
- `install`: SSH-backed `remote-exec` worker installation method. `"bundle"` (default) transfers a content-hashed bundle of the gateway's installed build and supports released, development, and unreleased versions. `"npm"` is an opt-in optimization for an unmodified packaged release; it installs `openclaw@<exact gateway version>` from the public npm registry and never installs `latest`. Node-backed `worker-turn` and `remote-exec` providers install the pinned Gateway bundle through node transport instead.
- `suspendAfter`: optional profile-level duration such as `45m`, `90m`, or `2h`; minimum `1m`. The Gateway safely reclaims the worker after its session stays idle for this long. The next message provisions a replacement, warm when an image exists. Omit this field to keep workers running until explicitly stopped.
- Bundled provider plugins are selected automatically when configured, but explicit disables and `plugins.allow` still apply. Include the provider id (for example, `crabbox`) when an allowlist is configured. External provider plugins must also be installed and explicitly enabled.
- `settings`: provider-owned bounded JSON. The selected plugin defines and validates its keys; use [SecretRef objects](/gateway/secrets) for secret-bearing values. The static SSH provider requires `host`, `user`, `hostKey`, and `keyRef`; `port` defaults to `22`. `hostKey` must be one OpenSSH public host-key line (`algorithm base64`) obtained from the known host or another trusted channel, with no options prefix.

A supported Node runtime (22.22.3+, 24.15+, or 25.9+) with WAL-reset-safe SQLite must already be installed on the worker. The opt-in `"npm"` method also requires `npm` and outbound HTTPS access to the public npm registry. Networked toolchain setup is provider policy; bootstrap reports an actionable error instead of installing toolchains itself.

Node-backed `worker-turn` launches the self-contained worker loop and proxies model inference through the Gateway. Node-backed or SSH-backed `remote-exec` keeps the model loop on the Gateway and routes sandbox operations to the remote host. Node-backed Codex accepts process, filesystem, capability, and credential-free HTTP operations; authenticated HTTP is rejected before reaching the node. Both modes reconcile the session workspace and transcript through the durable placement lifecycle. A disconnected node-backed Codex attempt is terminal; reconnect permits only a fresh attempt, never process or stream resumption.

Each durable environment record retains its validated provider settings and resolved install method in a creation-time profile snapshot. Changing or removing a named profile affects new creates; existing records continue lifecycle reconciliation with that snapshot, provided the owning plugin remains available.

Profile changes require a Gateway restart. With the default `gateway.reload.mode: "hybrid"`, the config watcher performs the restart automatically; `"off"` mode requires a manual restart.

<Warning>
  The `static-ssh` provider is a source-tree QA Lab `remote-exec` harness and is excluded from packaged distributions. A worker running on its shared host can read unrelated host data, so do not use this provider as a production isolation boundary.
  Its operator must supply the expected `hostKey`; OpenClaw will not learn or accept a key from the first connection.
  Destroying its lease only releases OpenClaw's logical record; it does not stop or clean the host.
</Warning>

---

## Hooks

`hooks.*` configures generic Gateway HTTP ingress. For setup and a verified first
request, see [Webhooks](/automation/cron-jobs#webhooks). This is separate from
[internal hooks](/automation/hooks) (`hooks.internal`, `HOOK.md`) and the
[TaskFlow Webhooks plugin](/plugins/webhooks) (`plugins.entries.webhooks`).

```json5
{
  hooks: {
    enabled: true,
    token: "<long-random-hook-token>",
    path: "/hooks",
    allowedAgentIds: ["main"],
    allowRequestSessionKey: false,
  },
}
```

Replace `main` with the intended configured agent. Hook tokens grant ingress
access, not an authenticated sender identity; treat payload content as untrusted
data and restrict the target agent's tools and workspace separately.

| Field                       | Default                         | Contract                                                                                                                                                                                                          |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                   | `false`                         | Enable the HTTP endpoints. Requires a nonempty `token`.                                                                                                                                                           |
| `token`                     | unset                           | Shared hook secret string. Use a dedicated long random value; SecretRef objects are not supported here.                                                                                                           |
| `path`                      | `/hooks`                        | Dedicated base path; a leading slash is added and trailing slashes removed. `/` is rejected.                                                                                                                      |
| `allowedAgentIds`           | unrestricted                    | Effective agent allowlist, including the default-agent path. Omitted or containing `"*"` allows all; `[]` denies all.                                                                                             |
| `defaultSessionKey`         | unset                           | Logical agent-run key when no request/mapping key is supplied; otherwise a fresh `hook:<uuid>` is generated. Does not itself enable persistent sessions.                                                          |
| `allowRequestSessionKey`    | `false`                         | Allow keys from `/agent`, `/wake`, and payload-derived mapping/transform values.                                                                                                                                  |
| `allowedSessionKeyPrefixes` | unrestricted                    | Case-insensitive prefixes for explicit request/mapping keys and the default/generated key. An empty list or all-blank list imposes no restriction; blank entries are otherwise ignored. See session policy below. |
| `presets`                   | `[]`                            | Built-in mappings appended after custom mappings. Available preset: `"gmail"`; unknown names add no mappings.                                                                                                     |
| `mappings`                  | `[]`                            | Ordered mapping list; first match wins. See [Mapping details](/gateway/configuration-reference#mapping-details).                                                                                                  |
| `transformsDir`             | `<config-dir>/hooks/transforms` | Transform directory, constrained to that root, including symlink containment. Normally `~/.openclaw/hooks/transforms`.                                                                                            |
| `gmail`                     | unset                           | Gmail transport and processing defaults; see [Gmail integration](/gateway/configuration-reference#gmail-integration).                                                                                             |
| `internal`                  | separate subsystem              | Internal event-hook configuration; see [Hooks](/automation/hooks). It does not enable HTTP ingress.                                                                                                               |

`hooks.token` should be distinct from active Gateway shared-secret auth
(`gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN` or `gateway.auth.password` /
`OPENCLAW_GATEWAY_PASSWORD`). Startup logs a non-fatal warning on reuse;
`openclaw security audit` reports a critical finding, including password auth
supplied at audit time (`--auth password --password <password>`). Use
`openclaw doctor --fix` to rotate a persisted reused hook token, then update all
external senders.

### Hook HTTP contract

Paths below assume `hooks.path: "/hooks"`; replace that prefix if configured
differently. Send `POST` with a JSON body and
`Content-Type: application/json`.

Authentication accepts `Authorization: Bearer <token>` or `x-openclaw-token`.
A nonempty Bearer token takes precedence. A `token` query parameter is rejected
with `400`, even if a valid header is also present. Missing or wrong credentials
return `401`. After 20 failed attempts in a 60-second window, further invalid
authentication attempts from that client are throttled with `429` and
`Retry-After`; valid authentication resets the counter. Loopback is not exempt.
Configure trusted proxy attribution correctly before exposing a proxy route.

The normal body limit is **256 KiB**, with a **30-second** body-read timeout.
Gmail-path mappings receive a larger derived allowance described below. Generic
hooks parse JSON but do not require the JSON content-type header; the TaskFlow
plugin does enforce it.

| Endpoint             | Payload and result                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /hooks/wake`   | Required nonempty `text`; optional `mode` (`"now"` default or `"next-heartbeat"`), `agentId`, `sessionKey`. Returns `200 { ok: true, mode, eventOutcome }`; `eventOutcome` is `"queued"` when the queue accepts the wake or `"coalesced"` when the same wake is already the queue's most recent pending event. `now` requests a heartbeat in either case; the result does not prove the heartbeat ran. |
| `POST /hooks/agent`  | [Agent payload](/gateway/configuration-reference#hook-agent-payload). Returns `200 { ok: true, runId }` after session/global placement admission, not completion.                                                                                                                                                                                                                                      |
| `POST /hooks/<name>` | First matching mapping produces wake/agent actions. No matching mapping returns `404`; no actions returns `204`. Agent fan-out has the [batch response contract](/gateway/configuration-reference#hook-retries-and-fan-out).                                                                                                                                                                           |

The direct `/wake` and `/agent` endpoints take precedence over mappings with
those names. `/hooks` itself has no action.

| Status | Meaning                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | Invalid JSON, payload, routing/session policy, or delivery/account selection. Read the `error` before retrying.                                                                                                              |
| `401`  | Hook authentication failed.                                                                                                                                                                                                  |
| `404`  | No hook action or mapping at that path. Disabled hooks fall through to the rest of Gateway routing.                                                                                                                          |
| `405`  | Wrong method; `Allow: POST` is returned.                                                                                                                                                                                     |
| `408`  | Request body timeout.                                                                                                                                                                                                        |
| `413`  | Body exceeds the path's byte limit.                                                                                                                                                                                          |
| `429`  | Failed-authentication throttling; honor `Retry-After`.                                                                                                                                                                       |
| `409`  | Agent admission rejected because the target session changed or cannot accept work.                                                                                                                                           |
| `500`  | Mapping/transform exception (`hook mapping failed`); inspect Gateway logs.                                                                                                                                                   |
| `502`  | Agent preparation failed before admission.                                                                                                                                                                                   |
| `503`  | Single-run admission did not occur within 15 seconds; that queued work is canceled. Fan-out pending work is different: it continues in the background. Gateway suspension/restart can also return `503 gateway_unavailable`. |

Agent admission failures use `{ ok: false, error, runId? }`. Early method/auth/path
failures can be plain text; do not assume every error response is JSON. The
15-second admission deadline is separate from the body-read timeout and
`timeoutSeconds` for the agent turn. HTTP success does not prove a model result
or channel delivery. See [hook verification](/automation/cron-jobs#verify-and-troubleshoot-hook-requests).

### Hook agent payload

| Field            | Default                  | Contract                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `message`        | required                 | Nonempty agent input text; external content is safety-wrapped.                                                                                                                                                                                               |
| `name`           | `"Hook"`                 | Hook label used in logs/completion events.                                                                                                                                                                                                                   |
| `agentId`        | resolved owner           | Must name a configured agent when supplied directly. Required when no implicit/retained owner can be resolved.                                                                                                                                               |
| `sessionKey`     | default/generated key    | Subject to caller-key opt-in and prefix policy.                                                                                                                                                                                                              |
| `sessionMode`    | `"isolated"`             | `"isolated"` creates a fresh run session; `"persistent"` reuses the resolved session.                                                                                                                                                                        |
| `idempotencyKey` | unset                    | Optional replay key; headers take precedence. See retries below.                                                                                                                                                                                             |
| `wakeMode`       | `"now"`                  | `"now"` or `"next-heartbeat"`; controls waking for completion events, not whether the agent is dispatched immediately.                                                                                                                                       |
| `deliver`        | `true`                   | Only `false` opts out. With no direct destination, successful output can become a main-session completion event. `false` logs successful completion without an announcement and ignores destination fields. Non-ok execution results produce a status event. |
| `channel`        | none for direct delivery | Registered concrete channel id; must be paired with `to`. Direct `/agent` cannot use `"last"`.                                                                                                                                                               |
| `to`             | unset                    | Nonempty recipient for direct announce delivery, paired with `channel`.                                                                                                                                                                                      |
| `accountId`      | channel default          | Selects a configured, enabled account; requires `channel` and `to`. Unknown, disabled, or invalid selections return `400` before dispatch.                                                                                                                   |
| `model`          | agent/model defaults     | Model id or alias override, subject to model availability and allowlist policy.                                                                                                                                                                              |
| `thinking`       | agent/model defaults     | Thinking override for the run.                                                                                                                                                                                                                               |
| `timeoutSeconds` | agent timeout            | Positive numeric turn-timeout override; direct payload values are floored to whole seconds. Invalid/nonpositive values are ignored.                                                                                                                          |

Omitting all destination fields runs without a direct announce destination.
Supplying only part of a destination fails with `400` while delivery is enabled.
`deliver: false` disables announcement, not the agent's ability to use messaging
tools; constrain those tools in the agent policy when needed.

### Hook session and agent policy

Direct request agent ids must exist. Mapping agent ids resolve to a configured
agent, with the legacy default-agent fallback for unknown mapping ids. If no
owner can be resolved, admission fails rather than inventing an agent. The
effective agent must pass `allowedAgentIds`; global session-store ownership is
also enforced. Agent-prefixed keys are re-scoped to the selected agent and
prefix-checked again.

Keys resolve from the request/mapping, then `hooks.defaultSessionKey`, then a
generated `hook:<uuid>`. A configured default must match the prefix allowlist.
Without a default, the allowlist must admit generated `hook:` keys.

- Direct `/agent` persistent mode requires an explicit request `sessionKey`, `allowRequestSessionKey: true`, and a nonempty prefix allowlist.
- Persistent mappings require a stable mapping `sessionKey` or `defaultSessionKey`. Static mapping keys do not require caller-key opt-in, but still obey configured prefixes.
- Templated mapping keys require a nonempty prefix allowlist at configuration resolution and `allowRequestSessionKey: true` at dispatch. This includes the built-in Gmail preset unless an earlier mapping overrides it.
- `/wake` accepts an explicit key only with `mode: "now"` and the same caller-key/prefix policy. Without one, it uses the selected agent's main session; `defaultSessionKey` is for agent runs, not wakes.

A logical hook key is not always the stored session key. Isolated runs use fresh
automation run sessions even when the hook key is stable. Persistence controls
conversation reuse, not tool permissions or sandboxing. Requests sharing a
canonical logical key are serialized through completion, even in isolated mode.
A fixed `defaultSessionKey` therefore orders those requests but can make a later
single request hit the admission timeout while an earlier run is still active.

### Mapping details

Custom `mappings` run in array order before `presets`. The first match owns the
request, including a transform that returns `null`; later mappings are not tried.
Both match predicates must pass when supplied. Omitting them matches any custom
hook path.

| Mapping field                | Default                     | Contract                                                                                                                                          |
| ---------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `mapping-<index>`           | Bounded ingress-source attribution for admitted agent actions, not an authenticated principal or invoker.                                         |
| `match.path`                 | any custom path             | Subpath after `hooks.path`, with leading/trailing slashes removed (`gmail` matches `/hooks/gmail`).                                               |
| `match.source`               | any source                  | Exact match against the payload's string `source` field.                                                                                          |
| `action`                     | `"agent"`                   | `"agent"` or `"wake"`.                                                                                                                            |
| `wakeMode`                   | `"now"`                     | `"now"` or `"next-heartbeat"`; becomes `mode` for wake actions.                                                                                   |
| `name`                       | `"Hook"` at dispatch        | Templated agent-run label.                                                                                                                        |
| `agentId`                    | resolved owner              | Static target agent id; subject to effective-agent allowlist.                                                                                     |
| `sessionKey`                 | default/generated key       | Static or templated logical key; see session policy.                                                                                              |
| `sessionMode`                | `"isolated"`                | `"isolated"` or `"persistent"` for agent actions.                                                                                                 |
| `messageTemplate`            | empty                       | Agent input template; the final action must have a nonempty message.                                                                              |
| `textTemplate`               | empty                       | Wake text template; the final action must have nonempty text. Use trusted notification text, not raw untrusted content.                           |
| `forEach`                    | unset                       | Top-level payload array key; one action per item, with a 200-item cap. Nested/prototype paths are rejected.                                       |
| `deliver`                    | `true`                      | Agent announcement policy. Unlike direct `/agent`, mapped delivery may use `"last"` or defer partial targets to the automation delivery resolver. |
| `channel`                    | `"last"`                    | Registered channel id or `"last"`. Mappings do not expose `accountId`.                                                                            |
| `to`                         | unset                       | Templated delivery target. Prefer explicit `channel` and `to`.                                                                                    |
| `model`                      | agent/model defaults        | Templated model override.                                                                                                                         |
| `thinking`                   | agent/model defaults        | Templated thinking override.                                                                                                                      |
| `timeoutSeconds`             | agent timeout               | Positive integer turn timeout.                                                                                                                    |
| `allowUnsafeExternalContent` | `false`                     | Dangerous: disables agent external-content wrapping for this mapping. Gmail's global unsafe flag can also disable wrapping.                       |
| `transform.module`           | unset                       | Safe relative JS/TS module under `transformsDir`; absolute, traversal, URL/drive forms, and symlink escapes are rejected.                         |
| `transform.export`           | `default`, then `transform` | Named function export; an explicitly named export must exist.                                                                                     |

Templates support `{{payload.field}}` or `{{field}}`, array indexing such as
`{{messages[0].subject}}`, `{{headers.x-event-type}}`, `{{query.kind}}`, `{{path}}`,
and `{{now}}` (ISO timestamp). Missing/null values become empty strings; objects
serialize as JSON. An empty rendered session-key template is rejected.

Transforms receive `{ payload, headers, url, path }` and may return a partial
action override, asynchronously if needed. Action output uses `kind: "agent"` or
`"wake"`, with `message` or `text` respectively. Returning `null` skips the action;
when no actions remain the response is `204`, before any run, task, execution
identity, or audit receipt is created. Transform exceptions return `500`.

A transform-provided `sessionKey` is externally derived by default. Only trusted
code producing a fixed key should mark `sessionKeySource: "static"`; never use
that marker to bypass policy for a payload-derived key. Transforms execute as
trusted Gateway code, not in the reader agent's sandbox. They are cached until
hook configuration reload. Keep modules under the hooks transforms root, not
workspace skill directories; move invalid modules there or remove an invalid
`transformsDir` if doctor reports it.

### Hook retries and fan-out

Agent replay keys resolve in this order: `Idempotency-Key`,
`X-OpenClaw-Idempotency-Key`, then payload `idempotencyKey`. Only trimmed nonempty
strings of at most 256 characters are used. The same key replays only for the
same token, path, and resolved dispatch fields; changing the message or routing
can create a new run. Completed admission replay entries expire after 5 minutes
and are bounded to 1,000 entries in memory. Restart clears them. Failed admissions
remain retryable; a replayed `200` is not a fresh execution or a completion check.

For `forEach`, templates/transforms see the original payload with the chosen
array replaced by `[currentItem]`. Missing, empty, or non-array values produce no
actions (`204`). Only the first **200** items are processed; excess items are
dropped with a warning, not an HTTP failure. Split larger batches at the sender.

Fan-out agent dispatch waits up to **8 seconds after mapping/transform work**.
Pending admissions continue in the background without the single-run 15-second
cancellation deadline. A fully admitted multi-agent batch returns:

```json
{
  "ok": true,
  "runId": "<first-hook-request-run-id>",
  "runIds": ["<hook-request-run-id-1>", "<hook-request-run-id-2>"],
  "dispatched": 2
}
```

A settled single-item batch retains `{ ok: true, runId }`. Partial failures or
pending items return non-2xx with `ok: false`, an incomplete-batch `error`, admitted
`runIds`, and up to five failure messages in `errors`. A pending-only batch uses
`503`. An error can therefore coexist with admitted or still-pending work.

Agent fan-out derives replay identity from each rendered action even without an
explicit idempotency key. Identical retries reconcile pending/admitted items
within the cache lifetime; keep transforms deterministic for retries. Wake
actions dispatch immediately and have no replay identity, including mixed
wake/agent batches. Their response includes `eventOutcome: "queued"` if any wake
was accepted by its queue, or `"coalesced"` if every wake was coalesced by its queue.
This is not durable exactly-once processing.

### Gmail integration

The Gmail preset routes `/hooks/gmail` through `forEach: "messages"` and
`sessionKey: "hook:gmail:{{messages[0].id}}"`, with isolated mode by default. A
custom matching mapping runs before the preset. Without a mapping `agentId`, the
preset uses the resolved default agent; conversation isolation does not restrict
that agent's tools or workspace.

Apply the [restricted Gmail reader
configuration](/automation/cron-jobs#configure-a-restricted-gmail-reader-recommended)
before connecting untrusted mail. The setup command configures transport, not the
reader or session-key policy. For the templated key, set
`allowRequestSessionKey: true` and `allowedSessionKeyPrefixes: ["hook:gmail:"]`
with a matching `defaultSessionKey`, or allow the broader `"hook:"` namespace.
To keep caller-key overrides disabled, replace the preset with an earlier mapping
using a static `sessionKey`. Keep isolated mode unless context reuse is intended.

```json5
{
  hooks: {
    gmail: {
      account: "reader@example.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "<separate-random-push-token>",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },
      model: "openai/gpt-5.6-sol",
      thinking: "high",
    },
  },
}
```

This is the transport block, not the complete reader setup. The model is an
example and must be available to the reader. Gmail fields:

| `hooks.gmail` field          | Runtime default              | Contract                                                                                                                                                      |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account`                    | required                     | Gmail account already authorized in `gog`.                                                                                                                    |
| `label`                      | `"INBOX"`                    | Gmail label to watch. OpenClaw excludes `SPAM`, `TRASH`, `DRAFT`, and `SENT` when launching the watcher.                                                      |
| `topic`                      | required                     | Full Pub/Sub topic path. Setup can provision the `gog-gmail-watch` topic.                                                                                     |
| `subscription`               | `"gog-gmail-watch-push"`     | Pub/Sub subscription used by setup.                                                                                                                           |
| `pushToken`                  | required                     | Authenticates incoming pushes to the watcher. Separate from `hooks.token`, which authenticates forwarding to OpenClaw. Setup generates one if absent.         |
| `hookUrl`                    | local Gateway `/hooks/gmail` | Forwarding URL built from `hooks.path` and Gateway port unless configured.                                                                                    |
| `includeBody`                | `true`                       | Include email body snippets. Set `false` in config to omit them.                                                                                              |
| `maxBytes`                   | `20000`                      | Positive integer per-message body limit passed to the watcher. Also used to derive the Gmail HTTP body allowance.                                             |
| `renewEveryMinutes`          | `720`                        | Positive integer watch-renewal interval.                                                                                                                      |
| `serve.bind`                 | `"127.0.0.1"`                | Watcher bind host.                                                                                                                                            |
| `serve.port`                 | `8788`                       | Positive integer watcher port.                                                                                                                                |
| `serve.path`                 | `"/gmail-pubsub"`            | Watcher path. With Tailscale enabled and no explicit target, it becomes `/` because the exposed prefix is stripped.                                           |
| `tailscale.mode`             | `"off"`                      | `"off"`, `"serve"`, or `"funnel"`. Setup defaults to `"funnel"`; runtime without saved config defaults to `"off"`.                                            |
| `tailscale.path`             | resolved serve path          | Exposed Tailscale path, normally `/gmail-pubsub` in setup.                                                                                                    |
| `tailscale.target`           | local watcher                | Optional port, `host:port`, or URL target. An explicit target preserves the configured serve path.                                                            |
| `model`                      | agent/model defaults         | Gmail model default; an explicit mapping model overrides it. A disallowed Gmail default is ignored, while an invalid explicit run override fails preparation. |
| `thinking`                   | agent/model defaults         | `"off"`, `"minimal"`, `"low"`, `"medium"`, or `"high"`; explicit mapping thinking takes precedence.                                                           |
| `allowUnsafeExternalContent` | `false`                      | Dangerous: disable email safety wrapping for Gmail agent turns. Leave off for untrusted inboxes.                                                              |

Gmail-path mappings use a request-body allowance of
`max(256 KiB, min(32 MiB, 100 × (3 × maxBytes + 8192)))`. The multiplier reserves
space for escaped content and message metadata; it is not a guarantee that every
upstream backlog fits. The upstream history page size counts history records,
which can contain multiple messages. Fan-out still processes only the first 200
items and logs dropped excess. See [batch limits and
retries](/gateway/configuration-reference#hook-retries-and-fan-out).

When `hooks.enabled: true` and `hooks.gmail.account` is set, the Gateway starts
`gog gmail watch serve` if its executable and required transport configuration
are available, and renews the watch. Set `OPENCLAW_SKIP_GMAIL_WATCHER=1` to opt out.
Do not start a second foreground watcher on the same listener. Setup output can
contain tokens; see the [CLI reference](/cli/webhooks).

A successful push or hook response is transport/admission evidence, not proof of
completed email processing or delivery. Verify the restricted reader through
[logs and its run output](/automation/cron-jobs#verify-the-reader-boundary). For a
reader-to-agent handoff, expose only the required tool and constrain
[`tools.agentToAgent`](/gateway/config-tools#tools-agenttoagent); see also
[Prompt injection](/gateway/security#prompt-injection) and
[per-agent sandbox and tools](/tools/multi-agent-sandbox-tools).

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

## Discovery

### mDNS (Bonjour)

```json5
{
  discovery: {
    mdns: {
      mode: "minimal", // minimal | full | off
    },
  },
}
```

- `minimal` (default): omit `cliPath` + `sshPort` from TXT records.
- `full`: include `cliPath` + `sshPort`; LAN multicast advertising still requires the bundled `bonjour` plugin to be enabled.
- `off`: suppress LAN multicast advertising without changing plugin enablement.
- The bundled `bonjour` plugin auto-starts on macOS hosts and is opt-in on Linux, Windows, and containerized Gateway deployments.
- Hostname defaults to the system hostname when it is a valid DNS label, falling back to `openclaw`. Override with `OPENCLAW_MDNS_HOSTNAME`.
- `OPENCLAW_DISABLE_BONJOUR=1` disables mDNS advertising outright, overriding `discovery.mdns.mode`.

### Wide-area (DNS-SD)

```json5
{
  discovery: {
    wideArea: { domain: "openclaw.internal" },
  },
}
```

Setting `discovery.wideArea.domain` enables wide-area discovery and writes a unicast DNS-SD zone under `~/.openclaw/dns/`. For cross-network discovery, pair with a DNS server (CoreDNS recommended) + Tailscale split DNS.

Setup: `openclaw dns setup --apply`.

---

## Environment

### `env` (inline env vars)

```json5
{
  env: {
    vars: {
      OPENROUTER_API_KEY: "sk-or-...",
      GROQ_API_KEY: "gsk-...",
    },
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

- Inline env vars are only applied if the process env is missing the key.
- `.env` files: CWD `.env` + `~/.openclaw/.env` (neither overrides existing vars).
- `shellEnv`: imports missing expected keys from your login shell profile.
- See [Environment](/help/environment) for full precedence.

### Env var substitution

Reference env vars in any config string with `${VAR_NAME}`:

```json5
{
  gateway: {
    auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" },
  },
}
```

- Only uppercase names matched: `[A-Z_][A-Z0-9_]*`.
- Missing/empty vars stay visibly unresolved, emit a warning, and are unavailable to consumers that require the value.
- Escape with `$${VAR}` to produce a literal `${VAR}` value.
- Works with `$include`.

---

## Secrets

Secret refs are additive: plaintext values still work.

### `secrets.egressProxy`

Default-off Gateway-owned substitution for shared-store `secret` entries used by agent exec subprocesses:

```json5
{
  secrets: {
    egressProxy: {
      enabled: false,
      allowedHosts: ["api.example.com"],
      bypassHosts: ["pinned-api.example.com"],
    },
  },
}
```

- `enabled`: starts the loopback proxy and ephemeral CA at Gateway startup. Default: `false`. Changing it requires a Gateway restart.
- `allowedHosts`: optional exact-hostname traffic allowlist for proxy requests and CONNECT tunnels. When present, only listed hosts, hosts bound to a registered secret, and `bypassHosts` are reachable. An empty array permits only bound or bypassed hosts. Changing it requires a Gateway restart.
- `bypassHosts`: optional exact-hostname list for authenticated blind CONNECT tunnels used by certificate-pinned clients. Sentinels are not substituted on bypassed hosts and fail vendor authentication without exposing plaintext.

See [Secret egress proxy](/gateway/secrets#secret-egress-proxy) for subprocess environment wiring, authentication, fail-closed behavior, and limitations.

### `SecretRef`

Use one object shape:

```json5
{ source: "env" | "file" | "exec" | "store", provider: "default", id: "..." }
```

Validation:

- `provider` pattern: `^[a-z][a-z0-9_-]{0,63}$`
- `source: "env"` id pattern: `^[A-Z][A-Z0-9_]{0,127}$`
- `source: "file"` id: absolute JSON pointer (for example `"/providers/openai/apiKey"`)
- `source: "exec"` id pattern: `^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$` (supports AWS-style `secret#json_key` selectors)
- `source: "exec"` ids must not contain `.` or `..` slash-delimited path segments (for example `a/../b` is rejected)

### Supported credential surface

- Canonical matrix: [SecretRef Credential Surface](/reference/secretref-credential-surface)
- `secrets apply` targets supported `openclaw.json` credential paths.
- Per-agent auth-profile refs are included in runtime resolution and audit coverage.

### Secret providers config

```json5
{
  secrets: {
    providers: {
      default: { source: "env" }, // optional explicit env provider
      filemain: {
        source: "file",
        path: "~/.openclaw/secrets.json",
        mode: "json",
        timeoutMs: 5000,
      },
      vault: {
        source: "exec",
        command: "/usr/local/bin/openclaw-vault-resolver",
        passEnv: ["PATH", "VAULT_ADDR"],
      },
    },
    defaults: {
      env: "default",
      file: "filemain",
      exec: "vault",
    },
  },
}
```

Notes:

- `file` provider supports `mode: "json"` and `mode: "singleValue"` (`id` must be `"value"` in singleValue mode).
- File and exec provider paths fail closed when Windows ACL verification is unavailable. Use paths whose ACLs OpenClaw can verify; there is no provider-level bypass.
- `exec` provider requires an absolute `command` path and uses protocol payloads on stdin/stdout.
- Symlink command paths are rejected. Configure the resolved absolute binary path instead; it must not be group- or world-writable and, on POSIX, must be owned by the current user.
- If `trustedDirs` is configured, the command path (after `~` expansion) must be inside an approved directory; symlinked commands are rejected before this check, so the configured path itself is what `trustedDirs` constrains.
- `exec` child environment is minimal by default; pass required variables explicitly with `passEnv`.
- Secret refs are resolved at activation time into an in-memory snapshot, then request paths read the snapshot only.
- Active-surface filtering applies during activation: unresolved refs on enabled surfaces fail startup/reload, while inactive surfaces are skipped with diagnostics.

---

## Auth storage

```json5
{
  auth: {
    profiles: {
      "anthropic:default": { provider: "anthropic", mode: "api_key" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
      "openai:personal": { provider: "openai", mode: "oauth" },
    },
    order: {
      anthropic: ["anthropic:default", "anthropic:work"],
      openai: ["openai:personal"],
    },
  },
}
```

- Per-agent profiles are stored in `<agentDir>/openclaw-agent.sqlite` (`auth_profile_store`).
- Stored auth profiles support value-level refs (`keyRef` for `api_key`, `tokenRef` for `token`) for static credential modes.
- Legacy flat `auth-profiles.json` maps such as `{ "provider": { "apiKey": "..." } }` are not a runtime format; `openclaw doctor --fix` rewrites them to canonical `provider:default` API-key profiles with a `.legacy-flat.*.bak` backup.
- OAuth-mode profiles (`auth.profiles.<id>.mode = "oauth"`) do not support SecretRef-backed auth-profile credentials.
- Static runtime credentials come from in-memory resolved snapshots; legacy static `auth.json` entries are scrubbed when discovered.
- Legacy OAuth imports from `~/.openclaw/credentials/oauth.json`.
- See [OAuth](/concepts/oauth).
- Secrets runtime behavior and `audit/configure/apply` tooling: [Secrets Management](/gateway/secrets).

---

## Audit

```json5
{
  logging: {
    audit: {
      enabled: true,
      executionIdentity: false,
      messages: "off", // off | direct | all
    },
  },
}
```

The Gateway records **metadata-only** audit events for agent runs and tool
actions into the shared state database. Message lifecycle metadata is a
separate opt-in. The ledger stores identity, timing, tool names, and normalized
outcomes, but never prompts, message bodies, tool arguments, results, or raw
error text. Message rows do not store raw platform account, conversation,
message, and target ids. Run/tool session keys remain available for correlation
and can themselves contain platform account or peer ids. Records
expire after 30 days and the ledger is capped at 100,000 rows. Query them with
[`openclaw audit`](/cli/audit) or the
[`audit.activity.list`](/gateway/protocol#audit-ledger-rpc) Gateway RPC. See
[Audit history](/gateway/audit) for the full data model, privacy semantics,
and coverage limits.

- `enabled`: record new audit events (default: `true`). The ledger is on by
  default because an audit trail enabled only after an incident cannot explain
  the incident. Setting `false` stops new event inserts after the Gateway restarts;
  existing records stay readable until they expire. Turning it back on resumes
  recording from that point — the gap is not backfilled.
- `executionIdentity`: retain bounded attribution context for exact execution
  inspection (default: `false`). This privacy-sensitive metadata is disabled
  on fresh installs and upgrades. Collection requires `enabled: true`; use
  `openclaw config set logging.audit.executionIdentity true`, then restart the
  Gateway. There is no environment-variable alias.
- `messages`: message metadata scope (default: `"off"`). `"direct"` records
  known direct conversations only. `"all"` also records group, channel, and
  unknown conversation kinds. Both modes remain content-free and replace raw
  identifiers with installation-local keyed pseudonyms where correlation is
  available. These are correlation aids rather than anonymization; the state
  database stores the derivation key, but RPC and CLI exports do not.

A root-level `audit` block is retired; the canonical path is `logging.audit`.
The root config object is strict, so an old top-level `audit` block is rejected.
Run [`openclaw doctor --fix`](/cli/doctor) to move it to `logging.audit`.

The running Gateway captures `logging.audit.enabled`,
`logging.audit.executionIdentity`, and `logging.audit.messages` at startup;
restart it after changing any of these settings. Message coverage currently includes
accepted inbound messages that reach core dispatch and one terminal row per
original logical outbound reply payload that reaches shared durable delivery.
Plugin-local and direct-send paths that bypass those shared boundaries are not
yet covered. The bounded background
writer is best-effort, not a lossless compliance archive.

---

## Logging

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty", // pretty | json
    redactPatterns: ["\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1"],
  },
}
```

- Default log file: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`; named profiles use `/tmp/openclaw/openclaw-<profile>-YYYY-MM-DD.log`.
- Set `logging.file` for a stable path.
- `consoleLevel` bumps to `debug` when `--verbose`.
- `consoleStyle`: `"pretty"` or `"json"`. The earlier `"compact"` value is retired; [`openclaw doctor --fix`](/cli/doctor) maps it to `"pretty"`.
- `maxFileBytes`: maximum active log file size in bytes before rotation (positive integer; default: `104857600` = 100 MB). OpenClaw keeps up to five numbered archives beside the active file.
- `redactPatterns`: regexes for best-effort masking of console output, file logs, OTLP log records, and persisted session transcript text. Setting this **replaces** the built-in default patterns for log and transcript output, so include the defaults you still want; omitting them also turns off form-body and structured auth-header redaction. Tool payload redaction is separate and always merges your patterns with the defaults.
- Redaction is always on and is no longer configurable. [`openclaw doctor --fix`](/cli/doctor) removes the retired switch from older config files; the runtime always applies `tools`-mode redaction to logs and transcripts. UI, tool, and diagnostic safety surfaces redact secrets independently of this policy.

---

## Diagnostics

```json5
{
  diagnostics: {
    enabled: true,
    flags: ["telegram.*"],

    otel: {
      enabled: false,
      endpoint: "https://otel-collector.example.com:4318",
      tracesEndpoint: "https://traces.example.com/v1/traces",
      metricsEndpoint: "https://metrics.example.com/v1/metrics",
      logsEndpoint: "https://logs.example.com/v1/logs",
      protocol: "http/protobuf",
      headers: { "x-tenant-id": "my-org" },
      serviceName: "openclaw-gateway",
      traces: true,
      metrics: true,
      logs: false,
      logsExporter: "otlp",
      sampleRate: 1.0,
      flushIntervalMs: 5000,
      captureContent: false,
    },

    cacheTrace: {
      enabled: false,
    },
  },
}
```

- `enabled`: master toggle for instrumentation output (default: `true`).
- `flags`: array of flag strings enabling targeted log output (supports wildcards like `"telegram.*"` or `"*"`).
- `otel.enabled`: enables the OpenTelemetry export pipeline (default: `false`). For the full configuration, signal catalog, and privacy model, see [OpenTelemetry export](/gateway/opentelemetry).
- `otel.endpoint`: collector URL for OTel export.
- `otel.tracesEndpoint` / `otel.metricsEndpoint` / `otel.logsEndpoint`: optional signal-specific OTLP endpoints. When set, they override `otel.endpoint` for that signal only.
- `otel.protocol`: `"http/protobuf"` (default). gRPC export is retired; run [`openclaw doctor --fix`](/cli/doctor) to repair a persisted legacy value or get source-specific manual-edit guidance.
- `otel.headers`: extra HTTP request headers sent with OTel export requests.
- `otel.serviceName`: service name for resource attributes.
- `otel.traces` / `otel.metrics` / `otel.logs`: enable trace, metrics, or log export.
- `otel.logsExporter`: log export sink: `"otlp"` (default), `"stdout"` for one JSON object per stdout line, or `"both"`.
- `otel.sampleRate`: trace sampling rate `0`-`1`.
- `otel.flushIntervalMs`: periodic telemetry flush interval in ms.
- `otel.captureContent`: opt-in content capture for OTEL span attributes. Defaults to off. `true` captures non-system visible message, tool, and tool-definition content plus OTLP log bodies; provider-internal thinking payloads remain excluded.
- `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental`: environment toggle for latest experimental GenAI inference span shape, including `{gen_ai.operation.name} {gen_ai.request.model}` span names, `CLIENT` span kind, and `gen_ai.provider.name` instead of legacy `gen_ai.system`. By default spans keep `openclaw.model.call` and `gen_ai.system` for compatibility; GenAI metrics use bounded semantic attributes.
- `OPENCLAW_OTEL_PRELOADED=1`: environment toggle for hosts that already registered a global OpenTelemetry SDK. OpenClaw then skips plugin-owned SDK startup/shutdown while keeping diagnostic listeners active.
- `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, and `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`: signal-specific endpoint env vars used when the matching config key is unset.
- `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, `OTEL_EXPORTER_OTLP_METRICS_PROTOCOL`, and `OTEL_EXPORTER_OTLP_LOGS_PROTOCOL`: signal-specific protocol fallbacks used when `otel.protocol` is unset. Each overrides `OTEL_EXPORTER_OTLP_PROTOCOL` for its signal.
- `OTEL_EXPORTER_OTLP_PROTOCOL`: shared protocol fallback used when neither `otel.protocol` nor the matching signal-specific variable is set. Only `http/protobuf` is supported. Protocol validation is isolated per signal, so an unsupported resolved value disables that signal's OTLP exporter without blocking supported sibling signals. Doctor does not rewrite environment variables.
- `cacheTrace.enabled`: log cache trace snapshots for embedded runs (default: `false`).

---

## Telemetry

```json5
{
  telemetry: {
    enabled: false,
    consentedAt: "2026-08-02T12:00:00.000Z",
  },
}
```

- `enabled`: include anonymous channel names, provider families, plugin count, and recent session count in the existing daily update-check request (default: `false`). Interactive setup offers an explicit opt-in with **No thanks** selected by default; non-interactive setup never enables it. `DO_NOT_TRACK=1` or `DO_NOT_TRACK=true` always disables feature statistics without disabling the update check.
- `consentedAt`: ISO timestamp recording when the operator accepted or declined feature statistics. Prevents interactive setup from asking again.
- `openclaw telemetry show` displays the exact current request; `openclaw telemetry on` and `openclaw telemetry off` update the preference and consent timestamp.
- `OPENCLAW_TELEMETRY_ENDPOINT`: optional full endpoint URL for testing or a self-hosted service. Defaults to `https://telemetry.openclaw.ai/api/latest-version`.

See [Usage telemetry and update checks](/gateway/telemetry) for the complete payload, privacy guarantees, and all opt-out controls.

---

## Update

```json5
{
  update: {
    channel: "stable", // stable | extended-stable | beta | dev
    checkOnStart: true,

    auto: {
      enabled: false,
    },
  },
}
```

- `channel`: release channel - `"stable"`, `"extended-stable"`, `"beta"`, or `"dev"`. Extended-stable is package-only: foreground commands own installation, while the Gateway may emit read-only update hints.
- `checkOnStart`: check for updates through `https://telemetry.openclaw.ai/api/latest-version` when the Gateway starts and at most once every 24 hours afterward (default: `true`). The default request shares only the OpenClaw version and platform information in its `User-Agent`; anonymous feature statistics are included only when `telemetry.enabled` is `true`. Setting this to `false`, or setting `OPENCLAW_NO_AUTO_UPDATE=1`, prevents all automatic update requests, feature statistics, and update notices, even when `auto.enabled` is `true`. Stored extended-stable selections use the same read-only hint and 24-hour hint schedule.
- `auto.enabled`: enable background auto-update campaigns for stable and beta package installs and dev git installs when `checkOnStart` is also enabled (default: `false`). Extended-stable never applies automatically.

---

## ACP

```json5
{
  acp: {
    enabled: true,
    dispatch: { enabled: true },
    backend: "acpx",
    fallbacks: ["acpx-secondary"],
    defaultAgent: "main",
    allowedAgents: ["main", "ops"],
    stream: {
      repeatSuppression: true,
      deliveryMode: "live", // live | final_only
    },
  },
}
```

- `enabled`: global ACP feature gate (default: `true`; set `false` to hide ACP dispatch and spawn affordances).
- `dispatch.enabled`: independent gate for ACP session turn dispatch (default: `true`). Set `false` to keep ACP commands available while blocking execution.
- `backend`: default ACP runtime backend id (must match a registered ACP runtime plugin).
  Install the backend plugin first, and if `plugins.allow` is set, include the backend plugin id (for example `acpx`) or the ACP backend will not load.
- `fallbacks`: ordered list of fallback ACP backend ids tried when the primary backend fails early with a transient-looking error (unavailable, rate-limited, quota exhausted, or overloaded) before it produced any output. Each entry must match a registered ACP runtime plugin backend.
- `defaultAgent`: fallback ACP target agent id when spawns do not specify an explicit target.
- `allowedAgents`: allowlist of agent ids permitted for ACP runtime sessions; empty means no additional restriction.
- `stream.repeatSuppression`: suppress repeated status/tool lines per turn (default: `true`).
- `stream.deliveryMode`: `"live"` streams incrementally; `"final_only"` buffers until turn terminal events.
- `stream.tagVisibility`: record of tag names to boolean visibility overrides for streamed events.
- `runtime.installCommand`: optional install command to run when bootstrapping an ACP runtime environment.

---

## Wizard

Behavior and metadata for CLI guided setup flows (`onboard`, `configure`, `doctor`):

```json5
{
  wizard: {
    accessMode: "full",
    appRecommendations: true,
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
    securityAcknowledgedAt: "2026-01-01T00:00:00.000Z",
  },
}
```

- `wizard.accessMode`: discovery consent chosen at the start of guided onboarding. `"full"` (recommended) lets setup look for AI apps, keys, and local runtimes automatically; `"guarded"` makes setup ask once before looking around and offers manual configuration instead.

- `wizard.appRecommendations` defaults to `true`. Set it to `false` to disable installed-application recommendations during guided or classic onboarding and block Gateway `device.apps` access. Node hosts still require their separate, default-off installed-app sharing flag before they advertise the command.

---

## Identity

See `agents.entries` identity fields under [Agent defaults](/gateway/config-agents#agent-defaults).

---

## Bridge (legacy, removed)

Current builds no longer include the TCP bridge. Nodes connect over the Gateway WebSocket. `bridge.*` keys are no longer part of the config schema (validation fails until removed; `openclaw doctor --fix` can strip unknown keys).

<Accordion title="Legacy bridge config (historical reference)">

```json
{
  "bridge": {
    "enabled": true,
    "port": 18790,
    "bind": "tailnet",
    "tls": {
      "enabled": true,
      "autoGenerate": true
    }
  }
}
```

</Accordion>

---

## Automations (`cron`)

```json5
{
  cron: {
    enabled: true,
    triggers: {
      enabled: true,
    },
    webhookToken: "replace-with-dedicated-token", // optional bearer token for outbound webhook auth
    webhookSsrfPolicy: {
      allowedHostnames: ["127.0.0.1"], // optional exact exception for a trusted receiver
    },
    sessionRetention: "24h", // duration string ("0h" disables) or false
  },
}
```

- `enabled`: execute stored automation jobs (default: `true`). Set `false` to pause all automation execution without deleting jobs.
- `skipMissedJobs`: skip missed recurring (`cron`/`every`) slots at startup and advance to the next future occurrence (default: `false`). One-shot (`at`) catch-up is unchanged.
- `triggers.enabled`: run event-driven automation triggers (default: `true`). Set `false` to disable condition triggers, script payloads, and stream schedules.
- `sessionRetention`: how long to keep completed isolated automation run sessions before pruning SQLite session rows. Also controls cleanup of archived deleted automation transcripts. Default: `24h`; set `false` or a zero duration such as `"0h"` to disable (negative durations are invalid).
- Terminal run history is retained for 7 days (`lost` rows for 24 hours), with the newest 2000 rows per job and history class enforced as an additional ceiling.
- `webhookToken`: bearer token used for automation webhook POST delivery (`delivery.mode = "webhook"`), if omitted no auth header is sent.
- `webhookSsrfPolicy`: shared outbound SSRF policy for primary, completion, failure-destination, and failure-alert webhooks. Private/internal targets are blocked when omitted. Prefer exact `allowedHostnames`; use `dangerouslyAllowPrivateNetwork: true` only for trusted private-network receivers. The narrow fake-IP proxy flags are `allowRfc2544BenchmarkRange` and `allowIpv6UniqueLocalRange`.
- `webhookSsrfPolicy.blockedHostnames`: denies exact hosts and wildcard subdomains before DNS and all allow rules. `*.example.com` excludes the apex; add `example.com` separately to block it. Empty or unset adds no denials.

The `cron` block is strict; `cron.enabled`, `cron.skipMissedJobs`, `cron.triggers`, `cron.webhookToken`,
`cron.webhookSsrfPolicy`, `cron.sessionRetention`, and `cron.failureAlert` are the only accepted keys. The
retired `cron.webhook` fallback URL is gone: runtime delivery uses per-job
`delivery.mode = "webhook"` plus `delivery.to`, or `delivery.completionDestination`
when preserving announce delivery. `openclaw doctor --fix` strips a leftover
`cron.webhook` from existing config files.

### `cron.failureAlert`

```json5
{
  cron: {
    failureAlert: {
      enabled: false,
      after: 2,
      cooldownMs: 3600000,
      includeSkipped: false,
      mode: "announce",
      channel: "last",
      to: "channel:C1234567890",
      accountId: "main",
    },
  },
}
```

`cron.failureAlert` owns the global alert policy and its default destination. Jobs
with an existing failure route are covered by default after 2 consecutive
execution failures with a 1-hour cooldown; a `cron.failureAlert` object explicitly
activates/tunes the policy even when no route existed. The retired
`cron.failureDestination` block is merged into it by
[`openclaw doctor --fix`](/cli/doctor).

- `enabled`: explicitly enable or disable the global policy. `false` disables inherited notifications unless a job has its own `failureAlert` object; `true` explicitly enables globally. Omitting it preserves route-backed defaults.
- `after`: consecutive failures before an alert fires (positive integer, min: `1`; default: `2`).
- `cooldownMs`: minimum milliseconds between repeated alerts for the same job (non-negative integer; default: `3600000`).
- `includeSkipped`: count consecutive skipped runs toward the alert threshold (default: `false`). Skipped runs are tracked separately and do not affect execution-error backoff.
- `mode`: delivery mode - `"announce"` sends via a channel message; `"webhook"` posts to the target in `to`. Defaults to `"announce"` when enough target data exists.
- `channel`: channel override for announce delivery. `"last"` reuses the last known delivery channel.
- `to`: explicit announce target or webhook URL. Required for webhook mode.
- `accountId`: optional account or channel id to scope alert delivery.
- Route precedence is per-job `failureAlert` route fields, then per-job `delivery.failureDestination` layered over these global destination fields, then the primary announce target.
- Per-job `failureAlert: false` disables execution and required-delivery failure alerts for that job; the auto-disable safety notification remains active. Any per-job `failureAlert` object explicitly enables and tunes that job.
- `delivery.bestEffort: true` suppresses inherited/default execution alerts; an explicit per-job `failureAlert` remains authoritative.
- Required completion-delivery failure (`status: "ok"`, `completionStatus: "failed"`) does not increment execution backoff and may notify immediately only through a resolved alternate failure destination, not the failed primary route.
- `delivery.failureDestination` is only supported for `sessionTarget="isolated"` jobs unless the job's primary `delivery.mode` is `"webhook"`.

See [Automations](/automation/cron-jobs). Isolated automation runs are tracked as [background tasks](/automation/tasks).

## Media model template variables

Template placeholders expanded in `tools.media.models[].args`:

| Variable                    | Description                                       |
| --------------------------- | ------------------------------------------------- |
| `{{Body}}`                  | Full inbound message body                         |
| `{{RawBody}}`               | Raw body (no history/sender wrappers)             |
| `{{BodyStripped}}`          | Body with group mentions stripped                 |
| `{{From}}`                  | Sender identifier                                 |
| `{{To}}`                    | Destination identifier                            |
| `{{MessageSid}}`            | Channel message id                                |
| `{{SessionId}}`             | Current session UUID                              |
| `{{IsNewSession}}`          | `"true"` when new session created                 |
| `{{AttachmentUrl}}`         | Current attachment URL or provider reference      |
| `{{AttachmentPath}}`        | Current attachment local path                     |
| `{{AttachmentContentType}}` | Current attachment MIME content type              |
| `{{AttachmentDir}}`         | Directory containing `AttachmentPath`             |
| `{{AttachmentIndex}}`       | Zero-based source fact index                      |
| `{{Transcript}}`            | Audio transcript                                  |
| `{{Prompt}}`                | Resolved media prompt for CLI entries             |
| `{{MaxChars}}`              | Resolved max output chars for CLI entries         |
| `{{ChatType}}`              | `"direct"` or `"group"`                           |
| `{{GroupSubject}}`          | Group subject (best effort)                       |
| `{{GroupMembers}}`          | Group members preview (best effort)               |
| `{{SenderName}}`            | Sender display name (best effort)                 |
| `{{SenderE164}}`            | Sender phone number (best effort)                 |
| `{{Provider}}`              | Provider hint (whatsapp, telegram, discord, etc.) |

The legacy `{{MediaPath}}`, `{{MediaUrl}}`, `{{MediaType}}`, and `{{MediaDir}}`
names remain available during the plugin SDK compatibility window but are
deprecated. New configuration should use the `Attachment*` variables.

---

## Config includes (`$include`)

Split config into multiple files:

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },
  agents: { $include: "./agents.json5" },
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

**Merge behavior:**

- Single file: replaces the containing object.
- Array of files: deep-merged in order (later overrides earlier).
- Sibling keys: merged after includes (override included values).
- Nested includes: up to 10 levels deep.
- Paths: resolved relative to the including file, but must stay inside the top-level config directory (`dirname` of `openclaw.json`). Absolute/`../` forms are allowed only when they still resolve inside that boundary. Set `OPENCLAW_INCLUDE_ROOTS` (absolute paths) to allow additional roots outside the config directory.
- Limits: paths must not contain null bytes and must be strictly shorter than 4096 characters before and after resolution; each included file is capped at 2 MB.
- OpenClaw-owned writes that change only one top-level section backed by a single-file include write through to that included file. For example, `plugins install` updates `plugins: { $include: "./plugins.json5" }` in `plugins.json5` and leaves `openclaw.json` intact.
- Root includes, include arrays, and includes with sibling overrides are read-only for OpenClaw-owned writes; those writes fail closed instead of flattening the config.
- Errors: clear messages for missing files, parse errors, circular includes, invalid path format, and excessive length.

---

## Related

- [Configuration](/gateway/configuration)
- [Configuration examples](/gateway/configuration-examples)
- [Doctor](/gateway/doctor)
