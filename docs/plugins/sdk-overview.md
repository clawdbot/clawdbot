---
summary: "Import map, registration API reference, and SDK architecture"
title: "Plugin SDK overview"
sidebarTitle: "Plugin SDK overview"
read_when:
  - You need to know which SDK subpath to import from
  - You want a reference for all registration methods on OpenClawPluginApi
  - You are looking up a specific SDK export
---

The plugin SDK is the typed contract between plugins and core. This page is the
reference for **what to import** and **what you can register**.

<Note>
  This page is for plugin authors using `openclaw/plugin-sdk/*` inside
  OpenClaw. For external apps, scripts, dashboards, CI jobs, and IDE extensions
  that want to run agents through the Gateway, use
  [Gateway integrations for external apps](/gateway/external-apps) instead.
</Note>

<Tip>
Looking for a how-to guide instead? Start with [Building plugins](/plugins/building-plugins). Use [Channel plugins](/plugins/sdk-channel-plugins) for channels, [Provider plugins](/plugins/sdk-provider-plugins) for model providers, [CLI backend plugins](/plugins/cli-backend-plugins) for local AI CLI backends, [Agent harness plugins](/plugins/sdk-agent-harness) for native agent executors, and [Plugin hooks](/plugins/hooks) for tool or lifecycle hooks.
</Tip>

## Import convention

Always import from a specific subpath:

```typescript
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
```

Each subpath is a small, self-contained module. This keeps startup fast and
prevents circular dependency issues. For channel-specific entry/build helpers,
prefer `openclaw/plugin-sdk/channel-core`; keep `openclaw/plugin-sdk/core` for
the broader umbrella surface and shared helpers such as
`buildChannelConfigSchema`.

For channel config, publish the channel-owned JSON Schema through
`openclaw.plugin.json#channelConfigs`. The `plugin-sdk/channel-config-schema`
subpath is for shared schema primitives and the generic builder. OpenClaw's
bundled plugins use `plugin-sdk/bundled-channel-config-schema` for retained
bundled-channel schemas. Deprecated compatibility exports remain on
`plugin-sdk/channel-config-schema-legacy`; neither bundled schema subpath is a
pattern for new plugins.

<Warning>
  Do not import provider- or channel-branded convenience seams (for example
  `openclaw/plugin-sdk/slack`, `.../discord`, `.../signal`, `.../whatsapp`).
  Bundled plugins compose generic SDK subpaths inside their own `api.ts` /
  `runtime-api.ts` barrels; core consumers should either use those plugin-local
  barrels or add a narrow generic SDK contract when a need is truly
  cross-channel.

A small set of bundled-plugin helper seams still appear in the generated export
map when they have tracked owner usage. They exist for bundled-plugin
maintenance only and are not recommended import paths for new third-party
plugins.

`openclaw/plugin-sdk/discord` and `openclaw/plugin-sdk/telegram-account` are
also kept as deprecated compatibility facades for tracked owner usage. Do not
copy those import paths into new plugins; use injected runtime helpers and
generic channel SDK subpaths instead.
</Warning>

## Subpath reference

The plugin SDK is exposed as a set of narrow subpaths grouped by area (plugin
entry, channel, provider, auth, runtime, capability, memory, and reserved
bundled-plugin helpers). For the full catalog — grouped and linked — see
[Plugin SDK subpaths](/plugins/sdk-subpaths).

The compiler entrypoint inventory lives in
`scripts/lib/plugin-sdk-entrypoints.json`; package exports are generated from
the public subset after subtracting repo-local test/internal subpaths listed in
`scripts/lib/plugin-sdk-private-local-only-subpaths.json`. Run
`pnpm plugin-sdk:surface` to audit the public export count. Deprecated public
subpaths that are old enough and unused by bundled extension production code are
tracked in `scripts/lib/plugin-sdk-deprecated-public-subpaths.json`; broad
deprecated re-export barrels are tracked in
`scripts/lib/plugin-sdk-deprecated-barrel-subpaths.json`.

## Registration API

The `register(api)` callback receives an `OpenClawPluginApi` object with these
methods:

### Capability registration

