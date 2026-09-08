---
summary: "api.runtime -- the injected runtime helpers available to plugins"
title: "Plugin runtime helpers"
sidebarTitle: "Runtime helpers"
read_when:
  - You need to call core helpers from a plugin (TTS, STT, image gen, web search, Gateway, subagent, nodes)
  - You want to understand what api.runtime exposes
  - You are accessing config, agent, or media helpers from plugin code
  - You are implementing model-picker persistence in a channel plugin
---

Reference for the live `api.runtime` object available during `"full"`, `"discovery"`, `"tool-discovery"`, and `"setup-runtime"` registration. During `"cli-metadata"` and `"setup-only"` registration, runtime capabilities are intentionally unavailable: accessing one throws an error naming the plugin and mode. Defer runtime access out of `register()` or, for root CLI commands, declare `cliCommands` in the plugin manifest. Use runtime helpers instead of importing host internals directly.

<CardGroup cols={2}>
  <Card title="Channel plugins" href="/plugins/sdk-channel-plugins">
    Step-by-step guide that uses these helpers in context for channel plugins.
  </Card>
  <Card title="Provider plugins" href="/plugins/sdk-provider-plugins">
    Step-by-step guide that uses these helpers in context for provider plugins.
  </Card>
</CardGroup>

```typescript
register(api) {
  const runtime = api.runtime;
}
```

`api.runtime.version` is the current OpenClaw product version, sourced from the shared version resolver so plugins see the same value the CLI reports.

## What each page covers

- [Config and utilities](/plugins/sdk-runtime/config-and-utilities) — runtime config reads and writes, plus the shared process, error, and model-picker utilities.
- [Agent and sessions](/plugins/sdk-runtime/agent) — agent identity, directories, session store, transcripts, and sandbox authority.
- [Model helpers](/plugins/sdk-runtime/models) — host-owned completions, model-selection policy, and provider auth resolution.
- [Background work](/plugins/sdk-runtime/background-work) — hook agent turns, subagent runs, and Task Flow record binding.
- [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes) — in-process Gateway requests, paired node invocation, and Gateway service events.
- [Media helpers](/plugins/sdk-runtime/media) — speech, media understanding, image/video/music generation, web search, and media utilities.
- [State and system](/plugins/sdk-runtime/state-and-system) — config snapshot, SQLite-backed plugin state, system utilities, events, and logging.
- [Channel helpers](/plugins/sdk-runtime/channel) — channel-specific runtime helper groups for chunking, routing, pairing, media, and mentions.

## Runtime namespaces

Every `api.runtime` namespace and the page that documents it.

