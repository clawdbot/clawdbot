---
summary: "Import map, registration API reference, and SDK architecture"
title: "Plugin SDK overview"
sidebarTitle: "SDK overview"
read_when:
  - You need to know which SDK subpath to import from
  - You want a reference for all registration methods on OpenClawPluginApi
  - You are looking up a specific SDK export
---

The plugin SDK is the typed contract between plugins and core. This page is the
reference for **what to import** and **what you can register**.

<Tip>
  Looking for a how-to guide instead?

- First plugin? Start with [Building plugins](/plugins/building-plugins).
- Channel plugin? See [Channel plugins](/plugins/sdk-channel-plugins).
- Provider plugin? See [Provider plugins](/plugins/sdk-provider-plugins).
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

<Warning>
  Do not import provider- or channel-branded convenience seams (for example
  `openclaw/plugin-sdk/slack`, `.../discord`, `.../signal`, `.../whatsapp`).
  Bundled plugins compose generic SDK subpaths inside their own `api.ts` /
  `runtime-api.ts` barrels; core consumers should either use those plugin-local
  barrels or add a narrow generic SDK contract when a need is truly
  cross-channel.

A small set of bundled-plugin helper seams (`plugin-sdk/feishu`,
`plugin-sdk/zalo`, `plugin-sdk/matrix*`, and similar) still appear in the
generated export map. They exist for bundled-plugin maintenance only and are
not recommended import paths for new third-party plugins.
</Warning>

## Subpath reference

The plugin SDK is exposed as a set of narrow subpaths grouped by area (plugin
entry, channel, provider, auth, runtime, capability, memory, and reserved
bundled-plugin helpers). For the full catalog — grouped and linked — see
[Plugin SDK subpaths](/plugins/sdk-subpaths).

The generated list of 200+ subpaths lives in `scripts/lib/plugin-sdk-entrypoints.json`.

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

| Method                          | What it registers                             |
| ------------------------------- | --------------------------------------------- |
| `api.registerTool(tool, opts?)` | Agent tool (required or `{ optional: true }`) |
| `api.registerCommand(def)`      | Custom command (bypasses the LLM)             |

### Infrastructure

| Method                                          | What it registers                       |
| ----------------------------------------------- | --------------------------------------- |
| `api.registerHook(events, handler, opts?)`      | Event hook                              |
| `api.registerHttpRoute(params)`                 | Gateway HTTP endpoint                   |
| `api.registerGatewayMethod(name, handler)`      | Gateway RPC method                      |
| `api.registerGatewayDiscoveryService(service)`  | Local Gateway discovery advertiser      |
| `api.registerCli(registrar, opts?)`             | CLI subcommand                          |
| `api.registerService(service)`                  | Background service                      |
| `api.registerInteractiveHandler(registration)`  | Interactive handler                     |
| `api.registerEmbeddedExtensionFactory(factory)` | Pi embedded-runner extension factory    |
| `api.registerMemoryPromptSupplement(builder)`   | Additive memory-adjacent prompt section |
| `api.registerMemoryCorpusSupplement(adapter)`   | Additive memory search/read corpus      |

<Note>
  Reserved core admin namespaces (`config.*`, `exec.approvals.*`, `wizard.*`,
  `update.*`) always stay `operator.admin`, even if a plugin tries to assign a
  narrower gateway method scope. Prefer plugin-specific prefixes for
  plugin-owned methods.
</Note>

<Accordion title="When to use registerEmbeddedExtensionFactory">
  Use `api.registerEmbeddedExtensionFactory(...)` when a plugin needs Pi-native
  event timing during OpenClaw embedded runs — for example async `tool_result`
  rewrites that must happen before the final tool-result message is emitted.

This is a bundled-plugin seam today: only bundled plugins may register one,
and they must declare `contracts.embeddedExtensionFactories: ["pi"]` in
`openclaw.plugin.json`. Keep normal OpenClaw plugin hooks for everything that
does not require that lower-level seam.
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

`api.registerCli(registrar, opts?)` accepts two kinds of top-level metadata:

- `commands`: explicit command roots owned by the registrar
- `descriptors`: parse-time command descriptors used for root CLI help,
  routing, and lazy plugin CLI registration

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

Use `commands` by itself only when you do not need lazy root CLI registration.
That eager compatibility path remains supported, but it does not install
descriptor-backed placeholders for parse-time lazy loading.

### CLI backend registration

`api.registerCliBackend(...)` lets a plugin own the default config for a local
AI CLI backend such as `codex-cli`.

- The backend `id` becomes the provider prefix in model refs like `codex-cli/gpt-5`.
- The backend `config` uses the same shape as `agents.defaults.cliBackends.<id>`.
- User config still wins. OpenClaw merges `agents.defaults.cliBackends.<id>` over the
  plugin default before running the CLI.
- Use `normalizeConfig` when a backend needs compatibility rewrites after merge
  (for example normalizing old flag shapes).

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