| Method                                           | What it registers                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)                                                              |
| `api.registerModelCatalogProvider(...)`          | Model catalog rows for text and media generation                                  |
| `api.registerAgentHarness(...)`                  | [Experimental](/plugins/sdk-agent-harness) native agent executor (Codex, Copilot) |
| `api.registerCliBackend(...)`                    | Local CLI inference backend                                                       |
| `api.registerChannel(...)`                       | Messaging channel                                                                 |
| `api.registerEmbeddingProvider(...)`             | Reusable vector embedding provider                                                |
| `api.registerSpeechProvider(...)`                | Text-to-speech / STT synthesis                                                    |
| `api.registerRealtimeTranscriptionProvider(...)` | Streaming realtime transcription                                                  |
| `api.registerRealtimeVoiceProvider(...)`         | Duplex realtime voice sessions                                                    |
| `api.registerMediaUnderstandingProvider(...)`    | Image/audio/video analysis                                                        |
| `api.registerTranscriptSourceProvider(...)`      | Live or imported meeting transcript source                                        |
| `api.registerImageGenerationProvider(...)`       | Image generation                                                                  |
| `api.registerMusicGenerationProvider(...)`       | Music generation                                                                  |
| `api.registerVideoGenerationProvider(...)`       | Video generation                                                                  |
| `api.registerWebFetchProvider(...)`              | Web fetch / scrape provider                                                       |
| `api.registerWebSearchProvider(...)`             | Web search                                                                        |
| `api.registerCompactionProvider(...)`            | Pluggable transcript-compaction backend                                           |

Embedding providers registered with `api.registerEmbeddingProvider(...)` must
also be listed in `contracts.embeddingProviders` in the plugin manifest. This
is the generic embedding surface for reusable vector generation. Memory search
can consume this generic provider surface. The older
`api.registerMemoryEmbeddingProvider(...)` and
`contracts.memoryEmbeddingProviders` seam is deprecated compatibility while
existing memory-specific providers migrate.

Memory-specific providers that still expose a runtime `batchEmbed(...)` stay on
the existing per-file batching contract unless their runtime explicitly sets
`sourceWideBatchEmbed: true`. That opt-in lets the memory host submit chunks from
multiple dirty memory files and enabled sources in one `batchEmbed(...)` call up
to the host batch limits. Batch adapters that upload JSONL request files must
split provider jobs before their upload-size cap as well as their request-count
cap. The provider must return one embedding per input chunk in the same order as
`batch.chunks`; omit the flag when the provider expects file-local batches or
cannot preserve input ordering across a larger source-wide job.

### Tools and commands

Use [`defineToolPlugin`](/plugins/tool-plugins) for simple tool-only plugins
with fixed tool names. Use `api.registerTool(...)` directly for mixed plugins
or fully dynamic tool registration.

| Method                          | What it registers                             |
| ------------------------------- | --------------------------------------------- |
| `api.registerTool(tool, opts?)` | Agent tool (required or `{ optional: true }`) |
| `api.registerCommand(def)`      | Custom command (bypasses the LLM)             |

Plugin commands can set `agentPromptGuidance` when the agent needs a short,
command-owned routing hint. Keep that text about the command itself; do not add
provider- or plugin-specific policy to core prompt builders.

Guidance entries may be legacy strings, which apply to every prompt surface, or
structured entries:

```ts
agentPromptGuidance: [
  "Global command hint.",
  { text: "Only show this in the main OpenClaw prompt.", surfaces: ["openclaw_main"] },
];
```

Structured `surfaces` may include `openclaw_main`, `codex_app_server`,
`cli_backend`, `acp_backend`, or `subagent`. `pi_main` remains a deprecated alias
for `openclaw_main`. Omit `surfaces` for intentional all-surface guidance. Do
not pass an empty `surfaces` array; it is rejected so accidental scope loss does
not become global prompt text.

Native Codex app-server developer instructions are stricter than other prompt
surfaces: only guidance explicitly scoped to `codex_app_server` is promoted into
that higher-priority lane. Legacy string guidance and unscoped structured
guidance remain available to non-Codex prompt surfaces for compatibility.

### Infrastructure

