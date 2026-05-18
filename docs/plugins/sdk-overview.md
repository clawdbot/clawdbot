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
  that want to run agents through the Gateway, use the
  [OpenClaw App SDK](/concepts/openclaw-sdk) and the `@openclaw/sdk` package
  instead.
</Note>

<Tip>
Looking for a how-to guide instead? Start with [Building plugins](/plugins/building-plugins), use [Channel plugins](/plugins/sdk-channel-plugins) for channel plugins, [Provider plugins](/plugins/sdk-provider-plugins) for provider plugins, [CLI backend plugins](/plugins/cli-backend-plugins) for local AI CLI backends, and [Plugin hooks](/plugins/hooks) for tool or lifecycle hook plugins.
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

| Method                                           | What it registers                     |
| ------------------------------------------------ | ------------------------------------- |
| `api.registerProvider(...)`                      | Text inference (LLM)                  |
| `api.registerAgentHarness(...)`                  | Experimental low-level agent executor |
| `api.registerCliBackend(...)`                    | Local CLI inference backend           |
| `api.registerChannel(...)`                       | Messaging channel                     |
| `api.registerSpeechProvider(...)`                | Text-to-speech / STT synthesis        |
| `api.registerRealtimeTranscriptionProvider(...)` | Streaming realtime transcription      |
| `api.registerRealtimeVoiceProvider(...)`         | Duplex realtime voice sessions        |
| `api.registerMediaUnderstandingProvider(...)`    | Image/audio/video analysis            |
| `api.registerImageGenerationProvider(...)`       | Image generation                      |
| `api.registerMusicGenerationProvider(...)`       | Music generation                      |
| `api.registerVideoGenerationProvider(...)`       | Video generation                      |
| `api.registerWebFetchProvider(...)`              | Web fetch / scrape provider           |
| `api.registerWebSearchProvider(...)`             | Web search                            |

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

### Infrastructure

| Method                                         | What it registers                       |
| ---------------------------------------------- | --------------------------------------- |
| `api.registerHook(events, handler, opts?)`     | Event hook                              |
| `api.registerHttpRoute(params)`                | Gateway HTTP endpoint                   |
| `api.registerGatewayMethod(name, handler)`     | Gateway RPC method                      |
| `api.registerGatewayDiscoveryService(service)` | Local Gateway discovery advertiser      |
| `api.registerCli(registrar, opts?)`            | CLI subcommand                          |
| `api.registerNodeCliFeature(registrar, opts?)` | Node feature CLI under `openclaw nodes` |
| `api.registerService(service)`                 | Background service                      |
| `api.registerInteractiveHandler(registration)` | Interactive handler                     |
| `api.registerAgentToolResultMiddleware(...)`   | Runtime tool-result middleware          |
| `api.registerMemoryPromptSupplement(builder)`  | Additive memory-adjacent prompt section |
| `api.registerMemoryCorpusSupplement(adapter)`  | Additive memory search/read corpus      |

### Host hooks for workflow plugins

Host hooks are the SDK seams for plugins that need to participate in the host
lifecycle rather than only adding a provider, channel, or tool. They are
generic contracts; Plan Mode can use them, but so can approval workflows,
workspace policy gates, background monitors, setup wizards, and UI companion
plugins.