| Namespace                        | Page                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `api.runtime.agent`              | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-agent)              |
| `api.runtime.agent.defaults`     | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-agent-defaults)     |
| `api.runtime.llm`                | [Model helpers](/plugins/sdk-runtime/models#api-runtime-llm)                    |
| `api.runtime.gateway`            | [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-gateway) |
| `api.runtime.hooks`              | [Background work](/plugins/sdk-runtime/background-work#api-runtime-hooks)       |
| `api.runtime.subagent`           | [Background work](/plugins/sdk-runtime/background-work#api-runtime-subagent)    |
| `api.runtime.sandbox`            | [Agent and sessions](/plugins/sdk-runtime/agent#api-runtime-sandbox)            |
| `api.runtime.nodes`              | [Gateway and nodes](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-nodes)   |
| `api.runtime.tasks`              | [Background work](/plugins/sdk-runtime/background-work#api-runtime-tasks)       |
| `api.runtime.tts`                | [Media helpers](/plugins/sdk-runtime/media#api-runtime-tts)                     |
| `api.runtime.mediaUnderstanding` | [Media helpers](/plugins/sdk-runtime/media#api-runtime-mediaunderstanding)      |
| `api.runtime.imageGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-imagegeneration)         |
| `api.runtime.videoGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-videogeneration)         |
| `api.runtime.musicGeneration`    | [Media helpers](/plugins/sdk-runtime/media#api-runtime-musicgeneration)         |
| `api.runtime.webSearch`          | [Media helpers](/plugins/sdk-runtime/media#api-runtime-websearch)               |
| `api.runtime.media`              | [Media helpers](/plugins/sdk-runtime/media#api-runtime-media)                   |
| `api.runtime.config`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-config)    |
| `api.runtime.system`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-system)    |
| `api.runtime.events`             | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-events)    |
| `api.runtime.logging`            | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-logging)   |
| `api.runtime.modelConfig`        | [Model helpers](/plugins/sdk-runtime/models#api-runtime-modelconfig)            |
| `api.runtime.modelAuth`          | [Model helpers](/plugins/sdk-runtime/models#api-runtime-modelauth)              |
| `api.runtime.state`              | [State and system](/plugins/sdk-runtime/state-and-system#api-runtime-state)     |
| `api.runtime.channel`            | [Channel helpers](/plugins/sdk-runtime/channel#api-runtime-channel)             |

## Storing runtime references

Use `createPluginRuntimeStore` to store the runtime reference for use outside the `register` callback:

<Steps>
  <Step title="Create the store">
    ```typescript
    import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
    import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

    const store = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "my-plugin",
      errorMessage: "my-plugin runtime not initialized",
    });
    ```

  </Step>
  <Step title="Wire into the entry point">
    ```typescript
    export default defineChannelPluginEntry({
      id: "my-plugin",
      name: "My Plugin",
      description: "Example",
      plugin: myPlugin,
      setRuntime: store.setRuntime,
    });
    ```
  </Step>
  <Step title="Access from other files">
    ```typescript
    export function getRuntime() {
      return store.getRuntime(); // throws if not initialized
    }

    export function tryGetRuntime() {
      return store.tryGetRuntime(); // returns null if not initialized
    }
    ```

  </Step>
</Steps>

<Note>
Prefer `pluginId` for the runtime-store identity. The lower-level `key` form is for uncommon cases where one plugin intentionally needs more than one runtime slot.
</Note>

## Other top-level `api` fields

Beyond `api.runtime`, the API object also provides:

<ParamField path="api.id" type="string">
  Plugin id.
</ParamField>
<ParamField path="api.name" type="string">
  Plugin display name.
</ParamField>
<ParamField path="api.config" type="OpenClawConfig">
  Current config snapshot (active in-memory runtime snapshot when available).
</ParamField>
<ParamField path="api.pluginConfig" type="Record<string, unknown>">
  Plugin-specific config from `plugins.entries.<id>.config`.
</ParamField>
<ParamField path="api.logger" type="PluginLogger">
  Scoped logger (`debug`, `info`, `warn`, `error`).
</ParamField>
<ParamField path="api.registrationMode" type="PluginRegistrationMode">
  Current load mode: `"full"` (live activation), `"discovery"` / `"tool-discovery"` (read-only capability discovery), `"setup-only"` (lightweight setup entry), `"setup-runtime"` (setup flow that also needs the runtime channel entry), or `"cli-metadata"` (CLI command metadata collection).
</ParamField>
<ParamField path="api.resolvePath(input)" type="(string) => string">
  Resolve a path relative to the plugin root.
</ParamField>

## Where each section moved

Every section heading and namespace anchor from the previous single-page version keeps its anchor here, so an existing link such as `/plugins/sdk-runtime#api-runtime-subagent` still resolves. Each entry points at the page that now holds the content.

- <a id="config-loading-and-writes" />[Config loading and writes](/plugins/sdk-runtime/config-and-utilities#config-loading-and-writes)
- <a id="reusable-runtime-utilities" />[Reusable runtime utilities](/plugins/sdk-runtime/config-and-utilities#reusable-runtime-utilities)
- <a id="stage-timing-diagnostics" />[Stage timing diagnostics](/plugins/sdk-runtime/config-and-utilities#stage-timing-diagnostics)
- <a id="plugin-command-runtime-helpers" />[Plugin command runtime helpers](/plugins/sdk-runtime/agent#plugin-command-runtime-helpers)
- <a id="gateway-service-events" />[Gateway service events](/plugins/sdk-runtime/gateway-and-nodes#gateway-service-events)
- <a id="api-runtime-agent" />[`api.runtime.agent`](/plugins/sdk-runtime/agent#api-runtime-agent)
- <a id="api-runtime-agent-defaults" />[`api.runtime.agent.defaults`](/plugins/sdk-runtime/agent#api-runtime-agent-defaults)
- <a id="api-runtime-llm" />[`api.runtime.llm`](/plugins/sdk-runtime/models#api-runtime-llm)
- <a id="api-runtime-gateway" />[`api.runtime.gateway`](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-gateway)
- <a id="api-runtime-hooks" />[`api.runtime.hooks`](/plugins/sdk-runtime/background-work#api-runtime-hooks)
- <a id="api-runtime-subagent" />[`api.runtime.subagent`](/plugins/sdk-runtime/background-work#api-runtime-subagent)
- <a id="api-runtime-sandbox" />[`api.runtime.sandbox`](/plugins/sdk-runtime/agent#api-runtime-sandbox)
- <a id="api-runtime-nodes" />[`api.runtime.nodes`](/plugins/sdk-runtime/gateway-and-nodes#api-runtime-nodes)
- <a id="api-runtime-tasks" />[`api.runtime.tasks`](/plugins/sdk-runtime/background-work#api-runtime-tasks)
- <a id="api-runtime-tts" />[`api.runtime.tts`](/plugins/sdk-runtime/media#api-runtime-tts)
- <a id="api-runtime-mediaunderstanding" />[`api.runtime.mediaUnderstanding`](/plugins/sdk-runtime/media#api-runtime-mediaunderstanding)
- <a id="api-runtime-imagegeneration" />[`api.runtime.imageGeneration`](/plugins/sdk-runtime/media#api-runtime-imagegeneration)
- <a id="api-runtime-videogeneration" />[`api.runtime.videoGeneration`](/plugins/sdk-runtime/media#api-runtime-videogeneration)
- <a id="api-runtime-musicgeneration" />[`api.runtime.musicGeneration`](/plugins/sdk-runtime/media#api-runtime-musicgeneration)
- <a id="api-runtime-websearch" />[`api.runtime.webSearch`](/plugins/sdk-runtime/media#api-runtime-websearch)
- <a id="api-runtime-media" />[`api.runtime.media`](/plugins/sdk-runtime/media#api-runtime-media)
- <a id="api-runtime-config" />[`api.runtime.config`](/plugins/sdk-runtime/state-and-system#api-runtime-config)
- <a id="api-runtime-system" />[`api.runtime.system`](/plugins/sdk-runtime/state-and-system#api-runtime-system)
- <a id="api-runtime-events" />[`api.runtime.events`](/plugins/sdk-runtime/state-and-system#api-runtime-events)
- <a id="api-runtime-logging" />[`api.runtime.logging`](/plugins/sdk-runtime/state-and-system#api-runtime-logging)
- <a id="api-runtime-modelconfig" />[`api.runtime.modelConfig`](/plugins/sdk-runtime/models#api-runtime-modelconfig)
- <a id="api-runtime-modelauth" />[`api.runtime.modelAuth`](/plugins/sdk-runtime/models#api-runtime-modelauth)
- <a id="api-runtime-state" />[`api.runtime.state`](/plugins/sdk-runtime/state-and-system#api-runtime-state)
- <a id="api-runtime-channel" />[`api.runtime.channel`](/plugins/sdk-runtime/channel#api-runtime-channel)

## Related

- [Plugin internals](/plugins/architecture) — capability model and registry
- [SDK entry points](/plugins/sdk-entrypoints) — `definePluginEntry` options
- [SDK overview](/plugins/sdk-overview) — subpath reference