| Method                                          | What it registers                                            |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `api.registerHook(events, handler, opts?)`      | Event hook                                                   |
| `api.registerHttpRoute(params)`                 | Gateway HTTP endpoint                                        |
| `api.registerGatewayMethod(name, handler)`      | Gateway RPC method                                           |
| `api.registerGatewayDiscoveryService(service)`  | Local Gateway discovery advertiser                           |
| `api.registerCli(registrar, opts?)`             | CLI subcommand                                               |
| `api.registerNodeCliFeature(registrar, opts?)`  | Node feature CLI under `openclaw nodes`                      |
| `api.registerService(service)`                  | Background service                                           |
| `api.registerInteractiveHandler(registration)`  | Interactive handler                                          |
| `api.registerAgentToolResultMiddleware(...)`    | Runtime tool-result middleware                               |
| `api.registerMemoryPromptSupplement(builder)`   | Additive memory-adjacent prompt section                      |
| `api.registerMemoryCorpusSupplement(adapter)`   | Additive memory search/read corpus                           |
| `api.registerHostedMediaResolver(resolver)`     | Resolver for browser-style hosted media URLs                 |
| `api.registerTextTransforms(transforms)`        | Plugin-owned prompt/message compatibility text rewrites      |
| `api.registerConfigMigration(migrate)`          | Lightweight config migration run before plugin runtime loads |
| `api.registerMigrationProvider(provider)`       | Importer for `openclaw migrate`                              |
| `api.registerAutoEnableProbe(probe)`            | Config probe that can auto-enable this plugin                |
| `api.registerReload(registration)`              | Restart/hot/noop config-prefix policy for reload handling    |
| `api.registerNodeHostCommand(command)`          | Command handler exposed to paired nodes                      |
| `api.registerNodeInvokePolicy(policy)`          | Allowlist/approval policy for node-invoked commands          |
| `api.registerSecurityAuditCollector(collector)` | Findings collector for `openclaw security audit`             |

Memory prompt supplement builders receive optional `agentId`,
`agentSessionKey`, and `sandboxed` context. Memory corpus supplement `search`
and `get` calls receive optional `agentId` and `sandboxed` context. Plugins with
agent-owned storage should resolve that storage for each call instead of
capturing one global path during registration. If an agent id is required but
missing in a multi-agent operation, fail closed rather than choosing an
arbitrary agent.

Telegram interactive handlers can return `{ submitText }` to route text through
Telegram's normal inbound agent path after the handler succeeds. OpenClaw keeps
the callback button when inbound policy skips the text or processing fails, so
the user can retry after the blocking condition changes. This result field is
Telegram-specific; other channels keep their own interactive result contracts.

### Host hooks for workflow plugins

Host hooks are the SDK seams for plugins that need to participate in the host
lifecycle rather than only adding a provider, channel, or tool. They are
generic contracts; Plan Mode can use them, but so can approval workflows,
workspace policy gates, background monitors, setup wizards, and UI companion
plugins.