| Method                                                                               | Contract it owns                                                                                                                  |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `api.session.state.registerSessionExtension(...)`                                    | Plugin-owned, JSON-compatible session state projected through Gateway sessions                                                    |
| `api.session.workflow.enqueueNextTurnInjection(...)`                                 | Durable exactly-once context injected into the next agent turn for one session                                                    |
| `api.registerTrustedToolPolicy(...)`                                                 | Bundled/trusted pre-plugin tool policy that can block or rewrite tool params                                                      |
| `api.registerToolMetadata(...)`                                                      | Tool catalog display metadata without changing the tool implementation                                                            |
| `api.registerCommand(...)`                                                           | Scoped plugin commands; command results can set `continueAgent: true`; Discord native commands support `descriptionLocalizations` |
| `api.session.controls.registerControlUiDescriptor(...)`                              | Control UI contribution descriptors for session, tool, run, or settings surfaces                                                  |
| `api.lifecycle.registerRuntimeLifecycle(...)`                                        | Cleanup callbacks for plugin-owned runtime resources on reset/delete/reload paths                                                 |
| `api.agent.events.registerAgentEventSubscription(...)`                               | Sanitized event subscriptions for workflow state and monitors                                                                     |
| `api.runContext.setRunContext(...)` / `getRunContext(...)` / `clearRunContext(...)`  | Per-run plugin scratch state cleared on terminal run lifecycle                                                                    |
| `api.session.workflow.registerSessionSchedulerJob(...)`                              | Cleanup metadata for plugin-owned scheduler jobs; does not schedule work or create task records                                   |
| `api.session.workflow.sendSessionAttachment(...)`                                    | Bundled-only host-mediated file attachment delivery to the active direct-outbound session route                                   |
| `api.session.workflow.scheduleSessionTurn(...)` / `unscheduleSessionTurnsByTag(...)` | Bundled-only Cron-backed scheduled session turns plus tag-based cleanup                                                           |
| `api.session.controls.registerSessionAction(...)`                                    | Typed session actions clients can dispatch through the Gateway                                                                    |

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
  bundled-only because they participate in host safety policy.
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
  Bundled plugins can use `api.registerAgentToolResultMiddleware(...)` when
  they need to rewrite a tool result after execution and before the runtime
  feeds that result back into the model. This is the trusted runtime-neutral
  seam for async output reducers such as tokenjuice.

Bundled plugins must declare `contracts.agentToolResultMiddleware` for each
targeted runtime, for example `["pi", "codex"]`. External plugins
cannot register this middleware; keep normal OpenClaw plugin hooks for work
that does not need pre-model tool-result timing. The old Pi-only embedded
extension factory registration path has been removed.
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
  flag.

For an end-to-end authoring guide, see
[CLI backend plugins](/plugins/cli-backend-plugins).

### Exclusive slots

| Method                                     | What it registers                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.registerContextEngine(id, factory)`   | Context engine (one active at a time). The `assemble()` callback receives `availableTools` and `citationsMode` so the engine can tailor prompt additions. |
| `api.registerMemoryCapability(capability)` | Unified memory capability                                                                                                                                 |
| `api.registerMemoryPromptSection(builder)` | Memory prompt section builder                                                                                                                             |
| `api.registerMemoryFlushPlan(resolver)`    | Memory flush plan resolver                                                                                                                                |
| `api.registerMemoryRuntime(runtime)`       | Memory runtime adapter                                                                                                                                    |

### Memory embedding adapters

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
- `registerMemoryEmbeddingProvider` lets the active memory plugin register one
  or more embedding adapter ids (for example `openai`, `gemini`, or a custom
  plugin-defined id).
- User config such as `agents.defaults.memorySearch.provider` and
  `agents.defaults.memorySearch.fallback` resolves against those registered
  adapter ids.

### Events and lifecycle

| Method                                       | What it does                  |
| -------------------------------------------- | ----------------------------- |
| `api.on(hookName, handler, opts?)`           | Typed lifecycle hook          |
| `api.onConversationBindingResolved(handler)` | Conversation binding callback |

See [Plugin hooks](/plugins/hooks) for examples, common hook names, and guard
semantics.

### Hook decision semantics

- `before_tool_call`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_tool_call`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `before_install`: returning `{ block: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `before_install`: returning `{ block: false }` is treated as no decision (same as omitting `block`), not as an override.
- `reply_dispatch`: returning `{ handled: true, ... }` is terminal. Once any handler claims dispatch, lower-priority handlers and the default model dispatch path are skipped.
- `message_sending`: returning `{ cancel: true }` is terminal. Once any handler sets it, lower-priority handlers are skipped.
- `message_sending`: returning `{ cancel: false }` is treated as no decision (same as omitting `cancel`), not as an override.
- `message_received`: use the typed `threadId` field when you need inbound thread/topic routing. Keep `metadata` for channel-specific extras.
- `message_sending`: use typed `replyToId` / `threadId` routing fields before falling back to channel-specific `metadata`.
- `gateway_start`: use `ctx.config`, `ctx.workspaceDir`, and `ctx.getCron?.()` for gateway-owned startup state instead of relying on internal `gateway:startup` hooks.
- `cron_changed`: observe gateway-owned cron lifecycle changes. Use `event.job?.state?.nextRunAtMs` and `ctx.getCron?.()` when syncing external wake schedulers, and keep OpenClaw as the source of truth for due checks and execution.

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

```
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