| Method                                                                               | Contract it owns                                                                                                                                           |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.session.state.registerSessionExtension(...)`                                    | Plugin-owned, JSON-compatible session state projected through Gateway sessions                                                                             |
| `api.session.workflow.enqueueNextTurnInjection(...)`                                 | Durable exactly-once context injected into the next agent turn for one session                                                                             |
| `api.registerTrustedToolPolicy(...)`                                                 | Manifest-gated trusted pre-plugin tool policy that can block or rewrite tool params                                                                        |
| `api.registerToolMetadata(...)`                                                      | Tool catalog display metadata without changing the tool implementation                                                                                     |
| `api.registerCommand(...)`                                                           | Scoped plugin commands; command results can set `continueAgent: true` or `suppressReply: true`; Discord native commands support `descriptionLocalizations` |
| `api.session.controls.registerControlUiDescriptor(...)`                              | Control UI contribution descriptors for session, tool, run, settings, or tab surfaces                                                                      |
| `api.lifecycle.registerRuntimeLifecycle(...)`                                        | Cleanup callbacks for plugin-owned runtime resources on reset/delete/reload paths                                                                          |
| `api.agent.events.registerAgentEventSubscription(...)`                               | Sanitized event subscriptions for workflow state and monitors                                                                                              |
| `api.runContext.setRunContext(...)` / `getRunContext(...)` / `clearRunContext(...)`  | Per-run plugin scratch state cleared on terminal run lifecycle                                                                                             |
| `api.session.workflow.registerSessionSchedulerJob(...)`                              | Cleanup metadata for plugin-owned scheduler jobs; does not schedule work or create task records                                                            |
| `api.session.workflow.sendSessionAttachment(...)`                                    | Bundled-only host-mediated file attachment delivery to the active direct-outbound session route                                                            |
| `api.session.workflow.scheduleSessionTurn(...)` / `unscheduleSessionTurnsByTag(...)` | Bundled-only Cron-backed scheduled session turns plus tag-based cleanup                                                                                    |
| `api.session.controls.registerSessionAction(...)`                                    | Typed session actions clients can dispatch through the Gateway                                                                                             |

A `surface: "tab"` descriptor adds a sidebar tab to the Control UI. Active
plugins' tab descriptors are advertised to dashboard clients in the gateway
hello (`controlUiTabs`), so the tab appears only while the plugin is enabled.
Bundled plugins may ship a first-class dashboard view for their tab; other
plugins can set `path` to a plugin HTTP route (see
`api.registerHttpRoute(...)`) that the dashboard renders in a sandboxed frame.
`icon` is a dashboard icon name hint, `group` picks the sidebar section
(`control` or `agent`), `order` sorts among plugin tabs, and `requiredScopes`
hides the tab from connections lacking those operator scopes:

```typescript
api.session.controls.registerControlUiDescriptor({
  surface: "tab",
  id: "logbook",
  label: "Logbook",
  description: "Your day as a timeline, built from screen snapshots.",
  icon: "sun",
  group: "control",
  requiredScopes: ["operator.write"],
});
```

Use the grouped namespaces for new plugin code:

- `api.session.state.registerSessionExtension(...)`
- `api.session.workflow.enqueueNextTurnInjection(...)`
- `api.session.workflow.registerSessionSchedulerJob(...)`
- `api.session.workflow.sendSessionAttachment(...)`
- `api.session.workflow.scheduleSessionTurn(...)`
- `api.session.workflow.unscheduleSessionTurnsByTag(...)`
- `api.session.controls.registerSessionAction(...)`
- `api.session.controls.registerControlUiDescriptor(...)`
- `api.agent.events.registerAgentEventSubscription(...)`
- `api.agent.events.emitAgentEvent(...)`
- `api.runContext.setRunContext(...)` / `getRunContext(...)` / `clearRunContext(...)`
- `api.lifecycle.registerRuntimeLifecycle(...)`

The equivalent flat methods remain available as deprecated compatibility
aliases for existing plugins. Do not add new plugin code that calls
`api.registerSessionExtension`, `api.enqueueNextTurnInjection`,
`api.registerControlUiDescriptor`, `api.registerRuntimeLifecycle`,
`api.registerAgentEventSubscription`, `api.emitAgentEvent`,
`api.setRunContext`, `api.getRunContext`, `api.clearRunContext`,
`api.registerSessionSchedulerJob`, `api.registerSessionAction`,
`api.sendSessionAttachment`, `api.scheduleSessionTurn`, or
`api.unscheduleSessionTurnsByTag` directly.

`scheduleSessionTurn(...)` is a session-scoped convenience over the Gateway
Cron scheduler. Cron owns timing and creates the background task record when the
turn runs; the Plugin SDK only constrains the target session, plugin-owned
naming, and cleanup. Use `api.runtime.tasks.managedFlows` inside the scheduled
turn when the work itself needs durable multi-step Task Flow state.

The contracts intentionally split authority:

- External plugins can own session extensions, UI descriptors, commands, tool
  metadata, next-turn injections, and normal hooks.
- Trusted tool policies run before ordinary `before_tool_call` hooks and are
  host-trusted. Bundled policies run first; installed-plugin policies require
  explicit enablement plus their local ids in
  `contracts.trustedToolPolicies`, and run next in plugin-load order. Policy ids
  are scoped to the registering plugin.
- Reserved command ownership is bundled-only. External plugins should use their
  own command names or aliases.
- `allowPromptInjection=false` disables prompt-mutating hooks including
  `agent_turn_prepare`, `before_prompt_build`, `heartbeat_prompt_contribution`,
  prompt fields from legacy `before_agent_start`, and
  `enqueueNextTurnInjection`.

Examples of non-Plan consumers:

| Plugin archetype             | Hooks used                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Approval workflow            | Session extension, command continuation, next-turn injection, UI descriptor                                                            |
| Budget/workspace policy gate | Trusted tool policy, tool metadata, session projection                                                                                 |
| Background lifecycle monitor | Runtime lifecycle cleanup, agent event subscription, session scheduler ownership/cleanup, heartbeat prompt contribution, UI descriptor |
| Setup or onboarding wizard   | Session extension, scoped commands, Control UI descriptor                                                                              |

<Note>
  Reserved core admin namespaces (`config.*`, `exec.approvals.*`, `wizard.*`,
  `update.*`) always stay `operator.admin`, even if a plugin tries to assign a
  narrower gateway method scope. Prefer plugin-specific prefixes for
  plugin-owned methods.
</Note>

<Accordion title="When to use tool-result middleware">
  Bundled plugins and explicitly enabled installed plugins with matching
  manifest contracts can use `api.registerAgentToolResultMiddleware(...)` when
  they need to rewrite a tool result after execution and before the runtime
  feeds that result back into the model. This is the trusted runtime-neutral
  seam for async output reducers such as tokenjuice.

Plugins must declare `contracts.agentToolResultMiddleware` for each targeted
runtime, for example `["openclaw", "codex"]`. Installed plugins without that
contract, or without explicit enablement, cannot register this middleware; keep
normal OpenClaw plugin hooks for work that does not need pre-model tool-result
timing. The old
embedded-runner-only extension factory registration path has been removed.
</Accordion>

### Gateway discovery registration

`api.registerGatewayDiscoveryService(...)` lets a plugin advertise the active
Gateway on a local discovery transport such as mDNS/Bonjour. OpenClaw calls the
service during Gateway startup when local discovery is enabled, passes the
current Gateway ports and non-secret TXT hint data, and calls the returned
`stop` handler during Gateway shutdown.

```typescript
api.registerGatewayDiscoveryService({
  id: "my-discovery",
  async advertise(ctx) {
    const handle = await startMyAdvertiser({
      gatewayPort: ctx.gatewayPort,
      tls: ctx.gatewayTlsEnabled,
      displayName: ctx.machineDisplayName,
    });
    return { stop: () => handle.stop() };
  },
});
```

Gateway discovery plugins must not treat advertised TXT values as secrets or
authentication. Discovery is a routing hint; Gateway auth and TLS pinning still
own trust.

### CLI registration metadata

`api.registerCli(registrar, opts?)` accepts two kinds of command metadata:

- `commands`: explicit command names owned by the registrar
- `descriptors`: parse-time command descriptors used for CLI help,
  routing, and lazy plugin CLI registration
- `parentPath`: optional parent command path for nested command groups, such as
  `["nodes"]`

For paired-node features, prefer
`api.registerNodeCliFeature(registrar, opts?)`. It is a small wrapper around
`api.registerCli(..., { parentPath: ["nodes"] })` and makes commands such as
`openclaw nodes canvas` explicit plugin-owned node features.

If you want a plugin command to stay lazy-loaded in the normal root CLI path,
provide `descriptors` that cover every top-level command root exposed by that
registrar.

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerMatrixCli } = await import("./src/cli.js");
    registerMatrixCli({ program });
  },
  {
    descriptors: [
      {
        name: "matrix",
        description: "Manage Matrix accounts, verification, devices, and profile state",
        hasSubcommands: true,
      },
    ],
  },
);
```

Nested commands receive the resolved parent command as `program`:

```typescript
api.registerCli(
  async ({ program }) => {
    const { registerNodesCanvasCommands } = await import("./src/cli.js");
    registerNodesCanvasCommands(program);
  },
  {
    parentPath: ["nodes"],
    descriptors: [
      {
        name: "canvas",
        description: "Capture or render canvas content from a paired node",
        hasSubcommands: true,
      },
    ],
  },
);
```

Use `commands` by itself only when you do not need lazy root CLI registration.
That eager compatibility path remains supported, but it does not install
descriptor-backed placeholders for parse-time lazy loading.

### CLI backend registration

`api.registerCliBackend(...)` lets a plugin own the default config for a local
AI CLI backend such as `claude-cli` or `my-cli`.

- The backend `id` becomes the provider prefix in model refs like `my-cli/gpt-5`.
- The backend `config` uses the same shape as `agents.defaults.cliBackends.<id>`.
- User config still wins. OpenClaw merges `agents.defaults.cliBackends.<id>` over the
  plugin default before running the CLI.
- Use `normalizeConfig` when a backend needs compatibility rewrites after merge
  (for example normalizing old flag shapes).
- Use `resolveExecutionArgs` for request-scoped argv rewrites that belong to
  the CLI dialect, such as mapping OpenClaw thinking levels to a native effort
  flag. The hook receives `ctx.executionMode`; use `"side-question"` to add
  backend-native isolation flags for ephemeral `/btw` calls. If those flags
  reliably disable native tools for an otherwise always-on CLI, declare
  `sideQuestionToolMode: "disabled"` too.

For an end-to-end authoring guide, see
[CLI backend plugins](/plugins/cli-backend-plugins).

### Exclusive slots

| Method                                     | What it registers                                                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.registerContextEngine(id, factory)`   | Context engine (one active at a time). Lifecycle callbacks receive `runtimeSettings` when the host can provide model/provider/mode diagnostics; older strict engines are retried without that key. |
| `api.registerMemoryCapability(capability)` | Unified memory capability                                                                                                                                                                          |
| `api.registerMemoryPromptSection(builder)` | Memory prompt section builder                                                                                                                                                                      |
| `api.registerMemoryFlushPlan(resolver)`    | Memory flush plan resolver                                                                                                                                                                         |
| `api.registerMemoryRuntime(runtime)`       | Memory runtime adapter                                                                                                                                                                             |

### Deprecated memory embedding adapters

| Method                                         | What it registers                              |
| ---------------------------------------------- | ---------------------------------------------- |
| `api.registerMemoryEmbeddingProvider(adapter)` | Memory embedding adapter for the active plugin |

- `registerMemoryCapability` is the preferred exclusive memory-plugin API.
- `registerMemoryCapability` may also expose `publicArtifacts.listArtifacts(...)`
  so companion plugins can consume exported memory artifacts through
  `openclaw/plugin-sdk/memory-host-core` instead of reaching into a specific
  memory plugin's private layout.
- `registerMemoryPromptSection`, `registerMemoryFlushPlan`, and
  `registerMemoryRuntime` are legacy-compatible exclusive memory-plugin APIs.
- `MemoryFlushPlan.model` can pin the flush turn to an exact `provider/model`
  reference, such as `ollama/qwen3:8b`, without inheriting the active fallback
  chain.
- `registerMemoryEmbeddingProvider` is deprecated. New embedding providers
  should use `api.registerEmbeddingProvider(...)` and
  `contracts.embeddingProviders`.
- Existing memory-specific providers continue to work during the migration
  window, but plugin inspection reports this as compatibility debt for
  non-bundled plugins.

### Events and lifecycle

| Method                                       | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | Typed lifecycle hook          |
| `api.onConversationBindingResolved(handler)` | Conversation binding callback |

See [Plugin hooks](/plugins/hooks) for examples, common hook names, and guard
semantics.

### Hook decision semantics

`before_install` is a plugin-runtime lifecycle hook, not the operator install
policy surface. Use `security.installPolicy` when an allow/block decision must
cover CLI and Gateway-backed install or update paths.

- `before_tool_call`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_tool_call`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `before_install`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_install`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `reply_dispatch`: returning `{ handled: true, ... }` is terminal. Once any handler claims dispatch, lower-priority handlers and the default model dispatch path are skipped.
- `message_sending`: returning `{ cancel: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `message_sending`: returning `{ cancel: false }` is treated as no decision (same as omitting `cancel`), not as an override.
- `message_received`: use the typed `threadId` field when you need inbound thread/topic routing. Keep `metadata` for channel-specific extras.
- `message_sending`: use typed `replyToId` / `threadId` routing fields before falling back to channel-specific `metadata`.
- `gateway_start`: use `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()` for gateway-owned startup state instead of relying on internal `gateway:startup` hooks. Cron may still be loading at this point.
- `cron_reconciled`: rebuild a full external cron projection after startup or scheduler reload. It includes `reason` and the effective `enabled` state, including `enabled: false`, while `ctx.getCron?.()` returns the exact reconciled scheduler.
- `cron_changed`: observe gateway-owned cron lifecycle changes. `scheduled` and `removed` events are post-commit reconciliation hints, not an ordered delta log. A scheduled event's `event.nextRunAtMs` is absent when the job has no next wake; a removed event still carries the deleted job snapshot.

External wake schedulers should debounce or coalesce `cron_changed` events,
then reread the full durable view from the scheduler last captured by
`cron_reconciled`. Do not adopt the scheduler from a `cron_changed` context: a
detached hint from an older scheduler can overlap a later reload.

Use `cron_reconciled` as the full-snapshot trigger for durable state loaded at
Gateway startup or scheduler replacement. It is not replayed for a plugin-only
hot reload. Observation handlers run in parallel, and fire-and-forget
dispatches can overlap, so consumers must not depend on event completion order.
Keep OpenClaw as the source of truth for due checks and execution.

For a single-flight adapter with durable replacement, retry/backoff, and clean
shutdown, see [Safe external cron projection](/plugins/hooks#safe-external-cron-projection).

### API object fields

| Field                    | Type                      | Description                                                                                 |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------- |
| `api.id`                 | `string`                  | Plugin id                                                                                   |
| `api.name`               | `string`                  | Display name                                                                                |
| `api.version`            | `string?`                 | Plugin version (optional)                                                                   |
| `api.description`        | `string?`                 | Plugin description (optional)                                                               |
| `api.source`             | `string`                  | Plugin source path                                                                          |
| `api.rootDir`            | `string?`                 | Plugin root directory (optional)                                                            |
| `api.config`             | `OpenClawConfig`          | Current config snapshot (active in-memory runtime snapshot when available)                  |
| `api.pluginConfig`       | `Record<string, unknown>` | Plugin-specific config from `plugins.entries.<id>.config`                                   |
| `api.runtime`            | `PluginRuntime`           | [Runtime helpers](/plugins/sdk-runtime)                                                     |
| `api.logger`             | `PluginLogger`            | Scoped logger (`debug`, `info`, `warn`, `error`)                                            |
| `api.registrationMode`   | `PluginRegistrationMode`  | Current load mode; `"setup-runtime"` is the lightweight pre-full-entry startup/setup window |
| `api.resolvePath(input)` | `(string) => string`      | Resolve path relative to plugin root                                                        |

## Internal module convention

Within your plugin, use local barrel files for internal imports:

```text
my-plugin/
  api.ts            # Public exports for external consumers
  runtime-api.ts    # Internal-only runtime exports
  index.ts          # Plugin entry point
  setup-entry.ts    # Lightweight setup-only entry (optional)
```

<Warning>
  Never import your own plugin through `openclaw/plugin-sdk/<your-plugin>`
  from production code. Route internal imports through `./api.ts` or
  `./runtime-api.ts`. The SDK path is the external contract only.
</Warning>

Facade-loaded bundled plugin public surfaces (`api.ts`, `runtime-api.ts`,
`index.ts`, `setup-entry.ts`, and similar public entry files) prefer the
active runtime config snapshot when OpenClaw is already running. If no runtime
snapshot exists yet, they fall back to the resolved config file on disk.
Packaged bundled plugin facades should be loaded through OpenClaw's plugin
facade loaders; direct imports from `dist/extensions/...` bypass the manifest
and runtime sidecar checks that packaged installs use for plugin-owned code.

Provider plugins can expose a narrow plugin-local contract barrel when a
helper is intentionally provider-specific and does not belong in a generic SDK
subpath yet. Bundled examples:

- **Anthropic**: public `api.ts` / `contract-api.ts` seam for Claude
  beta-header and `service_tier` stream helpers.
- **`@openclaw/openai-provider`**: `api.ts` exports provider builders,
  default-model helpers, and realtime provider builders.
- **`@openclaw/openrouter-provider`**: `api.ts` exports the provider builder
  plus onboarding/config helpers.

<Warning>
  Extension production code should also avoid `openclaw/plugin-sdk/<other-plugin>`
  imports. If a helper is truly shared, promote it to a neutral SDK subpath
  such as `openclaw/plugin-sdk/speech`, `.../provider-model-shared`, or another
  capability-oriented surface instead of coupling two plugins together.
</Warning>

## Related

<CardGroup cols={2}>
  <Card title="Entry points" icon="door-open" href="/plugins/sdk-entrypoints">
    `definePluginEntry` and `defineChannelPluginEntry` options.
  </Card>
  <Card title="Runtime helpers" icon="gears" href="/plugins/sdk-runtime">
    Full `api.runtime` namespace reference.
  </Card>
  <Card title="Setup and config" icon="sliders" href="/plugins/sdk-setup">
    Packaging, manifests, and config schemas.
  </Card>
  <Card title="Testing" icon="vial" href="/plugins/sdk-testing">
    Test utilities and lint rules.
  </Card>
  <Card title="SDK migration" icon="arrows-turn-right" href="/plugins/sdk-migration">
    Migrating from deprecated surfaces.
  </Card>
  <Card title="Plugin internals" icon="diagram-project" href="/plugins/architecture">
    Deep architecture and capability model.
  </Card>
</CardGroup>
